import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appListeners = new Map<string, (() => void)[]>();
const updaterListeners = new Map<string, ((...args: unknown[]) => void)[]>();
const appMock = {
  isPackaged: false,
  getVersion: () => '0.1.0',
  on: vi.fn((event: string, cb: () => void) => {
    appListeners.set(event, [...(appListeners.get(event) ?? []), cb]);
  }),
  releaseSingleInstanceLock: vi.fn(),
  requestSingleInstanceLock: vi.fn(() => true),
};
const autoUpdaterMock = {
  logger: null as unknown,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  autoRunAppAfterInstall: false,
  allowDowngrade: true,
  disableDifferentialDownload: false,
  on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    updaterListeners.set(event, [...(updaterListeners.get(event) ?? []), cb]);
  }),
  checkForUpdates: vi.fn(async () => null),
  quitAndInstall: vi.fn(),
};

vi.mock('electron', () => ({ app: appMock }));
vi.mock('electron-updater', () => ({ autoUpdater: autoUpdaterMock }));

const { afterStart, canUpdate, installUpdate, readSaved, startUpdates } = await import('./updates');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  appListeners.clear();
  updaterListeners.clear();
  appMock.isPackaged = false;
  appMock.getVersion = () => '0.1.0';
});

describe('afterStart', () => {
  it('says which release it updated to, once it runs a newer one', () => {
    expect(afterStart('20261121.1', { last: '20261120.3' })).toEqual({ updated: '20261121.1', failed: null });
  });

  it('says nothing on the same release, or on the first run with the updater', () => {
    expect(afterStart('20261121.1', { last: '20261121.1' })).toEqual({ updated: null, failed: null });
    expect(afterStart('20261121.1', {})).toEqual({ updated: null, failed: null });
  });

  it("says which release didn't install on the last quit", () => {
    expect(afterStart('20261120.3', { last: '20261120.3', installing: '20261121.1' })).toEqual({ updated: null, failed: '20261121.1' });
  });

  it('is only updated when the release that was to install did', () => {
    expect(afterStart('20261121.1', { last: '20261120.3', installing: '20261121.1' })).toEqual({ updated: '20261121.1', failed: null });
  });
});

describe('readSaved', () => {
  it('keeps only release names', () => {
    expect(readSaved({ last: '20261120.3', installing: 'x' })).toEqual({ last: '20261120.3', installing: undefined });
    expect(readSaved(null)).toEqual({ last: undefined, installing: undefined });
  });
});

describe('canUpdate', () => {
  it("is off for a build that isn't a packaged release", () => {
    expect(canUpdate()).toBe(false);
  });
});

describe('startUpdates', () => {
  it('checks 5 seconds after start and then every 10 minutes', () => {
    vi.useFakeTimers();
    vi.stubEnv('APPIMAGE', '/app/omfv.AppImage');
    appMock.isPackaged = true;
    appMock.getVersion = () => '20261121.1.0';
    const settings = { get: vi.fn(), set: vi.fn(), flush: vi.fn() };

    startUpdates(vi.fn(), settings);

    vi.advanceTimersByTime(4_999);
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});

describe('installUpdate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('APPIMAGE', '/app/omfv.AppImage');
    appMock.isPackaged = true;
    appMock.getVersion = () => '20261120.1.0';
  });

  const makeSettings = () => {
    const store = new Map<string, unknown>();
    return {
      get: (key: string) => store.get(key),
      set: vi.fn((key: string, value: unknown) => {
        store.set(key, value);
      }),
      flush: vi.fn(),
    };
  };

  it('refuses when no update is ready', async () => {
    startUpdates(() => {}, makeSettings());
    await expect(installUpdate()).rejects.toThrow('No update is ready to install.');
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
  });

  it('records installing, flushes, releases the lock, and restarts into the update in order', async () => {
    const order: string[] = [];
    const settings = makeSettings();
    settings.set.mockImplementation((_key, value) => {
      if ((value as { installing?: string })?.installing) order.push(`set:${(value as { installing?: string }).installing}`);
    });
    settings.flush.mockImplementation(() => order.push('flush'));
    const beforeRestart = vi.fn(async () => {
      order.push('beforeRestart');
    });
    appMock.releaseSingleInstanceLock.mockImplementation(() => order.push('releaseLock'));
    autoUpdaterMock.quitAndInstall.mockImplementation(() => order.push('quitAndInstall'));

    startUpdates(() => {}, settings, beforeRestart);
    for (const cb of updaterListeners.get('update-downloaded') ?? []) cb({ version: '20261121.1.0' });

    await installUpdate();
    // A second click while restarting is a no-op.
    await installUpdate();
    // `will-quit` doesn't write settings a second time after installUpdate already flushed them.
    for (const cb of appListeners.get('will-quit') ?? []) cb();

    expect(order).toEqual(['set:20261121.1', 'flush', 'beforeRestart', 'releaseLock', 'quitAndInstall']);
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(autoUpdaterMock.autoRunAppAfterInstall).toBe(true);
    expect(settings.flush).toHaveBeenCalledTimes(1);
  });
});
