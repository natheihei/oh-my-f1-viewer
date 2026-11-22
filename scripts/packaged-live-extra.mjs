// Run during a live session, against a packaged OMFV: build mode's look_at with DRM video on screen, then quitting
// mid-session and starting again on the same profile, where the capture is rebuilt and the time closed is a gap.
// Reads the page and `window.omfv` only. Prints tool names, states and row counts, never the agent's words.
//
// Usage: node scripts/packaged-live-extra.mjs <output-dir> [app]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { startElectron } from './platform.mjs';
import { prepareProfile, syncAgentLogin } from './isolated.mjs';

const outDir = process.argv[2] && path.resolve(process.argv[2]);
if (!outDir) throw new Error('Usage: node scripts/packaged-live-extra.mjs <output-dir> [app]');
mkdirSync(outDir, { recursive: true });
const bin = path.resolve(process.argv[3] ?? '/Applications/oh-my-f1-viewer.app/Contents/MacOS/oh-my-f1-viewer');
if (!existsSync(bin)) throw new Error(`No packaged app at ${bin}.`);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};
const freePort = () =>
  new Promise((resolve) => {
    const s = netServer();
    s.unref();
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
const settingsFile = path.join(userData, 'omfv-settings.json');
const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
writeFileSync(settingsFile, JSON.stringify({ ...settings, ui: { ...settings.ui, volume: { level: 0, lastHeard: 1 } } }, null, 2));
const ownPids = () => {
  try {
    return execFileSync('pgrep', ['-f', '--', `--user-data-dir=${userData}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').map(Number).filter(Boolean);
  } catch {
    return [];
  }
};

/** Starts the app on the profile and opens the live session through the agent. */
async function launch() {
  const cdpPort = await freePort();
  startElectron([`--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`], { bin, log: path.join(outDir, 'main.log') });
  const browser = await until('The app never opened its devtools port', () => chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`));
  const page = await until('The app window never loaded', async () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('file:')));
  await page.waitForSelector('[data-testid=palette]', { timeout: 60_000 });
  await page.evaluate(() => {
    window.events = [];
    window.omfv.ai.onEvent((e) => window.events.push(e));
    window.lastStatus = null;
    window.omfv.data.onStatus((s) => { window.lastStatus = s; });
  });
  const input = page.locator('[data-testid=palette-input]');
  const say = async (text, ms = 120_000) => {
    console.log(`> ${text}`);
    await page.evaluate(() => { window.events.length = 0; });
    if (!(await input.isVisible())) await page.keyboard.press('Control+K');
    await input.fill(text);
    await input.press('Enter');
    await page.waitForFunction(() => window.events.some((e) => e.type === 'turn_end' || e.type === 'error'), null, { timeout: ms }).catch(() => console.log('  the turn did not end in time'));
    const events = await page.evaluate(() => window.events);
    const starts = events.filter((e) => e.type === 'tool_start');
    const ends = events.filter((e) => e.type === 'tool_end');
    console.log('  tools:', starts.map((c, i) => `${c.name}${ends[i]?.ok === false ? '(failed)' : ''}`).join(' ') || 'none');
    const err = events.find((e) => e.type === 'error');
    if (err) console.log('  ERROR', err.message);
    return { starts, ends, events };
  };
  const stop = async () => {
    await browser.close().catch(() => {});
    for (const pid of ownPids()) {
      try {
        process.kill(pid);
      } catch {}
    }
    await until('The app never exited', async () => ownPids().length === 0, 15_000).catch(() => {});
  };
  const live = await page.evaluate(() => window.omfv.f1tv.liveNow());
  check('F1 TV reports something live', live.length > 0);
  await say('Open the session that is live now.');
  const playing = await until('no live video played', async () => page.evaluate(() => {
    const v = document.querySelector('video.stream-video');
    return v && v.getVideoPlaybackQuality().totalVideoFrames > 30 && !!v.mediaKeys;
  }), 90_000).catch(() => false);
  check('the live session plays under DRM', !!playing);
  const status = await until('the data never got ready', async () => {
    const st = await page.evaluate(() => window.lastStatus);
    return st?.state === 'ready' ? st : null;
  }, 180_000).catch(() => null);
  const rows = status
    ? await page.evaluate(async (key) => (await window.omfv.data.sql(key, Number.MAX_SAFE_INTEGER, 'SELECT (SELECT COUNT(*) FROM position) + (SELECT COUNT(*) FROM race_control) + (SELECT COUNT(*) FROM car_data) + (SELECT COUNT(*) FROM weather) AS n', [])).rows[0].n, status.sessionKey)
    : null;
  const earliest = status
    ? await page.evaluate(async (key) => (await window.omfv.data.sql(key, Number.MAX_SAFE_INTEGER, 'SELECT MIN(date) AS d FROM car_data', [])).rows[0].d, status.sessionKey)
    : null;
  return { page, say, stop, status, rows, earliest };
}

try {
  // First run: the capture, then build mode over DRM video.
  let app = await launch();
  const first = { rows: app.rows, coverage: app.status?.coverage, earliest: app.earliest };
  console.log('capture:', JSON.stringify({ state: app.status?.state, source: first.coverage?.source, capturedFrom: first.coverage?.capturedFrom, gaps: first.coverage?.gaps?.length, rows: first.rows }));
  check('live data reaches the database', first.coverage?.source === 'live' && first.rows > 0);

  const built = await app.say('/build a tile that shows the words "look test" in big white text on a blue background. Then look at it with look_at to check it draws, and say only "done".', 360_000);
  const tag = await app.page.locator('[data-testid=build-tag]').count();
  check('build mode opened on a live session', tag > 0);
  const looks = built.starts.map((c, i) => ({ name: c.name, ok: built.ends[i]?.ok })).filter((c) => c.name === 'look_at');
  check('the build agent called look_at', looks.length > 0, `${looks.length} call(s)`);
  check('look_at returned a picture with DRM video on screen', looks.some((c) => c.ok !== false), looks.map((c) => (c.ok === false ? 'failed' : 'ok')).join(' '));
  const lookEnds = built.events.filter((e) => e.type === 'tool_end' && e.name === 'look_at');
  for (const e of lookEnds) console.log('  look_at:', JSON.stringify(e).slice(0, 300));
  await app.page.screenshot({ path: path.join(outDir, 'build-live.png'), timeout: 10_000 }).catch(() => {});
  const undo = app.page.locator('[data-testid=build-undo]');
  if (await undo.count()) await undo.click().catch(() => {});
  await app.page.waitForTimeout(3000);

  // Quit mid-session, stay closed for a while, and start again on the same profile.
  const closedAt = Date.now();
  await app.stop();
  await new Promise((r) => setTimeout(r, 30_000));
  app = await launch();
  const closedFor = (Date.now() - closedAt) / 1000;
  const second = { rows: app.rows, coverage: app.status?.coverage, earliest: app.earliest };
  console.log(`after ${closedFor.toFixed(0)}s closed:`, JSON.stringify({ state: app.status?.state, source: second.coverage?.source, capturedFrom: second.coverage?.capturedFrom, gaps: second.coverage?.gaps, rows: second.rows }));
  check('the tables were rebuilt from what the first run kept', second.rows >= first.rows && second.earliest === first.earliest, `${first.rows} rows before, ${second.rows} after; earliest telemetry ${first.earliest} / ${second.earliest}`);
  check('the capture still starts where the first run joined', second.coverage?.capturedFrom === first.coverage?.capturedFrom);
  check('the time closed is recorded as a gap', (second.coverage?.gaps?.length ?? 0) > (first.coverage?.gaps?.length ?? 0));
  await app.stop();
} catch (e) {
  check('the check ran', false, e.message);
  for (const pid of ownPids()) {
    try {
      process.kill(pid);
    } catch {}
  }
} finally {
  syncAgentLogin(userData);
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
