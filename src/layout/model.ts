/**
 * The layout tree and every change to it, as pure functions. The tree is the source of truth:
 * GridStack only draws it and reports mouse edits. A layout knows nothing about video. A tile just
 * names a component, so charts can join later without touching this layer.
 *
 * At most one level of nesting: the root holds tiles and groups, groups hold tiles.
 */

export interface ComponentSpec {
  type: string;
  /** Unique within the layout: a second request for the same key is ignored. */
  key: string;
  label: string;
  props: Record<string, unknown>;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TileNode extends Rect {
  kind: 'tile';
  id: string;
  component: ComponentSpec;
}

export interface GroupNode extends Rect {
  kind: 'group';
  id: string;
  title: string;
  children: TileNode[];
}

export type LayoutNode = TileNode | GroupNode;

export interface LayoutState {
  nodes: LayoutNode[];
  /** The node given the largest area; the first node when unset. */
  primaryId: string | null;
  /** The mouse has moved something, so auto-layout leaves existing tiles where they are. */
  manual: boolean;
}

export const EMPTY_LAYOUT: LayoutState = { nodes: [], primaryId: null, manual: false };

export const GRID_COLUMNS = 24;
export const GRID_ROWS = 24;
export const GROUP_COLUMNS = 12;
export const GROUP_ROWS = 12;
const ZERO: Rect = { x: 0, y: 0, w: 0, h: 0 };

let nextId = 1;
const uid = (prefix: string) => `${prefix}-${nextId++}`;

/** Splits `total` into `parts` whole numbers that differ by at most one. */
function split(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const extra = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Fills a rectangle with `count` cells in the most even grid that fits. */
function tile(area: Rect, count: number): Rect[] {
  if (count === 0) return [];
  const aspect = area.w / Math.max(area.h, 1);
  const columns = Math.max(1, Math.min(count, Math.round(Math.sqrt(count * aspect))));
  const rows = Math.ceil(count / columns);
  const heights = split(area.h, rows);
  const out: Rect[] = [];
  let y = area.y;
  let remaining = count;
  for (let row = 0; row < rows; row += 1) {
    const inRow = Math.min(columns, remaining);
    const widths = split(area.w, inRow);
    let x = area.x;
    for (let c = 0; c < inRow; c += 1) {
      out.push({ x, y, w: widths[c], h: heights[row] });
      x += widths[c];
    }
    y += heights[row];
    remaining -= inRow;
  }
  return out;
}

/**
 * Broadcast-first: the primary node stays largest, and the rest fill a rail beside it, then the
 * band below it as the rail runs out of room. A group needs width for its members side by side,
 * so its presence widens the rail.
 */
export function solveRects(slots: number, hasGroup: boolean): Rect[] {
  const rest = slots - 1;
  if (slots <= 0) return [];
  if (rest === 0) return [{ x: 0, y: 0, w: GRID_COLUMNS, h: GRID_ROWS }];
  if (rest <= 3) {
    const mainW = hasGroup ? 14 : 16;
    let y = 0;
    const rail = split(GRID_ROWS, rest).map((h) => {
      const rect = { x: mainW, y, w: GRID_COLUMNS - mainW, h };
      y += h;
      return rect;
    });
    return [{ x: 0, y: 0, w: mainW, h: GRID_ROWS }, ...rail];
  }
  if (rest <= 6) {
    const main = { x: 0, y: 0, w: 16, h: 16 };
    const right = tile({ x: 16, y: 0, w: 8, h: 16 }, 2);
    const below = tile({ x: 0, y: 16, w: GRID_COLUMNS, h: 8 }, rest - 2);
    return [main, ...right, ...below];
  }
  const main = { x: 0, y: 0, w: 12, h: 12 };
  const right = tile({ x: 12, y: 0, w: 12, h: 12 }, 4);
  const below = tile({ x: 0, y: 12, w: GRID_COLUMNS, h: 12 }, rest - 4);
  return [main, ...right, ...below];
}

function layoutChildren(children: TileNode[]): TileNode[] {
  const widths = split(GROUP_COLUMNS, Math.min(children.length, 2));
  if (children.length <= 2) {
    let x = 0;
    return children.map((c, i) => {
      const placed = { ...c, x, y: 0, w: widths[i], h: GROUP_ROWS };
      x += widths[i];
      return placed;
    });
  }
  const rects = tile({ x: 0, y: 0, w: GROUP_COLUMNS, h: GROUP_ROWS }, children.length);
  return children.map((c, i) => ({ ...c, ...rects[i] }));
}

function withChildren(node: LayoutNode): LayoutNode {
  return node.kind === 'group' ? { ...node, children: layoutChildren(node.children) } : node;
}

/** Re-tile everything. Node order is insertion order and doesn't change, so a reset finds the main feed again. */
export function autoLayout(state: LayoutState): LayoutState {
  const primary = state.nodes.find((n) => n.id === state.primaryId) ?? state.nodes[0];
  const ranked = primary ? [primary, ...state.nodes.filter((n) => n !== primary)] : [];
  const rects = solveRects(ranked.length, ranked.some((n) => n.kind === 'group'));
  const rectOf = new Map(ranked.map((n, i) => [n.id, rects[i]]));
  return { ...state, nodes: state.nodes.map((n) => ({ ...withChildren(n), ...rectOf.get(n.id) })) };
}

/** The biggest empty rectangle on the grid, by brute force: the grid is small. */
export function largestFreeRect(nodes: Rect[], columns = GRID_COLUMNS, rows = GRID_ROWS): Rect {
  const occupied = Array.from({ length: rows }, () => new Array<boolean>(columns).fill(false));
  for (const n of nodes) {
    for (let y = n.y; y < Math.min(rows, n.y + n.h); y += 1) {
      for (let x = n.x; x < Math.min(columns, n.x + n.w); x += 1) occupied[y][x] = true;
    }
  }
  let best: Rect = ZERO;
  for (let y0 = 0; y0 < rows; y0 += 1) {
    for (let x0 = 0; x0 < columns; x0 += 1) {
      if (occupied[y0][x0]) continue;
      let maxWidth = columns - x0;
      for (let y1 = y0; y1 < rows; y1 += 1) {
        let w = 0;
        while (w < maxWidth && !occupied[y1][x0 + w]) w += 1;
        maxWidth = w;
        if (maxWidth === 0) break;
        const h = y1 - y0 + 1;
        if (maxWidth * h > best.w * best.h) best = { x: x0, y: y0, w: maxWidth, h };
      }
    }
  }
  return best;
}

/** A new node needs at least this much room before a manual layout gets re-tiled to make space. */
const MIN_FREE_AREA = 36;

/** After a structural change: re-tile, unless the user arranged things by hand and there's room. */
function place(state: LayoutState, added: LayoutNode | null): LayoutState {
  if (!state.manual) return autoLayout(state);
  if (!added) return state;
  const others = state.nodes.filter((n) => n !== added);
  const free = largestFreeRect(others);
  if (free.w * free.h < MIN_FREE_AREA) return autoLayout({ ...state, manual: false });
  return {
    ...state,
    nodes: state.nodes.map((n) => (n === added ? { ...withChildren(n), ...free } : n)),
  };
}

export function allTiles(state: LayoutState): TileNode[] {
  return state.nodes.flatMap((n) => (n.kind === 'tile' ? [n] : n.children));
}

export function findTile(state: LayoutState, key: string): { tile: TileNode; group: GroupNode | null } | null {
  for (const n of state.nodes) {
    if (n.kind === 'tile' && n.component.key === key) return { tile: n, group: null };
    if (n.kind === 'group') {
      const child = n.children.find((c) => c.component.key === key);
      if (child) return { tile: child, group: n };
    }
  }
  return null;
}

function newTile(component: ComponentSpec): TileNode {
  return { kind: 'tile', id: uid('tile'), component, ...ZERO };
}

export function addTile(state: LayoutState, component: ComponentSpec): LayoutState {
  if (findTile(state, component.key)) return state;
  const node = newTile(component);
  return place({ ...state, nodes: [...state.nodes, node] }, node);
}

/** Removes a tile. A group left with one member dissolves into a plain tile. */
export function removeTile(state: LayoutState, key: string): LayoutState {
  if (!findTile(state, key)) return state;
  const detached = detach(state, key);
  const primaryId = detached.nodes.some((n) => n.id === state.primaryId) ? state.primaryId : null;
  const next = { ...detached, primaryId };
  return state.manual ? { ...next, nodes: next.nodes.map(withChildren) } : autoLayout(next);
}

/** Creates a group from these components, moving any already on screen. Keeps tile ids stable. */
export function createGroup(state: LayoutState, components: ComponentSpec[], title?: string): { state: LayoutState; groupId: string } {
  const children: TileNode[] = [];
  let working = state;
  for (const component of components) {
    const found = findTile(working, component.key);
    if (found) {
      children.push({ ...found.tile });
      working = detach(working, component.key);
    } else {
      children.push(newTile(component));
    }
  }
  const group: GroupNode = {
    kind: 'group',
    id: uid('group'),
    title: title?.trim() || children.map((c) => c.component.label).join(' / '),
    children,
    ...ZERO,
  };
  return { state: place({ ...working, nodes: [...working.nodes, group] }, group), groupId: group.id };
}

/** Takes a tile out of the tree without re-tiling, as the first half of a move. */
function detach(state: LayoutState, key: string): LayoutState {
  const found = findTile(state, key);
  if (!found) return state;
  if (!found.group) return { ...state, nodes: state.nodes.filter((n) => n !== found.tile) };
  const group = found.group;
  const remaining = group.children.filter((c) => c !== found.tile);
  if (remaining.length === 0) return { ...state, nodes: state.nodes.filter((n) => n !== group) };
  if (remaining.length === 1) {
    return {
      ...state,
      nodes: state.nodes.map((n) => (n === group ? { ...remaining[0], x: group.x, y: group.y, w: group.w, h: group.h } : n)),
    };
  }
  return { ...state, nodes: state.nodes.map((n) => (n === group ? { ...group, children: remaining } : n)) };
}

function resolveGroup(state: LayoutState, ref: string): GroupNode | null {
  const needle = ref.trim().toLowerCase();
  const groups = state.nodes.filter((n): n is GroupNode => n.kind === 'group');
  return (
    groups.find((g) => g.id.toLowerCase() === needle || g.title.toLowerCase() === needle) ??
    groups.find((g) =>
      g.children.some(
        (c) => c.component.key.toLowerCase() === needle || c.component.label.toLowerCase() === needle,
      ),
    ) ??
    null
  );
}

/** Closes a group and everything in it. Returns the removed components, so streams can be released. */
export function closeGroup(state: LayoutState, ref: string): { state: LayoutState; removed: ComponentSpec[] } | null {
  const group = resolveGroup(state, ref);
  if (!group) return null;
  const nodes = state.nodes.filter((n) => n !== group);
  const primaryId = state.primaryId === group.id ? null : state.primaryId;
  const next = { ...state, nodes, primaryId };
  return { state: state.manual ? next : autoLayout(next), removed: group.children.map((c) => c.component) };
}

export function ungroup(state: LayoutState, ref: string): LayoutState | null {
  const group = resolveGroup(state, ref);
  if (!group) return null;
  const nodes = state.nodes.flatMap<LayoutNode>((n) => (n === group ? group.children : [n]));
  return autoLayout({ ...state, nodes, manual: false, primaryId: state.primaryId === group.id ? null : state.primaryId });
}

/** Makes a tile or group the largest thing on screen. A tile inside a group promotes the group. */
export function focus(state: LayoutState, ref: string): LayoutState | null {
  const group = resolveGroup(state, ref);
  const needle = ref.trim().toLowerCase();
  const tile = state.nodes.find(
    (n) =>
      n.kind === 'tile' &&
      (n.component.key.toLowerCase() === needle || n.component.label.toLowerCase() === needle),
  );
  const node = tile ?? group;
  if (!node) return null;
  return autoLayout({ ...state, primaryId: node.id, manual: false });
}

export function resetLayout(state: LayoutState): LayoutState {
  return autoLayout({ ...state, manual: false, primaryId: null });
}

/**
 * Swaps two tiles or groups, or two members of one group: dropping a tile on another. An
 * auto-laid-out grid has no empty cells, so this is what makes dragging useful.
 */
export function swap(state: LayoutState, idA: string, idB: string): LayoutState {
  const swapIn = <T extends Rect & { id: string }>(list: T[]): T[] | null => {
    const a = list.find((n) => n.id === idA);
    const b = list.find((n) => n.id === idB);
    if (!a || !b || a === b) return null;
    const rectOf = ({ x, y, w, h }: Rect): Rect => ({ x, y, w, h });
    return list.map((n) => (n === a ? { ...n, ...rectOf(b) } : n === b ? { ...n, ...rectOf(a) } : n));
  };
  const top = swapIn(state.nodes);
  if (top) return { ...state, nodes: top, manual: true };
  for (const node of state.nodes) {
    if (node.kind !== 'group') continue;
    const children = swapIn(node.children);
    if (children) {
      return { ...state, manual: true, nodes: state.nodes.map((n) => (n === node ? { ...node, children } : n)) };
    }
  }
  return state;
}

/** A mouse edit reported by the grid. */
export function applyMouseEdit(state: LayoutState, id: string, rect: Rect): LayoutState {
  let changed = false;
  const same = (n: Rect) => n.x === rect.x && n.y === rect.y && n.w === rect.w && n.h === rect.h;
  const nodes = state.nodes.map((n) => {
    if (n.id === id && !same(n)) {
      changed = true;
      return { ...n, ...rect };
    }
    if (n.kind === 'group') {
      const child = n.children.find((c) => c.id === id);
      if (child && !same(child)) {
        changed = true;
        return { ...n, children: n.children.map((c) => (c === child ? { ...c, ...rect } : c)) };
      }
    }
    return n;
  });
  return changed ? { ...state, nodes, manual: true } : state;
}
