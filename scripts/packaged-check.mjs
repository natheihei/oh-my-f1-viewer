// Runs a packaged OMFV, the way a release installs it, and checks what packaging can break: the app loads from
// app.asar, says which release it is, decrypts the F1 TV and agent logins copied into its profile, compiles a mod
// with the esbuild unpacked beside app.asar, copies the declarations and components the build agent reads, has the
// Widevine CDM, and plays a session. Runs on an isolated profile like the other checks (see isolated.mjs). Needs both sign-ins.
// See docs/RELEASE.md.
//
// Usage: npm run dist && node scripts/packaged-check.mjs <screenshot-dir> [app]
//   app: the packaged executable, an AppImage, or an installed /opt/oh-my-f1-viewer/oh-my-f1-viewer.
//        Defaults to what `npm run dist` left in release/ for this platform.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { ON_HYPRLAND, startElectron } from './platform.mjs';
import { prepareProfile, profileInUse, syncAgentLogin } from './isolated.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = process.argv[2] && path.resolve(process.argv[2]);
if (!outDir) throw new Error('Usage: node scripts/packaged-check.mjs <screenshot-dir> [app]');
mkdirSync(outDir, { recursive: true });

const DEFAULT_APP = {
  linux: path.join(root, 'release', 'linux-unpacked', 'oh-my-f1-viewer'),
  darwin: path.join(root, 'release', 'mac-arm64', 'oh-my-f1-viewer.app', 'Contents', 'MacOS', 'oh-my-f1-viewer'),
}[process.platform];
const bin = path.resolve(process.argv[3] ?? DEFAULT_APP ?? '');
if (!existsSync(bin)) throw new Error(`No packaged app at ${bin}: run npm run dist first, or name one.`);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = netServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const until = async (what, ok, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await ok().catch(() => null);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(what);
};

const userData = prepareProfile(mkdtempSync(path.join(outDir, 'user-data-')), { agent: true });
if (profileInUse(userData)) throw new Error(`Another OMFV is using ${userData}.`);
// Muted from the start: the volume is the renderer's saved state.
const settingsFile = path.join(userData, 'omfv-settings.json');
const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
writeFileSync(settingsFile, JSON.stringify({ ...settings, ui: { ...settings.ui, volume: { level: 0, lastHeard: 1 } } }, null, 2));
// A mod for the packaged esbuild to compile, there before the app starts.
cpSync(path.join(root, 'examples', 'mods', 'lap_form'), path.join(userData, 'mods', 'lap_form'), { recursive: true });

const cdpPort = await freePort();
const mainLog = path.join(outDir, 'main.log');
const child = startElectron([`--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`], { bin, log: mainLog });
console.log(`${bin}\n  devtools on ${cdpPort}, user data in ${userData}, output in ${mainLog}`);

const ownPids = () => {
  try {
    return execFileSync('pgrep', ['-f', '--', `--user-data-dir=${userData}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').map(Number).filter(Boolean);
  } catch {
    return [];
  }
};

let browser = null;
const stop = async () => {
  await browser?.close().catch(() => {});
  for (const pid of ownPids()) {
    try {
      process.kill(pid);
    } catch {}
  }
  child?.kill();
  await until('The app never exited', async () => ownPids().length === 0, 15_000).catch(() => {});
  syncAgentLogin(userData);
};

try {
  browser = await until('The app never opened its devtools port', () => chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`));
  const page = await until('The app window never loaded', async () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('file:')));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.waitForSelector('[data-testid=palette]', { timeout: 60_000 });

  if (ON_HYPRLAND) {
    const pids = new Set(ownPids());
    const mine = JSON.parse(execFileSync('hyprctl', ['clients', '-j']).toString()).find((c) => pids.has(c.pid));
    console.log(mine ? `  window on workspace ${mine.workspace.name}, focused: ${mine.focusHistoryID === 0}, class ${mine.class}` : '  window not found in hyprctl clients');
  }
  // A hidden workspace's window stops drawing once nothing moves on it, and screenshots time out.
  await page.addStyleTag({ content: '@keyframes tick{to{opacity:.99}}#tick{position:fixed;left:0;top:0;width:1px;height:1px;animation:tick 1s infinite alternate;pointer-events:none}' });
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="tick"></div>'));

  check('loads from app.asar', page.url().includes('/app.asar/'), page.url());

  const version = await page.evaluate(() => window.omfv.app.version());
  check('packaged', version.packaged, JSON.stringify(version));
  console.log(`  release: ${version.release ?? 'none (a build made by hand)'}`);

  const f1tv = await page.evaluate(() => window.omfv.f1tv.status());
  check("F1 TV's copied sign-in decrypts", f1tv.signedIn, JSON.stringify(f1tv));
  const ai = await page.evaluate(() => window.omfv.ai.status());
  check("the agent's copied login decrypts", ai.ready, ai.modelName ?? '');

  const mods = path.join(userData, 'mods');
  const installed = existsSync(path.join(mods, '.installed', 'builtin')) ? readdirSync(path.join(mods, '.installed', 'builtin')) : [];
  check('components copied for the build agent', installed.length > 0, installed.join(', '));
  check('declarations copied for the build agent', existsSync(path.join(mods, '.types')));
  const mod = await until('lap_form never compiled', async () => {
    const m = (await page.evaluate(() => window.omfv.mods.list())).find((x) => x.name === 'lap_form');
    return m && m.state !== 'loading' ? m : null;
  }).catch(() => null);
  check('a mod compiles and loads', mod?.state === 'ready' && mod.version > 0, JSON.stringify(mod && { state: mod.state, version: mod.version, error: mod.error }));

  // Widevine, from castLabs' build: most replays aren't encrypted, so playing one doesn't show it.
  const widevine = await page.evaluate(() =>
    navigator
      .requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }])
      .then((a) => a.keySystem)
      .catch((e) => `unavailable: ${e.message}`),
  );
  check('the Widevine CDM is there', widevine === 'com.widevine.alpha', widevine);

  // `/version`, in the palette.
  const input = page.locator('[data-testid=palette-input]');
  if (!(await input.isVisible())) await page.keyboard.press('Control+Shift+P');
  await input.fill('/version');
  await input.press('Enter');
  const said = await until('/version said nothing', async () => {
    // Other lines may come after it, such as "Ready."
    const lines = await page.locator('.palette-system .palette-text').allInnerTexts();
    return lines.map((l) => l.trim()).find((l) => l.startsWith('OMFV')) ?? null;
  }, 10_000).catch((e) => e.message);
  check('/version names it', said === (version.release ? `OMFV ${version.release}.` : 'OMFV, built by hand: not a release.'), said);
  await page.screenshot({ path: path.join(outDir, 'version.png') });

  // Playback, through the agent like a viewer: the session's name in the palette.
  await input.fill('2025 Mexico qualifying');
  await input.press('Enter');
  const video = page.locator('video.stream-video').first();
  const played = await until(
    'no video played',
    async () => {
      const q = await video.evaluate((v) => ({ t: +v.currentTime.toFixed(1), ready: v.readyState, frames: v.getVideoPlaybackQuality().totalVideoFrames }));
      return q.frames > 30 && q.ready >= 3 ? q : null;
    },
    120_000,
  ).catch((e) => ({ error: e.message }));
  check('video plays', !played.error, JSON.stringify(played));
  await page.keyboard.press('Control+Shift+P').catch(() => {});
  await page.screenshot({ path: path.join(outDir, 'packaged.png') });
  console.log(`  screenshot: ${path.join(outDir, 'packaged.png')}`);
} catch (e) {
  check('the check ran', false, e.message);
} finally {
  await stop();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
