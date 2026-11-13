/**
 * Circuit geometry for the telemetry charts: turning and fitting the outline to a tile, its length, and
 * distance along it. Pure, so it's tested on its own.
 *
 * MultiViewer's outline and corners are in the same units as `location`, tenths of a metre: on Austin,
 * `location` points sit a median 0.5 units off the outline, and a corner's `distance` is how far along the
 * outline it is from the outline's first point, which is at the timing line.
 */

/** Outline, corner and `location` units in a metre. */
export const UNITS_PER_METRE = 10;

export interface Outline {
  x: readonly number[];
  y: readonly number[];
}

/** `(x, y)` turned `degrees` anticlockwise, with y up, as MultiViewer's `rotation` is meant. */
export function rotate(x: number, y: number, degrees: number): [number, number] {
  const a = (degrees * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return [x * c - y * s, x * s + y * c];
}

/** Circuit coordinates to the screen, and how many pixels a unit is. */
export interface Fit {
  (x: number, y: number): [number, number];
  scale: number;
}

/**
 * Maps circuit coordinates into `box`: turned by `rotation`, y up as the data has it (screen y runs down),
 * scaled the same both ways so the shape keeps its aspect, and centred. Austin's outline runs anticlockwise
 * this way up, as the track does.
 */
export function fitOutline(outline: Outline, rotation: number, box: { left: number; top: number; width: number; height: number }): Fit {
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < outline.x.length; i++) {
    const [x, y] = rotate(outline.x[i], outline.y[i], rotation);
    [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
  }
  const w = x1 - x0 || 1;
  const h = y1 - y0 || 1;
  const scale = Math.max(0, Math.min(box.width / w, box.height / h));
  const left = box.left + (box.width - w * scale) / 2;
  const top = box.top + (box.height - h * scale) / 2;
  const fit = ((x: number, y: number) => {
    const [rx, ry] = rotate(x, y, rotation);
    return [left + (rx - x0) * scale, top + (y1 - ry) * scale];
  }) as Fit;
  fit.scale = scale;
  return fit;
}

/** The outline's length as a closed line, in its own units. */
export function outlineLength(outline: Outline): number {
  const n = outline.x.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    total += Math.hypot(outline.x[j] - outline.x[i], outline.y[j] - outline.y[i]);
  }
  return total;
}

/**
 * Projects points onto the outline as a closed line: how far along it the nearest point is, from its first
 * point, and how far off the line the point is, both in outline units, and that nearest point, `fx` and `fy`. It looks near its last answer first,
 * as a car moves on, and searches the whole outline when that's not close.
 */
export function projector(outline: Outline): (x: number, y: number) => { s: number; off: number; fx: number; fy: number } {
  const n = outline.x.length;
  const along = [0];
  for (let i = 0; i < n; i++) along.push(along[i] + Math.hypot(outline.x[(i + 1) % n] - outline.x[i], outline.y[(i + 1) % n] - outline.y[i]));
  let last = -1;
  const onSegment = (i: number, x: number, y: number) => {
    const j = (i + 1) % n;
    const [ax, ay] = [outline.x[i], outline.y[i]];
    const [dx, dy] = [outline.x[j] - ax, outline.y[j] - ay];
    const len2 = dx * dx + dy * dy;
    const k = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const [fx, fy] = [ax + k * dx, ay + k * dy];
    return { s: along[i] + k * Math.sqrt(len2), off: Math.hypot(fx - x, fy - y), fx, fy };
  };
  const search = (from: number, count: number, x: number, y: number) => {
    let best = { s: 0, off: Infinity, fx: 0, fy: 0, i: 0 };
    for (let c = 0; c < count; c++) {
      const i = (((from + c) % n) + n) % n;
      const p = onSegment(i, x, y);
      if (p.off < best.off) best = { ...p, i };
    }
    return best;
  };
  return (x, y) => {
    const WINDOW = 40;
    let best = last >= 0 ? search(last - WINDOW, WINDOW * 2 + 1, x, y) : null;
    // Near enough to the line to trust the local search: 20 m, the track's width.
    if (!best || best.off > 200) best = search(0, n, x, y);
    last = best.i;
    return { s: best.s, off: best.off, fx: best.fx, fy: best.fy };
  };
}
