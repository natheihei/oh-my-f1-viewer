/** The live layout, and the operations other layers use to change it. */
import { create } from 'zustand';
import {
  addTile,
  allTiles,
  applyMouseEdit,
  closeGroup,
  createGroup,
  EMPTY_LAYOUT,
  findTile,
  focus,
  removeTile,
  resetLayout,
  swap,
  ungroup,
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
  remove: (key: string) => set(removeTile(get(), key)),
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
  focus(ref: string): boolean {
    const next = focus(get(), ref);
    if (next) set(next);
    return next != null;
  },
  reset: () => set(resetLayout(get())),
  mouseEdit: (id: string, rect: Rect) => set(applyMouseEdit(get(), id, rect)),
  swap: (idA: string, idB: string) => set(swap(get(), idA, idB)),
  tiles: () => allTiles(get()),
  snapshot: () => get(),
};
