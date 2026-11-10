/** Speed through one lap for two drivers, overlaid, with the running time difference along the lap. */
import { useMemo, useRef } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql, type Circuit } from '../../host';
import {
  bridgeSlow,
  ChartCanvas,
  ChartFrame,
  circuitMessage,
  codeOf,
  colors,
  deltaAlong,
  hline,
  isCleanLap,
  formatLapTime,
  lapDistance,
  lineCrossings,
  linear,
  niceCeil,
  num,
  outlineLength,
  polyline,
  styleOf,
  text,
  textWidth,
  ticks,
  UNITS_PER_METRE,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
  type LapPoint,
} from './kit';

const NEEDS = ['telemetry' as const];

/** Below this, in km/h, a few metres of distance is too much time to trust the delta: it's drawn straight through. */
export const SLOW_KMH = 150;

/** Both drivers' laps: when each started and how long it took, and what makes it clean. */
export const LAPS_SQL = `SELECT driver_number, lap_number, date_start, lap_duration, is_pit_in_lap, is_pit_out_lap, track_status
FROM lap_summary WHERE driver_number IN (?1, ?2) AND lap_duration IS NOT NULL`;

/**
 * Held either side of a lap's timed ends, in ms. `date_start` comes a third of a second after the car
 * crosses the line by its positions, give or take 0.2 s, so the window is wide enough to hold both crossings.
 */
const MARGIN_MS = 3000;

/**
 * Both laps' positions and speeds: one `date` range per table and car, each an index range of about 9,000
 * rows of every car's, from which this car's 400 or so are kept. Its parameters are the laps' ends, so they
 * change only when a lap is completed.
 */
export const SPEED_SQL = `SELECT driver_number, date, x, y, NULL AS speed FROM location WHERE date BETWEEN ?2 AND ?3 AND driver_number = ?1
UNION ALL SELECT driver_number, date, x, y, NULL FROM location WHERE date BETWEEN ?5 AND ?6 AND driver_number = ?4
UNION ALL SELECT driver_number, date, NULL, NULL, speed FROM car_data WHERE date BETWEEN ?2 AND ?3 AND driver_number = ?1
UNION ALL SELECT driver_number, date, NULL, NULL, speed FROM car_data WHERE date BETWEEN ?5 AND ?6 AND driver_number = ?4`;

export interface LapPick {
  driver: number;
  lap: number;
  /** As timed, in UTC ms: the lap's start, and its start plus its time. */
  start: number;
  end: number;
  /** Whether it's the driver's last completed lap; if not, that one wasn't clean. */
  latest: boolean;
}

/**
 * Each driver's last completed lap, as long as it's clean: not lap 1, not an in-lap or out-lap, and run
 * all under green, as the lap charts count it. If the last one isn't, the latest one that is, so a pit
 * stop or a safety car shows an earlier lap, labelled with its number, rather than nothing. Null for a
 * driver with no clean lap yet.
 */
export function pickLaps(rows: ReadonlyArray<Record<string, unknown>>, drivers: readonly number[]): Array<LapPick | null> {
  return drivers.map((driver) => {
    const mine = rows.filter((r) => num(r.driver_number) === driver && num(r.lap_duration) !== null && num(r.date_start) !== null);
    const last = Math.max(-Infinity, ...mine.map((r) => num(r.lap_number) ?? -Infinity));
    const clean = mine.filter(isCleanLap).sort((a, b) => num(b.lap_number)! - num(a.lap_number)!)[0];
    if (!clean) return null;
    const start = num(clean.date_start)!;
    const lap = num(clean.lap_number)!;
    return { driver, lap, start, end: start + num(clean.lap_duration)! * 1000, latest: lap === last };
  });
}

/** `SPEED_SQL`'s parameters for the laps picked: an empty range for a driver without one. */
export function speedParams(laps: ReadonlyArray<LapPick | null>, drivers: readonly number[]): number[] {
  return drivers.flatMap((d, i) => {
    const lap = laps[i];
    return lap ? [d, lap.start - MARGIN_MS, lap.end + MARGIN_MS] : [d, 0, -1];
  });
}

export interface SpeedLap extends LapPick {
  /** Seconds since the line against metres from it, from the car's positions. */
  time: LapPoint[];
  /** Speed against metres from the line. */
  speed: Array<{ d: number; speed: number }>;
  /** Line to line by the car's positions, in seconds: within a tenth of the official time. */
  lapTime: number;
}

export interface SpeedModel {
  /** Per driver, in the order given: the lap drawn, or null without a clean lap or its samples. */
  laps: Array<SpeedLap | null>;
  /** The lap's length in metres, along the circuit's outline. */
  length: number;
  /** The second driver's time to each distance minus the first's, in seconds: positive is the first ahead. At the line, it's the difference between their lap times. */
  delta: Array<{ d: number; delta: number }>;
  /** Corners by distance from the line, in metres. */
  corners: Array<{ number: number; d: number }>;
}

/**
 * The laps picked and the rows of `SPEED_SQL` as speed against distance. Each lap runs between the car's own
 * crossings of the line, found by projecting its positions onto the circuit's outline, so its start doesn't
 * depend on when the timing reported it (that varies by a tenth of a second or two, which put whole
 * tenths into the delta at slow corners). Distance is the car's speed integrated over time between them,
 * scaled to the outline's length; positions alone jitter by a tenth of a second. The delta compares, at
 * the same distance, how long each car took to get there from the line, with each lap's times stretched to
 * its official lap time so the delta ends on their difference, and drawn straight through where either car
 * is below `SLOW_KMH` (see `bridgeSlow`).
 */
export function speedModel(
  picks: ReadonlyArray<LapPick | null>,
  rows: ReadonlyArray<Record<string, unknown>>,
  circuit: Pick<Circuit, 'outline' | 'corners'>,
): SpeedModel {
  const length = outlineLength(circuit.outline) / UNITS_PER_METRE;
  const laps = picks.map((p): SpeedLap | null => {
    if (!p) return null;
    const mine = rows.filter((r) => num(r.driver_number) === p.driver && num(r.date) !== null);
    const positions = mine
      .filter((r) => num(r.x) !== null && num(r.y) !== null && !(r.x === 0 && r.y === 0))
      .map((r) => ({ date: num(r.date)!, x: num(r.x)!, y: num(r.y)! }));
    const line = lineCrossings(positions, circuit.outline, p.start);
    if (!line) return null;
    const samples = mine.filter((r) => num(r.speed) !== null).map((r) => ({ date: num(r.date)!, speed: num(r.speed)! }));
    const points = lapDistance(samples, line.start, line.end, length);
    if (!points) return null;
    // Timed to the official lap time, which the loops measure to the millisecond; the crossings land within a tenth of it.
    const stretch = (p.end - p.start) / (line.end - line.start);
    return {
      ...p,
      time: points.map(({ t, d }) => ({ t: t * stretch, d })),
      speed: points.map(({ d, speed }) => ({ d, speed })),
      lapTime: (line.end - line.start) / 1000,
    };
  });
  const [a, b] = laps;
  const slow = (d: number) => !!a && !!b && Math.min(speedAt(a.speed, d), speedAt(b.speed, d)) < SLOW_KMH;
  return {
    laps,
    length,
    delta: a && b ? bridgeSlow(deltaAlong(a.time, b.time), slow) : [],
    corners: circuit.corners.map((c) => ({ number: c.number, d: c.distance / UNITS_PER_METRE })).filter((c) => c.d > 0 && c.d < length),
  };
}

/** The speed at `d` metres, from the sample nearest at or after it. */
function speedAt(points: ReadonlyArray<{ d: number; speed: number }>, d: number): number {
  let [lo, hi] = [0, points.length - 1];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].d < d) lo = mid + 1;
    else hi = mid;
  }
  return points[lo]?.speed ?? 0;
}

interface Drawn extends SpeedModel {
  styles: DriverStyle[];
}

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const left = compact ? 4 : 36;
  const right = width - (compact ? 4 : 10);
  const top = compact ? 4 : 18;
  const bottom = height - (compact ? 4 : 16);
  const avail = bottom - top;
  const speedBottom = top + avail * (compact ? 0.66 : 0.62);
  const cornerRow = speedBottom + 9;
  const deltaTop = compact ? speedBottom + 4 : speedBottom + 20;
  const x = linear([0, m.length || 1], [left, right]);
  const drawn = m.laps.filter((l): l is SpeedLap => l !== null);

  // Speed: round hundreds labelled, with a grid line each.
  const speeds = drawn.flatMap((l) => l.speed.map((p) => p.speed));
  const hi = niceCeil(Math.max(100, ...speeds), 4);
  const lo = Math.max(0, Math.floor(Math.min(hi - 100, ...speeds) / 50) * 50);
  const y = linear([lo, hi], [speedBottom, top]);
  if (!compact) {
    for (const v of ticks(lo, hi, 3, 100)) {
      hline(ctx, left, right, y(v));
      text(ctx, String(v), left - 5, y(v), { align: 'right' });
    }
  }
  drawn.forEach((lap) => {
    const style = m.styles[m.laps.indexOf(lap)];
    polyline(
      ctx,
      lap.speed.map((p) => [x(p.d), y(p.speed)] as const),
      { color: style.colour, dashed: style.dashed, width: compact ? 1 : 1.3 },
    );
  });

  // The running difference, either side of zero.
  const span = Math.max(0.2, niceCeil(Math.max(0, ...m.delta.map((p) => Math.abs(p.delta))), 2));
  const yd = linear([-span, span], [bottom, deltaTop]);
  const [first, second] = m.styles;
  if (!compact) {
    hline(ctx, left, right, yd(0), c.faint);
    text(ctx, 'Δ 0', left - 5, yd(0), { align: 'right' });
    for (const v of [span, -span]) {
      hline(ctx, left, right, yd(v));
      text(ctx, `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(span < 1 ? 1 : 0)}`, left - 5, yd(v), { align: 'right' });
    }
    // At the left, where the line starts from zero, so it rarely runs under them.
    text(ctx, `▲ ${first.code} ahead`, left + 4, deltaTop + 6, { color: first.colour, size: 9 });
    text(ctx, `▼ ${second.code} ahead`, left + 4, bottom - 6, { color: second.colour, size: 9 });
  } else hline(ctx, left, right, yd(0), c.line);
  if (m.delta.length) {
    polyline(
      ctx,
      m.delta.map((p) => [x(p.d), yd(Math.max(-span, Math.min(span, p.delta)))] as const),
      { color: c.ink, width: compact ? 1 : 1.3 },
    );
  }
  if (compact) return;

  // Who's who, and which lap each is.
  let lx = left;
  m.styles.forEach((style, i) => {
    const lap = m.laps[i];
    const label = lap ? `${style.code} L${lap.lap} ${formatLapTime((lap.end - lap.start) / 1000)}${lap.latest ? '' : ' (last clean)'}` : `${style.code} no lap to show`;
    text(ctx, label, lx, 7, { color: style.colour, size: 10, weight: 600 });
    lx += textWidth(ctx, label, 10, 600) + 14;
  });
  const end = m.delta.at(-1);
  if (end) {
    const value = `Δ ${end.delta >= 0 ? '+' : '−'}${Math.abs(end.delta).toFixed(3)} s`;
    text(ctx, value, right, 7, { align: 'right', color: c.ink, size: 10, weight: 600 });
  }

  // Corner numbers between the panels, where they don't crowd each other.
  let last = -Infinity;
  for (const corner of m.corners) {
    const cx = x(corner.d);
    const label = String(corner.number);
    const w = textWidth(ctx, label, 8);
    if (cx - w / 2 < last + 3) continue;
    text(ctx, label, cx, cornerRow, { align: 'center', color: c.faint, size: 8 });
    last = cx + w / 2;
  }

  // Kilometres from the line.
  const kms = ticks(0, m.length / 1000, Math.max(2, Math.floor((right - left) / 60)));
  for (const k of kms) text(ctx, k === 0 ? '0' : String(k), x(k * 1000), height - 7, { align: 'center' });
  text(ctx, 'km', right, height - 7, { align: 'right', color: c.faint, size: 8 });
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 2,
  maxItems: 2,
  description: 'The two drivers, as car numbers. The time difference is the second minus the first.',
});

const NO_ROWS: Array<Record<string, unknown>> = [];

function SpeedTrace({ props }: { props: { drivers: number[] } }) {
  const [a, b] = props.drivers;
  const lapsView = useSql(LAPS_SQL, [a, b]);
  const picks = useMemo(() => pickLaps(lapsView.state === 'ready' ? lapsView.rows : NO_ROWS, [a, b]), [lapsView, a, b]);
  // Keyed on the laps picked, so the speed query's parameters only change when a lap is completed.
  const params = speedParams(picks, [a, b]);
  const speedView = useSql(SPEED_SQL, params);
  const styles = useDriverStyles();
  const circuit = useLive((s) => s.circuit);
  const shown = useRef<Drawn | null>(null);
  const model = useMemo(() => {
    if (speedView.state !== 'ready' || circuit.state !== 'ready') return null;
    const next = { ...speedModel(picks, speedView.rows, circuit), styles: [styleOf(styles, a), styleOf(styles, b)] };
    // Just after a lap is completed, the new laps are picked before their samples arrive: keep the last drawing until then.
    const behind = next.laps.some((lap, i) => lap === null && picks[i] !== null);
    if (!behind || !shown.current) shown.current = next;
    return shown.current;
  }, [speedView, picks, circuit, styles, a, b]);
  const waiting = lapsView.state === 'ready' && picks.every((p) => p === null) ? 'Waiting for a clean lap' : null;
  return (
    <ChartFrame needs={NEEDS} waits={[circuitMessage(circuit), waiting]} views={[lapsView, speedView]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'speed_trace',
  title: 'Speed trace',
  description:
    'Speed through one lap for two drivers, overlaid, with the time gained or lost along the lap. Suggest it when the user asks where exactly a driver is faster: braking, corner speed or the straights. Replays only.',
  args: Type.Object({ drivers: Drivers }),
  needs: NEEDS,
  size: { aspect: 16 / 9, min: [12, 7] },
  spec: ({ drivers }) => ({ key: `speed_trace:${drivers.join('-')}`, label: `Speed ${drivers.map(codeOf).join(' · ')}` }),
  View: SpeedTrace,
});
