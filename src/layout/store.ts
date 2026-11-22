/** The live layout, and the operations other layers use to change it. */
import { create } from 'zustand';
import {
  addTile,
  addTileAt,
  allTiles,
  applyMouseEdit,
  autoLayout,
  EMPTY_LAYOUT,
  findTile,
  measure,
  removeTile,
  resized,
  replaceComponent,
  setMain,
  swap,
  tileWithKey,
  type Cell,
  type CellPx,
  type ComponentSpec,
  type LayoutState,
  type Rect,
} from './model';

export const useLayout = create<LayoutState>(() => EMPTY_LAYOUT);

const set = (next: LayoutState) => useLayout.setState(next, true);
const get = () => useLayout.getState();

/** How long the grid's size must hold still before the layout is re-tiled for it, in milliseconds. */
export const RESIZE_SETTLE_MS = 150;
/** The cell size the tiles were last laid out for, while a resize is under way, and the timer that ends it. */
let resizedFrom: CellPx | null = null;
let settling: ReturnType<typeof setTimeout> | null = null;

/** The resize has settled: the layout is re-tiled if the new size puts tiles elsewhere than the old one did. */
function settle(): void {
  settling = null;
  const from = resizedFrom;
  resizedFrom = null;
  if (from) set(measure({ ...get(), cell: from }, get().cell));
}

export const layout = {
  clear: () => set(EMPTY_LAYOUT),
  /** Returns the id of the tile showing it: a new one, or the one already showing its key. `group` is what it's added with: see `Tile.group`. */
  add(component: ComponentSpec, group?: string): string {
    set(addTile(get(), component, group));
    return tileWithKey(get(), component.key)!.id;
  },
  /** Adds a tile where it was dropped on the grid. Returns its id, as `add` does. */
  addAt(component: ComponentSpec, cell: Cell, cellAspect?: number, group?: string): string {
    set(addTileAt(get(), component, cell, cellAspect, group));
    return tileWithKey(get(), component.key)!.id;
  },
  /** Removes a tile by its id. Returns whether it was on screen. */
  remove(id: string): boolean {
    const found = findTile(get(), id) != null;
    if (found) set(removeTile(get(), id));
    return found;
  },
  /** Gives the tile with `id` another component in its place. Returns whether it was on screen. */
  replace(id: string, component: ComponentSpec): boolean {
    const next = replaceComponent(get(), id, component);
    if (next) set(next);
    return next != null;
  },
  /** Gives a tile the main place by its id, or takes it away with null. */
  setMain: (id: string | null) => set(setMain(get(), id)),
  /** Re-tiles the grid, discarding manual moves and resizes. */
  autoLayout: () => set(autoLayout(get())),
  /**
   * The grid's cell size on screen changed, in pixels. The first measurement lays tiles out at once.
   * After that the tiles scale with the grid while its size keeps changing, as a window drag does
   * every frame, and are re-tiled once it has held still for `RESIZE_SETTLE_MS`.
   */
  measure(cell: CellPx): void {
    const state = get();
    if (!(state.cell.w > 0 && state.cell.h > 0)) return set(measure(state, cell));
    const next = resized(state, cell);
    if (next === state) return;
    resizedFrom ??= state.cell;
    set(next);
    if (settling) clearTimeout(settling);
    settling = setTimeout(settle, RESIZE_SETTLE_MS);
  },
  mouseEdit: (id: string, rect: Rect) => set(applyMouseEdit(get(), id, rect)),
  swap: (idA: string, idB: string) => set(swap(get(), idA, idB)),
  tiles: () => allTiles(get()),
  snapshot: () => get(),
};
