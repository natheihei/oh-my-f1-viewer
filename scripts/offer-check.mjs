// Checks the viewing agent's offer of build mode for something no chart does, in an OMFV of its own (see
// isolated.mjs), over a real replay race, muted, and saves a screenshot at each step.
//
// By default there's no agent sign-in: it offers build mode as offer_build would, with no tiles, catches what
// would go to the build agent, and switches. With --agent the real models answer. A request a chart covers
// gets the chart and no offer. A question gets its answer, and data the session lacks gets told so, with no offer.
// Something to follow that none covers gets an offer with a reason and a handoff note, unasked, and the
// check switches and waits for the build agent's turn, with the agent's login copied in. It puts the mods
// folder back with Undo all.
// Needs the F1 TV sign-in. Prints race data: use a race you've watched.
// Usage: node scripts/offer-check.mjs <out-dir> [--agent] [--session <key>] [--year 2026] [--lap 30]
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { typeInPalette } from './harness.mjs';
import { frontRunners, openRace, seekToLap, startIsolatedApp } from './isolated.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const outDir = argv[0] && !argv[0].startsWith('--') ? path.resolve(argv[0]) : null;
if (!outDir) throw new Error('Usage: node scripts/offer-check.mjs <out-dir> [--agent] [--session <key>] [--year 2026] [--lap 30]');
const agent = argv.includes('--agent');
mkdirSync(outDir, { recursive: true });

const { page, log, stop } = await startIsolatedApp(outDir, { name: 'offer', agent });
const cleanUp = async () => {
  await page.evaluate(async () => {
    const { host, read } = await import('/src/host/index.ts');
    if (read().build.active) await host.build.undo();
  }).catch(() => {});
  await stop();
};
const fail = async (message) => {
  log('FAIL', message);
  await cleanUp();
  process.exit(1);
};
process.on('uncaughtException', (e) => fail(e.message));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};
let step = 0;
const shot = async (name) => {
  step += 1;
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, `${step}-${name}.png`) });
  log(`saved ${step}-${name}.png`);
};
/** Waits for `ok` in the page, up to `ms`. */
const until = async (what, ok, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await page.evaluate(ok)) return true;
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for ${what}`);
};
const offerText = () => page.locator('[data-testid=build-offer]').innerText().catch(() => '');

const opened = await openRace(page, { sessionKey: flag('session', null) == null ? null : Number(flag('session')), year: Number(flag('year', 2026)) }).catch((e) => fail(e.message));
log(`opened ${opened.title}`);
await seekToLap(page, opened.start ?? 600, Number(flag('lap', 30)));
const [leader] = await frontRunners(page);
const code = await page.evaluate(async (n) => (await import('/src/host/index.ts')).read().sessionData.drivers.find((d) => d.driver_number === n)?.name_acronym ?? String(n), leader);
log(`about ${code}`);

// What goes to an agent, kept, and with --agent still sent.
await page.evaluate(async (agent) => {
  const { host } = await import('/src/host/index.ts');
  window.__sent = [];
  window.events = [];
  const send = host.agent.send;
  if (agent) {
    window.omfv.ai.onEvent((e) => window.events.push(e));
    await window.omfv.ai.reset();
    host.agent.send = async (...a) => (window.__sent.push(a[0]), send(...a));
  } else {
    host.agent.status = async () => ({ ready: true });
    host.agent.send = async (text) => void window.__sent.push(text);
  }
}, agent);
if (agent && !(await page.evaluate(async () => (await window.omfv.ai.status()).ready))) await fail('The agent is not set up in the main profile: connect it in /settings-agent.');

/** Sends a message as the viewer, waits for the turn to end, and returns the tool calls and the reply. */
async function say(text) {
  console.log(`\n> ${text}`);
  await page.evaluate(() => (window.events.length = 0));
  await typeInPalette(page, text);
  await page.waitForFunction(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'), null, { timeout: 180_000 });
  await page.waitForTimeout(1500);
  const events = await page.evaluate(() => window.events);
  const calls = events.filter((e) => e.type === 'tool_start').map((e) => ({ name: e.name, args: e.args }));
  const reply = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  for (const call of calls) console.log(`  tool: ${call.name}(${JSON.stringify(call.args)})`);
  console.log(`  reply: ${reply}`);
  return { calls, reply };
}

if (!agent) {
  // As offer_build would leave it, for a component to build.
  await page.evaluate(async (code) => {
    const { host } = await import('/src/host/index.ts');
    host.build.offer({ reason: `build a chart of when ${code} opens DRS`, note: `The user wants to see, lap by lap, how often ${code} opens DRS. No chart shows it.` });
  }, code);
  await page.waitForSelector('[data-testid=build-offer]');
  const text = await offerText();
  check('the offer asks the reason', text.includes(`Build a chart of when ${code} opens DRS in build mode?`), text);
  check('with the spoiler warning', text.includes('the build agent looks ahead without asking'));
  check('it takes focus on Switch to build', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'offer-switch'));
  await shot('offer');
  await page.keyboard.press('Enter');
  await until('build mode', async () => (await import('/src/host/index.ts')).read().build.active, 30_000);
  await page.waitForTimeout(500);
  const [sent] = await page.evaluate(() => window.__sent);
  check('the build agent gets the note alone', /^<from_viewing_agent>\n[^<]*opens DRS[^<]*\n<\/from_viewing_agent>$/.test(sent ?? ''), sent);
  await shot('switched');
} else {
  // A chart covers it: suggest the chart, and offer nothing.
  const covered = await say(`track tyre degradation for ${code}`);
  check('a request a chart covers gets the chart', covered.calls.some((c) => c.name === 'suggest_tiles'));
  check('and no offer of build mode', !covered.calls.some((c) => c.name === 'offer_build') && !(await page.evaluate(async () => (await import('/src/host/index.ts')).read().build.offer)));
  await shot('covered');

  const noOffer = async (turn) => !turn.calls.some((c) => c.name === 'offer_build') && !(await page.evaluate(async () => (await import('/src/host/index.ts')).read().build.offer));

  // A fact: answer it, with no tile and no offer.
  const fact = await say(`how many laps has ${code} done on these tyres?`);
  check('a question gets an answer', fact.reply.trim().length > 0 && fact.calls.some((c) => c.name === 'query_session'));
  check('and no offer of build mode', await noOffer(fact));
  await shot('fact');

  // Something to follow that the session's data doesn't hold: say so, and offer nothing.
  const absent = await say(`track ${code}'s tyre temperatures`);
  check('data the session lacks gets no offer of build mode', await noOffer(absent), absent.reply);
  await shot('absent');

  // Something to keep doing: only a tile can, so it's an offer to build one, and no claim that the app will do it by itself.
  const standing = await say('always show the onboard of whoever set the last fastest lap');
  const tile = standing.calls.find((c) => c.name === 'offer_build');
  check('something to keep doing gets an offer to build a tile', tile != null, `${JSON.stringify(tile?.args)} ${standing.reply}`);
  await shot('standing');

  // Something to follow that nothing covers: offer build mode, though the user never said to build.
  const asked = await say(`keep track of how many times ${code} opens DRS each lap`);
  const call = asked.calls.find((c) => c.name === 'offer_build');
  check('something to follow that nothing covers gets an offer of build mode, unasked', call != null, JSON.stringify(call?.args));
  if (!call) await fail('No offer.');
  check('with no tiles', !call.args.error_tiles?.length);
  const offer = await page.evaluate(async () => (await import('/src/host/index.ts')).read().build.offer);
  check('the note is enough to start on: the driver and the data', offer && (offer.note.includes(code) || new RegExp(`driver ${leader}\\b`).test(offer.note)) && /DRS/i.test(offer.note), offer?.note);
  log(`offer: ${await offerText()}`);
  await shot('offer');
  await page.locator('[data-testid=offer-switch]').click();
  await until('build mode', async () => (await import('/src/host/index.ts')).read().build.active, 30_000);
  await until('the build agent to start', async () => (await import('/src/host/index.ts')).read().agentBusy, 30_000);
  const sent = (await page.evaluate(() => window.__sent)).at(-1) ?? '';
  check('the build agent gets the note', sent.includes(`<from_viewing_agent>\n${offer.note}\n</from_viewing_agent>`), sent.slice(0, 200));
  await shot('switched');
  await until('the build turn to end', async () => !(await import('/src/host/index.ts')).read().agentBusy, 600_000);
  const drafts = await page.evaluate(async () => (await import('/src/host/index.ts')).read().build.changes);
  check('the build agent built something', drafts.length > 0, JSON.stringify(drafts));
  await shot('built');
}

console.log(`\n${failures ? `${failures} failed` : 'all ok'}. Palette:\n${await page.locator('[data-testid=palette-history]').innerText().catch(() => '')}`);
await cleanUp();
process.exit(failures ? 1 : 0);
