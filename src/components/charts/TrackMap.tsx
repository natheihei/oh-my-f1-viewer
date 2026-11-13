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
  /** Cars off the racing line: drawn as rings. */
  lane: Set<number>;
  /** Each car's position in the race, by car number, for the name under the pointer. */
  positions: Map<number, number>;
  circuit: Extract<CircuitView, { state: 'ready' }>;
  styles: Map<number, DriverStyle>;
  pointer: Pointer;
  /** Where the drawing leaves the car under the pointer, for a click to pick it. */
  under: { current: number | null };
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
/** How opaque the cars nobody chose are, once someone is chosen. */
const RECEDE = 0.75;

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const { outline, corners, rotation } = m.circuit;
  const pad = compact ? 6 : 16;
  const fit = fitOutline(outline, rotation, { left: pad, top: pad, width: width - pad * 2, height: height - pad * 2 });
  const line = outline.x.map((x, i) => fit(x, outline.y[i]));
  const n = line.length;
  m.under.current = null;
  if (n < 2) return;

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
  // Once someone is chosen, the rest recede: smaller, dimmer and unlabelled, named only under the pointer.
  const recede = lit.size > 0;
  const radius = (d: number) => (lit.has(d) ? (compact ? 4 : 6) : compact ? 2.5 : recede ? 3 : 4);
  const at = new Map(m.cars.map((car) => [car.driver, fit(car.x, car.y)]));
  // Chosen cars are drawn last, so they sit on top, and labelled first, so they get the nearest places.
  const order = [...m.cars].sort((a, b) => Number(lit.has(a.driver)) - Number(lit.has(b.driver)));

  if (!compact) {
    const dots = order.map((car) => {
      const [x, y] = at.get(car.driver)!;
      const r = radius(car.driver) + 1;
      return { x, y, w: r * 2, h: r * 2 };
    });
    const labelled = [...order].reverse().filter((car) => !recede || lit.has(car.driver));
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
  const hit = m.cars.reduce<{ car: Car; x: number; y: number; dist: number } | null>((best, car) => {
    const [x, y] = at.get(car.driver)!;
    const dist = Math.hypot(x - p.x, y - p.y);
    return dist < HIT && (!best || dist < best.dist) ? { car, x, y, dist } : best;
  }, null);
  if (!hit) return;
  const { car, x, y } = hit;
  m.under.current = car.driver;
  const style = styleOf(m.styles, car.driver);
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, radius(car.driver) + 3, 0, Math.PI * 2);
  ctx.stroke();
  const position = m.positions.get(car.driver);
  const name = `${style.code} P${position ?? '–'}${m.lane.has(car.driver) ? ' · pit lane' : ''}`;
  const hint = lit.has(car.driver) ? ' · click to drop' : lit.size < MAX_CHOSEN ? ' · click to choose' : '';
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

/** The most drivers the map draws chosen. */
const MAX_CHOSEN = 6;

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 1,
  maxItems: MAX_CHOSEN,
  description:
    'Drivers to draw larger and labelled, as car numbers: the rest are drawn smaller and unlabelled, named under the pointer. Left out, every car is the same and labelled. The viewer can click a car to add or drop it on the map itself, which leaves these props as they are.',
});

/** The chosen drivers with `driver` added, or dropped if it's there: none at all as an empty list. */
export function toggleDriver(chosen: readonly number[], driver: number): number[] {
  if (chosen.includes(driver)) return chosen.filter((d) => d !== driver);
  return chosen.length < MAX_CHOSEN ? [...chosen, driver] : [...chosen];
}

const NO_PLAYHEAD = 0;
/** Least room: the circuit large enough for eleven-pixel codes to sit beside their dots. Fit: where a circuit stops gaining detail, as on the speed ribbon. */
const MIN = { width: 360, height: 250 };
const FIT = { width: 560, height: 400 };

function TrackMap({ props }: { props: { drivers?: number[] } }) {
  // Who's chosen is the map's own: it starts from the props, and a click adds or drops a car. New props start it again.
  const key = props.drivers?.join(',') ?? '';
  const [chosen, setChosen] = useState({ key, drivers: props.drivers ?? [] });
  if (chosen.key !== key) setChosen({ key, drivers: props.drivers ?? [] });
  const highlight = chosen.key === key ? chosen.drivers : (props.drivers ?? []);
  const playhead = useLive((s) => (s.sessionData.state === 'ready' ? s.sessionData.playheadMs : null));
  const view = useSql(SQL, [playhead ?? NO_PLAYHEAD]);
  // Without timing there are no laps, so no one is out: the map still draws.
  const out = useSql(OUT_SQL);
  const positionView = useSql(POSITION_SQL);
  const styles = useDriverStyles();
  const circuit = useLive((s) => s.circuit);
  const [pointer, setPointer] = useState<Pointer>(null);
  const under = useRef<number | null>(null);
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
    return { cars, lane: inLane(cars, circuit.outline), positions, highlight, circuit, styles };
  }, [view, out, positionView, circuit, styles, highlight]);
  // The pointer moves often: only the drawing follows it, not the model.
  const drawn = useMemo(() => (model ? { ...model, pointer, under } : null), [model, pointer]);
  const onClick = () => {
    const driver = under.current;
    if (driver !== null) setChosen((c) => ({ key: c.key, drivers: toggleDriver(c.drivers, driver) }));
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
