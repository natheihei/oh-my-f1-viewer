import { afterEach, describe, expect, it, vi } from 'vitest';

const appMock = {
  isPackaged: false,
  getVersion: () => '0.1.0',
  on: vi.fn(),
};
const autoUpdaterMock = {
  logger: null as unknown,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  allowDowngrade: true,
  disableDifferentialDownload: false,
  on: vi.fn(),
  checkForUpdates: vi.fn(async () => null),
};

vi.mock('electron', () => ({ app: appMock }));
vi.mock('electron-updater', () => ({ autoUpdater: autoUpdaterMock }));

const { afterStart, canUpdate, readSaved, startUpdates } = await import('./updates');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
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
