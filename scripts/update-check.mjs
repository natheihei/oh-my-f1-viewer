// Updates an AppImage from one release to the next, end to end, the way an installed one does (electron/updates.ts):
// it packages two releases whose feed is a server on localhost, serves the newer one as the latest release, runs the
// older one on an isolated profile, and checks that the palette says the newer one is ready, that quitting installs
// it over the AppImage, and that the next start says it updated. Linux only; needs `npm run build` first.
// See docs/RELEASE.md.
//
// Usage: npm run build && node scripts/update-check.mjs <output-dir>
import { execFileSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { startElectron } from './platform.mjs';
import { prepareProfile, profileInUse } from './isolated.mjs';

if (process.platform !== 'linux') throw new Error('The update check runs the AppImage, so it needs Linux.');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = process.argv[2] && path.resolve(process.argv[2]);
if (!outDir) throw new Error('Usage: node scripts/update-check.mjs <output-dir>');
mkdirSync(outDir, { recursive: true });

const OLD = '20261120.1';
const NEW = '20261120.2';

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

// Both releases, each fed from this server.
const feedPort = await freePort();
const feed = `http://127.0.0.1:${feedPort}`;
const pack = (release) => {
  const dir = path.join(outDir, `build-${release}`);
  console.log(`packaging ${release} into ${dir}…`);
  execFileSync(
    'npx',
    ['electron-builder', '--linux', 'AppImage', '--publish', 'never', `-c.extraMetadata.version=${release}.0`, `-c.publish.url=${feed}`, `-c.directories.output=${dir}`],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return dir;
};
const oldBuild = pack(OLD);
const newBuild = pack(NEW);
const appImage = (dir) => readdirSync(dir).find((f) => f.endsWith('.AppImage'));

// The newer release is the latest: its latest-linux.yml and AppImage.
const served = [];
const server = createServer((req, res) => {
  const file = path.join(newBuild, path.basename(decodeURIComponent(new URL(req.url, feed).pathname)));
  served.push(path.basename(file));
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-length': statSync(file).size });
  createReadStream(file).pipe(res);
}).listen(feedPort, '127.0.0.1');

// The older release, installed where an AppImage would be.
const apps = mkdtempSync(path.join(outDir, 'apps-'));
const installed = path.join(apps, appImage(oldBuild));
copyFileSync(path.join(oldBuild, appImage(oldBuild)), installed);
const userData = prepareProfile(mkdtempSync(path.join(outDir, 'user-data-')));
if (profileInUse(userData)) throw new Error(`Another OMFV is using ${userData}.`);

const ownPids = () => {
  try {
    return execFileSync('pgrep', ['-f', '--', `--user-data-dir=${userData}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').map(Number).filter(Boolean);
  } catch {
    return [];
  }
};
const lines = (page) => page.locator('.palette-history .palette-text').allInnerTexts();

/** Starts the AppImage at `bin`, and returns its page once the palette is up. */
async function start(bin, log) {
  const cdpPort = await freePort();
  // Its own config and cache homes too: the download waits in the cache, and whatever the AppImage starts after
  // installing never reaches the main profile.
  startElectron([`--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`], { bin, log, env: { XDG_CONFIG_HOME: path.join(outDir, 'config'), XDG_CACHE_HOME: path.join(outDir, 'cache') } });
  const browser = await until('The app never opened its devtools port', () => chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`));
  const page = await until('The app window never loaded', async () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('file:')));
  await page.waitForSelector('[data-testid=palette]', { timeout: 60_000 });
  // A hidden workspace's window stops drawing once nothing moves on it, and screenshots time out.
  await page.addStyleTag({ content: '@keyframes tick{to{opacity:.99}}#tick{position:fixed;left:0;top:0;width:1px;height:1px;animation:tick 1s infinite alternate;pointer-events:none}' });
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="tick"></div>'));
  return { browser, page };
}

let browser = null;
try {
  console.log(`${installed}\n  feed ${feed}, user data in ${userData}`);
  let page;
  ({ browser, page } = await start(installed, path.join(outDir, 'old.log')));
  check('the older release runs', (await page.evaluate(() => window.omfv.app.version())).release === OLD);

  // The first check is a minute after start, then the download.
  const ready = await until(`${NEW} never became ready`, async () => (await lines(page)).find((l) => l.includes(`OMFV ${NEW} is ready`)), 240_000).catch((e) => e.message);
  check('the palette says the newer release is ready', ready === `OMFV ${NEW} is ready. It automatically installs next time you start oh-my-f1-viewer.`, ready);
  await page.screenshot({ path: path.join(outDir, 'ready.png') });

  // Quit as a viewer does: closing the window.
  await page.evaluate(() => window.close()).catch(() => {});
  await browser.close().catch(() => {});
  browser = null;
  await until('The app never quit', async () => ownPids().length === 0, 30_000);
  const after = await until('No AppImage was installed', async () => {
    const files = readdirSync(apps).filter((f) => f.endsWith('.AppImage'));
    return files.length === 1 && files[0] !== path.basename(installed) ? files : null;
  }, 30_000).catch(() => readdirSync(apps));
  check('quitting installed the newer AppImage in its place', after.length === 1 && after[0] === appImage(newBuild), after.join(', '));

  ({ browser, page } = await start(path.join(apps, after[0]), path.join(outDir, 'new.log')));
  check('the next start is the newer release', (await page.evaluate(() => window.omfv.app.version())).release === NEW);
  const updated = await until('No line said it updated', async () => (await lines(page)).find((l) => l.startsWith('Updated to')), 15_000).catch((e) => e.message);
  check('the palette says it updated', updated === `Updated to OMFV ${NEW}. /whats-new lists what changed.`, updated);
  await page.screenshot({ path: path.join(outDir, 'updated.png') });
  console.log(`  served: ${[...new Set(served)].join(', ')}`);
} catch (e) {
  check('the check ran', false, e.message);
} finally {
  await browser?.close().catch(() => {});
  for (const pid of ownPids()) {
    try {
      process.kill(pid);
    } catch {}
  }
  server.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
