// Checks the race status board in the real app over a real replay race, muted, at moments picked by race
// control's own messages (a red flag, a safety car, a penalty owed): beside the main feed with the race
// control log and the timing tower, alone beside the feed, at its least size and squeezed below it, where it
// runs past the tile for the host to mark. Prints each tile's size, the size the board draws at and the
// host's mark, and saves a screenshot of each.
//
// Launched as scripts/tower-check.mjs is: through Hyprland on workspace 3, floating and without focus, with
// its own user data (the F1 TV sign-in copied in), and driven over CDP.
// Usage: node scripts/status-check.mjs <screenshot-dir> <race, by name> <message pattern>[,<pattern>...] [--keep]
//   e.g. node scripts/status-check.mjs shots mexico 'RACE WILL RESUME%,SAFETY CAR DEPLOYED'
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const keep = process.argv.includes('--keep');
const args = process.argv.filter((a) => a !== '--keep');
const outDir = args[2];
const raceName = args[3] ?? '';
const patterns = (args[4] ?? '').split(',').filter(Boolean);
if (!outDir || !patterns.length) throw new Error('Usage: node scripts/status-check.mjs <screenshot-dir> <race> <message pattern>[,...]');
mkdirSync(outDir, { recursive: true });
const userData = mkdtempSync(path.join(process.env.OMFV_SCRATCH ?? tmpdir(), 'omfv-status-'));
for (const f of ['omfv-session.json', 'omfv-cookies.json']) copyFileSync(path.join(homedir(), '.config/oh-my-f1-viewer', f), path.join(userData, f));

const PORT = 5229;
const CDP = 9369;
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

/** Seeks to a few seconds after the first message like `pattern`, as race control sent it. */
async function seekToMessage(pattern) {
  return page.evaluate(async (pattern) => {
    const { host, read } = await import('/src/host/index.ts');
    const ready = Date.now() + 60_000;
    while (Date.now() < ready && !Object.values(read().streams).some((s) => s.status === 'ready')) await new Promise((r) => setTimeout(r, 500));
    const {
      rows: [row],
    } = await host.data.sql({ sql: 'SELECT date, lap_number, message FROM race_control WHERE message LIKE ? ORDER BY date LIMIT 1', params: [pattern], asOf: 'session' });
    if (!row) return { error: `no message like ${pattern}` };
    host.playback.play();
    const landed = host.playback.seekToDate({ dateMs: row.date + 4000 });
    await new Promise((r) => setTimeout(r, 3000));
    host.playback.pause();
    return { lap: row.lap_number, message: row.message, landed };
  }, pattern);
}

/** The board's canvas: the one whose nearest ancestor with a title names it, and no other tile. */
const FIND = `[...document.querySelectorAll('.chart-canvas')].find((c) => {
  for (let e = c.parentElement; e; e = e.parentElement) if (e.textContent.includes('Race status')) return !e.textContent.includes('Race control') && !e.textContent.includes('Timing');
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
      const t = tilesOf(read().layout).find((x) => x.component.type === 'race_status');
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

const board = { type: 'race_status', props: {} };
let k = 0;
for (const event of ['unhandledRejection', 'uncaughtException'])
  process.on(event, async (e) => {
    console.log('FAIL', e);
    await done(1);
  });
for (const pattern of patterns) {
  const at = await seekToMessage(pattern);
  console.log(`at ${JSON.stringify(at)}`);
  if (at.error) continue;
  const tag = `${++k}-${raceName || 'race'}-lap${at.lap}`;
  await shoot(`${tag}-with-log`, [board, { type: 'race_control', props: {} }, { type: 'timing_tower', props: {} }]);
  await shoot(`${tag}-beside-video`, [board]);
}
// At its least size, and below it.
await shoot(`${k}-least`, [board], [300, 180]);
await shoot(`${k}-squeezed`, [board], [270, 170]);

if (keep) {
  console.log(`left open: user data in ${userData}. Serving it until the app is closed.`);
  page.on('close', () => done(0));
  browser.on('disconnected', () => done(0));
} else await done(0);
