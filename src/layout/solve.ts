/**
 * Auto-layout: where every tile goes when the app arranges them. One tile may be the main one, top left.
 * The rest go in a rail beside it, a band below it, or both, and which goes where follows each tile's
 * shape: tall ones suit the rail, wide ones the band. Every arrangement of that kind is tried, and the
 * one that keeps tiles at their least size, the main tile large, shapes close to what was asked for and
 * the grid full wins. It is small enough to try them all: a few thousand at most. The rail and band take
 * as many columns and rows as suit their tiles, so a wall of tiles still gets a grid, and no arrangement
 * that would give a tile under `LEAST_ROOM` cells either way, or put two on the same cells, is tried.
 *
 * Pure, and in grid cells. What a tile needs comes in as `Slot`s, so this file knows nothing of components.
 */

export interface Size {
  w: number;
  h: number;
}

export interface Box extends Size {
  x: number;
  y: number;
}

/** One thing to place, as the solver sees it. */
export interface Slot {
  /** The shape it reads best in, on screen: width over height. */
  aspect: number;
  /** The least cells it reads in. Zero where it has no least. */
  min: Size;
  /** The cells it uses of a rectangle this size: all of it, unless its content stops growing or keeps a shape. */
  fit(room: Size): Size;
  /** Its content stops growing at some size, so it can't fill the main slot. */
  capped: boolean;
}

export interface Grid {
  columns: number;
  rows: number;
  /** A cell on screen, in pixels, and the height of a tile's title bar: shapes are judged as they look. */
  cell: { w: number; h: number };
  titleBar: number;
}

/** The widths tried for the main tile, when something sits beside it. */
const MAIN_WIDTHS = [8, 10, 12, 14, 16, 18];
/** The heights tried for the main tile, when something sits below it. */
const MAIN_HEIGHTS = [10, 12, 14, 16, 18];
/** A band or rail thinner than this holds nothing worth showing. */
const LEAST_STRIP = 3;
/**
 * No tile gets less room than this many cells either way: a tile one row high is only its title bar.
 * An arrangement that would give one less isn't tried, and a tile that would leave none is refused.
 */
export const LEAST_ROOM = LEAST_STRIP;

/** How much each fault costs. A tile below its least size outweighs everything else. */
const COST = { deficit: 40, shape: 1, main: 5, empty: 3, uneven: 3 };

/** Splits `total` into `parts` whole numbers that differ by at most one. */
function split(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const extra = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Shares `total` cells between parts in proportion to what each wants, none above its `most`. What a
 * part can't use goes to the others. Whole numbers of at least one, and never more than `total` in all.
 */
export function shareWithin(total: number, wants: number[], most: number[]): number[] {
  const n = wants.length;
  const out = new Array<number>(n).fill(0);
  if (n === 0) return out;
  if (total < n) return split(Math.max(total, 0), n);
  let open = wants.map((_, i) => i);
  let left = total;
  // Parts that want less than their share take what they can use, and the rest is shared again.
  for (;;) {
    const sum = open.reduce((a, i) => a + Math.max(wants[i], 0.01), 0);
    const capped = open.filter((i) => (left * Math.max(wants[i], 0.01)) / sum >= most[i]);
    if (capped.length === 0 || capped.length === open.length) {
      if (capped.length === open.length) {
        for (const i of open) out[i] = Math.max(1, Math.floor(most[i]));
        return out;
      }
      const exact = open.map((i) => (left * Math.max(wants[i], 0.01)) / sum);
      const whole = exact.map((v) => Math.max(1, Math.floor(v)));
      const byRemainder = exact.map((v, k) => ({ k, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r || a.k - b.k);
      for (let k = 0, spare = left - whole.reduce((a, v) => a + v, 0); spare > 0; k += 1, spare -= 1) whole[byRemainder[k % whole.length].k] += 1;
      while (whole.reduce((a, v) => a + v, 0) > left) whole[whole.indexOf(Math.max(...whole))] -= 1;
      open.forEach((i, k) => (out[i] = whole[k]));
      return out;
    }
    for (const i of capped) {
      out[i] = Math.max(1, Math.floor(most[i]));
      left -= out[i];
    }
    open = open.filter((i) => !capped.includes(i));
    if (left < open.length) {
      for (const i of open) out[i] = 1;
      return out;
    }
  }
}

/** Splits a list into `lines` runs of near-equal length, in order. */
function runs<T>(list: T[], lines: number): T[][] {
  const out: T[][] = [];
  let at = 0;
  for (const n of split(list.length, lines)) {
    out.push(list.slice(at, at + n));
    at += n;
  }
  return out.filter((r) => r.length > 0);
}

const LOTS = 1e6;

/** Shares that each give at least `LEAST_ROOM` and together fit in `total`. */
const roomy = (shares: number[], total: number) => shares.every((v) => v >= LEAST_ROOM) && shares.reduce((a, v) => a + v, 0) <= total;

/**
 * Stacks slots down a column, each as tall as its shape asks at that width, within what it can use.
 * Null when the column is too short to give each its `LEAST_ROOM`.
 */
function stackDown(area: Box, items: number[], slots: Slot[], grid: Grid): Map<number, Box> | null {
  const { cell, titleBar } = grid;
  const wants = items.map((i) => Math.max(slots[i].min.h, ((area.w * cell.w) / slots[i].aspect + titleBar) / cell.h));
  const most = items.map((i) => slots[i].fit({ w: area.w, h: LOTS }).h);
  const heights = shareWithin(area.h, wants, most);
  if (area.w < LEAST_ROOM || !roomy(heights, area.h)) return null;
  const out = new Map<number, Box>();
  let y = area.y;
  items.forEach((i, k) => {
    const used = slots[i].fit({ w: area.w, h: heights[k] });
    out.set(i, { x: area.x, y, w: used.w, h: used.h });
    y += heights[k];
  });
  return out;
}

/** Lays slots along a row, each as wide as its shape asks at that height, within what it can use. Null as for `stackDown`. */
function layAcross(area: Box, items: number[], slots: Slot[], grid: Grid): Map<number, Box> | null {
  const { cell, titleBar } = grid;
  const wants = items.map((i) => Math.max(slots[i].min.w, (Math.max(1, area.h * cell.h - titleBar) * slots[i].aspect) / cell.w));
  const most = items.map((i) => slots[i].fit({ w: LOTS, h: area.h }).w);
  const widths = shareWithin(area.w, wants, most);
  if (area.h < LEAST_ROOM || !roomy(widths, area.w)) return null;
  const out = new Map<number, Box>();
  let x = area.x;
  items.forEach((i, k) => {
    const used = slots[i].fit({ w: widths[k], h: area.h });
    out.set(i, { x, y: area.y, w: used.w, h: used.h });
    x += widths[k];
  });
  return out;
}

/** Slots in `columns` side by side, each stacked down. Null when a tile wouldn't get its `LEAST_ROOM`. */
function rail(area: Box, items: number[], columns: number, slots: Slot[], grid: Grid): Map<number, Box> | null {
  const out = new Map<number, Box>();
  const widths = split(area.w, columns);
  let x = area.x;
  for (const [k, run] of runs(items, columns).entries()) {
    const boxes = stackDown({ x, y: area.y, w: widths[k], h: area.h }, run, slots, grid);
    if (!boxes) return null;
    for (const [i, box] of boxes) out.set(i, box);
    x += widths[k];
  }
  return out;
}

/** Slots in `rows` one above the other, each laid across. Null as for `rail`. */
function band(area: Box, items: number[], rows: number, slots: Slot[], grid: Grid): Map<number, Box> | null {
  const out = new Map<number, Box>();
  const heights = split(area.h, rows);
  let y = area.y;
  for (const [k, run] of runs(items, rows).entries()) {
    const boxes = layAcross({ x: area.x, y, w: area.w, h: heights[k] }, run, slots, grid);
    if (!boxes) return null;
    for (const [i, box] of boxes) out.set(i, box);
    y += heights[k];
  }
  return out;
}

/** The most lines a strip of this thickness can be split into, each still `LEAST_ROOM` thick. */
const mostLines = (items: number, thickness: number) => Math.max(1, Math.min(items, Math.floor(thickness / LEAST_ROOM)));

/**
 * Every slot in a plain grid of near-equal cells, in the order given, each fitted to its cell: what
 * `solve` falls back to when no rail or band gives every tile its `LEAST_ROOM`. Adding a tile is
 * refused before that, so this is only for a grid that shrank under tiles already there. Nothing
 * overlaps until there are more tiles than cells.
 */
function evenGrid(slots: Slot[], { columns, rows }: Grid): Box[] {
  const across = Math.min(columns, Math.ceil(Math.sqrt(slots.length)));
  const down = Math.min(rows, Math.ceil(slots.length / across));
  const widths = split(columns, across);
  const heights = split(rows, down);
  return slots.map((slot, i) => {
    const col = i % across;
    const row = Math.min(down - 1, Math.floor(i / across));
    const x = widths.slice(0, col).reduce((a, v) => a + v, 0);
    const y = heights.slice(0, row).reduce((a, v) => a + v, 0);
    return { x, y, ...slot.fit({ w: widths[col], h: heights[row] }) };
  });
}

/** How a tile's box looks on screen, as width over height, without its title bar. */
const shapeOf = (box: Size, { cell, titleBar }: Grid) => (box.w * cell.w) / Math.max(1, box.h * cell.h - titleBar);

/**
 * What one tile adds to `cost`: its deficit, its shape and the room it fills. They add up tile by tile,
 * so a strip's best split into lines can be chosen on its own. `others` is how many tiles aren't the main one.
 */
function tileCost(i: number, box: Box, main: number | null, others: number, slots: Slot[], grid: Grid): number {
  const { min, aspect } = slots[i];
  let deficit = 0;
  if (min.w > 0) deficit += Math.max(0, min.w - box.w) / min.w;
  if (min.h > 0) deficit += Math.max(0, min.h - box.h) / min.h;
  const shape = i === main ? 0 : Math.abs(Math.log(shapeOf(box, grid) / aspect));
  return COST.deficit * deficit + (COST.shape * shape) / others - (COST.empty * box.w * box.h) / (grid.columns * grid.rows);
}

function cost(boxes: Map<number, Box>, main: number | null, slots: Slot[], grid: Grid): number {
  const all = grid.columns * grid.rows;
  const mainBox = main === null ? null : boxes.get(main)!;
  const others = Math.max(1, boxes.size - (mainBox ? 1 : 0));
  let tiles = 0;
  for (const [i, box] of boxes) tiles += tileCost(i, box, main, others, slots, grid);
  const mainArea = mainBox ? mainBox.w * mainBox.h : 0;
  // With no main tile, none of those that can grow is favoured: the largest is kept close to the smallest.
  let uneven = 0;
  if (!mainBox) {
    const areas = [...boxes].filter(([i]) => !slots[i].capped).map(([, box]) => box.w * box.h);
    if (areas.length > 1) uneven = (Math.max(...areas) - Math.min(...areas)) / all;
  }
  return tiles - (COST.main * mainArea) / all + COST.empty + COST.uneven * uneven;
}

/** The widths tried for a rail of tall tiles when there is no main tile. */
const RAIL_WIDTHS = [4, 5, 6, 7, 8, 10, 12];

/**
 * A box for every slot, in the order given. `main` is the slot that has the main place, top left and as
 * large as the others allow. Null when none has: the slots then share the grid, none favoured. When no
 * arrangement gives every slot its `LEAST_ROOM`, they go in a plain grid: see `arrange` to tell.
 */
export function solve(slots: Slot[], grid: Grid, main: number | null = null): Box[] {
  return arrange(slots, grid, main) ?? evenGrid(slots, grid);
}

/** The boxes `solve` gives, or null when no arrangement gives every slot its `LEAST_ROOM`. */
export function arrange(slots: Slot[], grid: Grid, main: number | null = null): Box[] | null {
  const { columns, rows } = grid;
  if (slots.length === 0) return [];
  const whole = (i: number, w: number, h: number): Box => ({ x: 0, y: 0, ...slots[i].fit({ w, h }) });
  const rest = slots.map((_, i) => i).filter((i) => i !== main);
  if (slots.length === 1) return [whole(0, columns, rows)];
  // Tallest shapes first: the rail takes the first few of these, and the band the others.
  const byShape = [...rest].sort((a, b) => slots[a].aspect - slots[b].aspect || a - b);
  const inOrder = (list: number[]) => [...list].sort((a, b) => a - b);

  let best: Map<number, Box> | null = null;
  let bestCost = Infinity;
  // With a main tile, a tile's cost depends only on its own box, so each strip is split into however
  // many lines suits it best on its own: more of them as tiles are added, so none is squeezed to a
  // sliver. The same strip comes up again and again across main sizes and orders, so each is worked out once.
  const others = Math.max(1, rest.length);
  const strips = new Map<string, Map<number, Box> | null>();
  const bestStrip = (lay: typeof rail, area: Box, items: number[], thickness: number): Map<number, Box> | null => {
    const key = `${lay === rail ? 'rail' : 'band'} ${area.x},${area.y},${area.w},${area.h} ${items.join(',')}`;
    if (strips.has(key)) return strips.get(key)!;
    let found: Map<number, Box> | null = null;
    let least = Infinity;
    for (let lines = 1; lines <= mostLines(items.length, thickness); lines += 1) {
      const boxes = lay(area, items, lines, slots, grid);
      if (!boxes) continue;
      let c = 0;
      for (const [i, box] of boxes) c += tileCost(i, box, main, others, slots, grid);
      if (c < least - 1e-9) {
        found = boxes;
        least = c;
      }
    }
    strips.set(key, found);
    return found;
  };
  const consider = (boxes: Map<number, Box>) => {
    const c = cost(boxes, main, slots, grid);
    if (c < bestCost - 1e-9) {
      best = boxes;
      bestCost = c;
    }
  };

  // Within the rail and the band, tiles keep the order they were added in, unless ordering them by
  // shape fits better: the order added is tried first, so it wins a tie.
  const orders = (list: number[]): number[][] => {
    const out = [inOrder(list)];
    for (const other of [list, [...list].reverse()]) if (!out.some((o) => o.every((v, k) => v === other[k]))) out.push(other);
    return out;
  };
  // Most in the rail first, so on a tie a tall tile sits at the right whether or not there is a main tile.
  for (let inRail = rest.length; inRail >= 0; inRail -= 1) {
    for (const railItems of orders(byShape.slice(0, inRail))) {
      for (const bandItems of orders(byShape.slice(inRail))) {
        if (main === null) {
          // No main tile: wide tiles share the grid in rows, with the tall ones in a rail at the right.
          for (const railW of railItems.length ? (bandItems.length ? RAIL_WIDTHS : [columns]) : [0]) {
            const railArea: Box = { x: columns - railW, y: 0, w: railW, h: rows };
            const bodyArea: Box = { x: 0, y: 0, w: columns - railW, h: rows };
            const railLines = railItems.length ? Array.from({ length: Math.min(railItems.length, Math.max(1, Math.floor(railW / 4)), 4) }, (_, k) => k + 1) : [1];
            const bodyLines = bandItems.length ? Array.from({ length: Math.min(bandItems.length, 4) }, (_, k) => k + 1) : [1];
            for (const railColumns of railLines) {
              for (const bodyRows of bodyLines) {
                const railBoxes = railItems.length ? rail(railArea, railItems, railColumns, slots, grid) : new Map<number, Box>();
                const bandBoxes = bandItems.length ? band(bodyArea, bandItems, bodyRows, slots, grid) : new Map<number, Box>();
                if (railBoxes && bandBoxes) consider(new Map([...railBoxes, ...bandBoxes]));
              }
            }
          }
          continue;
        }
        for (const mw of railItems.length ? MAIN_WIDTHS : [columns]) {
          for (const mh of bandItems.length ? MAIN_HEIGHTS : [rows]) {
            const mainBox = whole(main, mw, mh);
            // The rail and band start where the main tile ends, so a picture that doesn't fill its slot leaves no seam.
            const railX = railItems.length ? mainBox.w : columns;
            const bandY = bandItems.length ? mainBox.h : rows;
            if (railItems.length && columns - railX < LEAST_STRIP) continue;
            if (bandItems.length && rows - bandY < LEAST_STRIP) continue;
            // The corner below the rail and beside the band goes to one of them.
            for (const corner of railItems.length && bandItems.length ? (['rail', 'band'] as const) : (['rail'] as const)) {
              const railArea: Box = {
                x: railX,
                y: 0,
                w: columns - railX,
                h: corner === 'rail' ? rows : bandY,
              };
              const bandArea: Box = {
                x: 0,
                y: bandY,
                w: corner === 'band' ? columns : railX,
                h: rows - bandY,
              };
              const railBoxes = railItems.length ? bestStrip(rail, railArea, railItems, railArea.w) : new Map<number, Box>();
              const bandBoxes = bandItems.length ? bestStrip(band, bandArea, bandItems, bandArea.h) : new Map<number, Box>();
              if (railBoxes && bandBoxes) consider(new Map([[main, mainBox], ...railBoxes, ...bandBoxes]));
            }
          }
        }
      }
    }
  }
  const found = best as Map<number, Box> | null;
  if (!found) return null;
  return slots.map((_, i) => found.get(i)!);
}
