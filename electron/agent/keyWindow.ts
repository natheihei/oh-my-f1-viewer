/**
 * The small window login prompts are answered in (API keys, account/project IDs, auth method choices, or
 * copy-paste auth codes). It's its own sandboxed page, not the app's renderer, because mods run in that
 * renderer with no sandbox and could read anything typed there. Answers go straight to main, and the
 * renderer never sees them.
 */
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import path from 'node:path';
import { getMainWindow } from '../windows';

export interface SelectOption {
  id: string;
  label: string;
  description?: string;
}

export type AuthWindowPrompt =
  | { type: 'secret'; message: string; placeholder?: string }
  | { type: 'text'; message: string; placeholder?: string }
  | { type: 'manual_code'; message: string; placeholder?: string }
  | { type: 'select'; message: string; options: readonly SelectOption[] };

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const BASE_CSS = `
  html, body { margin: 0; height: 100%; background: #0a0a0a; color: #e7e7e7; font: 13px/1.45 Menlo, 'JetBrains Mono', ui-monospace, monospace; }
  form, .wrap { display: grid; gap: 10px; padding: 12px; }
  label, .msg { color: #8a8a8a; }
  input { background: transparent; border: 1px solid #4a4a4a; color: #e7e7e7; font: inherit; padding: 3px 8px; outline: none; }
  input:focus { border-color: #8a8a8a; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  button { background: transparent; border: 1px solid #4a4a4a; color: #e7e7e7; font: inherit; padding: 2px 10px; cursor: pointer; }
  button:hover, button:focus-visible { border-color: #e7e7e7; background: rgb(255 255 255 / .1); outline: none; }
  button[type=button] { color: #8a8a8a; }
  .options { display: grid; gap: 6px; }
  .option { display: grid; gap: 2px; text-align: left; padding: 6px 10px; color: #e7e7e7 !important; }
  .option small { color: #8a8a8a; font-size: 11px; }
`;

function inputPage(title: string, prompt: Extract<AuthWindowPrompt, { type: 'secret' | 'text' | 'manual_code' }>): string {
  const secret = prompt.type === 'secret';
  const allowEmpty = prompt.type === 'text';
  const hint = secret ? `${prompt.message} OMFV stores it on this computer.` : prompt.message;
  const placeholder = prompt.placeholder ? ` placeholder="${escapeHtml(prompt.placeholder)}"` : '';
  const submitLabel = secret ? 'Save' : 'Continue';
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style></head>
<body><form id="form">
  <label for="key">${escapeHtml(hint)}</label>
  <input id="key" type="${secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false"${placeholder} autofocus>
  <div class="actions"><button type="button" id="cancel">Cancel</button><button type="submit">${submitLabel}</button></div>
</form>
<script>
  const key = document.getElementById('key');
  const allowEmpty = ${allowEmpty ? 'true' : 'false'};
  document.getElementById('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = key.value.trim();
    if (allowEmpty || val) window.keyWindow.submit(val);
  });
  document.getElementById('cancel').addEventListener('click', () => window.keyWindow.cancel());
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.keyWindow.cancel(); });
</script>
</body></html>`;
}

function selectPage(title: string, prompt: Extract<AuthWindowPrompt, { type: 'select' }>): string {
  const buttons = prompt.options
    .map(
      (o, i) =>
        `<button type="button" class="option" data-id="${escapeHtml(o.id)}"${i === 0 ? ' autofocus' : ''}><span>${escapeHtml(o.label)}</span>${o.description ? `<small>${escapeHtml(o.description)}</small>` : ''}</button>`,
    )
    .join('');
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style></head>
<body><div class="wrap">
  <div class="msg">${escapeHtml(prompt.message)}</div>
  <div class="options">${buttons}</div>
  <div class="actions"><button type="button" id="cancel">Cancel</button></div>
</div>
<script>
  const opts = [...document.querySelectorAll('.option')];
  for (const btn of opts) btn.addEventListener('click', () => window.keyWindow.submit(btn.dataset.id));
  document.getElementById('cancel').addEventListener('click', () => window.keyWindow.cancel());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { window.keyWindow.cancel(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const i = opts.indexOf(document.activeElement);
      const next = opts[Math.min(opts.length - 1, Math.max(0, (i < 0 ? 0 : i) + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { e.preventDefault(); next.focus(); }
    }
  });
</script>
</body></html>`;
}

/** Asks for a secret, text value, or choice in its own sandboxed window. Rejects if closed, cancelled or `signal` aborts. */
export function askForPrompt(title: string, prompt: AuthWindowPrompt, signal: AbortSignal): Promise<string> {
  const allowEmpty = prompt.type === 'text';
  const html = prompt.type === 'select' ? selectPage(title, prompt) : inputPage(title, prompt);
  const height = prompt.type === 'select' ? Math.min(420, 110 + prompt.options.length * 44) : 150;
  return new Promise((resolve, reject) => {
    const parent = getMainWindow() ?? undefined;
    const win = new BrowserWindow({
      width: 480,
      height,
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
    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('keyWindow:submit', onSubmit);
      ipcMain.removeListener('keyWindow:cancel', onCancel);
      signal.removeEventListener('abort', onAbort);
      if (!win.isDestroyed()) win.close();
      if (error) reject(error);
      else resolve(value as string);
    };
    const cancelled = () => new Error('Sign-in cancelled');
    const fromThisWindow = (evt: IpcMainEvent) => !win.isDestroyed() && evt.sender === win.webContents;
    const onSubmit = (evt: IpcMainEvent, value: unknown) => {
      const text = typeof value === 'string' ? value.trim() : '';
      if (fromThisWindow(evt) && (allowEmpty || text)) finish(null, text);
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
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
}

/** Asks for a key in its own window. Rejects if the window is closed, cancelled or `signal` aborts. */
export function askForKey(title: string, message: string, signal: AbortSignal): Promise<string> {
  return askForPrompt(title, { type: 'secret', message }, signal);
}
