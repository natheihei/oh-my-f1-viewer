/** One car's throttle and brake, lap over lap: a row per lap, from the line, with the turns marked. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql, type Circuit } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  circuitMessage,
  codeOf,
  colors,
  formatLapTime,
  linear,
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

/** Laps drawn: the one in progress and the five before it. */
export const LAPS_SHOWN = 6;

/** The feed's throttle and brake when it has no reading: both at once, mostly, while the revs freeze. */
export const NO_READING = 104;

/** Samples further apart than this, in ms, leave a gap: the feed sends one about every 240 ms. */
const BREAK_MS = 2000;

/** A corner is placed only if the car passed within this of it, in `location`'s tenths of a metre: 60 m. */
const CORNER_REACH = 600;

const LAP_COLUMNS = 'driver_number, lap_number, date_start, lap_duration';

/**
 * The driver's latest laps, the one in progress first. With none named, the car in the lead at the
 * playhead, which the query picks itself.
 */
export const lapsSql = (named: boolean) =>
  named
    ? `SELECT ${LAP_COLUMNS} FROM lap_summary WHERE driver_number = ?1 AND date_start IS NOT NULL ORDER BY lap_number DESC LIMIT ${LAPS_SHOWN}`
    : `WITH pos AS (SELECT driver_number, position, MAX(date) FROM position GROUP BY driver_number),
lead AS (SELECT driver_number FROM pos WHERE position IS NOT NULL ORDER BY position LIMIT 1)
SELECT ${LAP_COLUMNS} FROM lap_summary JOIN lead USING (driver_number) WHERE date_start IS NOT NULL ORDER BY lap_number DESC LIMIT ${LAPS_SHOWN}`;

/**
 * The completed laps' pedals, and the last completed lap's positions for placing the corners. Bounded by
 * `date` both ways, from the oldest lap's start to the current lap's, so its parameters change only when
 * a lap is completed: about 30,000 rows of every car's, of which this one's 1,500 or so are kept.
 */
export const PAST_SQL = `SELECT date, throttle, brake, NULL AS x, NULL AS y FROM car_data WHERE date >= ?2 AND date < ?3 AND driver_number = ?1
UNION ALL SELECT date, NULL, NULL, x, y FROM location WHERE date >= ?4 AND date < ?3 AND driver_number = ?1`;

/** The lap in progress, from its start to the playhead (`?3`): a row is never revealed before its `date`. */
export const NOW_SQL = `SELECT date, throttle, brake FROM car_data WHERE date >= ?2 AND date <= ?3 AND driver_number = ?1`;

export interface LapRow {
  lap: number;
  /** UTC ms. */
  start: number;
  /** Seconds; null for the lap in progress. */
  time: number | null;
}

/** The rows of `lapsSql` as laps, oldest first, and whose they are. */
export function lapsOf(rows: ReadonlyArray<Record<string, unknown>>): { driver: number | null; laps: LapRow[] } {
  const laps = rows
    .filter((r) => num(r.lap_number) !== null && num(r.date_start) !== null)
    .map((r) => ({ lap: num(r.lap_number)!, start: num(r.date_start)!, time: num(r.lap_duration) }))
    .sort((a, b) => a.lap - b.lap)
    .slice(-LAPS_SHOWN);
  return { driver: num(rows[0]?.driver_number), laps };
}

/** `PAST_SQL`'s parameters: an empty range until there's a completed lap. */
export function pastParams(driver: number | null, laps: readonly LapRow[]): number[] {
  const current = laps.at(-1);
  const last = laps.at(-2);
  if (driver === null || !current || !last) return [driver ?? 0, 0, -1, 0];
  return [driver, laps[0].start, current.start, last.start];
}

/** What a sample says: braking, the throttle from 0 to 100, or nothing read. */
export type Pedal = 'brake' | 'none' | number;

export interface Cell {
  /** ms from the lap's start. */
  t0: number;
  t1: number;
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
  /** The width of a row, in ms: the last completed lap's time, or the longest seen before there is one. */
  span: number;
  /** ms into the lap in progress, at the playhead. */
  now: number | null;
  /** Each corner's ms into the last completed lap, where the car passed nearest it. */
  corners: Array<{ number: number; t: number }>;
}

/** A sample's pedals. 104 on either is no reading: never full throttle and full brake at once. */
export function pedalOf(throttle: number | null, brake: number | null): Pedal {
  if (throttle === null || brake === null || throttle === NO_READING || brake === NO_READING) return 'none';
  if (brake > 0) return 'brake';
  return Math.max(0, Math.min(100, throttle));
}

/**
 * The laps and their samples as rows of cells. Each sample holds until the next, up to `BREAK_MS`, and
 * no further than its lap's end. The corners are placed on the last completed lap, at the sample of
 * the car's positions nearest each.
 */
export function pedalModel(
  laps: readonly LapRow[],
  rows: ReadonlyArray<Record<string, unknown>>,
  playhead: number,
  corners: Circuit['corners'],
): PedalModel {
  const samples = rows
    .map((r) => ({ date: num(r.date), throttle: num(r.throttle), brake: num(r.brake) }))
    .filter((s): s is { date: number; throttle: number | null; brake: number | null } => s.date !== null && (s.throttle !== null || s.brake !== null))
    .sort((a, b) => a.date - b.date);
  const drawn = laps.map((l, i): PedalLap => {
    const done = l.time !== null && i < laps.length - 1;
    const end = done ? l.start + l.time! * 1000 : playhead;
    const cells: Cell[] = [];
    const within = samples.filter((s) => s.date >= l.start && s.date < end);
    within.forEach((s, k) => {
      const next = within[k + 1]?.date ?? end;
      const t1 = Math.min(next, s.date + BREAK_MS, end);
      if (t1 > s.date) cells.push({ t0: s.date - l.start, t1: t1 - l.start, pedal: pedalOf(s.throttle, s.brake) });
    });
    return { ...l, cells, done };
  });
  const last = drawn.filter((l) => l.done).at(-1);
  const current = drawn.at(-1);
  const span = last ? last.time! * 1000 : Math.max(60_000, ...drawn.map((l) => (l.cells.at(-1)?.t1 ?? 0)));
  let placed: PedalModel['corners'] = [];
  if (last) {
    const end = last.start + last.time! * 1000;
    const positions = rows
      .map((r) => ({ date: num(r.date), x: num(r.x), y: num(r.y) }))
      .filter((p): p is { date: number; x: number; y: number } => p.date !== null && p.x !== null && p.y !== null && !(p.x === 0 && p.y === 0))
      .filter((p) => p.date >= last.start && p.date < end);
    placed = corners
      .map((c) => {
        let best: { date: number; d: number } | null = null;
        for (const p of positions) {
          const d = Math.hypot(p.x - c.x, p.y - c.y);
          if (!best || d < best.d) best = { date: p.date, d };
        }
        return best && best.d < CORNER_REACH ? { number: c.number, t: best.date - last.start } : null;
      })
      .filter((c): c is { number: number; t: number } => c !== null)
      .sort((a, b) => a.t - b.t);
  }
  return {
    laps: drawn.slice().reverse(),
    span,
    now: current && !current.done ? playhead - current.start : null,
    corners: placed,
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
  /** The driver was picked, not named: the title bar doesn't say who, so the chart does. */
  picked: boolean;
}

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const pad = compact ? 2 : PAD;
  const head = compact ? 0 : HEAD;
  const left = compact ? pad : LABEL_W;
  const right = width - pad;
  const rows = Math.max(1, m.laps.length);
  const rowH = compact ? (height - pad * 2) / rows : Math.max(ROW.min, Math.min(ROW.max, (height - head - pad) / rows));
  const x = linear([0, m.span || 1], [left, right]);

  // Whose laps, if the title bar does not say; then turn numbers where the car passed each on its last full lap, where they do not crowd.
  if (!compact) {
    if (m.picked) text(ctx, m.style.code, pad, head / 2, { color: m.style.colour, size: 10, weight: 700 });
    else if (m.corners.length) text(ctx, 'TURN', pad, head / 2, { color: c.faint, size: 9 });
    let lastX = -Infinity;
    for (const corner of m.corners) {
      const cx = x(corner.t);
      const label = String(corner.number);
      const w = textWidth(ctx, label, 9);
      if (cx > right || cx - w / 2 < lastX + 4) continue;
      text(ctx, label, cx, head / 2, { align: 'center', color: c.faint, size: 9 });
      lastX = cx + w / 2;
    }
  }

  m.laps.forEach((lap, i) => {
    const top = (compact ? pad : head) + i * rowH;
    const inset = rowH >= 12 ? 2 : 1;
    for (const cell of lap.cells) {
      const x0 = x(cell.t0);
      if (x0 >= right) break;
      // A cell is at least a pixel, so a brief brake still shows.
      const x1 = Math.min(right, Math.max(x0 + 1, x(cell.t1)));
      ctx.fillStyle = cell.pedal === 'none' ? c.quiet : cell.pedal === 'brake' ? c.brake : throttleShade(cell.pedal, c.throttle);
      ctx.fillRect(x0, top + inset, x1 - x0, rowH - inset * 2);
    }
    if (!lap.done && m.now !== null) {
      ctx.fillStyle = m.style.colour;
      ctx.fillRect(Math.min(right - 2, x(m.now)), top + 1, 2, rowH - 2);
    }
    if (compact) return;
    const y = top + rowH / 2;
    text(ctx, `L${lap.lap}`, pad, y, { color: lap.done ? c.dim : c.ink, size: 11, weight: lap.done ? 400 : 700 });
    if (lap.done && lap.time !== null) text(ctx, formatLapTime(lap.time), left - 6, y, { align: 'right', color: c.mute, size: 10 });
  });
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 1,
  maxItems: 1,
  description: 'The driver, as a car number. Left out, the leader at the time.',
});

const NO_ROWS: Array<Record<string, unknown>> = [];
const NO_PLAYHEAD = 0;

function PedalBarcode({ props }: { props: { drivers?: number[] } }) {
  const named = props.drivers?.[0] ?? null;
  const lapsView = useSql(lapsSql(named !== null), named !== null ? [named] : []);
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
    return { ...pedalModel(laps, [...pastView.rows, ...nowView.rows], playhead, circuit.corners), style: styleOf(styles, driver), picked: named === null };
  }, [driver, named, laps, pastView, nowView, playhead, circuit, styles]);
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
    "Is a driver driving every lap the same, and where did this one differ: one car's brake and throttle as a row per lap over the last six, lined up from the line with the turns marked, so a lift, an early brake or a mistake stands out against the laps before. Suggest it for consistency, a driver under pressure or one losing time; pick car_telemetry for the numbers right now, and speed_trace to compare two drivers' speed.",
  replayOnly: true,
  args: Type.Object({ drivers: Type.Optional(Drivers) }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 2.4, min: { width: 300, height: 150 } },
  fit: { width: 640, height: 200 },
  spec: ({ drivers }) => ({
    key: `pedal_barcode:${drivers?.[0] ?? 'lead'}`,
    label: drivers?.length ? `Pedals ${codeOf(drivers[0])}` : 'Pedals',
  }),
  View: PedalBarcode,
});
