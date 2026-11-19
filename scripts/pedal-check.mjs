// Checks the pedal barcode in the real app over a real replay race, muted, once its telemetry has loaded:
// at its fit beside the main feed and a driver's onboard, with no driver named, at its least size, and
// squeezed below it, where it draws the cells alone. Prints each tile's size and the host's mark, and saves
// a screenshot of each.
//
// The app is launched on Hyprland on workspace 3, floating and without focus (elsewhere as an ordinary window), with its own user data
// (the F1 TV sign-in copied in), and driven over CDP. With --keep the app is left open where the last
// screenshot was taken, and the script keeps serving it until the app is closed.
// Usage: node scripts/pedal-check.mjs <screenshot-dir> [lap] [race, by name: the latest replay race if none] [car] [--keep]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { MAIN_PROFILE, startElectron } from './platform.mjs';

const keep = process.argv.includes('--keep');
const args = process.argv.filter((a) => a !== '--keep');
const outDir = args[2];
if (!outDir) throw new Error('Usage: node scripts/pedal-check.mjs <screenshot-dir> [lap] [race] [car]');
const targetLap = Number(args[3] ?? 39);
const raceName = args[4] ?? '';
const car = Number(args[5] ?? 3);
mkdirSync(outDir, { recursive: true });
const userData = mkdtempSync(path.join(process.env.OMFV_SCRATCH ?? tmpdir(), 'omfv-pedals-'));
// The F1 TV sign-in, and the agent's if there is one.
for (const f of ['omfv-session.json', 'omfv-cookies.json', 'omfv-ai-credentials.json']) {
  const from = path.join(MAIN_PROFILE, f);
  if (existsSync(from)) copyFileSync(from, path.join(userData, f));
}

const PORT = Number(process.env.OMFV_VITE_PORT ?? 5231);
const CDP = Number(process.env.OMFV_CDP_PORT ?? 9371);
const server = await createServer({ server: { port: PORT, strictPort: true }, cacheDir: path.join(userData, 'vite'), logLevel: 'error' });
await server.listen();
startElectron([path.resolve('.'), `--user-data-dir=${userData}`, `--remote-debugging-port=${CDP}`], { env: { ELECTRON_START_URL: `http://127.0.0.1:${PORT}` } });
let browser;
for (let i = 0; i < 120 && !browser; i++) {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`).catch(() => null);
  if (!browser) await new Promise((r) => setTimeout(r, 500));
}
if (!browser) throw new Error('the app did not open its debugging port');
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
  // Its own copy of the logins and caches: nearly 200 MB a run.
  rmSync(userData, { recursive: true, force: true });
  process.exit(code);
};

const opened = await page.evaluate(async (raceName) => {
  const { host, read } = await import('/src/host/index.ts');
  if (!(await host.account.status()).f1tv.signedIn) return { error: 'F1 TV is not signed in' };
  host.audio.setVolume({ volume: 0 });
  let start = null;
  window.omfv.data.onStatus((s) => s.sessionStartSec != null && (start = s.sessionStartSec));
  const events = (await host.catalog.events({ year: 2026 })).filter((e) => e.endMs < Date.now() && !e.isTest).reverse();
  let race = null;
  for (const e of events) {
    race = (await host.catalog.sessions({ pageId: e.pageId, year: 2026 })).find((s) => s.type === 'race' && `${e.name} ${e.shortName} ${s.title}`.toLowerCase().includes(raceName.toLowerCase()));
    if (race) break;
  }
  if (!race) return { error: `no replay race matching "${raceName}"` };
  await host.session.open({ contentId: race.contentId, title: race.title });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && read().sessionData.state !== 'ready') await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 1500));
  return { title: `${race.title} (${race.sessionKey})`, start, feeds: read().feeds.map((f) => ({ id: f.id, kind: f.kind, number: f.number, label: f.label })) };
}, raceName);
if (opened.error) {
  console.log('FAIL', opened.error);
  await done(1);
}
console.log(`opened ${opened.title}`);

const telemetry = await page.evaluate(async () => {
  const { read } = await import('/src/host/index.ts');
  const deadline = Date.now() + 300_000;
  const state = () => read().sessionData.datasets?.telemetry.state;
  while (Date.now() < deadline && state() !== 'complete') await new Promise((r) => setTimeout(r, 1000));
  return state();
});
if (telemetry !== 'complete') {
  console.log('FAIL telemetry is', telemetry);
  await done(1);
}
console.log('telemetry loaded');

async function seekTo(time) {
  await page.evaluate(async (time) => {
    const { host, read } = await import('/src/host/index.ts');
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
const start = opened.start ?? 600;
let count = await seekTo(start + targetLap * 95);
if (count?.current && count.current !== targetLap) count = await seekTo(start + (targetLap - 0.5) * ((targetLap * 95) / count.current));
console.log(`at lap ${JSON.stringify(count)}`);

/** The pedal tile's size, the canvas it draws on and the host's mark. */
const measure = () =>
  page.evaluate(async (FRAME) => {
    const frame = await eval(FRAME);
    const canvas = frame?.querySelector('.chart-canvas');
    const mark = frame?.parentElement?.querySelector('[data-testid=overflow-mark]');
    return {
      tile: frame && { width: frame.clientWidth, height: frame.clientHeight },
      drawn: canvas && { width: canvas.clientWidth, height: canvas.clientHeight },
      mark: mark ? mark.textContent.trim() : null,
    };
  }, FRAME);

// The pedal tile's frame. Views are drawn in a stage over the grid, so it's the frame just under the tile's
// title bar, which carries the tile's id. Run in the page.
const FRAME = `(async () => {
  const { read, tilesOf } = await import('/src/host/index.ts');
  const t = tilesOf(read().layout).find((x) => x.component.type === 'pedal_barcode');
  const bar = t && document.querySelector('.tile-titlebar[data-tile-id="' + t.id + '"]');
  if (!bar) return null;
  const b = bar.getBoundingClientRect();
  return [...document.querySelectorAll('.view-frame')].find((f) => {
    const r = f.getBoundingClientRect();
    return Math.abs(r.left - b.left) < 4 && Math.abs(r.top - b.bottom) < 6;
  }) ?? null;
})()`;

async function shoot(name, items, squeeze) {
  await page.evaluate(async (items) => {
    const { host, read, tilesOf } = await import('/src/host/index.ts');
    host.layout.remove({ tiles: tilesOf(read().layout).filter((t) => t.component.type !== 'video' || !read().feeds.some((f) => f.id === t.component.props.feed && f.kind === 'main')).map((t) => t.id) });
    host.layout.add({ items });
    host.layout.autoLayout();
  }, items);
  await page.waitForTimeout(2500);
  if (squeeze) {
    // By hand, to about this many pixels.
    await page.evaluate(async ([width, height, FRAME]) => {
      const { host, read, tilesOf } = await import('/src/host/index.ts');
      const t = tilesOf(read().layout).find((x) => x.component.type === 'pedal_barcode');
      const el = await eval(FRAME);
      const cw = el.clientWidth / t.w;
      const chh = (el.clientHeight + 25) / t.h;
      host.layout.move({ tile: t.id, rect: { x: t.x, y: t.y, w: Math.max(1, Math.round(width / cw)), h: Math.max(1, Math.round(height / chh)) } });
    }, [...squeeze, FRAME]);
    await page.waitForTimeout(2500);
  }
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`${name}: ${JSON.stringify(await measure())} -> ${file}`);
}

const pedals = (driver) => ({ type: 'pedal_barcode', props: { driver } });
const onboard = opened.feeds.find((f) => f.kind === 'onboard' && f.number === car);
const watched = onboard ? [{ type: 'video', props: { feed: onboard.id } }] : [];
console.log(`onboard on screen: ${onboard?.id ?? 'none found'}`);

await shoot('1-fit', [pedals(car), ...watched]);
await shoot('2-with-telemetry', [pedals(car), { type: 'car_telemetry', props: { driver: car } }, { type: 'timing_tower', props: { drivers: [car] } }]);
// The grid rounds to its cells: these land at the least size, 300 by 150, or just over it.
await shoot('3-least', [pedals(car), ...watched], [300, 175]);
await shoot('4-squeezed', [pedals(car), ...watched], [220, 100]);

if (keep) {
  console.log(`left open: user data in ${userData}. Serving it until the app is closed.`);
  page.on('close', () => done(0));
  browser.on('disconnected', () => done(0));
} else await done(0);
