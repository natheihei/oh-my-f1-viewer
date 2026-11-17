// Asks the real agent for charts over a real replay race and checks what it did: the tool calls, what
// landed in the suggestion strip, adding a chart from the strip and removing it again by asking, and a
// seek by lap. Needs both sign-ins. Prints the agent's replies and some race data: use a race you've watched.
// Also saves the reference block the app sends at the end of the system prompt, before and after the
// session's data is ready.
// Usage: node scripts/agent-charts-check.mjs <out-dir> [sessionKey] [year] [event]
//   Defaults: 11396, 2026, "united states". The battle pair is the first two drivers of OMFV_PAIR (NOR,PIA).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startApp, typeInPalette } from './harness.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/agent-charts-check.mjs <out-dir> [sessionKey] [year] [event]');
const sessionKey = String(process.argv[3] ?? 11396);
const YEAR = Number(process.argv[4] ?? 2026);
const EVENT = process.argv[5] ?? 'united states';
const [A, B] = (process.env.OMFV_PAIR ?? 'NOR,PIA').split(',');
const PIT_DRIVER = process.env.OMFV_PIT_DRIVER ?? 'Hadjar';
mkdirSync(outDir, { recursive: true });

const { page, stop } = await startApp(5192);
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console error]', m.text().slice(0, 220));
});
process.on('uncaughtException', async (e) => {
  console.log('FAIL', e.message);
  await stop();
  process.exit(1);
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};

await page.waitForTimeout(2000);
const signIns = await page.evaluate(async () => ({ f1: (await window.omfv.f1tv.status()).signedIn, ai: (await window.omfv.ai.status()).ready }));
console.log(`sign-ins: ${JSON.stringify(signIns)}`);
if (!signIns.f1 || !signIns.ai) {
  console.log('FAIL a sign-in has expired: not running the agent checks.');
  await stop();
  process.exit(1);
}

// Every reference sent with a message is kept, by wrapping the host's link to the agent.
await page.evaluate(async () => {
  const { host, read, tilesOf } = await import('/src/host/index.ts');
  const bridge = await import('/src/agent/bridge.ts');
  Object.assign(window, { host, read, tilesOf, bridge });
  window.events = [];
  window.sent = [];
  window.omfv.ai.onEvent((e) => window.events.push({ ...e, at: performance.now() }));
  const send = host.agent.send;
  host.agent.send = (text, context, tools, reference) => {
    window.sent.push({ text, context, reference, queryDescription: tools.find((t) => t.name === 'query_session')?.description ?? '' });
    return send(text, context, tools, reference);
  };
  await window.omfv.ai.reset();
});

// Before any session: the reference the app would send has no table list.
const before = await page.evaluate(() => {
  const { events, components, sessionData } = window.read();
  const parts = [window.bridge.describeEvents(events), window.bridge.describeCharts(components), window.bridge.describeTables(sessionData)];
  return { state: sessionData.state, tables: parts[2], reference: parts.filter(Boolean).join('\n\n') };
});
writeFileSync(path.join(outDir, 'reference-before-session.txt'), before.reference);
check('no table list before the session data is ready', before.tables === '' && !before.reference.includes('Tables for query_session'), `state ${before.state}`);

/** Sends a message, waits for the turn to end, and reports what it did and what's in the strip. */
async function say(text, shot) {
  console.log(`\n> ${text}`);
  const start = await page.evaluate(() => {
    window.events.length = 0;
    return performance.now();
  });
  await typeInPalette(page, text);
  await page.waitForFunction(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'), null, { timeout: 180_000 });
  await page.waitForTimeout(1500);
  const events = await page.evaluate(() => window.events);
  const end = events.find((e) => e.type === 'turn_end' || e.type === 'error');
  const calls = events.filter((e) => e.type === 'tool_start');
  const ends = events.filter((e) => e.type === 'tool_end');
  const failed = ends.filter((e) => !e.ok).map((e) => e.name);
  const reply = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  if (end.type === 'error') console.log(`  ERROR: ${end.message}`);
  for (const call of calls) console.log(`  tool: ${call.name}(${JSON.stringify(call.args)})`);
  for (const e of ends) if (!e.ok) console.log(`  tool failed: ${e.name}: ${String(e.content ?? e.message ?? '').slice(0, 200)}`);
  // Every driver the chart's props name, whichever props they are in: driver, driver_a, drivers and the like.
  const strip = await page.evaluate(() =>
    window.read().suggestions.items.map((i) => {
      const named = Object.entries(i.props ?? {}).filter(([k]) => /^drivers?(_|$)/.test(k)).flatMap(([, v]) => (Array.isArray(v) ? v : [v]));
      return { type: i.type, label: i.label, key: i.key, drivers: named.length ? named : null };
    }),
  );
  console.log(`  strip: ${strip.map((s) => `${s.type}:${s.label}${s.drivers ? `[${s.drivers}]` : ''}`).join(', ') || 'empty'}`);
  console.log(`  reply: ${reply}`);
  console.log(`  time: ${Math.round(end.at - start)}ms`);
  if (shot) await page.screenshot({ path: path.join(outDir, shot) });
  return { reply, calls, names: calls.map((c) => c.name), failed, strip, ok: end.type !== 'error' };
}

const markdown = (reply) => /\*\*|^#+ |^\s*[-*] |^\s*\d+\. |`/m.test(reply);
const claimsOnScreen = (reply) => /\b(I('ve| have)? (added|put|placed|opened)|(is|are) (now )?on screen|now showing)\b/i.test(reply);
const describesChart = (reply) => /\b(\d+\.\d+ ?s\b|gap (is|of)|lead(s|ing)? by|faster|slower|degrad\w+ (is|of)|P\d+)\b/i.test(reply);
const hygiene = (r) => {
  check('reply uses no markdown', !markdown(r.reply));
  check('reply does not claim a tile is on screen', !claimsOnScreen(r.reply));
  check('reply does not describe what a chart shows', !describesChart(r.reply));
};
const tilesOnScreen = () => page.evaluate(() => window.tilesOf(window.read().layout).map((t) => ({ type: t.component.type, label: t.component.label, key: t.component.key })));

// 0: open the race by asking, the way a user would.
let r = await say(`${YEAR} ${EVENT} grand prix race`);
check('it loaded a session', r.names.includes('load_session'));
const session = await page.evaluate(() => window.read().session);
check('the right race is open', session != null && /united states/i.test(session.title ?? '') && session.type === 'race', session?.title ?? 'none');
await page.waitForFunction(() => window.read().sessionData.state === 'ready' && window.read().sessionData.playheadMs != null && window.read().clock.end > 0, null, { timeout: 120_000 });
const data = await page.evaluate(() => {
  const d = window.read().sessionData;
  return {
    sessionKey: d.sessionKey,
    tables: d.tables.map((t) => `${t.name}(${t.columns.length})`),
    lapSummary: d.tables.find((t) => t.name === 'lap_summary') ?? null,
    datasets: d.datasets ? Object.fromEntries(Object.entries(d.datasets).map(([k, v]) => [k, v.state])) : null,
    hasCoverage: 'coverage' in d,
  };
});
console.log(`  session data: ${JSON.stringify(data)}`);
check('it is the expected session', String(data.sessionKey) === sessionKey, String(data.sessionKey));
check('sessionData.tables has 12 tables including lap_summary', data.tables.length === 12 && data.lapSummary != null, data.tables.join(' '));
check('lap_summary carries its description', Boolean(data.lapSummary?.about));
check('sessionData.datasets has timing, telemetry and results', data.datasets && ['timing', 'telemetry', 'results'].every((k) => k in data.datasets), JSON.stringify(data.datasets));
check('sessionData has no coverage', !data.hasCoverage);
const sentFirst = await page.evaluate(() => window.sent.at(-1));
check('the first message went without a table list (data not ready yet)', !sentFirst.reference.includes('Tables for query_session'));

// Muted, at about lap 20, paused, so the playhead only moves when the agent moves it.
const lap20 = await page.evaluate(async () => {
  const { host, read } = window;
  host.audio.setVolume({ volume: 0 });
  const ready = Date.now() + 60_000;
  while (Date.now() < ready && !Object.values(read().streams).some((s) => s.status === 'ready')) await new Promise((r) => setTimeout(r, 500));
  const { rows } = await host.data.sql({ sql: 'SELECT MIN(date_start) AS t FROM laps WHERE lap_number = 20', asOf: 'session' });
  host.playback.play();
  await host.playback.seekToDate({ dateMs: rows[0].t + 20_000 });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && Math.abs(read().sessionData.playheadMs - (rows[0].t + 20_000)) > 5000) await new Promise((r) => setTimeout(r, 300));
  host.playback.pause();
  await new Promise((r) => setTimeout(r, 3000));
  return read().sessionData.lapCount;
});
console.log(`  at lap ${JSON.stringify(lap20)}`);

// 1: a request that needs a driver, with no context: it should ask.
await page.evaluate(() => window.omfv.ai.reset());
r = await say('pit window', 'agent-1-pit-window.png');
const sentReady = await page.evaluate(() => window.sent.at(-1));
writeFileSync(path.join(outDir, 'reference-session-ready.txt'), sentReady.reference);
writeFileSync(path.join(outDir, 'app-state-session-ready.txt'), sentReady.context);
check('the table list is sent once the data is ready', sentReady.reference.includes('Tables for query_session') && sentReady.reference.includes('lap_summary'));
check('query_session no longer lists the tables itself', !/lap_summary|car_data|race_control:/.test(sentReady.queryDescription), sentReady.queryDescription.slice(0, 120));
check('it asks whose pit window', r.reply.includes('?') && !r.strip.some((s) => s.type === 'pit_window'), r.reply.slice(0, 160));
hygiene(r);

// 2: a battle.
await page.evaluate(() => window.omfv.ai.reset());
const numbers = await page.evaluate(([a, b]) => {
  const d = window.read().sessionData.drivers;
  return [a, b].map((code) => d.find((x) => x.name_acronym === code)?.driver_number);
}, [A, B]);
r = await say(`${A} and ${B} battle`, 'agent-2-battle-strip.png');
const pairOk = (s) => s.drivers && numbers.every((n) => s.drivers.includes(n));
check('both onboards are suggested', [A, B].every((code) => r.strip.some((s) => s.type === 'video' && s.label === code)), r.strip.map((s) => s.label).join(', '));
check('a gap chart for the pair is suggested', r.strip.some((s) => s.type === 'gap_evolution' && pairOk(s)));
check('every suggested chart that takes drivers has the pair', r.strip.filter((s) => s.type !== 'video' && s.drivers).every(pairOk));
hygiene(r);

// Add the gap chart from the strip by clicking it.
const gap = r.strip.find((s) => s.type === 'gap_evolution');
if (gap) {
  await page.locator(`[data-testid=suggestion][data-key="${gap.key}"]`).click();
  await page.waitForTimeout(3000);
  const tiles = await tilesOnScreen();
  const messages = await page.evaluate(() => [...document.querySelectorAll('.chart-message')].map((m) => m.textContent));
  check('clicking the suggestion puts the gap chart on screen', tiles.some((t) => t.type === 'gap_evolution'), JSON.stringify(tiles.map((t) => t.label)));
  check('the chart draws (no message)', messages.length === 0, messages.join(' | '));
  await page.screenshot({ path: path.join(outDir, 'agent-2-gap-added.png') });
}

// 3: pit strategy for one driver.
r = await say(`pit strategy for ${PIT_DRIVER}`, 'agent-3-pit-strategy.png');
const pitNumber = await page.evaluate((name) => window.read().sessionData.drivers.find((d) => new RegExp(name, 'i').test(`${d.last_name ?? ''} ${d.full_name ?? ''} ${d.broadcast_name ?? ''}`))?.driver_number, PIT_DRIVER);
check(`pit_window for ${PIT_DRIVER} is suggested`, r.strip.some((s) => s.type === 'pit_window' && s.drivers?.length === 1 && s.drivers[0] === pitNumber), `car ${pitNumber}`);
check('a tyre chart comes with it', r.strip.some((s) => ['tyre_strategy', 'tyre_deg'].includes(s.type)));
hygiene(r);

// 4: tyres, field-wide.
r = await say('tyres', 'agent-4-tyres.png');
check('tyre charts are suggested', r.strip.some((s) => s.type === 'tyre_strategy'));
check('no driver is named for them', r.strip.filter((s) => s.type === 'tyre_strategy').every((s) => !s.drivers || s.drivers.length === 0), JSON.stringify(r.strip));
hygiene(r);

// 5: remove the chart that was added.
r = await say('remove the gap chart', 'agent-5-removed.png');
const after = await tilesOnScreen();
check('it used remove_tiles', r.names.includes('remove_tiles'));
check('the gap chart is gone', !after.some((t) => t.type === 'gap_evolution'), JSON.stringify(after.map((t) => t.label)));
check('nothing else went', after.some((t) => t.type === 'video'));
hygiene(r);

// 6: go to a lap.
const where = () => page.evaluate(() => ({ t: window.read().clock.timeSec, playhead: window.read().sessionData.playheadMs }));
const startAt = await where();
r = await say('go to lap 30', 'agent-6-lap30.png');
await page.waitForTimeout(2500);
const at = await where();
const [lap] = await page.evaluate(
  () =>
    window.host.data
      .sql({ sql: 'SELECT (SELECT MIN(date_start) FROM laps WHERE lap_number = 30) AS start, (SELECT MIN(date_start) FROM laps WHERE lap_number = 31) AS next', asOf: 'session' })
      .then((x) => x.rows),
);
const queries = r.calls.filter((c) => c.name === 'query_session').map((c) => c.args.sql);
check('it queried the session', queries.length > 0);
console.log(`  used lap_summary: ${queries.some((q) => /lap_summary/i.test(q))}`);
check('it sought', r.names.includes('seek_to'));
check('playback moved forward', at.t > startAt.t + 60, `video ${startAt.t.toFixed(1)}s to ${at.t.toFixed(1)}s`);
check('the playhead is in lap 30', at.playhead >= lap.start - 5000 && at.playhead < lap.next, `${((at.playhead - lap.start) / 1000).toFixed(1)}s after the lap began, lap lasts ${((lap.next - lap.start) / 1000).toFixed(1)}s`);
check('reply uses no markdown', !markdown(r.reply));

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
await page.evaluate(() => window.host.session.close());
await stop();
process.exit(failures ? 1 : 0);
