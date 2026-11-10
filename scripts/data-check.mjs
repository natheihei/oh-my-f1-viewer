// Runs the session database in the real app against F1's real archive, and then through a real opened
// session. Prints counts, timings and states only, no race information.
// Usage: node scripts/data-check.mjs [sessionKey] [meetingKey] [year]
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp } from './harness.mjs';

const [sessionKey, meetingKey, year] = [Number(process.argv[2] ?? 11396), Number(process.argv[3] ?? 1297), Number(process.argv[4] ?? 2026)];
const { page, stop } = await startApp(5194);
process.on('uncaughtException', async (e) => {
  console.log('FAIL', e.message);
  await stop();
  process.exit(1);
});
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};

const open = (live = false) =>
  page.evaluate(
    ({ query, live }) =>
      new Promise((resolve) => {
        const started = performance.now();
        const seen = [];
        const stop = window.f1a.data.onStatus((status) => {
          const states = status.coverage ? Object.values(status.coverage.datasets).map((d) => d.state) : [];
          seen.push({ at: Math.round(performance.now() - started), state: status.state, telemetry: status.coverage?.datasets.telemetry.state, results: status.coverage?.datasets.results.state, timing: status.coverage?.datasets.timing.state, reason: status.reason });
          const settled = status.state === 'failed' || status.state === 'unsupported' || (status.state === 'ready' && !states.includes('absent') && !states.includes('loading'));
          if (settled) {
            stop();
            resolve({ seen, ms: Math.round(performance.now() - started), status });
          }
        });
        void window.f1a.data.open(query, live);
      }),
    { query: { year, sessionKey, meetingKey, sessionType: 'race', sessionName: 'Race' }, live },
  );

let calendar = null;
const calendarDeadline = Date.now() + 120_000;
while (!calendar && Date.now() < calendarDeadline) {
  calendar = await page.evaluate(async () => {
    const s = await window.f1a.data.schedule();
    return s?.refreshedAt ? { meetings: s.meetings.length, sessions: s.sessions.length, upcoming: s.sessions.filter((x) => !x.path).length, seasons: [...new Set(s.sessions.map((x) => x.year))].sort() } : null;
  });
  if (!calendar) await page.waitForTimeout(1000);
}
if (!calendar) throw new Error('The calendar never refreshed.');
check('calendar refreshed', calendar.meetings > 0 && calendar.sessions > 0, JSON.stringify(calendar));
check('calendar starts at the first supported season', calendar.seasons[0] === 2023);

console.log('\nFirst open: ingesting everything…');
const first = await open();
for (const step of first.seen) console.log(`     ${String(step.at).padStart(7)}ms ${step.state} timing=${step.timing} results=${step.results} telemetry=${step.telemetry} ${step.reason ?? ''}`);
const coverage = first.status.coverage;
check('timing complete', coverage?.datasets.timing.state === 'complete', coverage?.datasets.timing.reason ?? '');
check('results complete', coverage?.datasets.results.state === 'complete', coverage?.datasets.results.reason ?? '');
check('telemetry complete', coverage?.datasets.telemetry.state === 'complete', coverage?.datasets.telemetry.reason ?? '');
console.log(`     missing feeds: ${coverage?.missingFeeds.join(', ') || 'none'}`);

const counts = await page.evaluate(async (key) => {
  const out = {};
  for (const table of ['car_data', 'location', 'position', 'intervals', 'weather', 'overtakes', 'race_control', 'pit', 'stints', 'laps', 'track_status', 'lap_summary']) {
    out[table] = (await window.f1a.data.sql(key, Number.MAX_SAFE_INTEGER, `SELECT COUNT(*) AS n FROM ${table}`, [])).rows[0].n;
  }
  const objects = await window.f1a.data.objects(key, Number.MAX_SAFE_INTEGER);
  out.objects = Object.fromEntries(Object.entries(objects).map(([k, v]) => [k, Array.isArray(v) ? v.length : v]));
  return out;
}, sessionKey);
console.log(`     rows: ${JSON.stringify(counts)}`);
check('every table has rows', ['car_data', 'location', 'position', 'intervals', 'weather', 'overtakes', 'race_control', 'pit', 'stints', 'laps', 'track_status', 'lap_summary'].every((t) => counts[t] > 0));
check('roster and results filled', Object.values(counts.objects).every((v) => (typeof v === 'number' ? v > 0 : v?.current > 0 && v.total > 0)));

const database = path.join(os.homedir(), '.config/f1a/timing.sqlite');
console.log(`     database: ${(statSync(database).size / 1e6).toFixed(0)} MB`);

const timing = await page.evaluate(async (key) => {
  const time = async (sql, playhead = Number.MAX_SAFE_INTEGER) => {
    const started = performance.now();
    const { rows } = await window.f1a.data.sql(key, playhead, sql, []);
    return { ms: Math.round(performance.now() - started), rows: rows.length };
  };
  const { rows } = await window.f1a.data.sql(key, Number.MAX_SAFE_INTEGER, 'SELECT MIN(date) AS a, MAX(date) AS b FROM car_data', []);
  const mid = Math.round((rows[0].a + rows[0].b) / 2);
  return {
    gapsPerLap: await time('SELECT lap_number, driver_number, date_start FROM laps'),
    oneCarWindow: await time(`SELECT * FROM car_data WHERE driver_number = 1 AND date BETWEEN ${mid} AND ${mid + 60000}`),
    allPositions: await time('SELECT * FROM position'),
    asOfMidway: await time('SELECT * FROM stints', mid),
  };
}, sessionKey);
console.log(`     query times: ${JSON.stringify(timing)}`);
check('a chart-sized query is quick', timing.gapsPerLap.ms < 500 && timing.oneCarWindow.ms < 500);

const visibility = await page.evaluate(async ({ key, timeBaseMs }) => {
  const count = async (table, at) => (await window.f1a.data.sql(key, at, `SELECT COUNT(*) AS n FROM ${table}`, [])).rows[0].n;
  const all = Number.MAX_SAFE_INTEGER;
  // The clock base comes from the feed's first anchor. Reading the views for it wouldn't do: they
  // only hold each row's newest version.
  const { rows } = await window.f1a.data.sql(key, all, 'SELECT MIN(visible_from) AS a, MAX(visible_from) AS b FROM laps', []);
  const mid = Math.round((rows[0].a + rows[0].b) / 2);
  const beforeFeed = timeBaseMs - 1;
  const denied = async (sql) => window.f1a.data.sql(key, all, sql, []).then(() => false, () => true);
  const objects = await window.f1a.data.objects(key, mid);
  const final = await window.f1a.data.objects(key, all);
  return {
    before: (await Promise.all(['laps', 'position', 'intervals', 'stints', 'pit', 'race_control', 'weather', 'car_data', 'location'].map((t) => count(t, beforeFeed)))).reduce((x, y) => x + y, 0),
    midway: await count('laps', mid),
    all: await count('laps', all),
    resultMidway: objects.sessionResult.length,
    resultEnd: final.sessionResult.length,
    gridMidway: objects.startingGrid.length,
    deniedBase: await denied('SELECT * FROM t_laps'),
    deniedWrite: await denied('DELETE FROM laps'),
  };
}, { key: sessionKey, timeBaseMs: first.status.clock.feedBaseUtc });
check('nothing shows before the feed begins', visibility.before === 0);
check('midway shows part of the laps', visibility.midway > 0 && visibility.midway < visibility.all, `${visibility.midway}/${visibility.all}`);
check('the result stays hidden midway', visibility.resultMidway === 0 && visibility.resultEnd > 0);
check('the grid shows midway', visibility.gridMidway > 0);
check('base tables and writes are refused', visibility.deniedBase && visibility.deniedWrite);

console.log('\nSecond open: should skip ingesting…');
const second = await open();
check('nothing ingested again', second.ms < 2000, `${second.ms}ms`);
await page.evaluate(() => window.f1a.data.close());

console.log('\nThrough the host, in a real session (muted, from the start)…');
const viaHost = await page.evaluate(async (year) => {
  const { host, read } = await import('/src/host/index.ts');
  host.audio.setVolume({ volume: 0 });
  let lastStatus = null;
  window.f1a.data.onStatus((status) => {
    if (status.clock) lastStatus = status;
  });
  const events = await host.catalog.events({ year });
  const past = events.filter((e) => e.endMs < Date.now() - 7 * 864e5 && !e.isTest).at(-1);
  const sessions = await host.catalog.sessions({ pageId: past.pageId, year });
  const race = sessions.find((s) => s.type === 'race' && s.status === 'replay');
  await host.session.open({ contentId: race.contentId, title: race.title });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && read().sessionData.state !== 'ready') await new Promise((r) => setTimeout(r, 500));
  const startRevision = read().sessionData.revision;
  const until = Date.now() + 90_000;
  while (Date.now() < until && !(read().sessionData.revision > startRevision + 2)) await new Promise((r) => setTimeout(r, 500));
  const data = read().sessionData;
  const onboards = read().feeds.filter((feed) => feed.kind === 'onboard' && feed.number != null);
  const numbers = new Set(data.drivers?.map((driver) => driver.driver_number));

  // Lights out on the video must be lights out in the data.
  const link = { sessionStartSec: lastStatus?.sessionStartSec ?? null, clock: lastStatus?.clock ?? null };
  if (link.sessionStartSec != null) {
    const startedAt = async (seconds) => {
      await host.playback.seek({ time: seconds });
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline && Math.abs(read().clock.timeSec - seconds) > 3) await new Promise((r) => setTimeout(r, 300));
      await new Promise((r) => setTimeout(r, 2500));
      const timeSec = read().clock.timeSec;
      const playheadMs = read().sessionData.playheadMs;
      const { rows } = await host.data.sql({ sql: "SELECT COUNT(*) AS n FROM race_control WHERE message = 'SESSION STARTED'" });
      const offsetMs = playheadMs - link.clock.feedBaseUtc;
      const expected = link.clock.clockStartOffsetMs + (timeSec - link.sessionStartSec) * 1000;
      return { timeSec: +timeSec.toFixed(1), started: rows[0].n > 0, mapError: Math.round(Math.abs(offsetMs - expected)) };
    };
    link.before = await startedAt(link.sessionStartSec - 60);
    link.after = await startedAt(link.sessionStartSec + 60);
    link.back = await startedAt(link.sessionStartSec - 60);
  }
  let writeRefused = false;
  try {
    data.drivers.push({});
  } catch {
    writeRefused = true;
  }
  const rows = await host.data.sql({ sql: 'SELECT COUNT(*) AS n FROM laps' }).catch((e) => e.message);
  const direct = await host.data.sql({ sql: 'SELECT * FROM t_laps' }).then(() => 'allowed', () => 'refused');
  const schedule = read().schedule;
  host.session.close();
  return {
    state: data.state,
    moved: (data.revision ?? 0) > (startRevision ?? 0),
    drivers: data.drivers?.length,
    results: data.sessionResult?.length,
    writeRefused,
    lapsVisible: rows.rows?.[0]?.n ?? rows,
    direct,
    scheduleSessions: schedule.sessions.length,
    idleAfterClose: read().sessionData.state,
    link,
    sameSession: String(data.sessionKey) === String(race.sessionKey),
    onboards: onboards.length,
    onboardsMatched: onboards.filter((feed) => numbers.has(feed.number)).length,
  };
}, year);
console.log(`     ${JSON.stringify(viaHost)}`);
check('ready through the host', viaHost.state === 'ready');
const { link } = viaHost;
check("F1 TV's session key finds the same session in the database", viaHost.sameSession);
check("onboard feeds match drivers by number", viaHost.onboards > 0 && viaHost.onboards === viaHost.onboardsMatched, `${viaHost.onboardsMatched}/${viaHost.onboards}`);
check('F1 TV has sync data for this session', link.sessionStartSec != null, `lights out at video ${link.sessionStartSec}s`);
if (link.before) {
  check('before lights out on the video, the session has not started', link.before.started === false, JSON.stringify(link.before));
  check('after lights out on the video, it has', link.after.started === true, JSON.stringify(link.after));
  check('seeking back hides it again', link.back.started === false, JSON.stringify(link.back));
  // The published playhead moves once a second, so this can only be checked to about that.
  check('frames land where the map says', link.before.mapError < 1500 && link.after.mapError < 1500, `${link.before.mapError}ms, ${link.after.mapError}ms`);
}
check('follows the playhead', viaHost.moved);
check('objects are read-only', viaHost.writeRefused);
check('no result at the start of a replay', viaHost.results === 0);
check('SQL through the host reads, and only the views', typeof viaHost.lapsVisible === 'number' && viaHost.direct === 'refused');
check('schedule reaches the host', viaHost.scheduleSessions > 0);
check('goes idle when closed', viaHost.idleAfterClose === 'idle');

await stop();
console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
