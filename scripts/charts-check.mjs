// Puts the charts on screen in the real app, over a real replay race, muted, and saves screenshots:
// first as previews in the suggestion strip, then as tiles. Also times each chart's query at the end
// of the race. Needs the F1 TV sign-in; it stops if that has expired.
// Usage: node scripts/charts-check.mjs <screenshot-dir> [sessionKey] [year] [minutes after lights out]
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { startApp } from './harness.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/charts-check.mjs <screenshot-dir> [sessionKey] [year] [minutes]');
const [sessionKey, year, minutes] = [String(process.argv[3] ?? 11396), Number(process.argv[4] ?? 2026), Number(process.argv[5] ?? 50)];
mkdirSync(outDir, { recursive: true });

const { page, stop } = await startApp(5193);
const fail = async (message) => {
  console.log('FAIL', message);
  await stop();
  process.exit(1);
};

const signedIn = await page.evaluate(async () => (await (await import('/src/host/index.ts')).host.account.status()).f1tv.signedIn);
if (!signedIn) await fail('F1 TV is not signed in: sign in in the app, then run this again.');

const opened = await page.evaluate(
  async ({ sessionKey, year }) => {
    const { host, read } = await import('/src/host/index.ts');
    host.audio.setVolume({ volume: 0 });
    let start = null;
    window.f1a.data.onStatus((status) => {
      if (status.sessionStartSec != null) start = status.sessionStartSec;
    });
    const events = (await host.catalog.events({ year })).filter((e) => e.endMs < Date.now() && !e.isTest).reverse();
    let race = null;
    for (const e of events) {
      race = (await host.catalog.sessions({ pageId: e.pageId, year })).find((s) => s.type === 'race' && s.sessionKey === sessionKey);
      if (race) break;
    }
    if (!race) return { error: `No replay race with session key ${sessionKey} in ${year}` };
    await host.session.open({ contentId: race.contentId, title: race.title });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && read().sessionData.state !== 'ready') await new Promise((r) => setTimeout(r, 500));
    const data = read().sessionData;
    return { title: race.title, state: data.state, start, drivers: data.drivers?.map((d) => d.driver_number) ?? [] };
  },
  { sessionKey, year },
);
if (opened.error || opened.state !== 'ready') await fail(opened.error ?? `Session data is ${opened.state}`);
console.log(`opened ${opened.title}, lights out at video ${opened.start}s`);

// Two teammates, so the dashed second driver shows wherever lines are drawn.
const pair = [1, 81].every((n) => opened.drivers.includes(n)) ? [1, 81] : opened.drivers.slice(0, 2);
const items = [
  { type: 'timing_tower', props: {} },
  { type: 'gap_evolution', props: { drivers: pair } },
  { type: 'tyre_strategy', props: {} },
];

const at = (opened.start ?? 600) + minutes * 60;
await page.evaluate(async (time) => {
  const { host, read } = await import('/src/host/index.ts');
  // A seek before the main stream plays is lost.
  const ready = Date.now() + 60_000;
  while (Date.now() < ready && !Object.values(read().streams).some((s) => s.status === 'ready')) await new Promise((r) => setTimeout(r, 500));
  await host.playback.seek({ time });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && Math.abs(read().clock.timeSec - time) > 3) await new Promise((r) => setTimeout(r, 300));
  host.playback.pause();
}, at);
await page.waitForTimeout(4000);
const lapCount = await page.evaluate(async () => (await import('/src/host/index.ts')).read().sessionData.lapCount);
console.log(`lap count at the playhead: ${JSON.stringify(lapCount)}`);

await page.evaluate(async (items) => (await import('/src/host/index.ts')).host.suggestions.offer({ items }), items);
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(outDir, 'charts-strip.png') });
console.log(`saved ${path.join(outDir, 'charts-strip.png')}`);

await page.evaluate(async (items) => {
  const { host } = await import('/src/host/index.ts');
  host.suggestions.dismiss();
  host.layout.add({ items });
}, items);
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(outDir, 'charts-tiles.png') });
console.log(`saved ${path.join(outDir, 'charts-tiles.png')}`);

// Bigger: the charts alone, in a row.
await page.evaluate(async () => {
  const { host, read, tilesOf } = await import('/src/host/index.ts');
  host.layout.remove({ keys: tilesOf(read().layout).filter((t) => t.component.type === 'video').map((t) => t.component.key) });
});
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(outDir, 'charts-alone.png') });
console.log(`saved ${path.join(outDir, 'charts-alone.png')}`);

const messages = await page.evaluate(() => [...document.querySelectorAll('.chart-message')].map((m) => m.textContent));
console.log(`chart messages: ${messages.length ? messages.join(' | ') : 'none'}`);

// Each query at the end of the race, as the worker runs it.
const timings = await page.evaluate(
  async ({ key, pair }) => {
    const [{ SQL: tower }, { SQL: gap }, { sqlFor }] = await Promise.all([
      import('/src/components/charts/TimingTower.tsx'),
      import('/src/components/charts/GapEvolution.tsx'),
      import('/src/components/charts/TyreStrategy.tsx'),
    ]);
    const time = async (sql, params) => {
      const runs = [];
      let rows = 0;
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        rows = (await window.f1a.data.sql(key, Number.MAX_SAFE_INTEGER, sql, params)).rows.length;
        runs.push(performance.now() - started);
      }
      runs.sort((a, b) => a - b);
      return { medianMs: Math.round(runs[2] * 10) / 10, rows };
    };
    // The lap-based charts to come read lap_summary: five at once is the load to plan for.
    const lapSummary = {
      lap_summary_all: await time('SELECT * FROM lap_summary', []),
      one_driver_laps: await time('SELECT lap_number, lap_duration, compound, tyre_age, track_status FROM lap_summary WHERE driver_number = ? ORDER BY lap_number', [pair[0]]),
      position_and_gap_per_lap: await time('SELECT driver_number, lap_number, position, gap_to_leader FROM lap_summary ORDER BY lap_number, position', []),
      last_five_laps: await time('SELECT * FROM lap_summary WHERE lap_number > (SELECT MAX(lap_number) FROM laps) - 5', []),
    };
    return { timing_tower: await time(tower, []), gap_evolution: await time(gap, pair), tyre_strategy: await time(sqlFor(0), []), ...lapSummary };
  },
  { key: Number(sessionKey), pair },
);
console.log(`query times at the end of the race: ${JSON.stringify(timings)}`);

await page.evaluate(async () => (await import('/src/host/index.ts')).host.session.close());
await stop();
