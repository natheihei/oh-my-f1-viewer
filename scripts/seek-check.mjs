// Asks the real agent to seek a real session by what happened in it, and checks where playback landed
// against the session database. Needs both sign-ins. Prints the agent's queries and replies, which can
// give away the race: use a session you've watched.
// Usage: node scripts/seek-check.mjs [lap]
//   F1A_YEAR and F1A_EVENT pick the race (2025, mexic).
import { startApp, typeInPalette } from './harness.mjs';

const YEAR = Number(process.env.F1A_YEAR ?? 2025);
const EVENT = process.env.F1A_EVENT ?? 'mexic';
const LAP = Number(process.argv[2] ?? 30);

const { page, stop } = await startApp(5191);
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
const opened = await page.evaluate(
  async ({ YEAR, EVENT }) => {
    const re = new RegExp(EVENT, 'i');
    const { host, read } = await import('/src/host/index.ts');
    window.events = [];
    window.f1a.ai.onEvent((e) => window.events.push({ ...e, at: performance.now() }));
    Object.assign(window, { host, read });
    const events = await host.catalog.events({ year: YEAR });
    const event = events.find((e) => re.test(e.name) || re.test(e.shortName));
    if (!event) return null;
    const sessions = await host.catalog.sessions({ pageId: event.pageId, year: YEAR });
    const race = sessions.find((s) => s.type === 'race' && s.series === 'FORMULA 1') ?? sessions.find((s) => s.type === 'race');
    if (!race) return null;
    await host.session.open({ contentId: race.contentId, title: race.title });
    return race.title;
  },
  { YEAR, EVENT },
);
if (!opened) throw new Error(`No race found for ${YEAR} ${EVENT}.`);
console.log(`opened: ${opened}`);

// The video has to be placed on the data clock before anything can be found on it.
await page.waitForFunction(() => window.read().sessionData.state === 'ready' && window.read().sessionData.playheadMs != null && window.read().clock.end > 0, null, {
  timeout: 120_000,
});

// Muted, and paused so the playhead only moves when the agent moves it.
await page.evaluate(() => {
  window.host.audio.set({ feed: null });
  window.host.playback.pause();
});
await page.waitForTimeout(1000);

const where = () =>
  page.evaluate(() => {
    const { clock, sessionData } = window.read();
    return { t: clock.timeSec, playhead: sessionData.playheadMs };
  });
const whole = (sql, params = []) => page.evaluate(({ sql, params }) => window.host.data.sql({ sql, params, asOf: 'session' }).then((r) => r.rows), { sql, params });
/** When the first car started a lap, and when the first car started the next one. */
const lapWindow = async (lap) => {
  const [row] = await whole(
    'SELECT (SELECT MIN(date_start) FROM laps WHERE lap_number = ?) AS start, (SELECT MIN(date_start) FROM laps WHERE lap_number = ?) AS next',
    [lap, lap + 1],
  );
  return row;
};

/** Sends a message, waits for the agent to finish and the seek to settle, and reports what it did. */
async function say(text) {
  console.log(`\n> ${text}`);
  await page.evaluate(() => {
    window.events.length = 0;
  });
  await typeInPalette(page, text);
  await page.waitForFunction(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'), null, { timeout: 180_000 });
  const events = await page.evaluate(() => window.events);
  const end = events.find((e) => e.type === 'turn_end' || e.type === 'error');
  const calls = events.filter((e) => e.type === 'tool_start');
  const failed = events.filter((e) => e.type === 'tool_end' && !e.ok).map((e) => e.name);
  const reply = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  if (end.type === 'error') console.log(`  ERROR: ${end.message}`);
  for (const call of calls) console.log(`  tool: ${call.name}(${JSON.stringify(call.args)})`);
  if (failed.length) console.log(`  failed tools: ${failed.join(' ')}`);
  console.log(`  reply: ${reply}`);
  await page.waitForTimeout(2500);
  return { reply, calls, names: calls.map((c) => c.name), failed, ok: end.type !== 'error' };
}

const readAhead = (r) => r.calls.some((c) => c.name === 'query_session' && c.args.asOf === 'session');
const seekTarget = (r) => r.calls.findLast((c) => c.name === 'seek_to')?.args.date ?? null;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

const start = await where();
console.log(`start: video ${start.t.toFixed(1)}s`);

// Forward, to a lap: the plain case.
let r = await say(`go to lap ${LAP}`);
let at = await where();
let lap = await lapWindow(LAP);
check('the turn finished', r.ok);
check('it read ahead to find the lap', readAhead(r));
check('it sought', r.names.includes('seek_to'));
check('playback moved forward', at.t > start.t + 60, `video ${start.t.toFixed(1)}s to ${at.t.toFixed(1)}s`);
check(
  `the playhead is in lap ${LAP}`,
  lap.start != null && at.playhead >= lap.start - 5000 && (lap.next == null || at.playhead < lap.next),
  lap.start == null ? 'the lap is not in the data' : `${secs(at.playhead - lap.start)} after the lap began, lap lasts ${secs(lap.next - lap.start)}`,
);
check('the reply says nothing about the race', !/\b(P\d+|leads?|leader|pit(ted|s)?|gap|ahead of|behind|overt[ao]k|crash|retire|safety car)\b/i.test(r.reply), r.reply.slice(0, 160));
const afterLap = at;

// Backward: still lands where asked.
const EARLY = Math.max(2, Math.floor(LAP / 6));
r = await say(`now back to lap ${EARLY}`);
at = await where();
lap = await lapWindow(EARLY);
check('it sought back', r.names.includes('seek_to') && at.t < afterLap.t - 60, `video ${at.t.toFixed(1)}s`);
check(
  `the playhead is in lap ${EARLY}`,
  lap.start != null && at.playhead >= lap.start - 5000 && at.playhead < lap.next,
  lap.start == null ? 'the lap is not in the data' : `${secs(at.playhead - lap.start)} after the lap began`,
);

// By what happened: there is no single right answer, so check it found a moment in the data and went there.
const [busiest] = await whole(
  `SELECT o.overtaking_driver_number AS a, o.overtaken_driver_number AS b, COUNT(*) AS n
     FROM overtakes o GROUP BY 1, 2 ORDER BY n DESC LIMIT 1`,
);
const acronym = async (number) => (await page.evaluate(() => window.read().sessionData.drivers)).find((d) => d.driver_number === number)?.name_acronym;
const [a, b] = busiest ? [await acronym(busiest.a), await acronym(busiest.b)] : ['HAM', 'VER'];
const before = at;
r = await say(`go to when ${a} catches up to ${b}`);
at = await where();
const target = seekTarget(r);
check('the turn finished', r.ok);
check('it queried the session', r.names.includes('query_session'));
check('no tool call failed for good', !r.failed.includes('seek_to'), r.failed.join(' '));
check('it sought to a moment', target != null);
check('playback is where it sought', target != null && Math.abs(at.playhead - target) < 5000, target == null ? '' : `${secs(at.playhead - target)} off`);
check('playback moved', Math.abs(at.t - before.t) > 5, `video ${before.t.toFixed(1)}s to ${at.t.toFixed(1)}s`);

// Past the end: it must not land somewhere made up.
r = await say('go to lap 500');
const last = await where();
check('a lap that does not exist moves nothing', Math.abs(last.t - at.t) < 30, r.reply.slice(0, 120));

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
await stop();
process.exit(failures ? 1 : 0);
