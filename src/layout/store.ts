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

export const layout = {
  clear: () => set(EMPTY_LAYOUT),
  /** Returns the id of the tile showing it: a new one, or the one already showing its key. */
  add(component: ComponentSpec): string {
    set(addTile(get(), component));
    return tileWithKey(get(), component.key)!.id;
  },
  /** Adds a tile where it was dropped on the grid. Returns its id, as `add` does. */
  addAt(component: ComponentSpec, cell: Cell, cellAspect?: number): string {
    set(addTileAt(get(), component, cell, cellAspect));
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
  /** The grid's cell size on screen changed, in pixels. */
  measure: (cell: CellPx) => set(measure(get(), cell)),
  mouseEdit: (id: string, rect: Rect) => set(applyMouseEdit(get(), id, rect)),
  swap: (idA: string, idB: string) => set(swap(get(), idA, idB)),
  tiles: () => allTiles(get()),
  snapshot: () => get(),
};
