/** The platform when the app is an Electron window: IPC with the app's own document, and nothing else. */
import { ipcMain } from 'electron';
import type { Platform } from './platform';
import { getMainAppUrl, getMainWindow, sendToRenderer } from './windows';

/* eslint-disable @typescript-eslint/no-require-imports */
const { openLoginWindow } = require('./vendor/f1ov/loginWindow');
const { isAppNavigation } = require('./vendor/f1ov/navigationPolicy');

/** Only the app's own document may use the bridge. */
function isTrusted(evt: { senderFrame?: { url?: string } | null }): boolean {
  const url = evt?.senderFrame?.url;
  return !!url && isAppNavigation(url, getMainAppUrl());
}

/**
 * A PNG of a component as the window shows it now: its tile if it has one, else its preview in the
 * strip. For the build agent, which may see the session anyway. Null when it's on neither.
 */
async function pictureOf(name: string): Promise<Buffer | null> {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  const box = (await win.webContents.executeJavaScript(
    `(() => {
      const type = ${JSON.stringify(name)};
      const el = document.querySelector('[data-tile-type="' + CSS.escape(type) + '"]') ?? document.querySelector('[data-draft-type="' + CSS.escape(type) + '"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null;
    })()`,
  )) as { x: number; y: number; width: number; height: number } | null;
  if (!box) return null;
  return (await win.webContents.capturePage(box)).toPNG();
}

export const electronPlatform: Platform = {
  handle(channel, fn) {
    ipcMain.handle(channel, (evt, ...args) => {
      if (!isTrusted(evt)) {
        console.warn('[ipc] rejected', channel, 'from untrusted sender');
        throw new Error('Untrusted sender');
      }
      return fn(...args);
    });
  },
  on(channel, fn) {
    ipcMain.on(channel, (evt, ...args) => {
      if (isTrusted(evt)) fn(...args);
    });
  },
  send: sendToRenderer,
  hasRenderer() {
    const win = getMainWindow();
    return !!win && !win.isDestroyed();
  },
  login: (validate) => openLoginWindow(validate),
  picture: pictureOf,
};
