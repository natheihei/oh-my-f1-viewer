/**
 * The small window an API key is typed into. It's its own sandboxed page, not the app's renderer, because
 * mods run in that renderer with no sandbox and could read anything typed there. The key goes from this
 * window straight to main, and the renderer never sees it.
 */
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import path from 'node:path';
import { getMainWindow } from '../windows';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function page(title: string, message: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #0a0a0a; color: #e7e7e7; font: 13px/1.45 'JetBrains Mono', ui-monospace, monospace; }
  form { display: grid; gap: 10px; padding: 12px; }
  label { color: #8a8a8a; }
  input { background: transparent; border: 1px solid #4a4a4a; color: #e7e7e7; font: inherit; padding: 3px 8px; outline: none; }
  input:focus { border-color: #8a8a8a; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  button { background: transparent; border: 1px solid #4a4a4a; color: #e7e7e7; font: inherit; padding: 2px 10px; cursor: pointer; }
  button:hover, button:focus-visible { border-color: #e7e7e7; background: rgb(255 255 255 / .1); outline: none; }
  button[type=button] { color: #8a8a8a; }
</style></head>
<body><form id="form">
  <label for="key">${escapeHtml(message)} OMFV stores it on this computer.</label>
  <input id="key" type="password" autocomplete="off" spellcheck="false" autofocus>
  <div class="actions"><button type="button" id="cancel">Cancel</button><button type="submit">Save</button></div>
</form>
<script>
  const key = document.getElementById('key');
  document.getElementById('form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (key.value.trim()) window.keyWindow.submit(key.value.trim());
  });
  document.getElementById('cancel').addEventListener('click', () => window.keyWindow.cancel());
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.keyWindow.cancel(); });
</script>
</body></html>`;
}

/** Asks for a key in its own window. Rejects if the window is closed, cancelled or `signal` aborts. */
export function askForKey(title: string, message: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const parent = getMainWindow() ?? undefined;
    const win = new BrowserWindow({
      width: 460,
      height: 150,
      resizable: false,
      minimizable: false,
      maximizable: false,
      parent,
      modal: !!parent,
      title,
      autoHideMenuBar: true,
      backgroundColor: '#0a0a0a',
      webPreferences: {
        preload: path.join(__dirname, 'keyWindowPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());

    let settled = false;
    const finish = (error: Error | null, key?: string) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('keyWindow:submit', onSubmit);
      ipcMain.removeListener('keyWindow:cancel', onCancel);
      signal.removeEventListener('abort', onAbort);
      if (!win.isDestroyed()) win.close();
      if (error) reject(error);
      else resolve(key as string);
    };
    const cancelled = () => new Error('Sign-in cancelled');
    const fromThisWindow = (evt: IpcMainEvent) => !win.isDestroyed() && evt.sender === win.webContents;
    const onSubmit = (evt: IpcMainEvent, value: unknown) => {
      const key = typeof value === 'string' ? value.trim() : '';
      if (fromThisWindow(evt) && key) finish(null, key);
    };
    const onCancel = (evt: IpcMainEvent) => {
      if (fromThisWindow(evt)) finish(cancelled());
    };
    const onAbort = () => finish(cancelled());

    ipcMain.on('keyWindow:submit', onSubmit);
    ipcMain.on('keyWindow:cancel', onCancel);
    signal.addEventListener('abort', onAbort, { once: true });
    win.on('closed', () => finish(cancelled()));
    if (signal.aborted) {
      onAbort();
      return;
    }
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(title, message))}`);
  });
}
