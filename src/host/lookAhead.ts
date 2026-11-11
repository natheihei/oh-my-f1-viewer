/**
 * Tiles that look past the playhead. A component says so with `looksAhead: true` in its definition,
 * and the grid doesn't draw it until the viewer allows it for that tile. Approval belongs to the
 * tile, lasts until the tile is gone, and survives its component reloading. See docs/BUILD_MODE.md.
 */
import { create } from 'zustand';

/** The scope of a suggestion's preview in the strip. A tile's scope is its id. */
export const previewScope = (key: string) => `preview:${key}`;

interface LookAheadTiles {
  approved: Record<string, true>;
}

export const useTileLookAhead = create<LookAheadTiles>(() => ({ approved: {} }));

const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _gone, ...rest } = record;
  return rest;
};

export const tileLookAhead = {
  approve(scope: string): void {
    useTileLookAhead.setState((s) => ({ approved: { ...s.approved, [scope]: true } }));
  },
  /** The tile is gone, and its approval with it. */
  forget(scope: string): void {
    if (useTileLookAhead.getState().approved[scope]) useTileLookAhead.setState((s) => ({ approved: without(s.approved, scope) }));
  },
  /** A preview became a tile: what the viewer allowed there carries over. */
  move(from: string, to: string): void {
    if (!useTileLookAhead.getState().approved[from]) return;
    useTileLookAhead.setState((s) => ({ approved: { ...without(s.approved, from), [to]: true } }));
  },
};
