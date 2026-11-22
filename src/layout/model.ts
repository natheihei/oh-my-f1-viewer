/**
 * The layout tree and every change to it, as pure functions. The tree is the source of truth:
 * GridStack only draws it and reports mouse edits. A layout knows nothing about video. A tile just
 * names a component, so charts can join later without touching this layer.
 *
 * Once a component is on screen it is a tile, and a tile is named by its id: it keeps it through
 * moves, resizes and new props, till it's taken off screen. Ids are only unique while the app runs.
 * A component's key only keeps the same thing from being added twice.
 */
import { arrange, LEAST_ROOM, solve, type Slot } from './solve';

/** A component's size hint: the shape it reads best in, as width over height, and the least room its content reads in, in pixels. */
export interface SizeHint {
  aspect: number;
  min: { width: number; height: number };
}

export interface ComponentSpec {
  type: string;
  /**
   * Made from its type and props, and unique on screen: adding a component whose key is already on
   * screen adds nothing. It follows the props, so it doesn't name a tile: the tile's id does.
   */
  key: string;
  /** What the tile is called, as text: its name, then its drivers' codes. */
  label: string;
  /**
   * The label's parts, when it names drivers: the title bar draws each as a driver code, from the roster.
   * Without it, the title bar shows `label`.
   */
  title?: { name: string; drivers: number[] };
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

export interface Tile extends Rect {
  /** What names this tile while it's on screen, such as "tile-3". A tile added again later gets a new one. */
  id: string;
  component: ComponentSpec;
}

export interface LayoutState {
  /** In the order they were added. */
  tiles: Tile[];
  /** The mouse has moved something, so auto-layout leaves existing tiles where they are. */
  manual: boolean;
  /** A grid cell's size on screen. Zero until the grid is measured, and nothing is fitted till then. */
  cell: CellPx;
  /**
   * The id of the tile that has the main place in auto-layout, top left and as large as the others
   * allow. Only `setMain` assigns it. Null when none has: every tile is then laid out by its own size.
   */
  main: string | null;
}

export const EMPTY_LAYOUT: LayoutState = { tiles: [], manual: false, cell: { w: 0, h: 0 }, main: null };

export const GRID_COLUMNS = 24;
export const GRID_ROWS = 24;
/** Height of the bar across the top of every tile: its drag handle, label and close button. */
export const TITLE_BAR_PX = 22;
const ZERO: Rect = { x: 0, y: 0, w: 0, h: 0 };

let nextId = 1;
const newId = () => `tile-${nextId++}`;

/** The columns and rows a tile's content needs out of `rect`. All of it when the tile has no fit, or before the grid is measured. */
function contentSize(tile: Tile, rect: Rect, cell: CellPx): { w: number; h: number } {
  const hint = tile.component.fit;
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
function fit(tile: Tile, cell: CellPx): Tile {
  const { w, h } = contentSize(tile, tile, cell);
  return w === tile.w && h === tile.h ? tile : { ...tile, w, h };
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

/** What the solver needs to know of a tile. */
function slotOf(tile: Tile, cell: CellPx): Slot {
  const fitTo = (room: { w: number; h: number }) => contentSize(tile, { x: 0, y: 0, ...room }, cell);
  const { size, fit: hint } = tile.component;
  const capped = Boolean(hint?.width || hint?.height);
  if (!size) return { aspect: hint?.aspect ?? 16 / 9, min: { w: 0, h: 0 }, fit: fitTo, capped };
  const [w, h] = minCells(size, cell);
  return { aspect: size.aspect, min: { w, h }, fit: fitTo, capped };
}

/** Where the main tile is in `tiles`. */
function mainIndex(state: LayoutState): number | null {
  const at = state.main === null ? -1 : state.tiles.findIndex((t) => t.id === state.main);
  return at >= 0 ? at : null;
}

/**
 * Re-tiles everything, discarding manual moves and resizes. The main tile, when one is assigned, goes
 * top left, and the rest beside or below it by shape, in the order they were added. See `solve`.
 */
export function autoLayout(state: LayoutState): LayoutState {
  return laidOut(state, solved('solve', state, () => solve(...problem(state))));
}

/** How many of the last problems' answers are kept. A resize asks for the old size's and the new one's. */
const KEPT_SOLVES = 4;
const solves = new Map<string, Rect[] | null>();

/**
 * What the solver gives for a layout, worked out once: the same tiles at the same cell size have the
 * same answer, and a resize asks again for the one the tiles are already in. `how` is which of the
 * solver's two entries is asked.
 */
function solved<T extends Rect[] | null>(how: string, state: LayoutState, work: () => T): T {
  const tiles = state.tiles.map((t) => [t.id, t.component.type, t.component.key, t.component.size, t.component.fit]);
  const key = JSON.stringify([how, state.cell, state.main, tiles]);
  const kept = solves.get(key);
  if (kept !== undefined) return kept as T;
  const boxes = work();
  solves.set(key, boxes);
  if (solves.size > KEPT_SOLVES) solves.delete(solves.keys().next().value!);
  return boxes;
}

/** What the solver is given for a layout: its tiles' slots, the grid, and which is the main one. */
const problem = (state: LayoutState) =>
  [state.tiles.map((t) => slotOf(t, state.cell)), { columns: GRID_COLUMNS, rows: GRID_ROWS, cell: measured(state.cell), titleBar: TITLE_BAR_PX }, mainIndex(state)] as const;

/** The layout with each tile in its box, in order: an auto layout again. */
const laidOut = (state: LayoutState, boxes: Rect[]): LayoutState => ({ ...state, manual: false, tiles: state.tiles.map((t, i) => ({ ...t, ...boxes[i] })) });

const rectsOf = (tiles: Tile[]) => JSON.stringify(tiles.map(({ id, x, y, w, h }) => [id, x, y, w, h]));

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
  return rectsOf(retiled.tiles) === rectsOf(autoLayout(state).tiles) ? next : retiled;
}

/**
 * The grid's cell size changed and nothing is re-tiled yet, as while the window is being dragged: tiles
 * keep their cells, so they scale with the grid. `measure` from the size before then decides what moves.
 */
export function resized(state: LayoutState, cell: CellPx): LayoutState {
  if ((cell.w === state.cell.w && cell.h === state.cell.h) || !(cell.w > 0 && cell.h > 0)) return state;
  return { ...state, cell };
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

/**
 * The biggest empty rectangle on the grid that is at least `min` cells. Empty when there is none.
 */
export function largestFreeRect(nodes: Rect[], min: [number, number] = [1, 1], columns = GRID_COLUMNS, rows = GRID_ROWS): Rect {
  return freeRects(nodes, min, columns, rows).reduce((best, r) => (area(r) > area(best) ? r : best), ZERO);
}

/** A new tile needs at least this much room before a manual layout gets re-tiled to make space. */
const MIN_FREE_AREA = 36;

/** The least room any tile is given, in cells either way, as `[columns, rows]`. */
const LEAST: [number, number] = [LEAST_ROOM, LEAST_ROOM];

/**
 * Adding a tile was refused: re-tiling can't give every tile, the new one
 * included, at least `LEAST_ROOM` cells either way. Nothing on screen changed.
 */
export class NoRoomError extends Error {
  constructor(component: ComponentSpec) {
    const name = component.label || component.title?.name || 'another tile';
    super(`No room for ${name}: with it, some tiles would be too small to read. Close a tile to make room.`);
    this.name = 'NoRoomError';
  }
}

/**
 * After a structural change. An auto layout is re-tiled, so a new tile takes its place among the
 * others as if the layout had been built with it. A hand-arranged layout uses its biggest gap for
 * anything, and re-tiles only when that is too small. A gap is never under `LEAST_ROOM` either way.
 * Throws `NoRoomError` when re-tiling can't give every tile that.
 */
function place(state: LayoutState, added: Tile): LayoutState {
  const retiled = () => {
    const boxes = solved('arrange', state, () => arrange(...problem(state)));
    if (!boxes) throw new NoRoomError(added.component);
    return laidOut(state, boxes);
  };
  if (!state.manual) return retiled();
  const free = largestFreeRect(state.tiles.filter((t) => t !== added), LEAST);
  return area(free) < MIN_FREE_AREA
    ? retiled()
    : { ...state, tiles: state.tiles.map((t) => (t === added ? fit({ ...t, ...free }, state.cell) : t)) };
}

export function allTiles(state: Pick<LayoutState, 'tiles'>): Tile[] {
  return state.tiles;
}

/** The tile with this id, if it's on screen. */
export function findTile(state: Pick<LayoutState, 'tiles'>, id: string): Tile | null {
  return state.tiles.find((t) => t.id === id) ?? null;
}

/** The tile showing a component with this key, if one is on screen. */
export function tileWithKey(state: Pick<LayoutState, 'tiles'>, key: string): Tile | null {
  return state.tiles.find((t) => t.component.key === key) ?? null;
}

function newTile(component: ComponentSpec): Tile {
  return { id: newId(), component, ...ZERO };
}

/**
 * Adds a tile for the component. One whose key is on screen already adds nothing: `tileWithKey` finds the
 * tile it has. Throws `NoRoomError`, and changes nothing, when there's no room left for it.
 */
export function addTile(state: LayoutState, component: ComponentSpec): LayoutState {
  if (tileWithKey(state, component.key)) return state;
  const tile = newTile(component);
  return place({ ...state, tiles: [...state.tiles, tile] }, tile);
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
 * tile, that tile splits across its longer side as it looks on screen, and the new tile takes the
 * half under the cell. `cellAspect` is a cell's width over its height. Null when the gap, or
 * either half of the tile, would be under `LEAST_ROOM` cells either way. With `component`, `rect`
 * is shrunk to what its content uses, keeping the top-left corner, as an auto-placed tile is: the
 * rest of `room` stays empty.
 */
export function dropTarget(
  state: LayoutState,
  cell: Cell,
  cellAspect = 1,
  component?: ComponentSpec,
): { rect: Rect; room: Rect; split: Tile | null } | null {
  const target = dropRoom(state, cell, cellAspect);
  if (!target) return null;
  const { room, split } = target;
  if (!component) return { rect: room, room, split };
  const { x, y, w, h } = fit({ id: '', component, ...room }, state.cell);
  return { rect: { x, y, w, h }, room, split };
}

/** The room a drop on this cell has: the gap there, or half the tile under it. */
function dropRoom(state: LayoutState, cell: Cell, cellAspect: number): { room: Rect; split: Tile | null } | null {
  const node = state.tiles.find((t) => contains(t, cell));
  if (!node) {
    const rect = freeRectAt(state.tiles, cell);
    return rect && rect.w >= LEAST_ROOM && rect.h >= LEAST_ROOM ? { room: rect, split: null } : null;
  }
  const across = node.w * cellAspect >= node.h;
  const size = across ? node.w : node.h;
  // Both halves keep their least room, and the new tile its least the other way too.
  if (Math.floor(size / 2) < LEAST_ROOM || (across ? node.h : node.w) < LEAST_ROOM) return null;
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
  return { room: inFirst ? halves[0] : halves[1], split: node };
}

/**
 * Adds a tile where it was dropped, which makes the layout manual. It takes what its content uses of
 * the room there, so a chart that stops growing doesn't stretch across it. Falls back to `addTile`.
 */
export function addTileAt(state: LayoutState, component: ComponentSpec, cell: Cell, cellAspect = 1): LayoutState {
  if (tileWithKey(state, component.key)) return state;
  const target = dropTarget(state, cell, cellAspect, component);
  if (!target) return addTile(state, component);
  const { rect, room, split } = target;
  const tile: Tile = { ...newTile(component), ...rect };
  const tiles = state.tiles.map((t) => (t === split ? { ...t, ...rectMinus(t, room) } : t));
  return { ...state, tiles: [...tiles, tile], manual: true };
}

/** What's left of a tile once one of its halves is taken. */
function rectMinus(r: Rect, half: Rect): Rect {
  if (half.x === r.x && half.w < r.w) return { x: r.x + half.w, y: r.y, w: r.w - half.w, h: r.h };
  if (half.x > r.x) return { x: r.x, y: r.y, w: r.w - half.w, h: r.h };
  if (half.y === r.y && half.h < r.h) return { x: r.x, y: r.y + half.h, w: r.w, h: r.h - half.h };
  return { x: r.x, y: r.y, w: r.w, h: r.h - half.h };
}

/**
 * Gives a tile the main place, or with null takes it from whichever has it. An auto layout re-tiles, and a
 * hand-arranged one keeps its places until it is next re-tiled. An id that isn't on screen changes nothing.
 */
export function setMain(state: LayoutState, id: string | null): LayoutState {
  if (id === state.main || (id !== null && !findTile(state, id))) return state;
  const next = { ...state, main: id };
  return state.manual ? next : autoLayout(next);
}

/** Removes a tile. The main tile takes its place with it: no other is promoted. */
export function removeTile(state: LayoutState, id: string): LayoutState {
  if (!findTile(state, id)) return state;
  const next = { ...state, tiles: state.tiles.filter((t) => t.id !== id), main: state.main === id ? null : state.main };
  return state.manual ? next : autoLayout(next);
}

/**
 * Gives a tile another component in its place, as when its props change: it keeps its id, its place, and
 * the main place if it had it. Null if `id` isn't on screen. The new key must not be another tile's: the
 * caller checks.
 */
export function replaceComponent(state: LayoutState, id: string, component: ComponentSpec): LayoutState | null {
  if (!findTile(state, id)) return null;
  return { ...state, tiles: state.tiles.map((t) => (t.id === id ? { ...t, component } : t)) };
}

/** Swaps two tiles' places: dropping a tile on another. An auto-laid-out grid has no empty cells, so this is what makes dragging useful. */
export function swap(state: LayoutState, idA: string, idB: string): LayoutState {
  const a = findTile(state, idA);
  const b = findTile(state, idB);
  if (!a || !b || a === b) return state;
  const rectOf = ({ x, y, w, h }: Rect): Rect => ({ x, y, w, h });
  return { ...state, manual: true, tiles: state.tiles.map((t) => (t === a ? { ...t, ...rectOf(b) } : t === b ? { ...t, ...rectOf(a) } : t)) };
}

/** A mouse edit reported by the grid. */
export function applyMouseEdit(state: LayoutState, id: string, rect: Rect): LayoutState {
  const tile = findTile(state, id);
  if (!tile || (tile.x === rect.x && tile.y === rect.y && tile.w === rect.w && tile.h === rect.h)) return state;
  return { ...state, manual: true, tiles: state.tiles.map((t) => (t === tile ? { ...t, ...rect } : t)) };
}
