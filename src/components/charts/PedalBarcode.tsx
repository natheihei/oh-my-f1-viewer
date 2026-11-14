/** One car's throttle and brake, lap over lap: a row per lap, from the line, with the turns marked. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, Driver, useLive, useSql, type Circuit } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  circuitMessage,
  colors,
  formatLapTime,
  linear,
  neutralOf,
  num,
  outlineLength,
  projector,
  styleOf,
  text,
  textWidth,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
  type Neutral,
} from './kit';

const NEEDS = ['telemetry' as const];

/** Laps drawn: the one in progress and the five before it. */
export const LAPS_SHOWN = 6;

/** The feed's throttle and brake when it has no reading: both at once, mostly, while the revs freeze. */
export const NO_READING = 104;

/** Samples further apart than this, in ms, leave a gap: the feed sends one about every 240 ms. */
const BREAK_MS = 2000;

/** A lap's time when there's none to scale by, in seconds: only used for a lap without positions. */
const GUESS_LAP_S = 90;

const LAP_COLUMNS = 'driver_number, lap_number, date_start, lap_duration, is_pit_in_lap, is_pit_out_lap, track_status';

/** Laps queried: those shown and the one before, to tell a restart by the red flag before it. */
const LAPS_READ = LAPS_SHOWN + 1;

/** The driver's latest laps, the one in progress first, and one more. */
export const LAPS_SQL = `SELECT ${LAP_COLUMNS} FROM lap_summary WHERE driver_number = ?1 AND date_start IS NOT NULL ORDER BY lap_number DESC LIMIT ${LAPS_READ}`;

/**
 * The completed laps' pedals and positions. Bounded by `date` both ways, from the oldest lap's start to the
 * current lap's, so its parameters change only when a lap is completed: about 30,000 rows of each table,
 * every car's, of which this one's 1,500 or so are kept.
 */
export const PAST_SQL = `SELECT date, throttle, brake, NULL AS x, NULL AS y FROM car_data WHERE date >= ?2 AND date < ?3 AND driver_number = ?1
UNION ALL SELECT date, NULL, NULL, x, y FROM location WHERE date >= ?2 AND date < ?3 AND driver_number = ?1`;

/** The lap in progress, from its start to the playhead (`?3`): a row is never revealed before its `date`. */
export const NOW_SQL = `SELECT date, throttle, brake, NULL AS x, NULL AS y FROM car_data WHERE date >= ?2 AND date <= ?3 AND driver_number = ?1
UNION ALL SELECT date, NULL, NULL, x, y FROM location WHERE date >= ?2 AND date <= ?3 AND driver_number = ?1`;

/** Why a lap's time isn't pace: a red flag, a pit stop, a safety car or a virtual one, or a standing start. */
export type Skip = 'PIT' | Neutral | 'START';

export interface LapRow {
  lap: number;
  /** UTC ms. */
  start: number;
  /** Seconds; null for the lap in progress. */
  time: number | null;
  /** Why the lap isn't compared, or null for a racing lap. */
  skip: Skip | null;
}

/**
 * Why a lap isn't compared, from its `lap_summary` row and the previous lap's. A red flag comes first, as
 * the cars go to the pit lane under it; then a pit lap, a safety car or a virtual one, and a standing
 * start: lap 1, or the lap after a red flag, the restart. Yellows are racing: the feed can stay on one
 * for the rest of a race.
 */
export function skipOf(r: Record<string, unknown>, before: Record<string, unknown> | undefined): Skip | null {
  const neutral = neutralOf(r.track_status);
  if (neutral === 'RED') return neutral;
  if (r.is_pit_in_lap || r.is_pit_out_lap) return 'PIT';
  if (neutral) return neutral;
  if (num(r.lap_number) === 1 || neutralOf(before?.track_status) === 'RED') return 'START';
  return null;
}

/** The rows of `lapsSql` as laps, oldest first, and whose they are. */
export function lapsOf(rows: ReadonlyArray<Record<string, unknown>>): { driver: number | null; laps: LapRow[] } {
  const sorted = rows
    .filter((r) => num(r.lap_number) !== null && num(r.date_start) !== null)
    .sort((a, b) => num(a.lap_number)! - num(b.lap_number)!);
  const laps = sorted
    .map((r, i) => {
      const prev = sorted[i - 1];
      const before = prev && num(prev.lap_number) === num(r.lap_number)! - 1 ? prev : undefined;
      return { lap: num(r.lap_number)!, start: num(r.date_start)!, time: num(r.lap_duration), skip: skipOf(r, before) };
    })
    .slice(-LAPS_SHOWN);
  return { driver: num(rows[0]?.driver_number), laps };
}

/** `PAST_SQL`'s parameters: an empty range until there's a completed lap. */
export function pastParams(driver: number | null, laps: readonly LapRow[]): number[] {
  const current = laps.at(-1);
  if (driver === null || !current || laps.length < 2) return [driver ?? 0, 0, -1];
  return [driver, laps[0].start, current.start];
}

/** What a sample says: braking, the throttle from 0 to 100, or nothing read. */
export type Pedal = 'brake' | 'none' | number;

export interface Cell {
  /** How far from the line it starts and ends, in the outline's units (tenths of a metre). */
  d0: number;
  d1: number;
  pedal: Pedal;
}

export interface PedalLap extends LapRow {
  cells: Cell[];
  /** Done, or the lap in progress. */
  done: boolean;
}

export interface PedalModel {
  /** Newest first. */
  laps: PedalLap[];
  /** The width of a row: the outline's length, in its units. */
  length: number;
  /** How far into the lap in progress the car is at the playhead, in the outline's units. */
  now: number | null;
  /** The circuit's corners, by distance from the line. */
  corners: Array<{ number: number; d: number }>;
}

/** A sample's pedals. 104 on either is no reading: never full throttle and full brake at once. */
export function pedalOf(throttle: number | null, brake: number | null): Pedal {
  if (throttle === null || brake === null || throttle === NO_READING || brake === NO_READING) return 'none';
  if (brake > 0) return 'brake';
  return Math.max(0, Math.min(100, throttle));
}

/**
 * Distance from the line at any time in a lap, from the car's positions projected onto the outline and
 * carried on past each crossing, so it keeps growing through the lap. Interpolated between positions, and
 * counted from the crossing nearest the lap's start. Null without two positions to go by.
 */
function distanceIn(
  positions: ReadonlyArray<{ date: number; s: number }>,
  start: number,
  length: number,
): ((t: number) => number) | null {
  if (positions.length < 2) return null;
  const run: Array<{ date: number; u: number }> = [];
  let turns = 0;
  positions.forEach((p, i) => {
    if (i > 0 && p.s - positions[i - 1].s < -length / 2) turns += 1;
    if (i > 0 && p.s - positions[i - 1].s > length / 2) turns -= 1;
    run.push({ date: p.date, u: p.s + turns * length });
  });
  const at = (t: number) => {
    let [lo, hi] = [0, run.length - 1];
    if (t <= run[0].date) return run[0].u;
    if (t >= run[hi].date) return run[hi].u;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (run[mid].date <= t) lo = mid;
      else hi = mid;
    }
    const [a, b] = [run[lo], run[hi]];
    return a.u + ((t - a.date) / (b.date - a.date)) * (b.u - a.u);
  };
  const base = Math.round(at(start) / length) * length;
  return (t) => Math.max(0, Math.min(length, at(t) - base));
}

/**
 * The laps and their samples as rows of cells, placed by distance from the line, so each corner falls in
 * the same place on every lap whatever its time. Each sample holds until the next, up to `BREAK_MS`, and
 * no further than its lap's end. A lap without positions is placed by time instead, scaled to the last
 * completed lap's.
 */
export function pedalModel(
  laps: readonly LapRow[],
  rows: ReadonlyArray<Record<string, unknown>>,
  playhead: number,
  circuit: Pick<Circuit, 'outline' | 'corners'>,
): PedalModel {
  const length = outlineLength(circuit.outline);
  const project = projector(circuit.outline);
  const samples = rows
    .map((r) => ({ date: num(r.date), throttle: num(r.throttle), brake: num(r.brake) }))
    .filter((s): s is { date: number; throttle: number | null; brake: number | null } => s.date !== null && (s.throttle !== null || s.brake !== null))
    .sort((a, b) => a.date - b.date);
  const positions = rows
    .map((r) => ({ date: num(r.date), x: num(r.x), y: num(r.y) }))
    .filter((p): p is { date: number; x: number; y: number } => p.date !== null && p.x !== null && p.y !== null && !(p.x === 0 && p.y === 0))
    .sort((a, b) => a.date - b.date)
    .map((p) => ({ date: p.date, s: project(p.x, p.y).s }));
  // A racing lap's time if there is one: a red flag's lap can be forty minutes.
  const completed = [...laps].reverse().filter((l, i) => i > 0 && l.time !== null);
  const lastTime = (completed.find((l) => !l.skip) ?? completed[0])?.time ?? GUESS_LAP_S;
  const drawn = laps.map((l, i) => {
    const done = l.time !== null && i < laps.length - 1;
    const end = done ? l.start + l.time! * 1000 : playhead;
    const mine = positions.filter((p) => p.date >= l.start - BREAK_MS && p.date <= end + BREAK_MS);
    // Two positions inside the lap at least: the ones either side only help at its ends.
    const placed = mine.filter((p) => p.date >= l.start && p.date <= end).length >= 2 ? distanceIn(mine, l.start, length) : null;
    const along = placed ?? ((t: number) => Math.max(0, Math.min(length, ((t - l.start) / (lastTime * 1000)) * length)));
    const cells: Cell[] = [];
    const within = samples.filter((s) => s.date >= l.start && s.date < end);
    within.forEach((s, k) => {
      const next = within[k + 1]?.date ?? end;
      const t1 = Math.min(next, s.date + BREAK_MS, end);
      if (t1 > s.date) cells.push({ d0: along(s.date), d1: along(t1), pedal: pedalOf(s.throttle, s.brake) });
    });
    return { lap: { ...l, cells, done } as PedalLap, along };
  });
  const current = drawn.at(-1);
  return {
    laps: drawn.map((d) => d.lap).reverse(),
    length,
    now: current && !current.lap.done ? current.along(playhead) : null,
    corners: circuit.corners
      .map((c) => ({ number: c.number, d: c.distance }))
      .filter((c) => c.d > 0 && c.d < length)
      .sort((a, b) => a.d - b.d),
  };
}

/**
 * The throttle colour by the amount pressed: from 15% of it with the pedal up to all of it flat out, so a
 * lift reads as a darker cell and coasting still differs from no reading.
 */
export function throttleShade(throttle: number, colour: string): string {
  const k = 0.15 + 0.85 * (Math.max(0, Math.min(100, throttle)) / 100);
  const [r, g, b] = [1, 3, 5].map((i) => Math.round(parseInt(colour.slice(i, i + 2), 16) * k));
  return `rgb(${r},${g},${b})`;
}

/** Room for the lap number and time at the left, and the turns along the top. */
const LABEL_W = 92;
const HEAD = 18;
const PAD = 10;
/** A row's height: never below the 16px a row of text reads in, and no taller than reads as a barcode. */
export const ROW = { min: 16, max: 26 };

interface Drawn extends PedalModel {
  style: DriverStyle;
}

/** The turn guides: a dark hairline cut through the cells, so it reads on green and red alike. */
const GUIDE = 'rgba(0,0,0,0.65)';

/** "−0.158" or "+0.036": a lap against the one before it. */
export const lapDelta = (seconds: number) => `${seconds < 0 ? '−' : '+'}${Math.abs(seconds).toFixed(3)}`;

/**
 * A row's time column: why it isn't compared, as "RED" or "PIT"; its difference to the lap before, when
 * both are completed racing laps; or else its own time. Nothing for a racing lap still being driven.
 */
export function lapColumn(lap: PedalLap, before: PedalLap | undefined): { text: string; delta: number | null } | null {
  if (lap.skip) return { text: lap.skip, delta: null };
  if (!lap.done || lap.time === null) return null;
  if (before?.done && before.time !== null && !before.skip) {
    const d = lap.time - before.time;
    return { text: lapDelta(d), delta: d };
  }
  return { text: formatLapTime(lap.time), delta: null };
}

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const pad = compact ? 2 : PAD;
  const head = compact ? 0 : HEAD;
  const left = compact ? pad : LABEL_W;
  const right = width - pad;
  const rows = Math.max(1, m.laps.length);
  const rowH = compact ? (height - pad * 2) / rows : Math.max(ROW.min, Math.min(ROW.max, (height - head - pad) / rows));
  const x = linear([0, m.length || 1], [left, right]);
  const top0 = compact ? pad : head;

  // The turn numbers, where they don't crowd each other. The title bar says whose laps these are.
  if (!compact) {
    if (m.corners.length) text(ctx, 'TURN', pad, head / 2, { color: c.faint, size: 9 });
    let lastX = -Infinity;
    for (const corner of m.corners) {
      const cx = x(corner.d);
      const label = String(corner.number);
      const w = textWidth(ctx, label, 9);
      if (cx - w / 2 < lastX + 4) continue;
      text(ctx, label, cx, head / 2, { align: 'center', color: c.faint, size: 9 });
      lastX = cx + w / 2;
    }
  }

  m.laps.forEach((lap, i) => {
    const top = top0 + i * rowH;
    const inset = rowH >= 12 ? 2 : 1;
    for (const cell of lap.cells) {
      const x0 = x(cell.d0);
      // A cell is at least a pixel, so a brief brake still shows.
      const x1 = Math.min(right, Math.max(x0 + 1, x(cell.d1)));
      ctx.fillStyle = cell.pedal === 'none' ? c.quiet : cell.pedal === 'brake' ? c.brake : throttleShade(cell.pedal, c.throttle);
      ctx.fillRect(x0, top + inset, x1 - x0, rowH - inset * 2);
    }
  });

  // A hairline at each turn, down through every row.
  if (!compact) {
    ctx.fillStyle = GUIDE;
    for (const corner of m.corners) ctx.fillRect(Math.round(x(corner.d)), top0, 1, rows * rowH);
  }

  m.laps.forEach((lap, i) => {
    const top = top0 + i * rowH;
    if (!lap.done && m.now !== null) {
      ctx.fillStyle = m.style.colour;
      ctx.fillRect(Math.min(right - 2, x(m.now)), top + 1, 2, rowH - 2);
    }
    if (compact) return;
    const y = top + rowH / 2;
    text(ctx, `L${lap.lap}`, pad, y, { color: lap.done ? c.dim : c.ink, size: 11, weight: lap.done ? 400 : 700 });
    // Against the lap before, ink when faster. The oldest row has none before it, and a lap after a pit
    // stop, a neutralised lap or a start has none to go by, so each keeps its time.
    const column = lapColumn(lap, m.laps[i + 1]);
    if (!column) return;
    const faster = column.delta !== null && column.delta < 0;
    text(ctx, column.text, left - 6, y, { align: 'right', color: faster ? c.ink : c.mute, size: 10, weight: faster ? 700 : 400 });
  });
}

const NO_ROWS: Array<Record<string, unknown>> = [];
const NO_PLAYHEAD = 0;

function PedalBarcode({ props }: { props: { driver: number } }) {
  const lapsView = useSql(LAPS_SQL, [props.driver]);
  const { driver, laps } = useMemo(() => lapsOf(lapsView.state === 'ready' ? lapsView.rows : NO_ROWS), [lapsView]);
  const playhead = useLive((s) => (s.sessionData.state === 'ready' ? s.sessionData.playheadMs : null)) ?? NO_PLAYHEAD;
  const current = laps.at(-1);
  // Keyed on the laps, so this only runs again when a lap is completed.
  const pastView = useSql(PAST_SQL, pastParams(driver, laps));
  const nowView = useSql(NOW_SQL, driver !== null && current ? [driver, current.start, playhead] : [0, 0, -1]);
  const styles = useDriverStyles();
  const circuit = useLive((s) => s.circuit);
  const model = useMemo(() => {
    if (driver === null || pastView.state !== 'ready' || nowView.state !== 'ready' || circuit.state !== 'ready') return null;
    return { ...pedalModel(laps, [...pastView.rows, ...nowView.rows], playhead, circuit), style: styleOf(styles, driver) };
  }, [driver, laps, pastView, nowView, playhead, circuit, styles]);
  const waiting = lapsView.state === 'ready' && laps.length === 0 ? 'Waiting for a lap' : null;
  return (
    <ChartFrame needs={NEEDS} waits={[circuitMessage(circuit), waiting]} views={[lapsView, pastView, nowView]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'pedal_barcode',
  title: 'Pedals',
  description:
    "Is a driver driving every lap the same, and where did this one differ: one car's brake and throttle as a row per lap over the last six, lined up from the line with the turns marked, so a lift, an early brake or a mistake stands out against the laps before. Suggest it for consistency, a driver under pressure or one losing time; pick car_telemetry for the numbers right now.",
  replayOnly: true,
  args: Type.Object({ driver: Driver('The driver') }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 2.4, min: { width: 300, height: 150 } },
  fit: { width: 640, height: 200 },
  spec: ({ driver }) => ({ key: `pedal_barcode:${driver}`, label: 'Pedals', drivers: [driver] }),
  View: PedalBarcode,
});
