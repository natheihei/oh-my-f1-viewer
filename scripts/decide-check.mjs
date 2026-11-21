// Checks how the real viewing agent decides what a request needs, in an OMFV of its own (see isolated.mjs), over a
// real replay race, muted: an answer, a suggested component, an offer of build mode, or none of them. Each case
// starts a new conversation, and --runs repeats them all, since one reply says little about a model. It never
// switches to build mode: offer-check.mjs --agent does that. See "Offered from view mode" in docs/BUILD_MODE.md.
//
// With --qualifying it then opens the same event's qualifying, where the race charts aren't offered.
// Needs the F1 TV sign-in and the agent's login, which it copies in. Prints race data: use a race you've watched.
// Usage: node scripts/decide-check.mjs <out-dir> [--runs 3] [--only <case>] [--qualifying] [--session <key>] [--year 2026] [--lap 30]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { typeInPalette } from './harness.mjs';
import { frontRunners, openRace, seekToLap, startIsolatedApp } from './isolated.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const outDir = argv[0] && !argv[0].startsWith('--') ? path.resolve(argv[0]) : null;
if (!outDir) throw new Error('Usage: node scripts/decide-check.mjs <out-dir> [--runs 3] [--only <case>] [--qualifying] [--session <key>] [--year 2026] [--lap 30]');
const runs = Number(flag('runs', 1));
const only = flag('only', null);
mkdirSync(outDir, { recursive: true });

const { page, log, stop } = await startIsolatedApp(outDir, { name: 'decide', agent: true });
const fail = async (message) => {
  log('FAIL', message);
  await stop();
  process.exit(1);
};
process.on('uncaughtException', (e) => fail(e.message));

const year = Number(flag('year', 2026));
const opened = await openRace(page, { sessionKey: flag('session', null) == null ? null : Number(flag('session')), year }).catch((e) => fail(e.message));
log(`opened ${opened.title}`);
await seekToLap(page, opened.start ?? 600, Number(flag('lap', 30)));
const codeOf = (n) => page.evaluate(async (n) => (await import('/src/host/index.ts')).read().sessionData.drivers.find((d) => d.driver_number === n)?.name_acronym ?? String(n), n);
const [first, second] = await frontRunners(page);
const [a, b] = [await codeOf(first), await codeOf(second)];
log(`about ${a} and ${b}`);

await page.evaluate(() => {
  window.events = [];
  window.omfv.ai.onEvent((e) => window.events.push(e));
});
if (!(await page.evaluate(async () => (await window.omfv.ai.status()).ready))) await fail('The agent is not set up in the main profile: connect it in /settings-agent.');

const offerNow = () => page.evaluate(async () => (await import('/src/host/index.ts')).read().build.offer);

/** Sends a message as the viewer and waits for the turn to end. A spoiler check is refused: no case needs to read ahead. */
async function say(text) {
  await page.evaluate(() => (window.events.length = 0));
  await typeInPalette(page, text);
  const deadline = Date.now() + 180_000;
  let refused = false;
  while (!(await page.evaluate(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error')))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the turn: ${text}`);
    const no = page.locator('[data-testid=spoiler-no]');
    if (await no.isVisible().catch(() => false)) {
      await no.click();
      refused = true;
    }
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(1200);
  const events = await page.evaluate(() => window.events);
  const calls = events.filter((e) => e.type === 'tool_start').map((e) => ({ name: e.name, args: e.args }));
  const reply = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  const turn = { text, calls, reply, refused, offer: await offerNow() };
  console.log(`  > ${text}`);
  for (const call of calls) console.log(`    tool: ${call.name}(${JSON.stringify(call.args).slice(0, 300)})`);
  console.log(`    reply: ${reply}${refused ? ' [read ahead refused]' : ''}`);
  return turn;
}

const offered = (t) => t.calls.some((c) => c.name === 'offer_build') && t.offer != null;
const noOffer = (t) => !t.calls.some((c) => c.name === 'offer_build') && t.offer == null;
const suggested = (t) => t.calls.some((c) => c.name === 'suggest_tiles');
const queried = (t) => t.calls.some((c) => c.name === 'query_session');
/** Says nothing is being built: the offer is a question. */
const noClaim = (t) => !/\b(building|built|i'll build|i will build)\b/i.test(t.reply);

/**
 * Each case is a conversation of its own: `turns` are what the viewer says, or a function that acts for them, and
 * `expect` names what each turn must do. Track temperature is in the weather table, and no component shows it.
 */
const RACE_CASES = [
  // A fact, however it's worded: an answer, and nothing else.
  { name: 'fact: track temperature', turns: ["what's the track temp right now?"], expect: [{ 'answers from the data': queried, 'no offer': noOffer, 'no tile': (t) => !suggested(t) }] },
  { name: 'fact: last pit', turns: [`when did ${a} last pit?`], expect: [{ 'no offer': noOffer }] },
  { name: 'fact: oldest tyres', turns: ["who's on the oldest tyres?"], expect: [{ 'no offer': noOffer }] },
  // Something to follow that a component covers.
  { name: 'follow, covered: gap', turns: [`keep an eye on the gap between ${a} and ${b}`], expect: [{ 'suggests a component': suggested, 'no offer': noOffer }] },
  { name: 'follow, covered: asked to build', turns: [`build me a tyre degradation chart for ${a}`], expect: [{ 'suggests the one there is': suggested, 'no offer': noOffer }] },
  // Something to follow that none covers, never saying build.
  { name: 'follow, uncovered: keep an eye on', turns: ['keep an eye on the track temperature for me'], expect: [{ offers: offered, 'claims nothing is built': noClaim }] },
  { name: 'follow, uncovered: somewhere I can see', turns: ['put the weather somewhere I can see it through the race'], expect: [{ offers: offered, 'claims nothing is built': noClaim }] },
  { name: 'follow, uncovered: want to watch', turns: ["I'd like to watch how the wind changes"], expect: [{ offers: offered }] },
  // Could be either. A component covers it: the component, or the fact.
  { name: 'either, covered: pace', turns: [`how is ${a}'s pace?`], expect: [{ 'no offer': noOffer, 'answers or suggests': (t) => suggested(t) || queried(t) }] },
  // Could be either, and none covers it: the fact first, and the offer once they say they meant to follow it.
  {
    name: 'either, uncovered: then clarified',
    turns: ['how warm is the track?', 'no, I meant I want to keep that on screen'],
    expect: [{ 'no offer': noOffer, 'answers from the data': queried }, { offers: offered }],
  },
  // Turned down: not offered again for a question about it, and offered again when asked.
  {
    name: 'turned down',
    turns: [
      'keep an eye on the track temperature for me',
      async () => {
        await page.locator('[data-testid=offer-stay]').click();
        await page.waitForTimeout(500);
      },
      'what is it right now, though?',
      'actually yes, go ahead and build that',
    ],
    expect: [{ offers: offered }, null, { 'no offer again': noOffer }, { 'offers when asked again': offered }],
  },
  // Something to keep doing is a tile.
  { name: 'keep doing: leader onboard', turns: ["always show the leader's onboard"], expect: [{ offers: offered, 'the note asks for a tile': (t) => /tile|component/i.test(t.offer?.note ?? '') }] },
  // Nothing built changes the app with no tile on screen.
  { name: 'no tile: fullscreen on start', turns: ['make the app open in fullscreen every time I start it'], expect: [{ 'no offer': noOffer }] },
  { name: 'no tile: shortcut', turns: ['change the shortcut that opens this palette to F2'], expect: [{ 'no offer': noOffer }] },
  // The session's data doesn't hold it.
  { name: 'no data: fuel', turns: [`track how much fuel ${a} has left`], expect: [{ 'no offer': noOffer }] },
];

const results = [];
async function runCases(cases, run) {
  for (const c of cases.filter((c) => !only || c.name.includes(only))) {
    console.log(`\n[run ${run}] ${c.name}`);
    await page.evaluate(async () => {
      (await import('/src/host/index.ts')).host.build.dismissOffer();
      await window.omfv.ai.reset();
    });
    const failed = [];
    const turns = [];
    for (const [i, step] of c.turns.entries()) {
      if (typeof step === 'function') {
        await step();
        continue;
      }
      const turn = await say(step).catch((e) => ({ text: step, calls: [], reply: `ERROR ${e.message}`, offer: null }));
      turns.push(turn);
      for (const [what, ok] of Object.entries(c.expect[i] ?? {})) {
        const pass = !!ok(turn);
        console.log(`    ${pass ? 'ok  ' : 'FAIL'} ${what}`);
        if (!pass) failed.push(`turn ${i + 1}: ${what}`);
      }
    }
    results.push({ run, name: c.name, failed, turns });
  }
}

for (let run = 1; run <= runs; run += 1) await runCases(RACE_CASES, run);

if (argv.includes('--qualifying')) {
  // The race charts aren't offered in qualifying: say why, and build no second one.
  const quali = await page.evaluate(
    async ({ title, year }) => {
      const { host, read } = await import('/src/host/index.ts');
      const events = (await host.catalog.events({ year })).filter((e) => e.endMs < Date.now() && !e.isTest).reverse();
      for (const e of events) {
        const sessions = await host.catalog.sessions({ pageId: e.pageId, year });
        if (!sessions.some((s) => s.title === title)) continue;
        const q = sessions.find((s) => s.type === 'qualifying');
        if (!q) return { error: 'That event has no qualifying.' };
        await host.session.open({ contentId: q.contentId, title: q.title });
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline && !['ready', 'waiting'].includes(read().sessionData.state)) await new Promise((r) => setTimeout(r, 500));
        return { title: q.title, state: read().sessionData.state };
      }
      return { error: 'No such event.' };
    },
    { title: opened.title, year },
  );
  if (quali.error) await fail(quali.error);
  log(`opened ${quali.title} (${quali.state})`);
  const says = (t) => /qualifying|race|sprint/i.test(t.reply);
  const cases = [{ name: 'not offered here: tyre degradation in qualifying', turns: [`track tyre degradation for ${a}`], expect: [{ 'no offer': noOffer, 'says why': says }] }];
  for (let run = 1; run <= runs; run += 1) await runCases(cases, run);
}

writeFileSync(path.join(outDir, 'decide.json'), JSON.stringify(results, null, 2));
console.log('\nBy case, runs passed:');
const names = [...new Set(results.map((r) => r.name))];
let failures = 0;
for (const name of names) {
  const of = results.filter((r) => r.name === name);
  const bad = of.filter((r) => r.failed.length);
  failures += bad.length;
  console.log(`  ${bad.length ? 'FAIL' : 'ok  '} ${of.length - bad.length}/${of.length} ${name}${bad.length ? ` (${[...new Set(bad.flatMap((r) => r.failed))].join('; ')})` : ''}`);
}
console.log(failures ? `\n${failures} failed` : '\nall ok');
await stop();
process.exit(failures ? 1 : 0);
