/**
 * Anonymous usage counts, for the shell: the notice, `/settings-usage`, and what it counts on screen. Main
 * checks every event against shared/telemetry.ts and sends it: see electron/telemetry.ts.
 */
import { telemetryInfo, tileKind, track } from '../data/telemetry';
import { useLayout } from '../layout/store';

export const telemetryOps = {
  ...telemetryInfo,
  /** Counts one of the events the renderer may send. Never throws. */
  track,
  /** Counts each tile that's new on the grid, until the returned function stops it. A tile keeps its id while it's on screen. */
  countTiles(): () => void {
    let seen = new Set(useLayout.getState().tiles.map((t) => t.id));
    return useLayout.subscribe((state) => {
      const now = new Set<string>();
      for (const tile of state.tiles) {
        now.add(tile.id);
        if (!seen.has(tile.id)) track('tile_added', { tile: tileKind(tile.component.type) });
      }
      seen = now;
    });
  },
};
