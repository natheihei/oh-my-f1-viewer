// Runs the real app on the real profile under Playwright, with the source served by Vite so checks can
// reach app modules. Shared by the scripts that need F1 TV or the agent.
import path from 'node:path';
import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { _electron as electron } from 'playwright';
import { MAIN_PROFILE, startIsolatedApp } from './isolated.mjs';

export async function startApp(port = 5198) {
  // Under Hyprland the window must open silently on workspace 3, which Playwright's own launch can't do:
  // the same real profile, started the way scripts/isolated.mjs starts it.
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) return startSilently();
  const server = await createServer({ server: { port, strictPort: true }, logLevel: 'error' });
  await server.listen();
  const { CHROME_DESKTOP: _ignored, ...env } = process.env;
  const app = await electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/electron'),
    args: ['.', ...(process.env.F1A_ELECTRON_ARGS?.split(' ') ?? [])],
    env: { ...env, ELECTRON_START_URL: `http://127.0.0.1:${port}` },
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
  };
  return { app, page, stop };
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

/** The real profile on an isolated launch. `app` stands in for Playwright's: it can only kill the app's process. */
async function startSilently() {
  const { page, stop } = await startIsolatedApp(mkdtempSync(path.join(os.tmpdir(), 'f1a-harness-')), { name: 'harness', scale: 1, mainProfile: true });
  const pids = () => {
    try {
      return execFileSync('pgrep', ['-f', '--', `^\\S*electron\\S* .*--user-data-dir=${MAIN_PROFILE}( |$)`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').map(Number).filter(Boolean);
    } catch {
      return [];
    }
  };
  const app = {
    evaluate: () => Promise.reject(new Error("The main process can't be reached on this launch.")),
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
  return { app, page, stop };
}
