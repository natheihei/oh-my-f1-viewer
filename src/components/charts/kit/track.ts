/**
 * Circuit geometry for the telemetry charts: turning and fitting the outline to a tile, and distance and
 * time along a lap. Pure, so it's tested on its own.
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

/** A point on a lap: seconds since it started and metres from the line. */
export interface LapPoint {
  t: number;
  d: number;
}

/**
 * Projects points onto the outline as a closed line: how far along it the nearest point is, from its first
 * point, and how far off the line the point is, both in outline units. It looks near its last answer first,
 * as a car moves on, and searches the whole outline when that's not close.
 */
export function projector(outline: Outline): (x: number, y: number) => { s: number; off: number } {
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
    return { s: along[i] + k * Math.sqrt(len2), off: Math.hypot(ax + k * dx - x, ay + k * dy - y) };
  };
  const search = (from: number, count: number, x: number, y: number) => {
    let best = { s: 0, off: Infinity, i: 0 };
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
    return { s: best.s, off: best.off };
  };
}

/** When a car crossed the line at each end of a lap, by its positions, in UTC ms. */
export interface LineCrossings {
  start: number;
  end: number;
}

/**
 * The lap a car started nearest `near` (UTC ms), from its positions over a window around it: each position
 * is projected onto the outline, progress round it is unwrapped as the car crosses the line, and the
 * crossings are interpolated between samples. The line is the outline's first point, where a corner's
 * `distance` counts from. Null when the positions don't hold a whole lap.
 */
export function lineCrossings(positions: ReadonlyArray<{ date: number; x: number; y: number }>, outline: Outline, near: number): LineCrossings | null {
  const project = projector(outline);
  const length = outlineLength(outline);
  if (!(length > 0)) return null;
  const sorted = [...positions].sort((a, b) => a.date - b.date);
  // Progress in outline units, counting laps: a drop of over half the outline is a crossing of the line.
  const progress: Array<{ date: number; p: number }> = [];
  let laps = 0;
  let previous: number | null = null;
  for (const { date, x, y } of sorted) {
    const { s } = project(x, y);
    if (previous !== null && previous - s > length / 2) laps += 1;
    else if (previous !== null && s - previous > length / 2) laps -= 1;
    previous = s;
    progress.push({ date, p: s + laps * length });
  }
  // When progress passes each whole lap.
  const crossings: Array<{ lap: number; date: number }> = [];
  for (let i = 1; i < progress.length; i++) {
    const [a, b] = [progress[i - 1], progress[i]];
    for (let k = Math.floor(a.p / length) + 1; k * length <= b.p; k++) {
      crossings.push({ lap: k, date: a.date + ((k * length - a.p) / (b.p - a.p)) * (b.date - a.date) });
    }
  }
  const first = crossings.reduce<(typeof crossings)[number] | null>((best, c) => (!best || Math.abs(c.date - near) < Math.abs(best.date - near) ? c : best), null);
  const next = first && crossings.find((c) => c.lap === first.lap + 1);
  return first && next ? { start: first.date, end: next.date } : null;
}

/**
 * One lap's speed samples as distance along it, by integrating speed over time (the trapezoid rule). The lap
 * runs from `start` to `end` (UTC ms); samples outside it are ignored, and the first and last samples' speeds
 * are held to the lap's ends. With `length` (metres), distances are scaled to end there: the speed channel
 * reads about 1% off, and scaling puts both cars' corners at the same distance. Null without samples in the lap.
 */
export function lapDistance(
  samples: ReadonlyArray<{ date: number; speed: number }>,
  start: number,
  end: number,
  length?: number,
): Array<LapPoint & { speed: number }> | null {
  const inLap = samples.filter((s) => s.date >= start && s.date <= end).sort((a, b) => a.date - b.date);
  if (inLap.length === 0 || !(end > start)) return null;
  const points = [{ t: 0, d: 0, speed: inLap[0].speed }];
  const add = (date: number, speed: number) => {
    const last = points[points.length - 1];
    const t = (date - start) / 1000;
    points.push({ t, d: last.d + ((last.speed + speed) / 2 / 3.6) * (t - last.t), speed });
  };
  for (const s of inLap) add(s.date, s.speed);
  add(end, inLap[inLap.length - 1].speed);
  const total = points[points.length - 1].d;
  if (length !== undefined && length > 0 && total > 0) for (const p of points) p.d *= length / total;
  return points;
}

/** Seconds into the lap at `d` metres, between the points either side, or null past either end. */
export function timeAt(lap: readonly LapPoint[], d: number): number | null {
  if (lap.length === 0 || d < lap[0].d || d > lap[lap.length - 1].d) return null;
  let [lo, hi] = [0, lap.length - 1];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lap[mid].d < d) lo = mid;
    else hi = mid;
  }
  const [a, b] = [lap[lo], lap[hi]];
  return b.d === a.d ? b.t : a.t + ((d - a.d) / (b.d - a.d)) * (b.t - a.t);
}

/**
 * The running time difference along the lap: at each of `steps + 1` even distances, the time `second` took
 * to get there minus the time `first` did, in seconds. Positive is `first` ahead. At the line it's the
 * difference in lap time.
 */
export function deltaAlong(first: readonly LapPoint[], second: readonly LapPoint[], steps = 400): Array<{ d: number; delta: number }> {
  const end = Math.min(first[first.length - 1]?.d ?? 0, second[second.length - 1]?.d ?? 0);
  if (!(end > 0)) return [];
  const out: Array<{ d: number; delta: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const d = (end * i) / steps;
    const [ta, tb] = [timeAt(first, d), timeAt(second, d)];
    if (ta !== null && tb !== null) out.push({ d, delta: tb - ta });
  }
  return out;
}

/**
 * `delta` drawn straight through the slow parts of corners: each point where `slow(d)` holds is replaced by
 * a line between the nearest points either side where it doesn't. Integrated distance is a few metres off
 * through braking zones (the speed samples' times jitter, and the error cancels after), and where a car is
 * at 70 km/h a few metres is a tenth of a second or more, so the raw delta spikes at every hairpin and
 * comes back. Time gained or lost in the corner still shows, as the change from before it to after. The
 * ends are kept, so the line still starts at zero and ends at the lap time difference.
 */
export function bridgeSlow(delta: ReadonlyArray<{ d: number; delta: number }>, slow: (d: number) => boolean): Array<{ d: number; delta: number }> {
  const keep = delta.map((p, i) => i === 0 || i === delta.length - 1 || !slow(p.d));
  return delta.map((p, i) => {
    if (keep[i]) return p;
    let [a, b] = [i - 1, i + 1];
    while (!keep[a]) a--;
    while (!keep[b]) b++;
    const [pa, pb] = [delta[a], delta[b]];
    return { d: p.d, delta: pa.delta + ((p.d - pa.d) / (pb.d - pa.d)) * (pb.delta - pa.delta) };
  });
}
