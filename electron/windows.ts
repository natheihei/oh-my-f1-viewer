import { BrowserWindow } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* eslint-disable @typescript-eslint/no-require-imports */
const { devEnv, devToolsAllowed } = require('./vendor/f1ov/devFlags');
const { isAppNavigation } = require('./vendor/f1ov/navigationPolicy');
const { redactUrl } = require('./vendor/f1ov/util');

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function getMainAppUrl(): string {
  const startUrl = devEnv('ELECTRON_START_URL');
  if (startUrl) return startUrl;
  return pathToFileURL(path.join(__dirname, '..', '..', 'dist', 'index.html')).href;
}

const MAX_CRASH_RELOADS = 3;
const CRASH_WINDOW_MS = 60_000;

/**
 * The window runs with relaxed web security because F1's CDN and DRM requests need it, so it may
 * only ever show the app itself: foreign navigations are blocked and window.open() is denied.
 */
function harden(win: BrowserWindow): void {
  const { webContents } = win;
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const crashes: number[] = [];
  webContents.on('render-process-gone', (_evt, details) => {
    if (details.reason === 'clean-exit' || webContents.isDestroyed()) return;
    const now = Date.now();
    while (crashes.length && now - crashes[0] > CRASH_WINDOW_MS) crashes.shift();
    crashes.push(now);
    if (crashes.length > MAX_CRASH_RELOADS) {
      console.warn(`[window] renderer keeps crashing (${details.reason}), not reloading again`);
      return;
    }
    console.warn(`[window] renderer gone (${details.reason}), reloading`);
    setTimeout(() => {
      if (!webContents.isDestroyed()) webContents.reload();
    }, 1000);
  });
  webContents.on('will-navigate', (event, url) => {
    if (isAppNavigation(url, getMainAppUrl())) return;
    event.preventDefault();
    console.warn('[security] blocked navigation to', redactUrl(url));
  });
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 860,
    backgroundColor: '#000000',
    title: 'f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // keep the clock and video at full rate while covered
      plugins: true, // required for the CDM
      webSecurity: false, // avoid CORS blocks on F1 TV CDN manifests, segments and licenses
    },
  });

  harden(win);

  win.webContents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event;
    if (level === 'debug' || level === 'info') return;
    if (typeof message === 'string' && message.includes('Electron Security Warning')) return;
    console.log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
  });

  const startUrl = devEnv('ELECTRON_START_URL');
  if (startUrl) void win.loadURL(startUrl);
  else void win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));

  win.webContents.on('before-input-event', (_evt, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && devToolsAllowed()) {
      win.webContents.toggleDevTools();
    }
  });

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

export function sendToRenderer(channel: string, payload?: unknown): void {
  const win = mainWindow;
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
