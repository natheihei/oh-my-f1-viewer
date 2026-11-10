// Puts the charts on screen in the real app, over a real replay race, muted, and saves screenshots: at
// a moment in the race and again near its end, each group of charts first as previews in the
// suggestion strip, then as tiles beside the main feed and the timing tower. Also times each chart's
// query at the end of the race. Needs the F1 TV sign-in; it stops if that has expired.
// Usage: node scripts/charts-check.mjs <screenshot-dir> [sessionKey] [year] [laps, such as 20,40] [groups, such as pit]
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { startApp } from './harness.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/charts-check.mjs <screenshot-dir> [sessionKey] [year] [laps] [groups]');
const [sessionKey, year] = [String(process.argv[3] ?? 11396), Number(process.argv[4] ?? 2026)];
const targetLaps = String(process.argv[5] ?? 30).split(',').map(Number);
const only = process.argv[6]?.split(',') ?? null;
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
const tower = { type: 'timing_tower', props: {} };
// A few at a time, so tiles are the size they'd be on screen. The tower stays beside them to check against.
// A front-runner for the pit window: whoever runs second at the first moment shot, kept after that.
let front = null;
const allGroups = {
  pit: () => [{ type: 'pit_window', props: { drivers: [front] } }],
  basics: [
    { type: 'gap_evolution', props: { drivers: pair } },
    { type: 'tyre_strategy', props: {} },
  ],
  race: [
    { type: 'race_trace', props: {} },
    { type: 'position_chart', props: { drivers: pair } },
  ],
  pace: [
    { type: 'lap_time_compare', props: { drivers: pair } },
    { type: 'stint_pace', props: {} },
  ],
  tyres: [
    { type: 'tyre_degradation', props: {} },
    { type: 'race_trace', props: { drivers: pair } },
  ],
};
const groups = Object.fromEntries(Object.entries(allGroups).filter(([name]) => !only || only.includes(name)));

/** Seeks the replay to `time` and pauses there. Returns the lap count it shows. */
async function seekTo(time) {
  await page.evaluate(async (time) => {
    const { host, read } = await import('/src/host/index.ts');
    // A seek before the main stream plays is lost.
    const ready = Date.now() + 60_000;
    while (Date.now() < ready && !Object.values(read().streams).some((s) => s.status === 'ready')) await new Promise((r) => setTimeout(r, 500));
    host.playback.play();
    await host.playback.seek({ time });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && Math.abs(read().clock.timeSec - time) > 3) await new Promise((r) => setTimeout(r, 300));
    host.playback.pause();
  }, time);
  await page.waitForTimeout(4000);
  return page.evaluate(async () => (await import('/src/host/index.ts')).read().sessionData.lapCount);
}

/** Each group as a strip of previews, then as tiles; the tiles are taken off again after. */
async function shoot(moment) {
  if (front === null) {
    front = await page.evaluate(async () => {
      const { host } = await import('/src/host/index.ts');
      const { rows } = await host.data.sql({ sql: 'SELECT driver_number FROM lap_summary WHERE position = 2 ORDER BY lap_number DESC LIMIT 1' });
      return rows[0]?.driver_number ?? null;
    });
    console.log(`pit window for car ${front}`);
  }
  for (const [name, group] of Object.entries(groups)) {
    const items = typeof group === 'function' ? group() : group;
    await page.evaluate(async (items) => {
      const { host } = await import('/src/host/index.ts');
      host.suggestions.newTurn();
      host.suggestions.offer({ items });
    }, items);
    await page.waitForTimeout(2500);
    const strip = path.join(outDir, `${moment}-${name}-strip.png`);
    await page.screenshot({ path: strip });
    await page.evaluate(async (items) => {
      const { host } = await import('/src/host/index.ts');
      host.suggestions.newTurn();
      host.layout.add({ items });
    }, [tower, ...items]);
    await page.waitForTimeout(3000);
    const tiles = path.join(outDir, `${moment}-${name}-tiles.png`);
    await page.screenshot({ path: tiles });
    const messages = await page.evaluate(() => [...document.querySelectorAll('.chart-message')].map((m) => m.textContent));
    console.log(`saved ${strip} and ${tiles}; chart messages: ${messages.length ? messages.join(' | ') : 'none'}`);
    if (name === 'pit') {
      // The palette covers the bottom of the tile, where the panel goes: once more without it.
      const palette = page.locator('[data-testid=palette]');
      await palette.evaluate((el) => (el.style.visibility = 'hidden'));
      await page.screenshot({ path: path.join(outDir, `${moment}-${name}-tiles-no-palette.png`) });
      await palette.evaluate((el) => (el.style.visibility = ''));
      // What the ring shows, in numbers, beside the tower's gaps, to check by hand.
      const check = await page.evaluate(async (driver) => {
        const { host, read } = await import('/src/host/index.ts');
        const pit = await import('/src/components/charts/PitWindow.tsx');
        const tower = await import('/src/components/charts/TimingTower.tsx');
        const circuit = read().circuit;
        const m = pit.pitWindowModel((await host.data.sql({ sql: pit.SQL })).rows, driver, circuit.state === 'ready' ? circuit.pitLoss.normal : null);
        const gaps = tower.towerModel((await host.data.sql({ sql: tower.SQL })).rows).map((r) => `${r.position}:${r.driver} ${r.gap}`);
        return { circuit: circuit.state === 'ready' ? `${circuit.name}, pit loss ${circuit.pitLoss.normal}` : circuit.state, lapTime: m.lapTime, from: m.from, out: m.out, tower: gaps.join(' | ') };
      }, front);
      console.log(`pit window: ${JSON.stringify(check)}`);
    }
    await page.evaluate(async () => {
      const { host, read, tilesOf } = await import('/src/host/index.ts');
      host.layout.remove({ keys: tilesOf(read().layout).filter((t) => t.component.type !== 'video').map((t) => t.component.key) });
    });
  }
}

// Lap times run about 1.5 minutes: aim, then correct from the lap the data shows.
const start = opened.start ?? 600;
let count = null;
let perLap = 90;
for (const targetLap of targetLaps) {
  count = await seekTo(start + targetLap * perLap);
  if (count?.current) count = await seekTo(start + ((targetLap - 0.5) * (targetLap * perLap)) / count.current);
  console.log(`at lap ${JSON.stringify(count)}`);
  if (count?.current) perLap = (await page.evaluate(async () => (await import('/src/host/index.ts')).read().clock.timeSec) - start) / count.current;
  await shoot(`lap${count?.current ?? targetLap}`);
}

if (count?.total) {
  const late = await seekTo(start + (count.total - 1.5) * perLap);
  console.log(`near the end: ${JSON.stringify(late)}`);
  await shoot(`lap${late?.current ?? 'end'}`);
}

// Each query at the end of the race, as the worker runs it.
const timings = await page.evaluate(
  async ({ key, pair }) => {
    const [tower, gap, tyres, trace, positions, compare, deg, pace, pit] = await Promise.all(
      ['TimingTower', 'GapEvolution', 'TyreStrategy', 'RaceTrace', 'PositionChart', 'LapTimeCompare', 'TyreDegradation', 'StintPace', 'PitWindow'].map(
        (name) => import(`/src/components/charts/${name}.tsx`),
      ),
    );
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
    return {
      timing_tower: await time(tower.SQL, []),
      gap_evolution: await time(gap.SQL, pair),
      tyre_strategy: await time(tyres.sqlFor(0), []),
      race_trace: await time(trace.SQL, []),
      position_chart: await time(positions.SQL, []),
      lap_time_compare: await time(compare.sqlFor(2), pair),
      tyre_degradation_top3: await time(deg.sqlFor(0), []),
      tyre_degradation_pair: await time(deg.sqlFor(2), pair),
      stint_pace: await time(pace.SQL, []),
      pit_window: await time(pit.SQL, []),
    };
  },
  { key: Number(sessionKey), pair },
);
console.log(`query times at the end of the race: ${JSON.stringify(timings, null, 1)}`);

await page.evaluate(async () => (await import('/src/host/index.ts')).host.session.close());
await stop();
