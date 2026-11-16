/**
 * The `electron` module for main-process code running in an extension page. Cookies, windows and
 * `session.fetch` go to the browser's own, through `chrome.*`. What only makes sense for a desktop app
 * (menus, the command line, protocols) does nothing.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { EventEmitter } = require('events');

const USER_DATA = '/f1a';

const noop = (): void => {};
/** An object any method can be called on, for the parts of Electron that have no browser meaning. */
const inert = (): any =>
  new Proxy(function () {} as any, {
    get: (_t, key) => (key === 'then' ? undefined : inert()),
    apply: () => undefined,
  });

// ----- app -----

const app = Object.assign(new EventEmitter(), {
  isPackaged: true,
  commandLine: { appendSwitch: noop, appendArgument: noop, hasSwitch: () => false, getSwitchValue: () => '' },
  getPath: (name: string) => (name === 'userData' ? USER_DATA : name === 'temp' ? '/tmp' : name === 'home' ? '/home' : `${USER_DATA}/${name}`),
  getAppPath: () => '/app',
  getName: () => 'f1a',
  getVersion: () => chrome.runtime.getManifest().version,
  getLocale: () => navigator.language,
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  requestSingleInstanceLock: () => true,
  quit: noop,
  exit: noop,
  focus: noop,
});

// ----- cookies -----

interface ElectronCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  expirationDate?: number;
}

const toElectron = (c: chrome.cookies.Cookie): ElectronCookie => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path,
  secure: c.secure,
  httpOnly: c.httpOnly,
  session: c.session,
  expirationDate: c.expirationDate,
});

class Cookies extends EventEmitter {
  private listening = false;

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    chrome.cookies.onChanged.addListener((change) => this.emit('changed', {}, toElectron(change.cookie), change.cause, change.removed));
  }

  on(event: string, listener: (...args: any[]) => void): this {
    if (event === 'changed') this.listen();
    return super.on(event, listener);
  }

  async get(filter: { url?: string; name?: string; domain?: string; path?: string } = {}): Promise<ElectronCookie[]> {
    const details: chrome.cookies.GetAllDetails = {};
    if (filter.url) details.url = filter.url;
    if (filter.name) details.name = filter.name;
    if (filter.domain) details.domain = filter.domain;
    if (filter.path) details.path = filter.path;
    return (await chrome.cookies.getAll(details)).map(toElectron);
  }

  async set(details: ElectronCookie & { url: string }): Promise<void> {
    const secure = details.secure ?? details.url.startsWith('https:');
    await chrome.cookies.set({
      url: details.url,
      name: details.name,
      value: details.value,
      path: details.path,
      // A host-only cookie comes back with its host as the domain: passing it would widen it to subdomains.
      ...(details.domain?.startsWith('.') ? { domain: details.domain } : {}),
      secure,
      httpOnly: details.httpOnly,
      ...(details.expirationDate ? { expirationDate: details.expirationDate } : {}),
    });
  }

  async remove(url: string, name: string): Promise<void> {
    await chrome.cookies.remove({ url, name });
  }

  async flushStore(): Promise<void> {}
}

const cookies = new Cookies();

// ----- session.fetch -----

let cookieTurn: Promise<unknown> = Promise.resolve();

/**
 * Electron's `session.fetch`: a request that carries the browser's cookies. The license proxy marks a
 * request with `X-F1OV-Cookie` to give each stream its own `playToken` cookie, which Electron applies in a
 * request hook. A page can't set a Cookie header, so the cookie is put in the jar for that one request,
 * and such requests go one at a time.
 */
async function sessionFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookieOverride = headers.get('X-F1OV-Cookie');
  headers.delete('X-F1OV-Cookie');
  headers.delete('X-F1OV-Proxy');
  const send = () => globalThis.fetch(input, { ...init, headers, credentials: 'include' });
  const playToken = cookieOverride?.match(/(?:^|;\s*)playToken=([^;]*)/)?.[1];
  if (!playToken) return send();
  const url = new URL(String(input));
  const turn = cookieTurn
    .catch(() => null)
    .then(async () => {
      await chrome.cookies.set({ url: `${url.origin}/`, name: 'playToken', value: playToken, path: '/', secure: true }).catch(noop);
      return send();
    });
  cookieTurn = turn;
  return turn;
}

const defaultSession = {
  cookies,
  fetch: sessionFetch,
  webRequest: inert(),
  protocol: inert(),
  clearCache: async () => {},
  clearStorageData: async () => {},
  setPermissionRequestHandler: noop,
  setPermissionCheckHandler: noop,
  getUserAgent: () => navigator.userAgent,
  setUserAgent: noop,
};

// ----- BrowserWindow -----

const windows = new Set<BrowserWindowShim>();

/**
 * A window on another site, as the F1 TV sign-in opens: a popup window, or for `show: false` a tab in the
 * background, since an extension has no hidden windows. Its page can't be scripted or restricted from here.
 */
class BrowserWindowShim extends EventEmitter {
  static getAllWindows(): BrowserWindowShim[] {
    return [...windows];
  }
  static fromWebContents(): null {
    return null;
  }

  webContents = Object.assign(inert(), { session: defaultSession });
  private destroyed = false;
  private tabId: number | null = null;
  private windowId: number | null = null;
  private opening: Promise<void> | null = null;

  constructor(private readonly options: { show?: boolean; width?: number; height?: number } = {}) {
    super();
    windows.add(this);
    chrome.tabs.onRemoved.addListener(this.onTabRemoved);
  }

  private onTabRemoved = (tabId: number): void => {
    if (tabId !== this.tabId) return;
    this.tabId = null;
    this.finish();
  };

  private finish(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    windows.delete(this);
    chrome.tabs.onRemoved.removeListener(this.onTabRemoved);
    this.emit('closed');
  }

  loadURL(url: string): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('The window is closed'));
    if (this.tabId !== null) return chrome.tabs.update(this.tabId, { url }).then(noop);
    this.opening ??= (async () => {
      if (this.options.show === false) {
        const tab = await chrome.tabs.create({ url, active: false });
        this.tabId = tab.id ?? null;
      } else {
        const win = await chrome.windows.create({ url, type: 'popup', width: this.options.width ?? 900, height: this.options.height ?? 700, focused: true });
        this.windowId = win?.id ?? null;
        this.tabId = win?.tabs?.[0]?.id ?? null;
      }
      // Closed while it was opening.
      if (this.destroyed) this.remove();
    })();
    return this.opening;
  }

  loadFile(): Promise<void> {
    return Promise.reject(new Error('loadFile is not available in the browser'));
  }

  private remove(): void {
    const tabId = this.tabId;
    this.tabId = null;
    if (this.windowId !== null) void chrome.windows.remove(this.windowId).catch(noop);
    else if (tabId !== null) void chrome.tabs.remove(tabId).catch(noop);
  }

  close(): void {
    this.remove();
    this.finish();
  }
  destroy(): void {
    this.close();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isMinimized(): boolean {
    return false;
  }
  setTitle(): void {}
  show(): void {}
  hide(): void {}
  focus(): void {
    if (this.windowId !== null) void chrome.windows.update(this.windowId, { focused: true }).catch(noop);
  }
  restore(): void {}
  setMenu(): void {}
  setMenuBarVisibility(): void {}
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: this.options.width ?? 900, height: this.options.height ?? 700 };
  }
}

// ----- safeStorage -----

const KEY_DB = 'f1a-keys';

function keyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let storageKey: Promise<CryptoKey> | null = null;

/**
 * The key the F1 TV token is encrypted with at rest: AES-GCM, made once and kept in IndexedDB as a key
 * that can't be exported. It keeps the token out of anything that copies the stored files, not from code
 * running in this page.
 */
function getStorageKey(): Promise<CryptoKey> {
  storageKey ??= (async () => {
    const db = await keyDb();
    const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const request = db.transaction('keys').objectStore('keys').get('safeStorage');
      request.onsuccess = () => resolve(request.result as CryptoKey | undefined);
      request.onerror = () => reject(request.error);
    });
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite');
      tx.objectStore('keys').put(key, 'safeStorage');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return key;
  })();
  return storageKey;
}

const safeStorage = {
  isEncryptionAvailable: () => false,
  isAsyncEncryptionAvailable: async () => {
    try {
      await getStorageKey();
      return true;
    } catch {
      return false;
    }
  },
  async encryptStringAsync(text: string): Promise<Buffer> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getStorageKey(), new TextEncoder().encode(text));
    return Buffer.concat([Buffer.from(iv), Buffer.from(sealed)]);
  },
  async decryptStringAsync(data: Uint8Array): Promise<{ result: string; shouldReEncrypt: boolean }> {
    const bytes = new Uint8Array(data);
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, await getStorageKey(), bytes.subarray(12));
    return { result: new TextDecoder().decode(opened), shouldReEncrypt: false };
  },
};

// ----- the rest -----

const shell = {
  openExternal: async (url: string): Promise<void> => {
    await chrome.tabs.create({ url });
  },
  openPath: async () => 'Not available in the browser',
  showItemInFolder: noop,
};

module.exports = {
  app,
  session: { defaultSession, fromPartition: () => defaultSession },
  BrowserWindow: BrowserWindowShim,
  safeStorage,
  shell,
  ipcMain: Object.assign(new EventEmitter(), { handle: noop, handleOnce: noop, removeHandler: noop }),
  protocol: inert(),
  Menu: inert(),
  dialog: inert(),
  nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: true }),
  screen: inert(),
  powerMonitor: new EventEmitter(),
  USER_DATA,
};
