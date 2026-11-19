// Runs an OMFV of its own for checks and screenshots, apart from any other OMFV on the machine: a fresh
// user data dir with copies of what it needs from the main profile (see prepareProfile), its own Vite and
// devtools ports, and on Hyprland it opens silently on workspace 3 and never takes focus; elsewhere it opens as usual. Driven over
// the devtools protocol, since Playwright's own Electron launch would spawn the window where it pleases.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createServer as netServer } from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { MAIN_PROFILE, ON_HYPRLAND, startElectron } from './platform.mjs';

export { MAIN_PROFILE };

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** A free TCP port on localhost. */
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


/** Whether an OMFV is running on a user data dir: its single-instance lock names a live process. */
export function profileInUse(dir) {
  try {
    const pid = Number(readlinkSync(path.join(dir, 'SingletonLock')).split('-').at(-1));
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const CREDENTIALS = 'omfv-credentials.json';
const SETTINGS = 'omfv-settings.json';
/** The agent's login as each prepared profile got it, to tell whether a run refreshed it. */
const copiedLogins = new Map();

const readOrNull = (file) => (existsSync(file) ? readFileSync(file) : null);

/** Merges `values` into the settings file of profile `dir`, at the top level. */
function writeSettings(dir, values) {
  const file = path.join(dir, SETTINGS);
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  writeFileSync(file, JSON.stringify({ ...settings, ...values }, null, 2));
}

/**
 * Makes `dir` a profile for a run: copies of the F1 TV login and the DRM module from the main profile, and with
 * `agent`, of the agent's login and its settings too (not the rest of the settings: the run's volume and
 * background start from the defaults). The originals are never moved. The agent's login is written back after
 * the run if it was refreshed: see syncAgentLogin. Onboarding is marked finished, since a profile without the agent's
 * login would show it over the empty screen and every tile a check puts there: `onboarding` keeps it. Returns `dir`.
 */
export function prepareProfile(dir, { agent = false, onboarding = false } = {}) {
  mkdirSync(dir, { recursive: true });
  for (const file of ['omfv-session.json', 'omfv-cookies.json']) {
    if (existsSync(path.join(MAIN_PROFILE, file))) copyFileSync(path.join(MAIN_PROFILE, file), path.join(dir, file));
  }
  // The DRM module, so the fresh dir doesn't fetch it again before the video can play.
  if (existsSync(path.join(MAIN_PROFILE, 'WidevineCdm'))) cpSync(path.join(MAIN_PROFILE, 'WidevineCdm'), path.join(dir, 'WidevineCdm'), { recursive: true });
  if (agent) {
    // Encrypted with the OS keystore, which works the same for any profile of this app on this machine.
    const login = readOrNull(path.join(MAIN_PROFILE, CREDENTIALS));
    if (login) {
      writeFileSync(path.join(dir, CREDENTIALS), login, { mode: 0o600 });
      copiedLogins.set(dir, login);
    }
    let settings = {};
    try {
      settings = JSON.parse(readFileSync(path.join(MAIN_PROFILE, SETTINGS), 'utf8'));
    } catch {}
    if (settings.agent) writeSettings(dir, { agent: settings.agent });
  }
  if (!onboarding) writeSettings(dir, { ui: { onboarded: true } });
  return dir;
}

/**
 * A sign-in like ChatGPT's refreshes its token when it expires, and the refresh token can change with it, which
 * leaves the one in the main profile no longer valid. So once a run's app has quit, a login it refreshed is
 * written back there, unless something changed that one meanwhile, such as an OMFV running on it.
 */
export function syncAgentLogin(dir, log = console.log) {
  const copied = copiedLogins.get(dir);
  if (!copied) return;
  const now = readOrNull(path.join(dir, CREDENTIALS));
  if (!now || now.equals(copied)) return;
  const main = path.join(MAIN_PROFILE, CREDENTIALS);
  if (!readOrNull(main)?.equals(copied)) {
    log(`the agent's login was refreshed here, but ${main} changed meanwhile, so it was left as it is`);
    return;
  }
  const next = `${main}.${process.pid}.tmp`;
  writeFileSync(next, now, { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, main);
  copiedLogins.set(dir, now);
  log(`the agent's login was refreshed, so it was written back to ${main}`);
}

/**
 * Starts the app from the source, served by Vite, on a fresh profile in `outDir`, or on `userData` when a run
 * prepared one to launch more than once. The page gets 1600×900 CSS pixels, the room the charts are designed in,
 * at `scale` device pixels each so a shot stays sharp. Returns the page, `log`, `userData` (the user data dir it
 * runs on), and `stop`, which closes only this instance.
 *
 * `agent` copies in the agent's login and settings, for runs with the real model, and `onboarding` keeps onboarding: see prepareProfile.
 */
export async function startIsolatedApp(outDir, { name = 'isolated', scale = 1.5, agent = false, onboarding = false, userData: given = null, inspect = false } = {}) {
  const log = (...a) => console.log(`[${name}]`, ...a);
  // A user data dir of its own, so the single-instance lock, window state, mods and timing.sqlite are apart.
  const userData = given ?? prepareProfile(mkdtempSync(path.join(outDir, 'user-data-')), { agent, onboarding });
  if (profileInUse(userData)) throw new Error(`Another OMFV is using ${userData}.`);

  const vitePort = await freePort();
  const cdpPort = await freePort();
  const inspectPort = inspect ? await freePort() : null;
  const server = await createServer({
    root,
    cacheDir: path.join(outDir, 'vite-cache'),
    server: { host: '127.0.0.1', port: vitePort, strictPort: true, fs: { strict: false } },
    logLevel: 'error',
  });
  await server.listen();
  log(`vite on ${vitePort}, devtools on ${cdpPort}, user data in ${userData}`);

  const [width, height] = [1600 * scale, 900 * scale];
  const electronArgs = [
    ...(inspectPort ? [`--inspect=127.0.0.1:${inspectPort}`] : []),
    root,
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${cdpPort}`,
    `--force-device-scale-factor=${scale}`,
  ];
  // The main process's own output: why a renderer went, what the agent and mods did.
  const mainLog = path.join(outDir, 'main.log');
  const child = startElectron(electronArgs, { env: { ELECTRON_START_URL: `http://127.0.0.1:${vitePort}` }, width, height, log: mainLog });

  /** This instance's electron pids, found by its user data dir. */
  const ownPids = () => {
    try {
      return execFileSync('pgrep', ['-f', '--', `--user-data-dir=${userData}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').map(Number).filter(Boolean);
    } catch {
      return [];
    }
  };

  const browser = await until('The app never opened its devtools port', () => chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`));
  const page = await until('The app window never loaded', async () =>
    browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(`http://127.0.0.1:${vitePort}`)),
  );
  page.on('pageerror', (e) => log('[pageerror]', e.message));
  page.on('crash', () => log('[crash] the renderer went: see main.log'));
  await page.waitForSelector('[data-testid=palette]', { timeout: 60_000 });
  const main = inspectPort ? await mainProcess(inspectPort) : null;

  const stop = async () => {
    main?.close();
    await browser.close().catch(() => {});
    for (const pid of ownPids()) {
      try {
        process.kill(pid);
      } catch {}
    }
    child?.kill();
    await server.close();
    await until('The app never exited', async () => ownPids().length === 0, 15_000).catch(() => {});
    syncAgentLogin(userData, log);
  };

  if (ON_HYPRLAND) {
    const pids = new Set(ownPids());
    const clients = JSON.parse(execFileSync('hyprctl', ['clients', '-j']).toString());
    const mine = clients.find((c) => pids.has(c.pid));
    log(mine ? `window on workspace ${mine.workspace.name}, focused: ${mine.focusHistoryID === 0}` : 'window not found in hyprctl clients');
  }

  // A hidden workspace's window stops drawing once nothing moves on it, and screenshots time out.
  await page.addStyleTag({ content: '@keyframes isolated-tick{to{opacity:.99}}#isolated-tick{position:fixed;left:0;top:0;width:1px;height:1px;animation:isolated-tick 1s infinite alternate;pointer-events:none}' });
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="isolated-tick"></div>'));

  return { page, log, stop, userData, evaluate: main?.evaluate ?? null };
}

/**
 * The main process, over its Node inspector (`--inspect`). `evaluate(fn, arg)` runs `fn(electron, arg)` there and
 * returns what it resolves to, like Playwright's `ElectronApplication.evaluate`: `fn` is sent as source, so it
 * can't close over anything, and `arg` and the result must be JSON.
 */
async function mainProcess(port) {
  const targets = await until('The main process never opened its inspector', async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("The main process's inspector refused the connection"));
  });
  let last = 0;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  };
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++last;
      waiting.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    evaluate: async (fn, arg) => {
      const expression = `(${fn})(process.mainModule.require('electron'), ${JSON.stringify(arg) ?? 'undefined'})`;
      const { result, error } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (error) throw new Error(error.message);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    close: () => socket.close(),
  };
}

/**
 * Opens a replay race, muted: the one with `sessionKey`, or the latest. Waits for its data, and for
 * telemetry and the circuit when asked. Returns its title, key, the video time of lights out and the roster.
 */
export async function openRace(page, { sessionKey = null, year = 2026, telemetry = false } = {}) {
  const opened = await page.evaluate(
    async ({ sessionKey, year }) => {
      const { host, read } = await import('/src/host/index.ts');
      if (!(await host.account.status()).f1tv.signedIn) return { error: 'F1 TV is not signed in in the main profile: sign in in the app, then run this again.' };
      host.audio.setVolume({ volume: 0 });
      let start = null;
      window.omfv.data.onStatus((status) => {
        if (status.sessionStartSec != null) start = status.sessionStartSec;
      });
      const events = (await host.catalog.events({ year })).filter((e) => e.endMs < Date.now() && !e.isTest).reverse();
      let race = null;
      for (const e of events) {
        race = (await host.catalog.sessions({ pageId: e.pageId, year })).find((s) => s.type === 'race' && (sessionKey == null ? s.sessionKey != null : s.sessionKey === sessionKey));
        if (race) break;
      }
      if (!race) return { error: sessionKey == null ? `No replay race in ${year}` : `No replay race with session key ${sessionKey} in ${year}` };
      await host.session.open({ contentId: race.contentId, title: race.title });
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline && read().sessionData.state !== 'ready') await new Promise((r) => setTimeout(r, 500));
      const data = read().sessionData;
      return { title: race.title, sessionKey: race.sessionKey, state: data.state, start, drivers: data.drivers?.map((d) => d.driver_number) ?? [] };
    },
    { sessionKey, year },
  );
  if (opened.error || opened.state !== 'ready') throw new Error(opened.error ?? `Session data is ${opened.state}`);
  if (telemetry) {
    const state = await page.evaluate(async () => {
      const { read } = await import('/src/host/index.ts');
      const deadline = Date.now() + 300_000;
      const state = () => read().sessionData.datasets?.telemetry.state;
      while (Date.now() < deadline && state() !== 'complete') await new Promise((r) => setTimeout(r, 1000));
      return state();
    });
    if (state !== 'complete') console.log(`telemetry is ${state}: the charts that need it may be waiting`);
  }
  // The circuit (outline, corners, pit loss) loads on its own: the charts that draw it wait for it.
  opened.circuit = await page.evaluate(async () => {
    const { read } = await import('/src/host/index.ts');
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && ['idle', 'loading'].includes(read().circuit.state)) await new Promise((r) => setTimeout(r, 500));
    const c = read().circuit;
    return c.state === 'failed' ? `failed: ${c.reason}` : c.state;
  });
  return opened;
}

/** Seeks the replay to video time `time` and pauses there. Returns the lap count it shows. */
async function seekTo(page, time) {
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

/** Seeks to about lap `lap` from lights out at video time `start`, aiming at 90 s a lap and then correcting. */
export async function seekToLap(page, start, lap) {
  const count = await seekTo(page, start + lap * 90);
  return count?.current ? seekTo(page, start + (lap - 0.5) * ((lap * 90) / count.current)) : count;
}

/** The cars running first to fourth at the playhead. */
export const frontRunners = (page) =>
  page.evaluate(async () => {
    const { host } = await import('/src/host/index.ts');
    const { rows } = await host.data.sql({ sql: 'SELECT driver_number FROM lap_summary WHERE lap_number = (SELECT MAX(lap_number) FROM lap_summary) ORDER BY position LIMIT 4' });
    return rows.map((r) => Number(r.driver_number));
  });
