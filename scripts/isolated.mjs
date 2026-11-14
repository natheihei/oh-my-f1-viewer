// Runs an f1a of its own for checks and screenshots, apart from any other f1a on the machine: a fresh
// user data dir (the F1 TV login is copied in from ~/.config/f1a, never moved), or the main profile itself
// when nothing else is using it and the run needs the agent's login, its own Vite
// and devtools ports, and on Hyprland it opens silently on workspace 3 and never takes focus. Driven over
// the devtools protocol, since Playwright's own Electron launch would spawn the window where it pleases.
import { copyFileSync, cpSync, existsSync, mkdtempSync, openSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createServer as netServer } from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright';

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

/** The main profile, ~/.config/f1a. */
export const MAIN_PROFILE = path.join(os.homedir(), '.config', 'f1a');

/** Whether an f1a is running on a user data dir: its single-instance lock names a live process. */
export function profileInUse(dir) {
  try {
    const pid = Number(readlinkSync(path.join(dir, 'SingletonLock')).split('-').at(-1));
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the app from the source, served by Vite, with its user data in `outDir`. The page gets 1600×900
 * CSS pixels, the room the charts are designed in, at `scale` device pixels each so a shot stays sharp.
 * Returns the page, `log`, `userData` (the user data dir it runs on), and `stop`, which closes only this instance.
 *
 * `mainProfile` runs on ~/.config/f1a itself instead, for the agent: its login (pi-agent/auth.json) is never
 * copied, since a copy refreshes the token on first use, and a refresh token that rotates would sign the
 * main profile out. It refuses while another f1a is using that profile.
 */
export async function startIsolatedApp(outDir, { name = 'isolated', scale = 1.5, mainProfile = false } = {}) {
  const log = (...a) => console.log(`[${name}]`, ...a);
  const config = MAIN_PROFILE;
  let userData = config;
  // On the main profile, the window's size and place are put back after, so the next launch opens as before.
  const windowState = path.join(config, 'window-state.json');
  const savedWindow = mainProfile && existsSync(windowState) ? readFileSync(windowState) : null;
  if (mainProfile) {
    if (profileInUse(config)) throw new Error(`Another f1a is using ${config}: close it, or run without the agent.`);
  } else {
    // A user data dir of its own, so the single-instance lock, window state, mods and timing.sqlite are apart.
    userData = mkdtempSync(path.join(outDir, 'user-data-'));
    for (const file of ['f1a-session.json', 'f1a-cookies.json']) {
      if (existsSync(path.join(config, file))) copyFileSync(path.join(config, file), path.join(userData, file));
    }
    // The DRM module, so the fresh dir doesn't fetch it again before the video can play.
    if (existsSync(path.join(config, 'WidevineCdm'))) cpSync(path.join(config, 'WidevineCdm'), path.join(userData, 'WidevineCdm'), { recursive: true });
  }

  const vitePort = await freePort();
  const cdpPort = await freePort();
  const server = await createServer({
    root,
    cacheDir: path.join(outDir, 'vite-cache'),
    server: { host: '127.0.0.1', port: vitePort, strictPort: true, fs: { strict: false } },
    logLevel: 'error',
  });
  await server.listen();
  log(`vite on ${vitePort}, devtools on ${cdpPort}, user data in ${userData}`);

  const electronBin = path.join(root, 'node_modules/electron/dist/electron');
  const [width, height] = [1600 * scale, 900 * scale];
  const electronArgs = [root, `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, `--force-device-scale-factor=${scale}`];
  // The main process's own output: why a renderer went, what the agent and mods did.
  const mainLog = path.join(outDir, 'main.log');
  let child = null;
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    // Through Hyprland so its rules apply: `exec` keeps electron as the spawned pid the rules match.
    const command = `sh -c 'exec env -u CHROME_DESKTOP ELECTRON_START_URL=http://127.0.0.1:${vitePort} ${[electronBin, ...electronArgs].join(' ')} >>${mainLog} 2>&1'`;
    execFileSync('hyprctl', ['eval', `hl.exec_cmd(${JSON.stringify(command)}, { workspace = "3 silent", float = true, size = "${width} ${height}", no_initial_focus = true })`]);
  } else {
    const { CHROME_DESKTOP: _ignored, ...env } = process.env;
    child = spawn(electronBin, electronArgs, { env: { ...env, ELECTRON_START_URL: `http://127.0.0.1:${vitePort}` }, stdio: ['ignore', openSync(mainLog, 'a'), openSync(mainLog, 'a')] });
  }

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

  const stop = async () => {
    await browser.close().catch(() => {});
    for (const pid of ownPids()) {
      try {
        process.kill(pid);
      } catch {}
    }
    child?.kill();
    await server.close();
    if (savedWindow) {
      await until('The app never exited', async () => ownPids().length === 0, 15_000).catch(() => {});
      writeFileSync(windowState, savedWindow);
    }
  };

  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    const pids = new Set(ownPids());
    const clients = JSON.parse(execFileSync('hyprctl', ['clients', '-j']).toString());
    const mine = clients.find((c) => pids.has(c.pid));
    log(mine ? `window on workspace ${mine.workspace.name}, focused: ${mine.focusHistoryID === 0}` : 'window not found in hyprctl clients');
  }

  // A hidden workspace's window stops drawing once nothing moves on it, and screenshots time out.
  await page.addStyleTag({ content: '@keyframes isolated-tick{to{opacity:.99}}#isolated-tick{position:fixed;left:0;top:0;width:1px;height:1px;animation:isolated-tick 1s infinite alternate;pointer-events:none}' });
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="isolated-tick"></div>'));

  return { page, log, stop, userData };
}

/**
 * Opens a replay race, muted: the one with `sessionKey`, or the latest. Waits for its data, and for
 * telemetry and the circuit when asked. Returns its title, key, the video time of lights out and the roster.
 */
export async function openRace(page, { sessionKey = null, year = 2026, telemetry = false } = {}) {
  const opened = await page.evaluate(
    async ({ sessionKey, year }) => {
      const { host, read } = await import('/src/host/index.ts');
      if (!(await host.account.status()).f1tv.signedIn) return { error: 'F1 TV is not signed in in ~/.config/f1a: sign in in the app, then run this again.' };
      host.audio.setVolume({ volume: 0 });
      let start = null;
      window.f1a.data.onStatus((status) => {
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
