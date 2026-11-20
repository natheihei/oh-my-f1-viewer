import { app, BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isFilling, loadWindowState, MIN_SIZE, openingState, saveWindowState, type WindowState } from './windowState';

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

const SAVE_DELAY_MS = 500;

/**
 * Opens the window where the user last left it, or fitted to the display the mouse is on, and saves its
 * size and position as they change. What's saved is its last size when neither maximized nor full
 * screen, plus whether it was maximized, so un-maximizing after a restart goes back to that size.
 * A window manager may still size and place the window itself, as a tiling one does, and Wayland never
 * tells an app its window's position, so there the position saved is 0,0.
 */
function placeWindow(): { state: WindowState; track: (win: BrowserWindow) => void } {
  const file = path.join(app.getPath('userData'), 'window-state.json');
  const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const state = openingState(
    loadWindowState(file),
    screen.getAllDisplays().map((d) => d.workArea),
    cursorDisplay.workArea,
  );
  const track = (win: BrowserWindow) => {
    let normal = { x: state.x, y: state.y, width: state.width, height: state.height };
    let timer: NodeJS.Timeout | null = null;
    const save = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (win.isDestroyed()) return;
      const bounds = win.getBounds();
      const maximized = isFilling(win.isMaximized(), bounds, screen.getDisplayMatching(bounds).workArea);
      if (!maximized && !win.isFullScreen() && !win.isMinimized()) {
        const [width, height] = win.getContentSize();
        normal = { x: bounds.x, y: bounds.y, width, height };
      }
      saveWindowState(file, { ...normal, maximized });
    };
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, SAVE_DELAY_MS);
    };
    win.on('resize', later);
    win.on('move', later);
    win.on('maximize', later);
    win.on('unmaximize', later);
    win.on('close', save);
  };
  return { state, track };
}

export function createMainWindow(): BrowserWindow {
  const { state, track } = placeWindow();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    useContentSize: true, // sizes are the page's area, so they mean the same with or without a frame
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    backgroundColor: '#000000',
    title: 'oh-my-f1-viewer',
    icon: path.join(__dirname, '..', '..', 'icons', 'omfv-app-icon.png'),
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

  if (state.maximized) win.maximize();
  track(win);
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
