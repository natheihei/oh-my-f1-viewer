/** Every running car as a dot on the circuit, where it is now, from `location` and MultiViewer's outline. Retired cars are left off. */
import { useMemo } from 'react';
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
  styleOf,
  text,
  textWidth,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
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

export interface Car {
  driver: number;
  x: number;
  y: number;
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
const STEPS = [6, 15, 25, 36];

/**
 * Where each label goes, as its box's centre. Each label is pushed off the line along `normal` (a unit
 * vector, pointing out of the circuit), as close as it can be inside `bounds` without covering another
 * label, a dot in `avoid`, or a point of the line in `line`; failing that, without covering a label or dot;
 * failing that, at the first step out. Labels are placed in the order given, so put the ones that matter most first.
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
    const best = candidates.find((r) => clear(r) && offLine(r)) ?? candidates.find(clear) ?? candidates[0];
    placed.push(best);
    return best;
  });
}

interface Drawn {
  cars: Car[];
  highlight: number[];
  circuit: Extract<CircuitView, { state: 'ready' }>;
  styles: Map<number, DriverStyle>;
}

const BACKGROUND = '#000';

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const { outline, corners, rotation } = m.circuit;
  const pad = compact ? 6 : 30;
  const fit = fitOutline(outline, rotation, { left: pad, top: pad, width: width - pad * 2, height: height - pad * 2 });
  const line = outline.x.map((x, i) => fit(x, outline.y[i]));
  const n = line.length;
  if (n < 2) return;

  ctx.strokeStyle = c.faint;
  ctx.lineWidth = compact ? 2.5 : 4;
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
  const radius = (d: number) => (lit.has(d) ? (compact ? 4 : 6) : compact ? 2.5 : 4);
  const at = new Map(m.cars.map((car) => [car.driver, fit(car.x, car.y)]));
  // Highlighted cars are drawn last, so they sit on top, and labelled first, so they get the nearest places.
  const order = [...m.cars].sort((a, b) => Number(lit.has(a.driver)) - Number(lit.has(b.driver)));

  let labels: Rect[] = [];
  const labelled = [...order].reverse();
  if (!compact) {
    const dots = order.map((car) => {
      const [x, y] = at.get(car.driver)!;
      const r = radius(car.driver) + 1;
      return { x, y, w: r * 2, h: r * 2 };
    });
    labels = placeLabels(
      labelled.map((car) => {
        const [x, y] = at.get(car.driver)!;
        const [nx, ny] = normalAt(x, y);
        const style = styleOf(m.styles, car.driver);
        const size = lit.has(car.driver) ? 10 : 9;
        return { x, y, nx, ny, w: textWidth(ctx, style.code, size, lit.has(car.driver) ? 700 : 400) + 2, h: size + 1 };
      }),
      [...dots, { x: sx, y: sy, w: bar * 2, h: bar * 2 }],
      line,
      { width, height },
    );

    // Corner numbers, outside the line, where they fit without touching a car's label or each other.
    if (Math.min(width, height) >= 260) {
      const taken: Rect[] = [...labels, ...dots];
      for (const corner of corners) {
        const [x, y] = fit(corner.x, corner.y);
        const [nx, ny] = normalAt(x, y);
        const label = String(corner.number);
        const box = { x: x + nx * 11, y: y + ny * 11, w: textWidth(ctx, label, 8) + 2, h: 9 };
        if (taken.some((t) => overlaps(t, box))) continue;
        taken.push(box);
        text(ctx, label, box.x, box.y, { align: 'center', color: c.faint, size: 8 });
      }
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
      text(ctx, style.code, box.x, box.y, { align: 'center', color: mine ? c.ink : style.colour, size: mine ? 10 : 9, weight: mine ? 700 : 400 });
    });
  }

  for (const car of order) {
    const [x, y] = at.get(car.driver)!;
    const style = styleOf(m.styles, car.driver);
    ctx.fillStyle = style.colour;
    ctx.strokeStyle = lit.has(car.driver) ? c.ink : BACKGROUND;
    ctx.lineWidth = lit.has(car.driver) ? 1.5 : 1;
    ctx.beginPath();
    ctx.arc(x, y, radius(car.driver), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 1,
  maxItems: 6,
  description: 'Drivers to draw larger, with their codes in white, as car numbers. Left out, every car is the same.',
});

const NO_PLAYHEAD = 0;

function TrackMap({ props }: { props: { drivers?: number[] } }) {
  const key = props.drivers?.join(',') ?? '';
  const playhead = useLive((s) => (s.sessionData.state === 'ready' ? s.sessionData.playheadMs : null));
  const view = useSql(SQL, [playhead ?? NO_PLAYHEAD]);
  // Without timing there are no laps, so no one is out: the map still draws.
  const out = useSql(OUT_SQL);
  const styles = useDriverStyles();
  const circuit = useLive((s) => s.circuit);
  const model = useMemo(() => {
    if (view.state !== 'ready' || circuit.state !== 'ready') return null;
    const retired = out.state === 'ready' ? out.rows : [];
    return { cars: trackModel(view.rows, retired), highlight: key ? key.split(',').map(Number) : [], circuit, styles };
  }, [view, out, circuit, styles, key]);
  return (
    <ChartFrame needs={NEEDS} waits={[circuitMessage(circuit)]} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'track_map',
  title: 'Track',
  description:
    'Every running car as a dot on the circuit, where it is right now. Retired cars are left off. Suggest it when the user asks where cars are on track, or wants to see traffic.',
  replayOnly: true,
  args: Type.Object({ drivers: Type.Optional(Drivers) }),
  needs: NEEDS,
  size: { aspect: 10 / 7, min: { width: 380, height: 260 } },
  spec: ({ drivers }) => ({
    key: `track_map:${drivers?.join('-') ?? 'all'}`,
    label: drivers?.length ? `Track ${drivers.map(codeOf).join(' · ')}` : 'Track',
  }),
  View: TrackMap,
});
