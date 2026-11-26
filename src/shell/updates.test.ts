import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../shared/release';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { watchUpdates } = await import('./updates');
const { palette, usePalette } = await import('./palette');

let listener: ((state: UpdateState) => void) | null = null;
let installUpdate = vi.fn(async () => {});
const fakeMain = (start: UpdateState) => {
  installUpdate = vi.fn(async () => {});
  (globalThis as { window?: unknown }).window = {
    omfv: {
      app: {
        update: async () => start,
        onUpdate: (cb: (state: UpdateState) => void) => {
          listener = cb;
          return () => (listener = null);
        },
        installUpdate: () => installUpdate(),
      },
    },
  };
};
const lines = () => usePalette.getState().entries.map((e) => `${e.role}: ${e.text}`);
const NOTHING: UpdateState = { ready: null, updated: null, failed: null };

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
    expect(lines()).toEqual(['system: OMFV 20261121.1 is ready.', 'system: OMFV 20261121.2 is ready.']);
    expect(usePalette.getState().entries.map((e) => e.action?.label)).toEqual(['restart to update', 'restart to update']);
    off();
    expect(listener).toBeNull();
  });

  it('offers a one-click restart button that installs the ready update', async () => {
    fakeMain({ ...NOTHING, ready: '20261121.1' });
    await watchUpdates().reported;
    const entry = usePalette.getState().entries[0];
    expect(entry.action?.label).toBe('restart to update');
    palette.act(entry.id);
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(usePalette.getState().entries[0].action).toBeUndefined();
    expect(lines().at(-1)).toBe('system: Restarting to install OMFV 20261121.1…');
  });

  it('reports an error if restarting to install fails', async () => {
    fakeMain({ ...NOTHING, ready: '20261121.1' });
    installUpdate.mockRejectedValueOnce(new Error("Error invoking remote method 'app:install-update': Error: No update is ready to install."));
    await watchUpdates().reported;
    palette.act(usePalette.getState().entries[0].id);
    await vi.waitFor(() => {
      expect(lines().at(-1)).toBe("error: Couldn't restart to install OMFV 20261121.1: No update is ready to install.");
    });
  });
});
