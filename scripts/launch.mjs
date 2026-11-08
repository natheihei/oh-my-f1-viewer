// Launches the built app under Playwright for checks and screenshots.
import { _electron as electron } from 'playwright';
import path from 'node:path';

export async function launch({ userDataDir } = {}) {
  // Chromium aborts at startup with the CHROME_DESKTOP value Claude's desktop app sets.
  const { CHROME_DESKTOP: _ignored, ...env } = process.env;
  const app = await electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/electron'),
    args: ['.', ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : [])],
    env,
  });
  const page = await app.firstWindow();
  return { app, page };
}
