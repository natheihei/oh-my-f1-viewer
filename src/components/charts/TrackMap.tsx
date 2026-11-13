/** Every running car as a dot on the circuit, where it is now, from `location` and MultiViewer's outline. Retired cars are left off. */
import { useMemo, useRef, useState } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql, type CircuitView } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  circuitMessage,
  codeOf,
  colors,
  fitOutline,
  num,
  projector,
  styleOf,
  text,
  textWidth,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
  type Outline,
  type Pointer,
} from './kit';

const NEEDS = ['telemetry' as const];

/** How far back from the playhead to look for each car's latest position, in ms: rows are revealed up to 2 s after their `date`, every 0.25 s or so. */
export const WINDOW_MS = 5000;

/**
 * Each car's latest position in the last few seconds. Bounded both ways by `date`, the second column of the
 * primary key, so it reads an index range of about 500 rows, not the table. The upper bound matters: a row
 * is never revealed before its `date`, and without it the range would run on through every row after the
 * playhead. `?1` is the playhead.
 */
export const SQL = `SELECT driver_number, x, y, MAX(date) AS date FROM location WHERE date > ?1 - ${WINDOW_MS} AND date <= ?1 GROUP BY driver_number`;

/** Cars that have retired, as of the playhead. They keep reporting where they stopped, or the garage. */
export const OUT_SQL = `SELECT DISTINCT driver_number FROM laps WHERE is_out`;

/** Each car's latest position in the race, as of the playhead, for the name under the pointer. */
export const POSITION_SQL = `SELECT driver_number, position, MAX(date) AS date FROM position GROUP BY driver_number`;

export interface Car {
  driver: number;
  x: number;
  y: number;
}

/** How far off the racing line a car is in the pit lane, in outline units: 10 m. Cars racing sit within a metre or two of it. */
export const IN_LANE = 100;

/** The cars that are off the racing line by more than `IN_LANE`: in the pit lane, or stopped off the track. */
export function inLane(cars: readonly Car[], outline: Outline): Set<number> {
  const project = projector(outline);
  return new Set(cars.filter((car) => project(car.x, car.y).off > IN_LANE).map((car) => car.driver));
}

/** The first stop the feed has told of, as of the playhead: whose, when they entered the lane, and how long they took through it. */
export const STOP_SQL = `SELECT driver_number, date, lane_duration FROM pit WHERE date IS NOT NULL AND lane_duration IS NOT NULL ORDER BY date LIMIT 1`;

/**
 * That car's positions through its stop: `?1` the car, `?2` the stop's `date` and `?3` its lane time, in ms. A minute before and
 * half a minute after, since the feed's `date` isn't always when the car turned in: the lane is picked out of them by `lanePath`.
 */
export const LANE_SQL = `SELECT x, y FROM location WHERE driver_number = ?1 AND date >= ?2 - 60000 AND date <= ?2 + ?3 + 30000 AND NOT (x = 0 AND y = 0) ORDER BY date`;

/** A point the pit lane runs through, and the nearest point of the racing line, `fx` and `fy`, `off` away, all in outline units. */
export interface LanePoint {
  x: number;
  y: number;
  fx: number;
  fy: number;
  off: number;
}

/** How far off the racing line a car through a stop has to be for it to be in the lane, in outline units: 4 m. */
const LANE_OFF = 40;
/** How far off it still counts as leaving or joining the track, where the lane runs in from and out to it: 1.5 m. */
const LANE_ENDS = 15;
/** The fewest positions, about a quarter second apart, that make a lane: a run shorter is the car running wide. */
const LANE_LEAST = 12;

/**
 * The pit lane, from one car's positions through a stop: the longest run of them more than 4 m off the racing line,
 * carried on at each end while the car is still 1.5 m off it, where the lane leaves the track and joins it. MultiViewer
 * has no pit lane, so this is the only one there is. Empty when there's no run long enough to be the lane.
 */
export function lanePath(positions: ReadonlyArray<{ x: number; y: number }>, outline: Outline): LanePoint[] {
  const project = projector(outline);
  const points = positions.map(({ x, y }) => ({ x, y, ...project(x, y) })).map(({ x, y, fx, fy, off }) => ({ x, y, fx, fy, off }));
  let [start, end] = [0, -1];
  for (let i = 0; i < points.length; ) {
    if (points[i].off <= LANE_OFF) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < points.length && points[j + 1].off > LANE_OFF) j++;
    if (j - i > end - start) [start, end] = [i, j];
    i = j + 1;
  }
  if (end - start + 1 < LANE_LEAST) return [];
  while (start > 0 && points[start - 1].off > LANE_ENDS) start--;
  while (end + 1 < points.length && points[end + 1].off > LANE_ENDS) end++;
  return points.slice(start, end + 1);
}

/**
 * The rows of `SQL` as cars, by car number, without those in `out`, the rows of `OUT_SQL`. A position of
 * exactly (0, 0) is the feed's placeholder for a car with none yet, before it leaves the garage, so it's left out.
 */
export function trackModel(rows: ReadonlyArray<Record<string, unknown>>, out: ReadonlyArray<Record<string, unknown>> = []): Car[] {
  const retired = new Set(out.map((r) => num(r.driver_number)));
  const latest = new Map<number, { date: number; car: Car }>();
  for (const r of rows) {
    const [driver, x, y, date] = [num(r.driver_number), num(r.x), num(r.y), num(r.date) ?? 0];
    if (driver === null || x === null || y === null || (x === 0 && y === 0) || retired.has(driver)) continue;
    const seen = latest.get(driver);
    if (!seen || date > seen.date) latest.set(driver, { date, car: { driver, x, y } });
  }
  return [...latest.values()].map((v) => v.car).sort((a, b) => a.driver - b.driver);
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Rect, b: Rect) => Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;

/** Distances from the dot to the label's near edge, in pixels, tried in turn on the outer side, then the inner. */
const STEPS = [6, 15, 25, 36, 48];

/**
 * Where each label goes, as its box's centre. Each label is pushed off the line along `normal` (a unit
 * vector, pointing out of the circuit), as close as it can be inside `bounds` without covering another
 * label, a dot in `avoid`, or a point of the line in `line`; failing that, without covering a label or dot;
 * failing that, moved inside `bounds`, clear of them if it can be, or else at the first step out. Labels are
 * placed in the order given, so put the ones that matter most first.
 */
export function placeLabels(
  labels: ReadonlyArray<{ x: number; y: number; nx: number; ny: number; w: number; h: number }>,
  avoid: readonly Rect[] = [],
  line: ReadonlyArray<readonly [number, number]> = [],
  bounds: { width: number; height: number } = { width: Infinity, height: Infinity },
): Rect[] {
  const placed: Rect[] = [];
  const inside = (r: Rect) => r.x - r.w / 2 >= 0 && r.y - r.h / 2 >= 0 && r.x + r.w / 2 <= bounds.width && r.y + r.h / 2 <= bounds.height;
  return labels.map((l) => {
    const candidates: Rect[] = [];
    for (const side of [1, -1])
      for (const step of STEPS) {
        const reach = step + (Math.abs(l.nx) * l.w) / 2 + (Math.abs(l.ny) * l.h) / 2;
        candidates.push({ x: l.x + side * l.nx * reach, y: l.y + side * l.ny * reach, w: l.w, h: l.h });
      }
    const clear = (r: Rect) => inside(r) && !placed.some((p) => overlaps(p, r)) && !avoid.some((a) => overlaps(a, r));
    const offLine = (r: Rect) => !line.some(([x, y]) => Math.abs(x - r.x) * 2 < r.w && Math.abs(y - r.y) * 2 < r.h);
    // Moved inside the tile, the places that were past its edge: clear of the others if one is.
    const within = candidates.map((r) => ({
      ...r,
      x: Math.min(bounds.width - r.w / 2, Math.max(r.w / 2, r.x)),
      y: Math.min(bounds.height - r.h / 2, Math.max(r.h / 2, r.y)),
    }));
    const best = candidates.find((r) => clear(r) && offLine(r)) ?? candidates.find(clear) ?? within.find(clear) ?? within[0];
    placed.push(best);
    return best;
  });
}

interface Drawn {
  cars: Car[];
  highlight: number[];
  /** The pinned from the props: pinned for good, so a click doesn't unpin them. */
  fixed: number[];
  /** Cars off the racing line: drawn as rings. */
  lane: Set<number>;
  /** The pit lane, from the first stop's positions, or empty before there's been one. */
  pitLane: LanePoint[];
  /** Each car's position in the race, by car number, for the name under the pointer. */
  positions: Map<number, number>;
  circuit: Extract<CircuitView, { state: 'ready' }>;
  styles: Map<number, DriverStyle>;
  pointer: Pointer;
  /** Where the drawing leaves each car's dot, for a click to find the car at its own point. */
  dots: { current: ReadonlyArray<{ driver: number; x: number; y: number }> };
}

const BACKGROUND = '#000';
/** Type for car codes and the name under the pointer, at the 11px floor. */
const TYPE = 11;
/** Turn numbers, as the speed ribbon draws them: hints, smaller, and the first to give way. */
const TURN_TYPE = 9;
/** How far past the track's edge a turn number is tried, in pixels, in turn, as on the speed ribbon. */
const TURN_STEPS = [3, 8, 14];
/** How near the pointer has to be to a dot, in pixels, to name it. */
const HIT = 12;
/** How opaque the cars nobody pinned are, once someone is pinned. */
const RECEDE = 0.75;
/** How far beside the track the pit lane is drawn, in pixels: fixed, since at a tile's scale its 20 m would be 3 or 4. */
const LANE_GAP = 7;
/** How far off the racing line, in outline units, the lane is drawn its full gap away: 15 m. Nearer, where it leaves and joins the track, it closes in. */
const LANE_FULL = 150;

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const { outline, corners, rotation } = m.circuit;
  const pad = compact ? 6 : 16;
  const fit = fitOutline(outline, rotation, { left: pad, top: pad, width: width - pad * 2, height: height - pad * 2 });
  const line = outline.x.map((x, i) => fit(x, outline.y[i]));
  const n = line.length;
  m.dots.current = [];
  if (n < 2) return;

  // A point off the racing line, drawn the lane's gap beside the track on its own side, closing in as it nears it.
  const beside = (p: { x: number; y: number; fx: number; fy: number; off: number }): [number, number] => {
    const [px, py] = fit(p.x, p.y);
    const [qx, qy] = fit(p.fx, p.fy);
    const len = Math.hypot(px - qx, py - qy);
    if (len === 0) return [qx, qy];
    const gap = LANE_GAP * Math.min(1, p.off / LANE_FULL);
    return [qx + ((px - qx) / len) * gap, qy + ((py - qy) / len) * gap];
  };

  // The pit lane, thin and under the track.
  if (!compact && m.pitLane.length > 1) {
    ctx.strokeStyle = c.faint;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    m.pitLane.map(beside).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }

  const track = compact ? 2.5 : 4;
  ctx.strokeStyle = c.faint;
  ctx.lineWidth = track;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  line.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.stroke();

  // The outward normal at a point of the line: across the track, away from the circuit's middle.
  const [mx, my] = [width / 2, height / 2];
  const normalAt = (x: number, y: number): [number, number] => {
    let k = 0;
    let best = Infinity;
    line.forEach(([lx, ly], i) => {
      const d = (lx - x) ** 2 + (ly - y) ** 2;
      if (d < best) [best, k] = [d, i];
    });
    const [ax, ay] = line[(k + n - 1) % n];
    const [bx, by] = line[(k + 1) % n];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let [nx, ny] = [-(by - ay) / len, (bx - ax) / len];
    if (nx * (x - mx) + ny * (y - my) < 0) [nx, ny] = [-nx, -ny];
    return [nx, ny];
  };

  // The timing line: a bar across the track at the outline's first point.
  const [sx, sy] = line[0];
  const [nx0, ny0] = normalAt(sx, sy);
  const bar = compact ? 5 : 9;
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sx - nx0 * bar, sy - ny0 * bar);
  ctx.lineTo(sx + nx0 * bar, sy + ny0 * bar);
  ctx.stroke();

  const lit = new Set(m.highlight);
  // Only the pinned are labelled; the rest are named under the pointer. Once someone is pinned, the rest also recede: smaller and dimmer.
  const recede = lit.size > 0;
  const radius = (d: number) => (lit.has(d) ? (compact ? 4 : 6) : compact ? 2.5 : recede ? 3 : 4);
  // A car off the line by more than the lane's own threshold sits on the lane as it's drawn, not on the track.
  const project = projector(outline);
  const at = new Map(
    m.cars.map((car) => {
      const p = project(car.x, car.y);
      return [car.driver, !compact && m.pitLane.length > 1 && p.off > LANE_OFF ? beside({ ...car, ...p }) : fit(car.x, car.y)];
    }),
  );
  m.dots.current = m.cars.map((car) => {
    const [x, y] = at.get(car.driver)!;
    return { driver: car.driver, x, y };
  });
  // Chosen cars are drawn last, so they sit on top, and labelled first, so they get the nearest places.
  const order = [...m.cars].sort((a, b) => Number(lit.has(a.driver)) - Number(lit.has(b.driver)));

  if (!compact) {
    const dots = order.map((car) => {
      const [x, y] = at.get(car.driver)!;
      const r = radius(car.driver) + 1;
      return { x, y, w: r * 2, h: r * 2 };
    });
    const labelled = [...order].reverse().filter((car) => lit.has(car.driver));
    const labels = placeLabels(
      labelled.map((car) => {
        const [x, y] = at.get(car.driver)!;
        const [nx, ny] = normalAt(x, y);
        const code = styleOf(m.styles, car.driver).code;
        return { x, y, nx, ny, w: textWidth(ctx, code, TYPE, lit.has(car.driver) ? 700 : 400) + 2, h: TYPE + 1 };
      }),
      [...dots, { x: sx, y: sy, w: bar * 2, h: bar * 2 }],
      line,
      { width, height },
    );

    // Turn numbers as the speed ribbon draws them: just outside the track, stepped out until clear of the
    // track, the tile's edge, the cars and their labels, and left out where there's no room.
    const taken: Rect[] = [...labels, ...dots, { x: sx, y: sy, w: bar * 2, h: bar * 2 }];
    for (const corner of corners) {
      const [x, y] = fit(corner.x, corner.y);
      const [nx, ny] = normalAt(x, y);
      const label = String(corner.number);
      const [w, h] = [textWidth(ctx, label, TURN_TYPE) + 2, TURN_TYPE + 1];
      const box = TURN_STEPS.map((step) => {
        const reach = track / 2 + step + (Math.abs(nx) * w) / 2 + (Math.abs(ny) * h) / 2;
        return { x: x + nx * reach, y: y + ny * reach, w, h };
      }).find(
        (b) =>
          b.x - b.w / 2 >= 0 &&
          b.x + b.w / 2 <= width &&
          b.y - b.h / 2 >= 0 &&
          b.y + b.h / 2 <= height &&
          !taken.some((t) => overlaps(t, b)) &&
          !line.some(([lx, ly]) => Math.abs(lx - b.x) * 2 < b.w + track && Math.abs(ly - b.y) * 2 < b.h + track),
      );
      if (!box) continue;
      taken.push(box);
      text(ctx, label, box.x, box.y, { align: 'center', color: c.mute, size: TURN_TYPE });
    }

    labelled.forEach((car, i) => {
      const [x, y] = at.get(car.driver)!;
      const box = labels[i];
      const style = styleOf(m.styles, car.driver);
      const mine = lit.has(car.driver);
      // A label set further out than the first step gets a short line back to its dot.
      const reach = Math.hypot(box.x - x, box.y - y) - Math.max(box.w, box.h) / 2;
      if (reach > 10) {
        ctx.strokeStyle = c.faint;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(box.x - Math.sign(box.x - x) * Math.min(box.w / 2, Math.abs(box.x - x)), box.y);
        ctx.stroke();
      }
      // A car in the pit lane is labelled in grey, as its ring is hollow: it isn't racing on this stretch.
      const colour = m.lane.has(car.driver) ? c.mute : mine ? c.ink : style.colour;
      text(ctx, style.code, box.x, box.y, { align: 'center', color: colour, size: TYPE, weight: mine ? 700 : 400 });
    });
  }

  for (const car of order) {
    const [x, y] = at.get(car.driver)!;
    const style = styleOf(m.styles, car.driver);
    const mine = lit.has(car.driver);
    const r = radius(car.driver);
    ctx.globalAlpha = recede && !mine ? RECEDE : 1;
    ctx.beginPath();
    if (m.lane.has(car.driver)) {
      // In the pit lane: a ring in the team's colour, hollow, so it doesn't read as a car racing past.
      ctx.arc(x, y, Math.max(2.5, r - 0.5), 0, Math.PI * 2);
      ctx.fillStyle = BACKGROUND;
      ctx.fill();
      ctx.strokeStyle = style.colour;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = style.colour;
      ctx.fill();
      ctx.strokeStyle = mine ? c.ink : BACKGROUND;
      ctx.lineWidth = mine ? 1.5 : 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // The car under the pointer, named, with what a click does to it.
  const p = m.pointer;
  if (compact || !p) return;
  const driver = dotAt(m.dots.current, p);
  const car = m.cars.find((c) => c.driver === driver);
  if (!car) return;
  const [x, y] = at.get(car.driver)!;
  const style = styleOf(m.styles, car.driver);
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, radius(car.driver) + 3, 0, Math.PI * 2);
  ctx.stroke();
  const position = m.positions.get(car.driver);
  const name = `${style.code} P${position ?? '–'}${m.lane.has(car.driver) ? ' · pit lane' : ''}`;
  // A car from the props is pinned for good; any other says what a click does, unless six are pinned already.
  const hint = m.fixed.includes(car.driver) ? ' · pinned' : lit.has(car.driver) ? ' · click to unpin' : lit.size < MAX_PINNED ? ' · click to pin' : '';
  const w = textWidth(ctx, name, TYPE) + textWidth(ctx, hint, TYPE) + 12;
  const bx = Math.min(Math.max(4, x - w / 2), width - w - 4);
  const by = y < 34 ? y + 12 : y - 32;
  ctx.fillStyle = c.select;
  ctx.fillRect(bx, by, w, 20);
  ctx.strokeStyle = c.line;
  ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, 19);
  ctx.fillStyle = style.colour;
  ctx.fillRect(bx, by, 2, 20);
  text(ctx, name, bx + 7, by + 10.5, { color: c.ink, size: TYPE });
  text(ctx, hint, bx + 7 + textWidth(ctx, name, TYPE), by + 10.5, { color: c.mute, size: TYPE });
}

/** The car whose dot is nearest `point`, within `HIT` pixels, or null. */
export function dotAt(dots: ReadonlyArray<{ driver: number; x: number; y: number }>, point: { x: number; y: number }): number | null {
  let best: { driver: number; dist: number } | null = null;
  for (const d of dots) {
    const dist = Math.hypot(d.x - point.x, d.y - point.y);
    if (dist < HIT && (!best || dist < best.dist)) best = { driver: d.driver, dist };
  }
  return best?.driver ?? null;
}

/** The most drivers the map pins. */
const MAX_PINNED = 6;

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 1,
  maxItems: MAX_PINNED,
  description:
    'Drivers to draw larger and labelled, as car numbers: the rest are drawn smaller and unlabelled, named under the pointer. Left out, every car is the same and unlabelled. These are pinned for good; the viewer can click other cars to pin or unpin them on the map itself, which leaves these props as they are.',
});

/**
 * The cars pinned by click, after a click on `driver`: pinned, or unpinned if it was. A car in `fixed`, the
 * props' drivers, is pinned for good and a click leaves it. Nothing is pinned past six in all.
 */
export function toggleDriver(added: readonly number[], fixed: readonly number[], driver: number): number[] {
  if (fixed.includes(driver)) return [...added];
  if (added.includes(driver)) return added.filter((d) => d !== driver);
  return pinnedOf(fixed, added).length < MAX_PINNED ? [...added, driver] : [...added];
}

/** Everyone pinned: the props' drivers, then those pinned by click, six at most. */
export function pinnedOf(fixed: readonly number[], added: readonly number[]): number[] {
  return [...fixed, ...added.filter((d) => !fixed.includes(d))].slice(0, MAX_PINNED);
}

const NO_PLAYHEAD = 0;
/** A car number no car has, for the lane's query before there's been a stop. */
const NO_CAR = -1;
/** Least room: the circuit large enough for eleven-pixel codes to sit beside their dots. Fit: where a circuit stops gaining detail, as on the speed ribbon. */
const MIN = { width: 360, height: 250 };
const FIT = { width: 560, height: 400 };

function TrackMap({ props }: { props: { drivers?: number[] } }) {
  // The props' drivers are pinned for good. A click pins or unpins another car: the map's own state, on top of them.
  const key = props.drivers?.join(',') ?? '';
  const [added, setAdded] = useState<number[]>([]);
  const fixed = useMemo(() => (key ? key.split(',').map(Number) : []), [key]);
  const highlight = useMemo(() => pinnedOf(fixed, added), [fixed, added]);
  const playhead = useLive((s) => (s.sessionData.state === 'ready' ? s.sessionData.playheadMs : null));
  const view = useSql(SQL, [playhead ?? NO_PLAYHEAD]);
  // Without timing there are no laps, so no one is out: the map still draws.
  const out = useSql(OUT_SQL);
  const positionView = useSql(POSITION_SQL);
  const circuit = useLive((s) => s.circuit);
  const stopView = useSql(STOP_SQL);
  const stop = stopView.state === 'ready' ? stopView.rows[0] : undefined;
  const stopParams = [num(stop?.driver_number) ?? NO_CAR, num(stop?.date) ?? 0, (num(stop?.lane_duration) ?? 0) * 1000];
  const laneView = useSql(LANE_SQL, stopParams);
  const outline = circuit.state === 'ready' ? circuit.outline : null;
  const pitLane = useMemo(
    () => (laneView.state === 'ready' && outline ? lanePath(laneView.rows.map((r) => ({ x: num(r.x) ?? 0, y: num(r.y) ?? 0 })), outline) : []),
    [laneView, outline],
  );
  const styles = useDriverStyles();
  const [pointer, setPointer] = useState<Pointer>(null);
  const dots = useRef<ReadonlyArray<{ driver: number; x: number; y: number }>>([]);
  const model = useMemo(() => {
    if (view.state !== 'ready' || circuit.state !== 'ready') return null;
    const retired = out.state === 'ready' ? out.rows : [];
    const cars = trackModel(view.rows, retired);
    const positions = new Map<number, number>();
    if (positionView.state === 'ready')
      for (const r of positionView.rows) {
        const [d, p] = [num(r.driver_number), num(r.position)];
        if (d !== null && p !== null) positions.set(d, p);
      }
    return { cars, lane: inLane(cars, circuit.outline), pitLane, positions, highlight, fixed, circuit, styles };
  }, [view, out, positionView, pitLane, circuit, styles, highlight, fixed]);
  // The pointer moves often: only the drawing follows it, not the model.
  const drawn = useMemo(() => (model ? { ...model, pointer, dots } : null), [model, pointer]);
  // The car at the click's own point, among the dots as last drawn: the pointer it was named under may not have been drawn yet.
  const onClick = (point: { x: number; y: number }) => {
    const driver = dotAt(dots.current, point);
    if (driver !== null) setAdded((a) => toggleDriver(a, fixed, driver));
  };
  return (
    <ChartFrame needs={NEEDS} waits={[circuitMessage(circuit)]} views={[view]}>
      {() => drawn && <ChartCanvas model={drawn} draw={draw} onPointer={setPointer} onClick={onClick} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'track_map',
  title: 'Track',
  description:
    'Every running car as a dot on the circuit, where it is right now, a ring in the pit lane. Retired cars are left off. Suggest it when the user asks where cars are on track, or wants to see traffic.',
  replayOnly: true,
  args: Type.Object({ drivers: Type.Optional(Drivers) }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: Math.round((FIT.width / FIT.height) * 100) / 100, min: MIN },
  fit: FIT,
  spec: ({ drivers }) => ({
    key: `track_map:${drivers?.join('-') ?? 'all'}`,
    label: drivers?.length ? `Track ${drivers.map(codeOf).join(' · ')}` : 'Track',
  }),
  View: TrackMap,
});
