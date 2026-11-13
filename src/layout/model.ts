/**
 * The layout tree and every change to it, as pure functions. The tree is the source of truth:
 * GridStack only draws it and reports mouse edits. A layout knows nothing about video. A tile just
 * names a component, so charts can join later without touching this layer.
 *
 * At most one level of nesting: the root holds tiles and groups, groups hold tiles.
 */
import { solve, type Slot } from './solve';

/** A component's size hint: the shape it reads best in, as width over height, and the least room its content reads in, in pixels. */
export interface SizeHint {
  aspect: number;
  min: { width: number; height: number };
}

export interface ComponentSpec {
  type: string;
  /** Unique within the layout: a second request for the same key is ignored. */
  key: string;
  label: string;
  props: Record<string, unknown>;
  /**
   * The component's size hint, when it has one. Auto-layout puts it where its shape suits and keeps it
   * at its least size while it can, and puts a new one into the gap closest to its shape.
   */
  size?: SizeHint;
  /** How its content draws, when it doesn't simply fill the tile. Auto-layout shrinks the tile to it. */
  fit?: ContentFit;
}

/**
 * `width` and `height` are the most its content ever draws, in pixels; `aspect` is a fixed shape it
 * draws at, as large as fits, such as a video's 16:9. A tile keeps its top-left corner and leaves what
 * it doesn't need empty, for a later tile to fill.
 */
export interface ContentFit {
  width?: number;
  height?: number;
  aspect?: number;
}

/** A grid cell's size on screen, in pixels. */
export interface CellPx {
  w: number;
  h: number;
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
  /** The mouse has moved something, so auto-layout leaves existing tiles where they are. */
  manual: boolean;
  /** A grid cell's size on screen. Zero until the grid is measured, and nothing is fitted till then. */
  cell: CellPx;
  /**
   * The key of the tile that has the main place in auto-layout, top left and as large as the others
   * allow. Only `setMain` assigns it. Null when none has: every tile is then laid out by its own size.
   */
  main: string | null;
}

export const EMPTY_LAYOUT: LayoutState = { nodes: [], manual: false, cell: { w: 0, h: 0 }, main: null };

export const GRID_COLUMNS = 24;
export const GRID_ROWS = 24;
export const GROUP_COLUMNS = 12;
export const GROUP_ROWS = 12;
/** Height of the bar across the top of every tile: its drag handle, label and close button. */
export const TITLE_BAR_PX = 22;
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

/** The columns and rows a tile's content needs out of `rect`. All of it when the tile has no fit, or before the grid is measured. */
function contentSize(node: LayoutNode, rect: Rect, cell: CellPx): { w: number; h: number } {
  const hint = node.kind === 'tile' ? node.component.fit : undefined;
  if (!hint || !(cell.w > 0 && cell.h > 0)) return { w: rect.w, h: rect.h };
  let { w, h } = rect;
  if (hint.width) w = Math.min(w, Math.ceil(hint.width / cell.w));
  if (hint.height) h = Math.min(h, Math.ceil((hint.height + TITLE_BAR_PX) / cell.h));
  if (hint.aspect) {
    const boxW = w * cell.w;
    const boxH = h * cell.h - TITLE_BAR_PX;
    // Shapes are compared with a hair of slack, so rounding a pixel doesn't take a whole row off.
    if (boxW / boxH < hint.aspect * 0.99) h = Math.min(h, Math.ceil((boxW / hint.aspect + TITLE_BAR_PX) / cell.h));
    else if (boxW / boxH > hint.aspect * 1.01) w = Math.min(w, Math.ceil((boxH * hint.aspect) / cell.w));
  }
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

/** Shrinks a tile to its content, keeping its top-left corner: what it doesn't need stays empty. */
function fit<T extends LayoutNode>(node: T, cell: CellPx): T {
  const { w, h } = contentSize(node, node, cell);
  return w === node.w && h === node.h ? node : { ...node, w, h };
}

/** The cell auto-layout reasons with before the grid is measured: a 16:9 window. */
const NOMINAL_CELL: CellPx = { w: 1600 / GRID_COLUMNS, h: 900 / GRID_ROWS };
const measured = (cell: CellPx): CellPx => (cell.w > 0 && cell.h > 0 ? cell : NOMINAL_CELL);

/** A size hint's least room, in whole cells: the tile's, so with its title bar. */
export function minCells(size: SizeHint | undefined, cell: CellPx): [number, number] {
  if (!size) return [1, 1];
  const { w, h } = measured(cell);
  return [Math.max(1, Math.ceil(size.min.width / w)), Math.max(1, Math.ceil((size.min.height + TITLE_BAR_PX) / h))];
}

/** A group's members are videos side by side: it needs room for each. */
const GROUP_MEMBER = { aspect: 16 / 9, min: { width: 320, height: 180 } };

/** What the solver needs to know of a node. */
function slotOf(node: LayoutNode, cell: CellPx): Slot {
  const fitTo = (room: { w: number; h: number }) => contentSize(node, { x: 0, y: 0, ...room }, cell);
  if (node.kind === 'group') {
    const across = Math.min(node.children.length, 2);
    const down = Math.ceil(node.children.length / 2);
    const [w, h] = minCells({ aspect: 1, min: { width: GROUP_MEMBER.min.width * across, height: GROUP_MEMBER.min.height * down } }, cell);
    return { aspect: (GROUP_MEMBER.aspect * across) / down, min: { w, h }, fit: fitTo, capped: false };
  }
  const { size, fit: hint } = node.component;
  const capped = Boolean(hint?.width || hint?.height);
  if (!size) return { aspect: hint?.aspect ?? 16 / 9, min: { w: 0, h: 0 }, fit: fitTo, capped };
  const [w, h] = minCells(size, cell);
  return { aspect: size.aspect, min: { w, h }, fit: fitTo, capped };
}

/** The root node that is the main tile, or holds it. */
function mainIndex(state: LayoutState): number | null {
  if (state.main === null) return null;
  const at = state.nodes.findIndex((n) => (n.kind === 'tile' ? n.component.key === state.main : n.children.some((c) => c.component.key === state.main)));
  return at >= 0 ? at : null;
}

/**
 * Re-tiles everything, discarding manual moves and resizes. The main tile, when one is assigned, goes
 * top left, and the rest beside or below it by shape, in the order they were added. See `solve`.
 */
export function autoLayout(state: LayoutState): LayoutState {
  const { nodes } = state;
  const grid = { columns: GRID_COLUMNS, rows: GRID_ROWS, cell: measured(state.cell), titleBar: TITLE_BAR_PX };
  const boxes = solve(
    nodes.map((n) => slotOf(n, state.cell)),
    grid,
    mainIndex(state),
  );
  return { ...state, manual: false, nodes: nodes.map((n, i) => withChildren({ ...n, ...boxes[i] })) };
}

const rectsOf = (nodes: LayoutNode[]) => JSON.stringify(nodes.map(({ id, x, y, w, h }) => [id, x, y, w, h]));

/**
 * The grid was measured. An auto layout re-tiles when that changes where re-tiling would put things;
 * otherwise nothing moves, so a window drag doesn't shuffle tiles every frame, and a tile that went
 * into a gap stays there.
 */
export function measure(state: LayoutState, cell: CellPx): LayoutState {
  if ((cell.w === state.cell.w && cell.h === state.cell.h) || !(cell.w > 0 && cell.h > 0)) return state;
  const next = { ...state, cell };
  if (state.manual) return next;
  const retiled = autoLayout(next);
  return rectsOf(retiled.nodes) === rectsOf(autoLayout(state).nodes) ? next : retiled;
}

function occupancy(nodes: Rect[], columns: number, rows: number): boolean[][] {
  const occupied = Array.from({ length: rows }, () => new Array<boolean>(columns).fill(false));
  for (const n of nodes) {
    for (let y = Math.max(0, n.y); y < Math.min(rows, n.y + n.h); y += 1) {
      for (let x = Math.max(0, n.x); x < Math.min(columns, n.x + n.w); x += 1) occupied[y][x] = true;
    }
  }
  return occupied;
}

/** Every empty rectangle at least `min` cells that is as wide as it can be for its rows, by brute force: the grid is small. */
function freeRects(nodes: Rect[], min: [number, number], columns: number, rows: number): Rect[] {
  const occupied = occupancy(nodes, columns, rows);
  const out: Rect[] = [];
  for (let y0 = 0; y0 < rows; y0 += 1) {
    for (let x0 = 0; x0 < columns; x0 += 1) {
      if (occupied[y0][x0]) continue;
      let maxWidth = columns - x0;
      for (let y1 = y0; y1 < rows; y1 += 1) {
        let w = 0;
        while (w < maxWidth && !occupied[y1][x0 + w]) w += 1;
        maxWidth = w;
        if (maxWidth < min[0]) break;
        const h = y1 - y0 + 1;
        if (h >= min[1]) out.push({ x: x0, y: y0, w: maxWidth, h });
      }
    }
  }
  return out;
}

/** True when no side of `r` can move out a cell into empty space. */
function maximal(r: Rect, occupied: boolean[][], columns: number, rows: number): boolean {
  const free = (x0: number, y0: number, w: number, h: number) => {
    if (x0 < 0 || y0 < 0 || x0 + w > columns || y0 + h > rows) return false;
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) if (occupied[y][x]) return false;
    return true;
  };
  return !free(r.x - 1, r.y, 1, r.h) && !free(r.x + r.w, r.y, 1, r.h) && !free(r.x, r.y - 1, r.w, 1) && !free(r.x, r.y + r.h, r.w, 1);
}

/**
 * The biggest empty rectangle on the grid that is at least `min` cells. Empty when there is none.
 */
export function largestFreeRect(nodes: Rect[], min: [number, number] = [1, 1], columns = GRID_COLUMNS, rows = GRID_ROWS): Rect {
  return freeRects(nodes, min, columns, rows).reduce((best, r) => (area(r) > area(best) ? r : best), ZERO);
}

/**
 * The gap for a tile of this shape: of the gaps at least `min` cells that can't grow any further, the
 * one closest to `aspect` as it looks on screen, then the biggest. Empty when there is none.
 */
export function gapFor(nodes: Rect[], min: [number, number], aspect: number, cell: CellPx, columns = GRID_COLUMNS, rows = GRID_ROWS): Rect {
  const occupied = occupancy(nodes, columns, rows);
  const [cw, ch] = cell.w > 0 && cell.h > 0 ? [cell.w, cell.h] : [1, 1];
  const off = (r: Rect) => Math.abs(Math.log((r.w * cw) / Math.max(1, r.h * ch - (cell.h > 0 ? TITLE_BAR_PX : 0)) / aspect));
  let best: Rect = ZERO;
  for (const r of freeRects(nodes, min, columns, rows)) {
    if (!maximal(r, occupied, columns, rows)) continue;
    if (area(best) === 0 || off(r) < off(best) - 1e-9 || (Math.abs(off(r) - off(best)) <= 1e-9 && area(r) > area(best))) best = r;
  }
  return best;
}

/** A new node needs at least this much room before a manual layout gets re-tiled to make space. */
const MIN_FREE_AREA = 36;

/**
 * After a structural change. An auto layout puts a tile with a size hint into the gap closest to its
 * shape that meets its least size, so nothing on screen moves, and re-tiles when no gap does. A hand-arranged
 * layout uses its biggest gap for anything, and re-tiles only when that is too small.
 */
function place(state: LayoutState, added: LayoutNode | null): LayoutState {
  if (!added) return state.manual ? state : autoLayout(state);
  const others = state.nodes.filter((n) => n !== added);
  const into = (free: Rect) => ({
    ...state,
    nodes: state.nodes.map((n) => (n === added ? fit({ ...withChildren(n), ...free }, state.cell) : n)),
  });
  if (!state.manual) {
    const size = added.kind === 'tile' ? added.component.size : undefined;
    const free = size ? gapFor(others, minCells(size, state.cell), size.aspect, state.cell) : ZERO;
    return area(free) > 0 ? into(free) : autoLayout(state);
  }
  const free = largestFreeRect(others);
  return area(free) < MIN_FREE_AREA ? autoLayout(state) : into(free);
}

export function allTiles(state: Pick<LayoutState, 'nodes'>): TileNode[] {
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

/** A cell on the grid, in grid units. */
export interface Cell {
  x: number;
  y: number;
}

const area = (r: Rect) => r.w * r.h;
const contains = (r: Rect, { x, y }: Cell) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** The biggest empty rectangle that covers a cell, or null if the cell is taken. */
export function freeRectAt(nodes: Rect[], cell: Cell, columns = GRID_COLUMNS, rows = GRID_ROWS): Rect | null {
  const taken = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (const n of nodes) {
    for (let y = n.y; y < Math.min(rows, n.y + n.h); y += 1) {
      for (let x = n.x; x < Math.min(columns, n.x + n.w); x += 1) taken[y + 1][x + 1] = 1;
    }
  }
  // Prefix sums, so asking whether a rectangle is empty is four lookups.
  for (let y = 1; y <= rows; y += 1) {
    for (let x = 1; x <= columns; x += 1) taken[y][x] += taken[y - 1][x] + taken[y][x - 1] - taken[y - 1][x - 1];
  }
  const filled = (x0: number, y0: number, x1: number, y1: number) => taken[y1][x1] - taken[y0][x1] - taken[y1][x0] + taken[y0][x0];
  if (filled(cell.x, cell.y, cell.x + 1, cell.y + 1) > 0) return null;
  let best: Rect | null = null;
  for (let y0 = cell.y; y0 >= 0; y0 -= 1) {
    for (let x0 = cell.x; x0 >= 0; x0 -= 1) {
      if (filled(x0, y0, cell.x + 1, cell.y + 1) > 0) break;
      for (let y1 = cell.y + 1; y1 <= rows; y1 += 1) {
        if (filled(x0, y0, cell.x + 1, y1) > 0) break;
        let x1 = cell.x + 1;
        while (x1 < columns && filled(x0, y0, x1 + 1, y1) === 0) x1 += 1;
        const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        if (!best || area(rect) > area(best)) best = rect;
      }
    }
  }
  return best;
}

/**
 * Where a tile dropped on this cell goes. On empty space, it fills the biggest gap there. On a
 * node, that node splits across its longer side as it looks on screen, and the new tile takes the
 * half under the cell. `cellAspect` is a cell's width over its height. Null when the node is too
 * small to split.
 */
export function dropTarget(state: LayoutState, cell: Cell, cellAspect = 1): { rect: Rect; split: LayoutNode | null } | null {
  const node = state.nodes.find((n) => contains(n, cell));
  if (!node) {
    const rect = freeRectAt(state.nodes, cell);
    return rect ? { rect, split: null } : null;
  }
  const across = node.w * cellAspect >= node.h;
  const size = across ? node.w : node.h;
  if (size < 2) return null;
  const first = Math.floor(size / 2);
  const inFirst = across ? cell.x < node.x + first : cell.y < node.y + first;
  const halves: [Rect, Rect] = across
    ? [
        { x: node.x, y: node.y, w: first, h: node.h },
        { x: node.x + first, y: node.y, w: size - first, h: node.h },
      ]
    : [
        { x: node.x, y: node.y, w: node.w, h: first },
        { x: node.x, y: node.y + first, w: node.w, h: size - first },
      ];
  return { rect: inFirst ? halves[0] : halves[1], split: node };
}

/** Adds a tile where it was dropped, which makes the layout manual. Falls back to `addTile`. */
export function addTileAt(state: LayoutState, component: ComponentSpec, cell: Cell, cellAspect = 1): LayoutState {
  if (findTile(state, component.key)) return state;
  const target = dropTarget(state, cell, cellAspect);
  if (!target) return addTile(state, component);
  const { rect, split } = target;
  const node: TileNode = { ...newTile(component), ...rect };
  const nodes = state.nodes.map((n) => {
    if (n !== split) return n;
    const rest = rectMinus(n, rect);
    return withChildren({ ...n, ...rest });
  });
  return { ...state, nodes: [...nodes, node], manual: true };
}

/** What's left of a node once one of its halves is taken. */
function rectMinus(r: Rect, half: Rect): Rect {
  if (half.x === r.x && half.w < r.w) return { x: r.x + half.w, y: r.y, w: r.w - half.w, h: r.h };
  if (half.x > r.x) return { x: r.x, y: r.y, w: r.w - half.w, h: r.h };
  if (half.y === r.y && half.h < r.h) return { x: r.x, y: r.y + half.h, w: r.w, h: r.h - half.h };
  return { x: r.x, y: r.y, w: r.w, h: r.h - half.h };
}

/**
 * Gives a tile the main place, or with null takes it from whichever has it. An auto layout re-tiles, and a
 * hand-arranged one keeps its places until it is next re-tiled. A key that isn't on screen changes nothing.
 */
export function setMain(state: LayoutState, key: string | null): LayoutState {
  if (key === state.main || (key !== null && !findTile(state, key))) return state;
  const next = { ...state, main: key };
  return state.manual ? next : autoLayout(next);
}

/**
 * Puts `component` in the tile with id `id`, in its place, as when a tile's props change. Ignored when no
 * tile has that id or another tile already has the new key. The main place follows the tile.
 */
export function replaceComponent(state: LayoutState, id: string, component: ComponentSpec): LayoutState {
  const tile = allTiles(state).find((t) => t.id === id);
  if (!tile) return state;
  const other = findTile(state, component.key);
  if (other && other.tile.id !== id) return state;
  const swapIn = (t: TileNode): TileNode => (t.id === id ? { ...t, component } : t);
  const nodes = state.nodes.map((n) => (n.kind === 'tile' ? swapIn(n) : { ...n, children: n.children.map(swapIn) }));
  return { ...state, nodes, main: state.main === tile.component.key ? component.key : state.main };
}

/** Removes a tile. A group left with one member dissolves into a plain tile. The main tile takes its place with it: no other is promoted. */
export function removeTile(state: LayoutState, key: string): LayoutState {
  if (!findTile(state, key)) return state;
  const next = { ...detach(state, key), main: state.main === key ? null : state.main };
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
  const next = { ...state, nodes, main: group.children.some((c) => c.component.key === state.main) ? null : state.main };
  return { state: state.manual ? next : autoLayout(next), removed: group.children.map((c) => c.component) };
}

export function ungroup(state: LayoutState, ref: string): LayoutState | null {
  const group = resolveGroup(state, ref);
  if (!group) return null;
  const nodes = state.nodes.flatMap<LayoutNode>((n) => (n === group ? group.children : [n]));
  return autoLayout({ ...state, nodes });
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
