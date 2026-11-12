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
  /**
   * The component's size hint in grid cells, when it has one: its shape, and the least room it reads
   * in. Auto-layout shares a column of tiles by their least height when every one of them has a hint,
   * and puts a new one into the gap closest to its shape.
   */
  size?: { aspect: number; min: [number, number] };
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
}

export const EMPTY_LAYOUT: LayoutState = { nodes: [], manual: false, cell: { w: 0, h: 0 } };

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

/**
 * Splits `total` in proportion to `weights`, in whole numbers of at least one. Without a weight for
 * every part, or with too little to go round, it splits evenly instead.
 */
function share(total: number, weights: ReadonlyArray<number | null>): number[] {
  const known = weights.filter((w): w is number => w !== null && w > 0);
  const sum = known.reduce((a, w) => a + w, 0);
  if (known.length !== weights.length || total < weights.length) return split(total, weights.length);
  const exact = known.map((w) => (total * w) / sum);
  const out = exact.map((v) => Math.max(1, Math.floor(v)));
  // What rounding down left over goes to the largest remainders, and any excess comes off the largest parts.
  const byRemainder = exact.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0, left = total - out.reduce((a, v) => a + v, 0); left > 0; k += 1, left -= 1) out[byRemainder[k % out.length].i] += 1;
  while (out.reduce((a, v) => a + v, 0) > total) out[out.indexOf(Math.max(...out))] -= 1;
  return out;
}

/** Stacks `heights` rows down a column of `area`, top to bottom. */
function column(area: Rect, heights: number[]): Rect[] {
  let y = area.y;
  return heights.map((h) => {
    const rect = { x: area.x, y, w: area.w, h };
    y += h;
    return rect;
  });
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
 *
 * `heights` holds each slot's least height from its size hint, or null without one. Tiles stacked
 * in the column beside the primary share it in proportion to those, so a tall timing tower gets more
 * rows than a small card, but only when every tile in that column has a hint: a video's never
 * changes. Nothing else moves.
 */
export function solveRects(slots: number, hasGroup: boolean, heights: ReadonlyArray<number | null> = []): Rect[] {
  const rest = slots - 1;
  if (slots <= 0) return [];
  if (rest === 0) return [{ x: 0, y: 0, w: GRID_COLUMNS, h: GRID_ROWS }];
  const hint = (i: number) => heights[i] ?? null;
  if (rest <= 3) {
    const mainW = hasGroup ? 14 : 16;
    const rail = column(
      { x: mainW, y: 0, w: GRID_COLUMNS - mainW, h: GRID_ROWS },
      share(GRID_ROWS, Array.from({ length: rest }, (_, i) => hint(i + 1))),
    );
    return [{ x: 0, y: 0, w: mainW, h: GRID_ROWS }, ...rail];
  }
  if (rest <= 6) {
    const main = { x: 0, y: 0, w: 16, h: 16 };
    const right = column({ x: 16, y: 0, w: 8, h: 16 }, share(16, [hint(1), hint(2)]));
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

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Moves each node up into empty rows above it, top first, so the space tiles leave collects at the bottom. */
function rise<T extends Rect & { id: string }>(nodes: T[]): T[] {
  const placed: Rect[] = [];
  const moved = new Map<string, T>();
  for (const n of [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let y = n.y;
    while (y > 0 && !placed.some((p) => overlaps({ x: n.x, y: y - 1, w: n.w, h: 1 }, p))) y -= 1;
    const node = y === n.y ? n : { ...n, y };
    placed.push(node);
    moved.set(n.id, node);
  }
  return nodes.map((n) => moved.get(n.id)!);
}

/**
 * Re-tiles everything, discarding manual moves and resizes. Nodes are ranked by insertion order, which
 * doesn't change: the first one added gets the largest slot.
 */
export function autoLayout(state: LayoutState): LayoutState {
  const { nodes } = state;
  const heights = nodes.map((n) => (n.kind === 'tile' ? (n.component.size?.min[1] ?? null) : null));
  const rects = solveRects(nodes.length, nodes.some((n) => n.kind === 'group'), heights);
  return { ...state, manual: false, nodes: rise(nodes.map((n, i) => fit({ ...withChildren(n), ...rects[i] }, state.cell))) };
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
    const free = size ? gapFor(others, size.min, size.aspect, state.cell) : ZERO;
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

/** Removes a tile. A group left with one member dissolves into a plain tile. */
export function removeTile(state: LayoutState, key: string): LayoutState {
  if (!findTile(state, key)) return state;
  const next = detach(state, key);
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
  const next = { ...state, nodes };
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
