/** The live layout, and the operations other layers use to change it. */
import { create } from 'zustand';
import {
  addTile,
  addTileAt,
  allTiles,
  applyMouseEdit,
  autoLayout,
  closeGroup,
  createGroup,
  EMPTY_LAYOUT,
  findTile,
  measure,
  removeTile,
  setMain,
  swap,
  ungroup,
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
  add: (component: ComponentSpec) => set(addTile(get(), component)),
  /** Adds a tile where it was dropped on the grid. */
  addAt: (component: ComponentSpec, cell: Cell, cellAspect?: number) => set(addTileAt(get(), component, cell, cellAspect)),
  remove: (key: string) => set(removeTile(get(), key)),
  /** Removes a tile by its id, as the close button on its title bar does. */
  close(id: string): boolean {
    const tile = allTiles(get()).find((t) => t.id === id);
    if (tile) set(removeTile(get(), tile.component.key));
    return tile != null;
  },
  has: (key: string) => findTile(get(), key) != null,
  group(components: ComponentSpec[], title?: string): string {
    const { state, groupId } = createGroup(get(), components, title);
    set(state);
    return groupId;
  },
  closeGroup(ref: string): ComponentSpec[] | null {
    const result = closeGroup(get(), ref);
    if (!result) return null;
    set(result.state);
    return result.removed;
  },
  ungroup(ref: string): boolean {
    const next = ungroup(get(), ref);
    if (next) set(next);
    return next != null;
  },
  /** Gives a tile the main place by its key, or takes it away with null. */
  setMain: (key: string | null) => set(setMain(get(), key)),
  /** Re-tiles the grid, discarding manual moves and resizes. */
  autoLayout: () => set(autoLayout(get())),
  /** The grid's cell size on screen changed, in pixels. */
  measure: (cell: CellPx) => set(measure(get(), cell)),
  mouseEdit: (id: string, rect: Rect) => set(applyMouseEdit(get(), id, rect)),
  swap: (idA: string, idB: string) => set(swap(get(), idA, idB)),
  tiles: () => allTiles(get()),
  snapshot: () => get(),
};
