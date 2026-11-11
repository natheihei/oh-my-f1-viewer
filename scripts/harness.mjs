// Runs the real app on the real profile under Playwright, with the source served by Vite so checks can
// reach app modules. Shared by the scripts that need F1 TV or the agent.
import path from 'node:path';
import { createServer } from 'vite';
import { _electron as electron } from 'playwright';

export async function startApp(port = 5198) {
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
