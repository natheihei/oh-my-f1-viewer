import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../shared/release';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { watchUpdates } = await import('./updates');
const { usePalette } = await import('./palette');

let listener: ((state: UpdateState) => void) | null = null;
const fakeMain = (start: UpdateState) => {
  (globalThis as { window?: unknown }).window = {
    omfv: {
      app: {
        update: async () => start,
        onUpdate: (cb: (state: UpdateState) => void) => {
          listener = cb;
          return () => (listener = null);
        },
      },
    },
  };
};
const lines = () => usePalette.getState().entries.map((e) => `${e.role}: ${e.text}`);
const NOTHING: UpdateState = { ready: null, out: null, updated: null, failed: null };

describe('watchUpdates', () => {
  beforeEach(() => usePalette.setState({ entries: [] }));

  it('says which release the start updated to', async () => {
    fakeMain({ ...NOTHING, updated: '20261121.1' });
    await watchUpdates().reported;
    expect(lines()).toEqual(['system: Updated to OMFV 20261121.1. /whats-new lists what changed.']);
  });

  it("says, in red, which release didn't install", async () => {
    fakeMain({ ...NOTHING, failed: '20261121.1' });
    await watchUpdates().reported;
    expect(lines()).toEqual(["error: OMFV 20261121.1 didn't install. It tries again next time you start oh-my-f1-viewer."]);
  });

  it('says once that a release is ready, and again for a newer one', async () => {
    fakeMain(NOTHING);
    const { reported, off } = watchUpdates();
    await reported;
    expect(lines()).toEqual([]);
    listener!({ ...NOTHING, ready: '20261121.1' });
    listener!({ ...NOTHING, ready: '20261121.1' });
    listener!({ ...NOTHING, ready: '20261121.2' });
    expect(lines()).toEqual(['system: OMFV 20261121.1 is ready. It automatically installs next time you start oh-my-f1-viewer.', 'system: OMFV 20261121.2 is ready. It automatically installs next time you start oh-my-f1-viewer.']);
    off();
    expect(listener).toBeNull();
  });

  it('says once that a release is out, for the AUR package', async () => {
    fakeMain(NOTHING);
    await watchUpdates().reported;
    listener!({ ...NOTHING, out: '20261121.1' });
    listener!({ ...NOTHING, out: '20261121.1' });
    expect(lines()).toEqual(['system: OMFV 20261121.1 is out. Your next system update installs it.']);
  });
});
