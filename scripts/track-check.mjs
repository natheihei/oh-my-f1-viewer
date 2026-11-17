// Checks the track map in the real app over a real replay race, muted: the pack on lap 2, the busiest moment of the
// pit stops with nobody pinned and with two drivers pinned, the name under the pointer, a click that pins a car and
// one that unpins it, and the map at its fit, its least size and squeezed below it. Prints each tile's size, the size
// the chart draws at and the host's mark, and saves a screenshot of each.
//
// The app is launched through Hyprland on workspace 3, floating and without focus, with its own user data
// (the F1 TV sign-in copied in), and driven over CDP. It waits for the session's telemetry to load.
// Run `npm run build:electron` first in a fresh checkout.
// Usage: node scripts/track-check.mjs <screenshot-dir> [session key] [vite port] [cdp port]
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/track-check.mjs <screenshot-dir> [session key] [vite port] [cdp port]');
const SESSION = String(process.argv[3] ?? 11412);
const PORT = Number(process.argv[4] ?? 5221);
const CDP = Number(process.argv[5] ?? 9361);
mkdirSync(outDir, { recursive: true });
const scratch = process.env.OMFV_SCRATCH ?? tmpdir();
const userData = mkdtempSync(path.join(scratch, 'omfv-track-'));
for (const f of ['omfv-session.json', 'omfv-cookies.json']) copyFileSync(path.join(homedir(), '.config/oh-my-f1-viewer', f), path.join(userData, f));

const server = await createServer({ server: { port: PORT, strictPort: true }, cacheDir: path.join(userData, 'vite'), logLevel: 'error' });
await server.listen();
const electronBin = path.resolve('node_modules/electron/dist/electron');
const cmd = `env -u CHROME_DESKTOP ELECTRON_START_URL=http://127.0.0.1:${PORT} ${electronBin} ${path.resolve('.')} --user-data-dir=${userData} --remote-debugging-port=${CDP}`;
execFileSync('hyprctl', ['eval', `hl.exec_cmd(${JSON.stringify(cmd)}, { workspace = "3 silent", float = true, size = "1600 900", no_initial_focus = true })`]);
let browser;
for (let i = 0; i < 120 && !browser; i++) {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`).catch(() => null);
  if (!browser) await new Promise((r) => setTimeout(r, 500));
}
if (!browser) throw new Error('the app did not open its debugging port: is dist-electron built?');
let page;
for (let i = 0; i < 120 && !page; i++) {
  page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(`http://127.0.0.1:${PORT}`));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.waitForSelector('[data-testid=palette]', { timeout: 60_000 });
// A hidden workspace stops producing frames once nothing moves: a tiny animation keeps screenshots working.
await page.addStyleTag({ content: '@keyframes omfv-tick{to{opacity:.99}} body::after{content:"";position:fixed;width:1px;height:1px;animation:omfv-tick 1s infinite alternate}' });

const done = async (code = 0) => {
  await page.evaluate(async () => (await import('/src/host/index.ts')).host.session.close()).catch(() => {});
  await browser.close().catch(() => {});
  try {
    execFileSync('pkill', ['-f', '--', `user-data-dir=${userData}`]);
  } catch {}
  await server.close();
  // Its own user data, the cache and video included, which runs to gigabytes.
  await new Promise((r) => setTimeout(r, 1000));
  rmSync(userData, { recursive: true, force: true });
  process.exit(code);
};

// A step that throws still closes the app it opened.
process.on('uncaughtException', (e) => {
  console.log('FAIL', e.message);
  void done(1);
});

const opened = await page.evaluate(async (sessionKey) => {
  const { host, read } = await import('/src/host/index.ts');
  if (!(await host.account.status()).f1tv.signedIn) return { error: 'F1 TV is not signed in' };
  host.audio.setVolume({ volume: 0 });
  const events = (await host.catalog.events({ year: 2026 })).filter((e) => e.endMs < Date.now() && !e.isTest).reverse();
  let race = null;
  for (const e of events) {
    race = (await host.catalog.sessions({ pageId: e.pageId, year: 2026 })).find((s) => s.type === 'race' && s.sessionKey === sessionKey);
    if (race) break;
  }
  if (!race) return { error: `no replay race with session key ${sessionKey}` };
  await host.session.open({ contentId: race.contentId, title: race.title });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && read().sessionData.state !== 'ready') await new Promise((r) => setTimeout(r, 500));
  const loaded = Date.now() + 420_000;
  while (Date.now() < loaded && read().sessionData.datasets?.telemetry.state !== 'complete') await new Promise((r) => setTimeout(r, 1000));
  // The circuit's outline comes from MultiViewer, apart from the session's data.
  const drawn = Date.now() + 60_000;
  while (Date.now() < drawn && read().circuit.state !== 'ready') await new Promise((r) => setTimeout(r, 500));
  if (read().circuit.state !== 'ready') return { error: `the circuit is ${JSON.stringify(read().circuit).slice(0, 200)}` };
  return { title: race.title, telemetry: read().sessionData.datasets?.telemetry.state, feeds: read().feeds.map((f) => ({ id: f.id, kind: f.kind, number: f.number })) };
}, SESSION);
if (opened.error || opened.telemetry !== 'complete') {
  console.log('FAIL', opened.error ?? `telemetry is ${opened.telemetry}`);
  await done(1);
}
console.log(`opened ${opened.title}`);

/** Lap 2, 30 s in: the field still in a pack. And the busiest moment of the stops: the stop with the most others within 20 s. */
const moments = await page.evaluate(async () => {
  const { host } = await import('/src/host/index.ts');
  const q = async (sql) => (await host.data.sql({ sql, params: [], asOf: 'session' })).rows;
  const [lap2] = await q('SELECT MIN(date_start) AS at FROM laps WHERE lap_number = 2');
  const stops = (await q('SELECT date FROM pit WHERE date IS NOT NULL ORDER BY date')).map((r) => r.date);
  const busiest = stops.reduce((best, d) => {
    const near = stops.filter((e) => Math.abs(e - d) <= 20_000).length;
    return near > best.near ? { at: d, near } : best;
  }, { at: stops[0], near: 0 });
  return { pack: lap2.at + 30_000, stops: busiest.at, near: busiest.near };
});
console.log(`moments: ${JSON.stringify(moments)}`);

async function seekToMs(ms) {
  await page.evaluate(async (ms) => {
    const { host, read } = await import('/src/host/index.ts');
    const ready = Date.now() + 60_000;
    while (Date.now() < ready && !Object.values(read().streams).some((s) => s.status === 'ready')) await new Promise((r) => setTimeout(r, 500));
    // Video seconds from the playhead's milliseconds, by the offset between the two now.
    const time = read().clock.timeSec + (ms - read().sessionData.playheadMs) / 1000;
    host.playback.play();
    await host.playback.seek({ time });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && Math.abs(read().clock.timeSec - time) > 3) await new Promise((r) => setTimeout(r, 300));
    host.playback.pause();
  }, ms);
  await page.waitForTimeout(4000);
  return page.evaluate(async () => (await import('/src/host/index.ts')).read().sessionData.lapCount);
}

const measure = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.chart-canvas')].map((canvas) => {
      const frame = canvas.closest('.view-frame');
      const mark = frame?.parentElement?.querySelector('[data-testid=overflow-mark]');
      return { tile: frame && [frame.clientWidth, frame.clientHeight], drawn: [canvas.clientWidth, canvas.clientHeight], mark: mark ? mark.textContent.trim() : null };
    }),
  );

/** The whole window, and the track tile alone, title bar and all, as `<name>.png` and `<name>-tile.png`. */
async function capture(name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  const box = await page.evaluate(() => {
    const r = document.querySelector('.chart-canvas')?.closest('.stage-host')?.getBoundingClientRect();
    return r && { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (box) await page.screenshot({ path: path.join(outDir, `${name}-tile.png`), clip: box });
}

/** Puts `items` on screen beside the main feed, or with `alone` on their own, and squeezes the map to about `squeeze` pixels. */
async function shoot(name, items, squeeze, alone = false) {
  await page.evaluate(async ([items, alone]) => {
    const { host, read, tilesOf } = await import('/src/host/index.ts');
    host.layout.remove({ tiles: tilesOf(read().layout).filter((t) => alone || t.component.type !== 'video' || !read().feeds.some((f) => f.id === t.component.props.feed && f.kind === 'main')).map((t) => t.id) });
    host.layout.add({ items });
    host.layout.autoLayout();
  }, [items, alone]);
  await page.waitForTimeout(2500);
  if (squeeze) {
    // By hand, to about this many pixels.
    await page.evaluate(async ([width, height]) => {
      const { host, read, tilesOf } = await import('/src/host/index.ts');
      const t = tilesOf(read().layout).find((x) => x.component.type === 'track_map');
      // The only chart on screen here.
      const el = document.querySelector('.chart-canvas').closest('.view-frame');
      const cw = el.clientWidth / t.w;
      const chh = (el.clientHeight + 25) / t.h;
      host.layout.move({ tile: t.id, rect: { x: t.x, y: t.y, w: Math.max(1, Math.round(width / cw)), h: Math.max(1, Math.round(height / chh)) } });
    }, squeeze);
    await page.waitForTimeout(2500);
  }
  await capture(name);
  console.log(`${name}: ${JSON.stringify(await measure())}`);
}


/** Where a car's dot is on screen, by the draw's own fit: the outline turned and fitted inside 16px of padding. */
const dotOf = (driver) =>
  page.evaluate(async (driver) => {
    const { host, read } = await import('/src/host/index.ts');
    const { fitOutline } = await import('/src/kit/index.ts');
    const { rows } = await host.data.sql({ sql: 'SELECT x, y, MAX(date) FROM location WHERE driver_number = ?1 AND date > ?2 - 5000 AND date <= ?2', params: [driver, read().sessionData.playheadMs] });
    const { outline, rotation } = read().circuit;
    const canvas = document.querySelector('.chart-canvas');
    const r = canvas.getBoundingClientRect();
    const [x, y] = fitOutline(outline, rotation, { left: 16, top: 16, width: r.width - 32, height: r.height - 32 })(rows[0].x, rows[0].y);
    return { x: r.left + x, y: r.top + y };
  }, driver);

/** The track tile's key, which a click must leave as it is. */
const trackKey = () => page.evaluate(async () => {
  const { read, tilesOf } = await import('/src/host/index.ts');
  return tilesOf(read().layout).find((t) => t.component.type === 'track_map')?.component.key;
});

const all = { type: 'track_map', props: {} };
console.log(`pack, lap ${JSON.stringify(await seekToMs(moments.pack))}`);
await shoot('1-pack', [all]);
console.log(`stops, lap ${JSON.stringify(await seekToMs(moments.stops))}`);
await shoot('2-stops', [all]);
// The pit lane the map draws: whose stop, how many positions, and how far off the line it runs at most and at its ends, in metres.
console.log(`lane: ${JSON.stringify(await page.evaluate(async () => {
  const { host, read } = await import('/src/host/index.ts');
  const { STOP_SQL, LANE_SQL, lanePath } = await import('/src/components/track_map/main.tsx');
  const [stop] = (await host.data.sql({ sql: STOP_SQL })).rows;
  if (!stop) return null;
  const { rows } = await host.data.sql({ sql: LANE_SQL, params: [stop.driver_number, stop.date, stop.lane_duration * 1000] });
  const lane = lanePath(rows, read().circuit.outline);
  const m = (u) => Math.round(u / 10);
  return { car: stop.driver_number, positions: rows.length, lane: lane.length, most: m(Math.max(...lane.map((p) => p.off))), ends: [m(lane[0]?.off), m(lane.at(-1)?.off)] };
}))}`);
const { rows: order } = await page.evaluate(async () => {
  const { host } = await import('/src/host/index.ts');
  return host.data.sql({ sql: 'SELECT driver_number, position, MAX(date) FROM position GROUP BY driver_number ORDER BY position' });
});
const [first, second, third] = order.map((r) => r.driver_number);
await shoot('3-pinned', [{ type: 'track_map', props: { drivers: [first, second] } }]);
// The name under the pointer, then a click that chooses that car, and another that drops it.
const dot = await dotOf(third);
await page.mouse.move(dot.x, dot.y);
await page.waitForTimeout(800);
await capture('4-pointer');
await page.mouse.click(dot.x, dot.y);
await page.waitForTimeout(1500);
const added = await trackKey();
await page.mouse.move(dot.x, dot.y + 1);
await page.waitForTimeout(800);
await capture('5-clicked');
await page.mouse.click(dot.x, dot.y + 1);
await page.waitForTimeout(1500);
const dropped = await trackKey();
console.log(`click on ${third}: the tile is ${added}, then ${dropped}`);
// A driver from the props is pinned for good: a click on one leaves it, and its name says it's pinned.
const fixedDot = await dotOf(first);
await page.mouse.click(fixedDot.x, fixedDot.y);
await page.waitForTimeout(1500);
await capture('5b-fixed');
await page.mouse.move(5, 5);
// On its own, so the tile can grow to its fit without another tile in the way.
await shoot('6-fit', [all], null, true);
await shoot('7-least', [all], [360, 260]);
await shoot('8-squeezed', [all], [300, 200]);
// A click changes the map's own state, not the tile: its key stays the one it was added with.
await done(added === `track_map:${first}-${second}` && dropped === added ? 0 : 1);
