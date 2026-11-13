/** One car's speed, gear, revs, throttle and brake as of the playhead, with its speed over the last lap. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql, type ChaseAid } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  codeOf,
  colors,
  hline,
  linear,
  num,
  polyline,
  styleOf,
  text,
  textWidth,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
} from './kit';

const NEEDS = ['telemetry' as const];

/** The trace's length, in seconds, before the car has a lap time. */
export const TRACE_SECONDS = 60;
/** The trace is one lap long, kept within these, in seconds: a lap behind the safety car can run past two minutes. */
const WINDOW = { least: 60, most: 120 };
/** Samples further apart than this, in seconds, break the trace: the feed sends about four a second. */
const BREAK_SECONDS = 2;
/** What the feed sends for throttle and brake when it has no reading. The revs freeze with it. */
const NO_READING = 104;

/**
 * The car's samples over the trace's window (`?3`, in ms). Bounded both ways by `date`, the second column of
 * the primary key, so it reads an index range of all cars' rows and keeps this one's 300 or so. A row is never
 * revealed before its `date`, so the playhead (`?2`) is the upper bound.
 */
export const SQL = `SELECT date, speed, rpm, n_gear, throttle, brake, drs FROM car_data
WHERE date > ?2 - ?3 AND date <= ?2 AND driver_number = ?1 ORDER BY date`;

/** The car's latest lap time, which sets the trace's length. */
export const LAP_SQL = `SELECT lap_duration FROM laps WHERE driver_number = ?1 AND lap_duration IS NOT NULL ORDER BY lap_number DESC LIMIT 1`;

/** The car's latest interval to the one ahead. */
export const INTERVAL_SQL = `SELECT interval FROM intervals WHERE driver_number = ?1 ORDER BY date DESC LIMIT 1`;

/** The trace's length in seconds, from the latest lap time: whole seconds, within `WINDOW`. */
export function traceSeconds(rows: ReadonlyArray<Record<string, unknown>>): number {
  const lap = num(rows[0]?.lap_duration);
  return lap === null ? TRACE_SECONDS : Math.max(WINDOW.least, Math.min(WINDOW.most, Math.round(lap)));
}

/** DRS as the feed's codes give it: open, available to open in the next zone, or shut. */
export type Drs = 'open' | 'available' | 'off';

const DRS_CODES: Record<number, Drs> = { 0: 'off', 1: 'off', 2: 'off', 3: 'off', 8: 'available', 9: 'available', 10: 'open', 12: 'open', 14: 'open' };

export interface TracePoint {
  t: number;
  speed: number;
  gear: number | null;
}

export interface TelemetryModel {
  speed: number | null;
  gear: number | null;
  /** Null while the feed has no reading. */
  rpm: number | null;
  /** 0 to 100, null while the feed has no reading. */
  throttle: number | null;
  /** 0 to 100, null while the feed has no reading: the feed only ever sends off or on. */
  brake: number | null;
  /** Null when the feed has no DRS channel, or one that isn't DRS: 2026's cars have none, and the channel is empty. */
  drs: Drs | null;
  /** Speed against seconds before the latest sample, oldest first; null breaks the line at a gap. */
  trace: Array<TracePoint | null>;
  /** The trace's length, in seconds. */
  seconds: number;
}

const pct = (v: number | null) => (v === null ? null : Math.max(0, Math.min(100, v)));

/**
 * The rows of `SQL` as the latest values and the trace. DRS shows only while every code in the window is
 * one of DRS's own (0 to 3 shut, 8 and 9 available, 10, 12 and 14 open). A sample whose throttle or brake is
 * 104 has no reading: throttle, brake and revs are null for it.
 */
export function telemetryModel(rows: ReadonlyArray<Record<string, unknown>>, seconds = TRACE_SECONDS): TelemetryModel {
  const valid = rows.filter((r) => num(r.date) !== null).sort((a, b) => num(a.date)! - num(b.date)!);
  const last = valid.at(-1);
  if (!last) return { speed: null, gear: null, rpm: null, throttle: null, brake: null, drs: null, trace: [], seconds };
  const end = num(last.date)!;
  const trace: TelemetryModel['trace'] = [];
  let previous: number | null = null;
  for (const r of valid) {
    const [date, speed] = [num(r.date)!, num(r.speed)];
    const t = (date - end) / 1000;
    if (speed === null || t < -seconds) continue;
    if (previous !== null && t - previous > BREAK_SECONDS) trace.push(null);
    trace.push({ t, speed, gear: num(r.n_gear) });
    previous = t;
  }
  const codes = valid.map((r) => num(r.drs)).filter((d): d is number => d !== null);
  const isDrs = codes.length > 0 && codes.every((d) => d in DRS_CODES);
  const drs = num(last.drs);
  const unread = num(last.throttle) === NO_READING || num(last.brake) === NO_READING;
  return {
    speed: num(last.speed),
    gear: num(last.n_gear),
    rpm: unread ? null : num(last.rpm),
    throttle: unread ? null : pct(num(last.throttle)),
    brake: unread ? null : pct(num(last.brake)),
    drs: isDrs && drs !== null ? DRS_CODES[drs] : null,
    trace,
    seconds,
  };
}

/** The chase aid as of the playhead: null for a car with no interval, such as the leader. */
export interface Chase {
  label: string;
  interval: number;
  inRange: boolean;
}

/** The latest interval against the season's line. A lapped interval is text, not a number, so it's never in range. */
export function chaseOf(rows: ReadonlyArray<Record<string, unknown>>, aid: ChaseAid): Chase | null {
  const interval = num(rows[0]?.interval);
  return interval === null ? null : { label: aid.label, interval, inRange: interval < aid.within };
}

/** How much faster, km/h, the car must be after a low point for it to count as a corner. */
const RISE = 10;

/**
 * The trace's corners: each point that is the lowest within `around` seconds either side, with that long after it, at
 * least `drop` km/h under the fastest in the `before` seconds leading to it, and `RISE` under the fastest after it.
 */
export function corners(trace: ReadonlyArray<TracePoint | null>, { around = 2.2, before = 6, drop = 40 } = {}): TracePoint[] {
  const points = trace.filter((p): p is TracePoint => p !== null);
  // A low point needs `around` seconds after it, or it may be the car still braking.
  const end = points.at(-1)?.t ?? 0;
  return points.filter((p, i) => {
    if (p.t > end - around) return false;
    const near = points.filter((q) => Math.abs(q.t - p.t) <= around);
    // The first of equal lows only.
    if (near.some((q) => q.speed < p.speed) || points.findIndex((q) => q.speed === p.speed && Math.abs(q.t - p.t) <= around) !== i) return false;
    const lead = points.filter((q) => q.t < p.t && q.t >= p.t - before);
    // And the car is out of it: faster again within twice `around`, not still braking for what comes next.
    const out = points.filter((q) => q.t > p.t && q.t <= p.t + around * 2);
    return lead.length > 0 && Math.max(...lead.map((q) => q.speed)) - p.speed >= drop && Math.max(...out.map((q) => q.speed)) - p.speed >= RISE;
  });
}

interface Drawn extends TelemetryModel {
  style: DriverStyle;
  chase: Chase | null;
}

const SHADE = '#161616';
/** The trace's speed range, km/h, and its rules. */
const TOP_SPEED = 350;
const RULES = [100, 200, 300];

/** "11 420": thousands set apart by a thin space, as the broadcast does. */
const grouped = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const gearText = (g: number | null) => (g === null ? '—' : g === 0 ? 'N' : String(g));

/** A chip: filled ink when on, outlined when off. Returns its width. */
function chip(ctx: Ctx, label: string, x: number, row: number, on: boolean, offColour: string): number {
  const c = colors();
  const w = textWidth(ctx, label, 9, 700) + 10;
  const h = 14;
  const top = row - h / 2;
  if (on) {
    ctx.fillStyle = c.ink;
    ctx.fillRect(x, top, w, h);
  } else {
    ctx.strokeStyle = offColour;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(top) + 0.5, w - 1, h - 1);
  }
  text(ctx, label, x + w / 2, row + 0.5, { align: 'center', size: 9, weight: 700, color: on ? '#000' : offColour });
  return w;
}

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const pad = compact ? 4 : 10;
  const barW = compact ? 8 : Math.min(22, Math.max(14, width * 0.06));
  const barGap = compact ? 4 : 8;
  const barsLeft = width - pad - barW * 2 - barGap;
  const right = barsLeft - (compact ? 6 : 14);
  const labelRow = compact ? 0 : 14;

  // Throttle and brake, as stacks of segments lit from the bottom; a dash while the feed has no reading.
  const barTop = pad;
  const barBottom = height - pad - labelRow;
  const [segment, segmentGap] = compact ? [3, 1] : [4, 2];
  const segments = Math.max(1, Math.floor((barBottom - barTop + segmentGap) / (segment + segmentGap)));
  ([
    ['THR', m.throttle, c.throttle],
    ['BRK', m.brake, c.brake],
  ] as const).forEach(([label, value, colour], i) => {
    const x = barsLeft + i * (barW + barGap);
    const lit = value === null ? 0 : Math.round((segments * value) / 100);
    for (let k = 0; k < segments; k++) {
      ctx.fillStyle = k < lit ? colour : SHADE;
      ctx.fillRect(x, barBottom - k * (segment + segmentGap) - segment, barW, segment);
    }
    if (value === null && !compact) text(ctx, '—', x + barW / 2, (barTop + barBottom) / 2, { align: 'center', color: c.faint });
    if (!compact) text(ctx, label, x + barW / 2, height - pad - 4, { align: 'center', color: value === null ? c.faint : c.dim });
  });

  // The speed now, and gear, revs and DRS or the chase aid under it.
  let traceTop = pad;
  if (!compact) {
    const big = Math.max(18, Math.min(40, height * 0.24));
    const y = pad + big / 2;
    const speed = m.speed === null ? '—' : String(Math.round(m.speed));
    text(ctx, speed, pad, y, { color: c.ink, size: big, weight: 700 });
    text(ctx, 'km/h', pad + textWidth(ctx, speed, big, 700) + 6, y + big * 0.22, { size: 10 });
    const row = pad + big + 12;
    let x = pad;
    const pair = (label: string, value: string, weight = 400, color = c.ink) => {
      text(ctx, label, x, row);
      x += textWidth(ctx, label) + 6;
      text(ctx, value, x, row, { color, size: 12, weight });
      x += textWidth(ctx, value, 12, weight) + 12;
    };
    pair('GEAR', gearText(m.gear), 700);
    if (x + 80 < right) pair('RPM', m.rpm === null ? '—' : grouped(m.rpm), 400, m.rpm === null ? c.faint : c.ink);
    if (m.drs !== null) {
      // Open is filled, available is outlined, shut is faint.
      if (x + 36 <= right) chip(ctx, 'DRS', x, row, m.drs === 'open', m.drs === 'available' ? c.ink : c.faint);
    } else if (m.chase) {
      // No DRS channel: the season's aid, lit within its line of the car ahead, and the interval.
      const value = m.chase.interval.toFixed(2);
      const weight = m.chase.inRange ? 700 : 400;
      if (x + textWidth(ctx, m.chase.label, 9, 700) + 16 + textWidth(ctx, value, 12, weight) <= right) {
        x += chip(ctx, m.chase.label, x, row, m.chase.inRange, c.faint) + 6;
        text(ctx, value, x, row, { color: m.chase.inRange ? c.ink : c.dim, size: 12, weight });
      }
    }
    traceTop = row + 14;
  }

  // The last lap of speed, newest at the right, on rules at 100, 200 and 300 km/h.
  const traceBottom = height - pad - labelRow;
  if (traceBottom - traceTop < 12) return;
  const left = compact ? pad : pad + textWidth(ctx, '300', 9) + 6;
  const x = linear([-m.seconds, 0], [left, right]);
  const y = linear([0, TOP_SPEED], [traceBottom, traceTop]);
  if (!compact) {
    for (const v of RULES) {
      if (y(v) < traceTop + 4) continue;
      hline(ctx, left, right, y(v), c.quiet);
      text(ctx, String(v), pad, y(v), { color: c.faint, size: 9 });
    }
  }
  const at = (p: TracePoint) => [x(p.t), y(Math.min(TOP_SPEED, p.speed))] as const;
  polyline(ctx, m.trace.map((p) => (p ? at(p) : null)), { color: m.style.colour, dashed: m.style.dashed, width: compact ? 1.4 : 2 });
  const now = m.trace.at(-1);
  if (now) {
    const [nx, ny] = at(now);
    ctx.fillStyle = m.style.colour;
    ctx.beginPath();
    ctx.arc(nx, ny, compact ? 2 : 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Each corner's speed, and its gear under it where there's room.
  if (!compact) {
    let lastX = -Infinity;
    for (const p of corners(m.trace)) {
      const px = x(p.t);
      if (px - lastX < 34 || px > right - 8) continue;
      lastX = px;
      const py = Math.min(traceBottom - 5, y(p.speed) + 10);
      text(ctx, String(p.speed), px, py, { align: 'center', color: c.ink, size: 9 });
      if (traceBottom - py > 12) text(ctx, gearText(p.gear), px, py + 10, { align: 'center', color: c.faint, size: 9 });
    }
    text(ctx, `last ${m.seconds} s`, left, height - pad - 4, { color: c.faint, size: 9 });
  }
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 1,
  maxItems: 1,
  description: 'The driver, as a car number',
});

const NO_PLAYHEAD = 0;

function CarTelemetry({ props }: { props: { drivers: number[] } }) {
  const [driver] = props.drivers;
  const playhead = useLive((s) => (s.sessionData.state === 'ready' ? s.sessionData.playheadMs : null));
  const aid = useLive((s) => s.spec.chaseAid);
  const lap = useSql(LAP_SQL, [driver]);
  const seconds = lap.state === 'ready' ? traceSeconds(lap.rows) : TRACE_SECONDS;
  const view = useSql(SQL, [driver, playhead ?? NO_PLAYHEAD, seconds * 1000]);
  const interval = useSql(INTERVAL_SQL, [driver]);
  const styles = useDriverStyles();
  const model = useMemo(
    () =>
      view.state === 'ready' && interval.state === 'ready'
        ? { ...telemetryModel(view.rows, seconds), style: styleOf(styles, driver), chase: chaseOf(interval.rows, aid) }
        : null,
    [view, interval, seconds, styles, driver, aid],
  );
  return (
    <ChartFrame needs={NEEDS} views={[view, lap, interval]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

/** Where its content stops growing: a strip as wide as an onboard beside it, and no taller than the trace reads. */
const FIT = { width: 480, height: 200 };

export default defineComponent({
  name: 'car_telemetry',
  title: 'Telemetry',
  description:
    "One car's speed, gear, revs, throttle and brake as the driver is driving, with its speed over the last lap and each corner's speed. Suggest it under that driver's onboard.",
  replayOnly: true,
  args: Type.Object({ drivers: Drivers }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: Math.round((FIT.width / FIT.height) * 100) / 100, min: { width: 300, height: 150 } },
  fit: FIT,
  spec: ({ drivers }) => ({ key: `car_telemetry:${drivers[0]}`, label: `Telemetry ${codeOf(drivers[0])}` }),
  View: CarTelemetry,
});
