// Checks the timing tower in the real app over a real replay race, muted: at its fit size beside the main
// feed, with two onboards on screen and their rows lifted by its drivers prop, and squeezed below its least size, where it
// keeps every column and lets its rows and columns run past the tile for the host to mark. Prints each
// tile's size, the size the tower draws at and the host's mark, and saves a screenshot of each.
//
// The app is launched on Hyprland on workspace 3, floating and without focus (elsewhere as an ordinary window), with its own user data
// (the F1 TV sign-in copied in), and driven over CDP. With --keep the app is left open where the last
// screenshot was taken, and the script keeps serving it until the app is closed.
// Usage: node scripts/tower-check.mjs <screenshot-dir> [lap] [race, by name: the latest replay race if none] [--keep]
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { MAIN_PROFILE, startElectron } from './platform.mjs';

const keep = process.argv.includes('--keep');
const args = process.argv.filter((a) => a !== '--keep');
const outDir = args[2];
if (!outDir) throw new Error('Usage: node scripts/tower-check.mjs <screenshot-dir> [lap]');
const targetLap = Number(args[3] ?? 39);
const raceName = args[4] ?? '';
mkdirSync(outDir, { recursive: true });
const userData = mkdtempSync(path.join(process.env.OMFV_SCRATCH ?? tmpdir(), 'omfv-tower-'));
for (const f of ['omfv-session.json', 'omfv-cookies.json']) copyFileSync(path.join(MAIN_PROFILE, f), path.join(userData, f));

const PORT = 5197;
const CDP = 9337;
const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
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

/** The tower tile's size, the canvas it draws on and the host's mark. */
const measure = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('.chart-canvas');
    const frame = canvas?.closest('.view-frame');
    const mark = frame?.parentElement?.querySelector('[data-testid=overflow-mark]');
    return {
      tile: frame && { width: frame.clientWidth, height: frame.clientHeight },
      drawn: canvas && { width: canvas.clientWidth, height: canvas.clientHeight },
      mark: mark ? mark.textContent.trim() : null,
    };
  });

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
    await page.evaluate(async ([width, height]) => {
      const { host, read, tilesOf } = await import('/src/host/index.ts');
      const t = tilesOf(read().layout).find((x) => x.component.type === 'timing_tower');
      const el = document.querySelector('.chart-canvas').closest('.view-frame');
      const cw = el.clientWidth / t.w;
      const chh = (el.clientHeight + 25) / t.h;
      host.layout.move({ tile: t.id, rect: { x: t.x, y: t.y, w: Math.max(1, Math.round(width / cw)), h: Math.max(1, Math.round(height / chh)) } });
    }, squeeze);
    await page.waitForTimeout(2500);
  }
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`${name}: ${JSON.stringify(await measure())} -> ${file}`);
}

const tower = { type: 'timing_tower', props: {} };
// The rows it lifts are the props' drivers; the onboards beside it no longer lift them.
const lifted = { type: 'timing_tower', props: { drivers: [3, 44] } };
const onboard = (n) => opened.feeds.find((f) => f.kind === 'onboard' && f.number === n);
const watched = [3, 44].map(onboard).filter(Boolean).map((f) => ({ type: 'video', props: { feed: f.id } }));
console.log(`onboards on screen: ${watched.map((w) => w.props.feed).join(', ') || 'none found'}`);

await shoot('1-beside-video', [tower]);
await shoot('2-with-onboards', [lifted, ...watched]);
await shoot('3-crowded', [lifted, ...watched, { type: 'gap_evolution', props: { driver_a: 3, driver_b: 44 } }, { type: 'tyre_strategy', props: {} }, { type: 'tyre_deg', props: {} }]);
// Below its least size: about 200 by 290, then narrow and tall, then wide and short.
await shoot('4-squeezed', [lifted, ...watched], [200, 290]);
await shoot('5-narrow', [lifted, ...watched], [240, 560]);
await shoot('6-short', [lifted, ...watched], [420, 300]);

if (keep) {
  console.log(`left open: user data in ${userData}. Serving it until the app is closed.`);
  page.on('close', () => done(0));
  browser.on('disconnected', () => done(0));
} else await done(0);
