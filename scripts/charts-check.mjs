// Puts the charts on screen in the real app, over a real replay race, muted, and saves screenshots: at
// a moment in the race and again near its end, each group of charts first as previews in the
// suggestion strip, then as tiles beside the main feed and the timing tower. Also times each chart's
// query at the end of the race. Needs the F1 TV sign-in; it stops if that has expired. The telemetry group
// waits for the session's telemetry to finish loading first.
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
    window.omfv.data.onStatus((status) => {
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
  pit: () => [{ type: 'pit_window', props: { driver: front } }],
  basics: [
    { type: 'gap_evolution', props: { driver_a: pair[0], driver_b: pair[1] } },
    { type: 'tyre_strategy', props: {} },
  ],
  deg: [
    { type: 'tyre_deg', props: {} },
  ],
  small: [
    { type: 'sector_table', props: { driver_a: pair[0], driver_b: pair[1] } },
    { type: 'race_control', props: {} },
    { type: 'race_status', props: {} },
  ],
  telemetry: [
    { type: 'track_map', props: { drivers: pair } },
    { type: 'car_telemetry', props: { driver: pair[0] } },
  ],
};
const groups = Object.fromEntries(Object.entries(allGroups).filter(([name]) => !only || only.includes(name)));

if (groups.telemetry) {
  const telemetry = await page.evaluate(async () => {
    const { read } = await import('/src/host/index.ts');
    const deadline = Date.now() + 300_000;
    const state = () => read().sessionData.datasets?.telemetry.state;
    while (Date.now() < deadline && state() !== 'complete') await new Promise((r) => setTimeout(r, 1000));
    return state();
  });
  if (telemetry !== 'complete') await fail(`Telemetry is ${telemetry}`);
  console.log('telemetry loaded');
}

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
        const pit = await import('/src/kit/index.ts');
        const tower = await import('/src/components/timing_tower/main.tsx');
        const circuit = read().circuit;
        const m = pit.pitWindowModel((await host.data.sql({ sql: pit.PIT_WINDOW_SQL })).rows, driver, circuit.state === 'ready' ? circuit.pitLoss.normal : null);
        const gaps = tower.towerModel((await host.data.sql({ sql: tower.SQL })).rows).map((r) => `${r.position}:${r.driver} ${r.gap}`);
        return { circuit: circuit.state === 'ready' ? `${circuit.name}, pit loss ${circuit.pitLoss.normal}` : circuit.state, lapTime: m.lapTime, from: m.from, out: m.out, tower: gaps.join(' | ') };
      }, front);
      console.log(`pit window: ${JSON.stringify(check)}`);
    }
    if (name === 'small') {
      // The gap chart's sides and the sectors in numbers, beside the tower's rows for the pair, to check by hand.
      const check = await page.evaluate(async (pair) => {
        const { host, read } = await import('/src/host/index.ts');
        const gap = await import('/src/components/gap_evolution/main.tsx');
        const tower = await import('/src/components/timing_tower/main.tsx');
        const sectors = await import('/src/components/sector_table/main.tsx');
        const { points: _points, ...b } = gap.gapModel((await host.data.sql({ sql: gap.SQL, params: pair })).rows, pair);
        const s = sectors.sectorTable((await host.data.sql({ sql: sectors.SQL, params: pair })).rows, pair);
        const t = tower.towerModel((await host.data.sql({ sql: tower.SQL })).rows).filter((r) => pair.includes(r.driver));
        return { gap: b, sectors: { laps: s.rows.map((r) => `${r.lap}${r.skip ? ` ${r.skip}` : ''}`), averages: s.averages, counted: s.counted }, tower: t };
      }, pair);
      console.log(`small: ${JSON.stringify(check)}`);
    }
    if (name === 'telemetry') {
      // Cars in order round the lap from the timing line, by the outline point nearest each, beside the
      // tower, to check by hand.
      const check = await page.evaluate(async () => {
        const { host, read } = await import('/src/host/index.ts');
        const map = await import('/src/components/track_map/main.tsx');
        const tower = await import('/src/components/timing_tower/main.tsx');
        const { playheadMs } = read().sessionData;
        const circuit = read().circuit;
        const cars = map.trackModel((await host.data.sql({ sql: map.SQL, params: [playheadMs] })).rows);
        const { x, y } = circuit.outline;
        const along = (car) => {
          let best = 0;
          x.forEach((_, i) => (Math.hypot(x[i] - car.x, y[i] - car.y) < Math.hypot(x[best] - car.x, y[best] - car.y) ? (best = i) : null));
          return { driver: car.driver, at: Math.round((best / x.length) * 1000) / 10, off: Math.round(Math.hypot(x[best] - car.x, y[best] - car.y)) };
        };
        const road = cars.map(along).sort((a, b) => b.at - a.at);
        const gaps = tower.towerModel((await host.data.sql({ sql: tower.SQL })).rows).map((r) => `${r.position}:${r.driver} ${r.gap}`);
        return { road: road.map((c) => `${c.driver}@${c.at}%${c.off > 150 ? ` off ${c.off}` : ''}`).join(' '), tower: gaps.join(' | ') };
      });
      console.log(`telemetry: ${JSON.stringify(check)}`);
    }
    await page.evaluate(async () => {
      const { host, read, tilesOf } = await import('/src/host/index.ts');
      host.layout.remove({ tiles: tilesOf(read().layout).filter((t) => t.component.type !== 'video').map((t) => t.id) });
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

// Each query at the end of the race, as the worker runs it. The telemetry queries are bounded by the
// playhead, so they're timed at the frame on screen there, as they'd run.
const timings = await page.evaluate(
  async ({ key, pair }) => {
    const { read } = await import('/src/host/index.ts');
    const playhead = read().sessionData.playheadMs ?? Number.MAX_SAFE_INTEGER;
    const [tower, gap, tyres, deg, pit, sectors, control] = await Promise.all(
      [
        'timing_tower', 'gap_evolution', 'tyre_strategy', 'tyre_deg', '../kit',
        'sector_table', 'race_control',
      ].map((name) => import(name === '../kit' ? '/src/kit/index.ts' : `/src/components/${name}/main.tsx`)),
    );
    const time = async (sql, params, at = Number.MAX_SAFE_INTEGER) => {
      const runs = [];
      let rows = 0;
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        rows = (await window.omfv.data.sql(key, at, sql, params)).rows.length;
        runs.push(performance.now() - started);
      }
      runs.sort((a, b) => a - b);
      return { medianMs: Math.round(runs[2] * 10) / 10, rows };
    };
    return {
      timing_tower: await time(tower.SQL, []),
      gap_evolution: await time(gap.SQL, pair),
      tyre_strategy: await time(tyres.sqlFor(0), []),
      tyre_deg: await time(deg.SQL, []),
      pit_window: await time(pit.PIT_WINDOW_SQL, []),
      sector_table: await time(sectors.SQL, pair),
      race_control: await time(control.SQL, []),
      ...(await (async () => {
        const [map, live] = await Promise.all(['track_map', 'car_telemetry'].map((name) => import(`/src/components/${name}/main.tsx`)));
        return {
          track_map: await time(map.SQL, [playhead], playhead),
          car_telemetry: await time(live.SQL, [pair[0], playhead], playhead),
        };
      })()),
    };
  },
  { key: Number(sessionKey), pair },
);
console.log(`query times at the end of the race: ${JSON.stringify(timings, null, 1)}`);

await page.evaluate(async () => (await import('/src/host/index.ts')).host.session.close());
await stop();
