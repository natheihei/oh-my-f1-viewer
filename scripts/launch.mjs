// Launches the built app under Playwright for checks and screenshots.
import { _electron as electron } from 'playwright';
import { appEnv, ELECTRON_BIN } from './platform.mjs';

export async function launch({ userDataDir } = {}) {
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: ['.', ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : [])],
    env: appEnv(),
  });
  const page = await app.firstWindow();
  return { app, page };
}
