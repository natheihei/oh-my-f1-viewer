// Checks tyre strategy in the real app over a real replay race, muted, at each lap asked for: beside the main feed,
// among other charts, at its least size, below it (where rows stop at 16px and run past the tile for the host to
// mark) and at its fit. Prints each tile's size, the size the chart draws at and the host's mark, saves a
// screenshot of the window and of the tile, and writes the rows the chart's query returns at each lap to data.json.
//
// The app is launched through Hyprland on workspace 3, floating and without focus, with its own user data
// (the F1 TV sign-in copied in), and driven over CDP on its own ports.
// Usage: node scripts/tyre-check.mjs <screenshot-dir> [laps, comma separated: 39,57] [race, by name: the latest replay race if none]
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const args = process.argv;
const outDir = args[2];
if (!outDir) throw new Error('Usage: node scripts/tyre-check.mjs <screenshot-dir> [laps] [race]');
const raceName = args[4] ?? '';
mkdirSync(outDir, { recursive: true });
const userData = mkdtempSync(path.join(process.env.F1A_SCRATCH ?? tmpdir(), 'f1a-tyres-'));
for (const f of ['f1a-session.json', 'f1a-cookies.json']) copyFileSync(path.join(homedir(), '.config/f1a', f), path.join(userData, f));

const PORT = 5214;
const CDP = 9354;
const server = await createServer({ cacheDir: path.join(userData, 'vite-cache'), server: { port: PORT, strictPort: true }, logLevel: 'error' });
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


async function gotoLap(lap) {
  let count = await seekTo(start + lap * 95);
  for (let i = 0; i < 5 && count?.current && count.current !== lap; i++) count = await seekTo(start + (lap - 0.5) * ((lap * 95) / count.current));
  console.log(`at lap ${JSON.stringify(count)}`);
  return count;
}
const measure = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('.chart-canvas');
    const frame = canvas?.closest('.view-frame');
    const mark = frame?.parentElement?.querySelector('[data-testid=overflow-mark]');
    return { tile: frame && { width: frame.clientWidth, height: frame.clientHeight }, drawn: canvas && { width: canvas.clientWidth, height: canvas.clientHeight }, mark: mark ? mark.textContent.trim() : null };
  });
async function layout(items) {
  await page.evaluate(async (items) => {
    const { host, read, tilesOf } = await import('/src/host/index.ts');
    host.layout.remove({ tiles: tilesOf(read().layout).filter((t) => t.component.type !== 'video' || !read().feeds.some((f) => f.id === t.component.props.feed && f.kind === 'main')).map((t) => t.id) });
    host.layout.add({ items });
    host.layout.autoLayout();
  }, items);
  await page.waitForTimeout(2500);
}
async function squeeze([width, height]) {
  await page.evaluate(async ([width, height]) => {
    const { host, read, tilesOf } = await import('/src/host/index.ts');
    const t = tilesOf(read().layout).find((x) => x.component.type === 'tyre_strategy');
    const el = document.querySelector('.chart-canvas').closest('.view-frame');
    const cw = el.clientWidth / t.w;
    const chh = (el.clientHeight + 25) / t.h;
    host.layout.move({ tile: t.id, rect: { x: t.x, y: t.y, w: Math.max(1, Math.round(width / cw)), h: Math.max(1, Math.round(height / chh)) } });
  }, [width, height]);
  await page.waitForTimeout(2500);
}
async function shot(name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  const tileShot = path.join(outDir, `${name}-tile.png`);
  const frame = await page.$('.chart-canvas');
  const box = await page.evaluate(() => { const f = document.querySelector('.chart-canvas')?.closest('.view-frame')?.parentElement; const r = f?.getBoundingClientRect(); return r && { x: r.x, y: r.y, width: r.width, height: r.height }; });
  if (box) await page.screenshot({ path: tileShot, clip: box });
  console.log(`${name}: ${JSON.stringify(await measure())} -> ${file}`);
}
const tyres = { type: 'tyre_strategy', props: {} };
const out = { title: opened.title, moments: {} };
const LAPS = (args[3] ?? '39,57').split(',').map(Number);
for (const lap of LAPS) {
  const count = await gotoLap(lap);
  const got = await page.evaluate(async () => {
    const { host, read } = await import('/src/host/index.ts');
    const { sqlFor } = await import('/src/components/charts/TyreStrategy.tsx');
    const r = await host.data.sql({ sql: sqlFor(0) });
    const sd = read().sessionData;
    return { rows: r.rows ?? r, lapCount: sd.lapCount, drivers: sd.drivers.map((d) => ({ n: d.driver_number, code: d.name_acronym, colour: d.team_colour, team: d.team_name })) };
  });
  out.moments[lap] = got;
  writeFileSync(path.join(outDir, 'data.json'), JSON.stringify(out));
  console.log(`lap ${lap}: ${(got.rows.length ?? 0)} rows`);
  {
    await layout([tyres]);
    await shot(`L${lap}-1-beside-video`);
    await layout([tyres, { type: 'timing_tower', props: {} }, { type: 'gap_evolution', props: { driver_a: 3, driver_b: 44 } }, { type: 'tyre_deg', props: {} }]);
    await shot(`L${lap}-2-crowded`);
    await layout([tyres]);
    await squeeze([364, 374]);
    await shot(`L${lap}-3-least`);
    await squeeze([380, 250]);
    await shot(`L${lap}-4-squeezed`);
    await squeeze([660, 520]);
    await shot(`L${lap}-5-fit`);
  }
}
writeFileSync(path.join(outDir, 'data.json'), JSON.stringify(out));
await done(0);
