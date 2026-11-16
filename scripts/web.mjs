// Runs the browser build (dist-web, an unpacked extension) in a Chrome of its own, for checks and
// screenshots: a fresh profile in `outDir`, the extension loaded over Chrome's debugging pipe (branded
// Chrome no longer takes --load-extension), and the page driven over the devtools protocol. On Hyprland
// the window opens silently on workspace 3 and never takes focus, like scripts/isolated.mjs.
// Build first: `npm run build:web`. See docs/WEB.md.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { createServer as netServer, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const DIST = path.join(root, 'dist-web');
/** The main profile of the desktop app, whose sign-ins the checks borrow. */
export const MAIN_PROFILE = path.join(os.homedir(), '.config', 'f1a');
const CHROME = process.env.F1A_CHROME ?? 'google-chrome-stable';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const until = async (what, ok, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await Promise.resolve()
      .then(ok)
      .catch(() => null);
    if (value) return value;
    await sleep(300);
  }
  throw new Error(what);
};

/** Chrome's debugging pipe: JSON messages ended by a zero byte, written to its fd 3 and read from its fd 4. */
function pipeClient(input, output) {
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  const waiting = new Map();
  output.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let end = buffer.indexOf(0); end >= 0; end = buffer.indexOf(0)) {
      const message = JSON.parse(buffer.subarray(0, end).toString());
      buffer = buffer.subarray(end + 1);
      const pending = waiting.get(message.id);
      if (!pending) continue;
      waiting.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      input.write(JSON.stringify({ id, method, params }) + '\0');
    });
}

/**
 * Starts Chrome with the extension loaded and the app's page open. Returns the page, its browser context,
 * `reload` (loads the extension again, for a new build, and reopens the page), and `stop`, which closes
 * only this Chrome. `profile` is a Chrome profile to run on instead of a fresh one, which must not be open:
 * one a person signed in on by hand, since Google refuses a sign-in in a Chrome that's being debugged.
 */
export async function startWebApp(outDir, { name = 'web', scale = 1, profile = null } = {}) {
  if (!existsSync(path.join(DIST, 'manifest.json'))) throw new Error('No dist-web: run `npm run build:web` first.');
  mkdirSync(outDir, { recursive: true });
  const log = (...a) => console.log(`[${name}]`, ...a);
  const userData = profile ?? mkdtempSync(path.join(outDir, 'chrome-'));
  const port = await freePort();
  const chromeLog = path.join(outDir, 'chrome.log');
  const args = [
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    // Streams start themselves when the agent adds them: no click is there to unlock them.
    '--autoplay-policy=no-user-gesture-required',
    `--force-device-scale-factor=${scale}`,
    `--window-size=${1600},${900}`,
    'about:blank',
  ];

  let send;
  let child = null;
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    // Through Hyprland so its rules apply. Chrome must be the pid Hyprland starts, so the pipe is two
    // named pipes opened by the shell that execs it.
    const [fifoIn, fifoOut] = [path.join(outDir, `${path.basename(userData)}.in`), path.join(outDir, `${path.basename(userData)}.out`)];
    execFileSync('mkfifo', [fifoIn, fifoOut]);
    // Both ends are opened here first, read-write so neither open waits: the shell's own opens would
    // otherwise block until this process got to them, and Hyprland with it.
    // As sockets, which wait for data without holding a thread: a file stream's read would block one, and the
    // process could then never exit.
    const [input, output] = [openSync(fifoIn, 'r+'), openSync(fifoOut, 'r+')];
    send = pipeClient(new Socket({ fd: input, readable: false, writable: true }), new Socket({ fd: output, readable: true, writable: false }));
    const command = `sh -c 'exec ${CHROME} ${args.join(' ')} 3<${fifoIn} 4>${fifoOut} >>${chromeLog} 2>&1'`;
    let request = `hl.exec_cmd(${JSON.stringify(command)}, { workspace = "3 silent", float = true, size = "${1600 * scale} ${900 * scale}", no_initial_focus = true })`;
    // Hyprland 0.56 never answers a request whose length lands on a multiple of 1024 bytes, and holds its
    // socket for five seconds. Spaces move a request that's near one clear of it.
    const over = (Buffer.byteLength(request) + 32) % 1024;
    if (over < 64) request += ' '.repeat(64 - over);
    execFileSync('hyprctl', ['eval', request]);
  } else {
    const out = openSync(chromeLog, 'a');
    child = spawn(CHROME, args, { stdio: ['ignore', out, out, 'pipe', 'pipe'] });
    send = pipeClient(child.stdio[3], child.stdio[4]);
  }

  const ownPids = () => {
    try {
      return execFileSync('pgrep', ['-f', '--', `--user-data-dir=${userData}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').map(Number).filter(Boolean);
    } catch {
      return [];
    }
  };

  const { id: extensionId } = await until('Chrome never loaded the extension', () => send('Extensions.loadUnpacked', { path: DIST }));
  const appUrl = `chrome-extension://${extensionId}/index.html`;
  const browser = await until('Chrome never opened its devtools port', () => chromium.connectOverCDP(`http://127.0.0.1:${port}`));
  const context = browser.contexts()[0];
  log(`chrome on ${port}, extension ${extensionId}, profile in ${userData}`);

  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    const mine = await until('', () => {
      const pids = new Set(ownPids());
      return JSON.parse(execFileSync('hyprctl', ['clients', '-j']).toString()).find((c) => pids.has(c.pid));
    }, 5000).catch(() => null);
    log(mine ? `window on workspace ${mine.workspace.name}, focused: ${mine.focusHistoryID === 0}` : 'window not found in hyprctl clients');
  }

  const open = async () => {
    const page = await context.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    await page.goto(appUrl);
    await page.waitForSelector('[data-testid=palette]', { timeout: 60_000 });
    // The host, as mods get it, for checks to call.
    await page.evaluate(() => Object.assign(window, { host: globalThis.__f1aShared.f1a.host, read: globalThis.__f1aShared.f1a.read }));
    return page;
  };

  const closeAppPages = async () => {
    for (const p of context.pages()) if (p.url().startsWith(`chrome-extension://${extensionId}/`)) await p.close().catch(() => {});
  };
  /** Loads the extension again, as after a new build, and reopens the page. What the app stored stays. */
  const reload = async () => {
    await closeAppPages();
    await send('Extensions.loadUnpacked', { path: DIST });
    await sleep(800);
    return open();
  };

  const stop = async () => {
    await browser.close().catch(() => {});
    for (const pid of ownPids()) {
      try {
        process.kill(pid);
      } catch {}
    }
    child?.kill();
  };

  return { context, extensionId, appUrl, log, userData, open, reload, stop };
}

// ----- the desktop app's sign-ins, for checks -----

/** Whether an f1a is running on the main profile: its single-instance lock names a live process. */
export function mainProfileInUse() {
  try {
    process.kill(Number(readlinkSync(path.join(MAIN_PROFILE, 'SingletonLock')).split('-').at(-1)), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a file the desktop app encrypted with Electron's safeStorage. Linux only: the key is in the desktop
 * keyring under the app's name, as Chromium's v11 scheme keeps it.
 */
function readSafeStorage(file) {
  const envelope = JSON.parse(readFileSync(file, 'utf8'));
  if (envelope?.format !== 'f1ov-safestorage-v1') return JSON.stringify(envelope);
  const password = execFileSync('secret-tool', ['lookup', 'application', 'f1a'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
  const data = Buffer.from(envelope.data, 'base64');
  if (data.subarray(0, 3).toString() !== 'v11') throw new Error(`${file} is not encrypted the way this reads`);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  return Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]).toString('utf8');
}

/**
 * Signs the page in to F1 TV with the desktop app's sign-in: its F1 cookies go into this Chrome, where the
 * app's own sign-in then finds them, as it would in a browser already signed in to F1. Returns whether it
 * ended up signed in.
 */
export async function signInFromMainProfile(context, page) {
  if ((await page.evaluate(() => window.f1a.f1tv.status())).signedIn) return true;
  const file = path.join(MAIN_PROFILE, 'f1a-cookies.json');
  if (!existsSync(file)) return false;
  const cookies = JSON.parse(readSafeStorage(file));
  for (const c of cookies) {
    await context
      .addCookies([{ name: c.name, value: c.value, ...(c.domain ? { domain: c.domain } : { url: c.url }), path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly, ...(c.expirationDate ? { expires: c.expirationDate } : {}) }])
      .catch(() => {});
  }
  // The sign-in window opens only if the cookies don't hold a session F1 accepts. It's closed again here.
  const result = await Promise.race([page.evaluate(() => window.f1a.f1tv.login().then((s) => s.signedIn, () => false)), sleep(45_000).then(() => 'timeout')]);
  if (result === 'timeout') for (const p of context.pages()) if (/formula1\.com/.test(p.url())) await p.close().catch(() => {});
  return (await page.evaluate(() => window.f1a.f1tv.status())).signedIn;
}

const AGENT_DIR = path.join(MAIN_PROFILE, 'pi-agent');

/**
 * Gives the page the desktop app's agent login, for checks that need the real model. A copy refreshes its
 * token on first use, and a refresh token that rotates would sign the desktop app out, so this refuses while
 * the desktop app runs, and `returnAgentLogin` must be called before the check ends.
 */
export async function borrowAgentLogin(page) {
  if (mainProfileInUse()) throw new Error(`An f1a is using ${MAIN_PROFILE}: close it, or run without the agent.`);
  const files = { auth: readFileSync(path.join(AGENT_DIR, 'auth.json'), 'utf8'), settings: readFileSync(path.join(AGENT_DIR, 'settings.json'), 'utf8') };
  await page.evaluate(async ({ auth, settings }) => {
    const { fs, flushFs } = window.__f1aWeb;
    fs.mkdirSync('/f1a/pi-agent', { recursive: true });
    fs.writeFileSync('/f1a/pi-agent/auth.json', auth);
    fs.writeFileSync('/f1a/pi-agent/settings.json', settings);
    await new Promise((r) => setTimeout(r, 400));
    await flushFs();
  }, files);
}

/** Writes the login back if the page refreshed it, so the desktop app keeps a refresh token that works. Says what it did. */
export async function returnAgentLogin(page) {
  const now = await page.evaluate(() => {
    try {
      return window.__f1aWeb.fs.readFileSync('/f1a/pi-agent/auth.json', 'utf8');
    } catch {
      return null;
    }
  });
  if (!now) return 'no login in the page';
  const file = path.join(AGENT_DIR, 'auth.json');
  const disk = readFileSync(file, 'utf8');
  if (now === disk) return 'unchanged';
  const [page_, main] = [JSON.parse(now), JSON.parse(disk)];
  const provider = Object.keys(main)[0];
  if (!provider || !page_[provider]?.refresh) return 'the page holds a different login: not written';
  if (page_[provider].refresh === main[provider].refresh && page_[provider].access === main[provider].access) return 'unchanged';
  if ((page_[provider].expires ?? 0) <= (main[provider].expires ?? 0)) return 'the main profile is newer: not written';
  if (mainProfileInUse()) return `REFRESHED, but an f1a is using ${MAIN_PROFILE}: not written back. Sign the agent in again there.`;
  writeFileSync(`${file}.web-check.tmp`, now, { mode: 0o600 });
  renameSync(`${file}.web-check.tmp`, file);
  return 'refreshed login written back to the main profile';
}

export const paletteText = (page) => page.locator('[data-testid=palette-history]').innerText().catch(() => '');

export async function typeInPalette(page, text) {
  const input = page.locator('[data-testid=palette-input]');
  if (!(await input.isVisible())) await page.keyboard.press('Control+Shift+P');
  await input.fill(text);
  await input.press('Enter');
}
