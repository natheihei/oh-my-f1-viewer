import { app, BrowserWindow, Menu, protocol, session } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { setupIpc } from './ipc';
import { appSettings } from './settings';
import { MOD_SCHEME, Mods } from './mods';
import { createMainWindow, getMainAppUrl, getMainWindow, sendToRenderer } from './windows';

// Vendored F1OpenViewer modules are plain CommonJS.
/* eslint-disable @typescript-eslint/no-require-imports */
const widevine = require('./vendor/f1ov/widevine');
const sessionState = require('./vendor/f1ov/session');
const licenseProxy = require('./vendor/f1ov/licenseProxy');
const livetiming = require('./vendor/f1ov/livetiming');
const { isAppNavigation, isPermissionAllowed } = require('./vendor/f1ov/navigationPolicy');

/** Whether `wc` is the app's own window showing the app's own document. */
function isAppWindow(wc: Electron.WebContents | null): boolean {
  const win = getMainWindow();
  return !!wc && !!win && !win.isDestroyed() && wc === win.webContents && isAppNavigation(wc.getURL(), getMainAppUrl());
}

process.on('uncaughtException', (e) => console.error('[main] uncaught exception:', e?.stack ?? e));
process.on('unhandledRejection', (e) => console.error('[main] unhandled rejection:', e));

widevine.configureWidevineFromEnv();

// Streams start themselves when the agent adds them: no click is available to unlock audio.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// nvidia-vaapi-driver: zero-copy import of NVDEC frames garbles the picture. Keep hardware decode
// but copy decoded frames before rendering.
if (process.env.LIBVA_DRIVER_NAME === 'nvidia') {
  app.commandLine.appendSwitch('disable-features', 'AcceleratedVideoDecodeLinuxZeroCopyGL');
}

// Chromium only finds the desktop keyring on GNOME and KDE. Elsewhere (Hyprland, Sway) it silently
// stores account tokens in plain text, even with a keyring running, unless told where to look.
if (process.platform === 'linux' && !app.commandLine.hasSwitch('password-store')) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

// Mods are served from memory over their own scheme, which the page imports as ES modules. See docs/MODS.md.
protocol.registerSchemesAsPrivileged([
  { scheme: MOD_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const cacheRoot = path.join(os.tmpdir(), 'f1a-cache');
app.commandLine.appendSwitch('disk-cache-dir', path.join(cacheRoot, String(process.pid)));
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

/** Each launch gets its own cache folder; remove those left by processes that have exited. */
async function pruneStaleCacheDirs(): Promise<void> {
  const names = await fsp.readdir(cacheRoot).catch(() => [] as string[]);
  await Promise.all(
    names.map(async (name) => {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) return;
      try {
        process.kill(Number(name), 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EPERM') {
          await fsp.rm(path.join(cacheRoot, name), { recursive: true, force: true }).catch(() => {});
        }
      }
    }),
  );
}

// One instance per profile: two would race on the session files and license proxy ports.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

app
  .whenReady()
  .then(async () => {
    if (!gotLock) return;
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) =>
      callback(isPermissionAllowed(permission) || (permission === 'display-capture' && isAppWindow(wc))),
    );
    session.defaultSession.setPermissionCheckHandler(
      (wc, permission) => isPermissionAllowed(permission) || (permission === 'display-capture' && isAppWindow(wc)),
    );
    // The build agent's look_at records the app's window, restricted to one tile: src/host/picture.ts. The app's
    // own document may record itself, and nothing else: not the screen, not another window.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const win = getMainWindow();
      const own = win && !win.isDestroyed() && request.frame && request.frame === win.webContents.mainFrame && isAppNavigation(request.frame.url, getMainAppUrl());
      // Electron denies when the callback gets no video.
      callback(own ? { video: request.frame! } : {});
    });

    // Don't hold the window for the CDM: playback awaits it instead.
    widevine.whenCdmReady();
    void pruneStaleCacheDirs();
    livetiming.setCacheDir(path.join(app.getPath('userData'), 'livetiming-cache'));
    // The static timing archive requires the F1 TV subscription token.
    livetiming.setAuthTokenProvider(() => sessionState.memSession.accessToken);
    licenseProxy.startLicenseProxy();
    licenseProxy.installWebRequestHooks();
    const root = path.join(__dirname, '..', '..');
    const mods = new Mods(
      path.join(app.getPath('userData'), 'mods'),
      (list) => sendToRenderer('mods:changed', list),
      { declarations: path.join(root, 'dist-types') },
      path.join(app.getPath('userData'), 'mods-snapshot'),
      (state) => sendToRenderer('build:changed', state),
    );
    protocol.handle(MOD_SCHEME, (request) => mods.serve(request));
    app.on('will-quit', () => void mods.stop());
    // A change still waiting to be written, such as the volume just set.
    app.on('will-quit', () => appSettings().flush());
    const data = setupIpc(path.join(app.getPath('userData'), 'timing.sqlite'), mods);
    void mods.start().catch((e: Error) => console.warn('[mods] start:', e.message));

    try {
      await sessionState.restoreSessionOnStartup();
    } catch (e) {
      console.warn('[main] session restore failed:', (e as Error).message);
    }
    sessionState.startProactiveRefreshLoop();

    Menu.setApplicationMenu(null);
    createMainWindow();
    // The calendar is refreshed on every start. Until it's done, the last one is still there to read.
    void data.refreshSchedule().catch((e: Error) => console.warn('[timingdb] schedule:', e.message));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  })
  .catch((e) => {
    // Never leave a running app with no window: it would also hold the single-instance lock.
    console.error('[main] startup failed:', e?.stack ?? e);
    if (gotLock && BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
