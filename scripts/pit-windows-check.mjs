// Checks the pit windows table in the real app over a real replay race, muted: beside the main feed, with
// two onboards on screen and their rows lifted by its drivers prop, beside the timing tower, and squeezed below its least size,
// where it keeps every column and lets its rows and columns run past the tile for the host to mark. Prints
// each tile's size, the size the table draws at and the host's mark, and saves a screenshot of each.
//
// Launched as scripts/tower-check.mjs is: through Hyprland on workspace 3, floating and without focus, with
// its own user data (the F1 TV sign-in copied in), and driven over CDP.
// Usage: node scripts/pit-windows-check.mjs <screenshot-dir> [lap] [race, by name: the latest replay race if none] [--keep]
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const keep = process.argv.includes('--keep');
const args = process.argv.filter((a) => a !== '--keep');
const outDir = args[2];
if (!outDir) throw new Error('Usage: node scripts/pit-windows-check.mjs <screenshot-dir> [lap]');
const targetLap = Number(args[3] ?? 39);
const raceName = args[4] ?? '';
mkdirSync(outDir, { recursive: true });
const userData = mkdtempSync(path.join(process.env.F1A_SCRATCH ?? tmpdir(), 'f1a-pitwin-'));
for (const f of ['f1a-session.json', 'f1a-cookies.json']) copyFileSync(path.join(homedir(), '.config/f1a', f), path.join(userData, f));

const PORT = 5236;
const CDP = 9376;
const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
await server.listen();
const electronBin = path.resolve('node_modules/electron/dist/electron');
const cmd = `env -u CHROME_DESKTOP ELECTRON_START_URL=http://127.0.0.1:${PORT} ${electronBin} ${path.resolve('.')} --user-data-dir=${userData} --remote-debugging-port=${CDP}`;
execFileSync('hyprctl', ['eval', `hl.exec_cmd(${JSON.stringify(cmd)}, { workspace = "3 silent", float = true, size = "1600 900", no_initial_focus = true })`]);
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
await page.addStyleTag({ content: '@keyframes f1a-tick{to{opacity:.99}} body::after{content:"";position:fixed;width:1px;height:1px;animation:f1a-tick 1s infinite alternate}' });

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
  window.f1a.data.onStatus((s) => s.sessionStartSec != null && (start = s.sessionStartSec));
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

/** The pit windows canvas: the one whose nearest ancestor with a title names it, and no other tile. */
const FIND = `[...document.querySelectorAll('.chart-canvas')].find((c) => {
  for (let e = c.parentElement; e; e = e.parentElement) if (e.textContent.includes('Pit windows')) return !e.textContent.includes('Timing');
  return false;
})`;
/** The tile's size, the canvas it draws on and the host's mark. */
const measure = () =>
  page.evaluate((find) => {
    const canvas = eval(find);
    const frame = canvas?.closest('.view-frame');
    const mark = frame?.parentElement?.querySelector('[data-testid=overflow-mark]');
    return {
      tile: frame && { width: frame.clientWidth, height: frame.clientHeight },
      drawn: canvas && { width: canvas.clientWidth, height: canvas.clientHeight },
      mark: mark ? mark.textContent.trim() : null,
    };
  }, FIND);

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
    await page.evaluate(async ([width, height, find]) => {
      const { host, read, tilesOf } = await import('/src/host/index.ts');
      const t = tilesOf(read().layout).find((x) => x.component.type === 'pit_windows');
      const el = eval(find).closest('.view-frame');
      const cw = el.clientWidth / t.w;
      const chh = (el.clientHeight + 25) / t.h;
      host.layout.move({ tile: t.id, rect: { x: t.x, y: t.y, w: Math.max(1, Math.round(width / cw)), h: Math.max(1, Math.round(height / chh)) } });
    }, [...squeeze, FIND]);
    await page.waitForTimeout(2500);
  }
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`${name}: ${JSON.stringify(await measure())} -> ${file}`);
}

const windows = { type: 'pit_windows', props: {} };
// Its lifted rows are the props' drivers, here the cars whose onboards sit beside it.
const lifted = { type: 'pit_windows', props: { drivers: [44, 1] } };
const onboard = (n) => opened.feeds.find((f) => f.kind === 'onboard' && f.number === n);
const watched = [44, 1].map(onboard).filter(Boolean).map((f) => ({ type: 'video', props: { feed: f.id } }));
console.log(`onboards on screen: ${watched.map((w) => w.props.feed).join(', ') || 'none found'}`);

await shoot('1-beside-video', [windows]);
await shoot('2-with-onboards', [lifted, ...watched]);
await shoot('3-with-tower', [windows, { type: 'timing_tower', props: {} }]);
// Below its least size.
await shoot('4-squeezed', [lifted, ...watched], [260, 280]);

if (keep) {
  console.log(`left open: user data in ${userData}. Serving it until the app is closed.`);
  page.on('close', () => done(0));
  browser.on('disconnected', () => done(0));
} else await done(0);
