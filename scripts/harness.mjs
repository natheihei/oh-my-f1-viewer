// Runs the real app under Playwright, with the source served by Vite so checks can reach app modules, on a
// profile of its own with the F1 TV and agent logins copied in (scripts/isolated.mjs). Shared by the scripts
// that need F1 TV or the agent.
import path from 'node:path';
import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { _electron as electron } from 'playwright';
import { MAIN_PROFILE, prepareProfile, profileInUse, startIsolatedApp, syncAgentLogin } from './isolated.mjs';
import { appEnv, ELECTRON_BIN, ON_HYPRLAND } from './platform.mjs';

/**
 * Starts the app on a fresh profile, or on `userData`: one prepareProfile made, for a check that launches it
 * more than once, or the main profile, for login.mjs. Returns the `userData` it runs on as well.
 *
 * A fresh profile holds copies of the logins, so `stop` removes it. What a run leaves is its folder under the
 * temp dir with the app's main.log, on Hyprland.
 */
export async function startApp(port = 5198, { userData: given = null } = {}) {
  const run = mkdtempSync(path.join(os.tmpdir(), 'omfv-harness-'));
  const userData = given ?? prepareProfile(path.join(run, 'user-data'), { agent: true });
  // On the main profile, the window's size and place are put back after, so the next launch opens as before.
  const windowState = path.join(userData, 'window-state.json');
  const savedWindow = path.resolve(userData) === MAIN_PROFILE && existsSync(windowState) ? readFileSync(windowState) : null;
  const cleanUp = () => {
    rmSync(path.join(run, 'vite-cache'), { recursive: true, force: true });
    if (!given) rmSync(userData, { recursive: true, force: true });
    if (savedWindow) writeFileSync(windowState, savedWindow);
  };
  // Under Hyprland the window must open silently on workspace 3, which Playwright's own launch can't do:
  // started the way scripts/isolated.mjs starts it.
  if (ON_HYPRLAND) {
    return startSilently(run, userData, cleanUp).catch((e) => {
      cleanUp();
      throw e;
    });
  }
  if (profileInUse(userData)) {
    cleanUp();
    throw new Error(`Another OMFV is using ${userData}: close it first.`);
  }
  const server = await createServer({ server: { port, strictPort: true }, logLevel: 'error' });
  await server.listen();
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: ['.', `--user-data-dir=${userData}`, ...(process.env.OMFV_ELECTRON_ARGS?.split(' ') ?? [])],
    env: appEnv({ ELECTRON_START_URL: `http://127.0.0.1:${port}` }),
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('crash', () => console.log('[renderer crashed]'));
  let firstLoad = true;
  page.on('load', () => {
    if (!firstLoad) console.log('[page reloaded]');
    firstLoad = false;
  });
  const appLog = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (/^\[(login|session|window|main|ai|Widevine|security|license)\b/.test(line)) console.log('  app:', line.slice(0, 200));
    }
  };
  app.process().stdout?.on('data', appLog);
  app.process().stderr?.on('data', appLog);
  await page.waitForSelector('[data-testid=palette]');
  const stop = async () => {
    await app.close().catch(() => {});
    await server.close();
    syncAgentLogin(userData);
    cleanUp();
  };
  return { app, page, stop, userData };
}

export const paletteText = (page) => page.locator('[data-testid=palette-history]').innerText().catch(() => '');

export async function typeInPalette(page, text) {
  const input = page.locator('[data-testid=palette-input]');
  if (!(await input.isVisible())) await page.keyboard.press('Control+Shift+P');
  await input.fill(text);
  await input.press('Enter');
}

export async function waitForPalette(page, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await paletteText(page);
    if (pattern.test(text)) return text;
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for ${pattern}. Palette:\n${await paletteText(page)}`);
}

/** An isolated launch, with logs in `run`. `app` stands in for Playwright's: it can reach the main process and kill the app. */
async function startSilently(run, userData, cleanUp) {
  const isolated = await startIsolatedApp(run, { name: 'harness', scale: 1, userData, inspect: true });
  const pids = () => {
    try {
      return execFileSync('pgrep', ['-f', '--', `^\\S*electron\\S* .*--user-data-dir=${userData}( |$)`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').map(Number).filter(Boolean);
    } catch {
      return [];
    }
  };
  const stop = async () => {
    await isolated.stop();
    cleanUp();
  };
  const app = {
    evaluate: isolated.evaluate,
    process: () => ({
      kill: (signal) => {
        for (const pid of pids()) {
          try {
            process.kill(pid, signal);
          } catch {}
        }
      },
    }),
    close: stop,
  };
  return { app, page: isolated.page, stop, userData };
}
