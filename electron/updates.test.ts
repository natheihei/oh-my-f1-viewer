import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '0.1.0' } }));
vi.mock('electron-updater', () => ({ autoUpdater: {} }));

const { afterStart, canUpdate, readSaved } = await import('./updates');

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
