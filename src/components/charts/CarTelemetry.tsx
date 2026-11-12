/** One car's speed, gear, revs, throttle, brake and DRS as of the playhead, with its speed over the last minute. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  codeOf,
  colors,
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

/** The trace's length, in seconds. */
export const TRACE_SECONDS = 60;
/** Samples further apart than this, in seconds, break the trace: the feed sends about four a second. */
const BREAK_SECONDS = 2;

/**
 * The car's samples over the last minute. Bounded both ways by `date`, the second column of the primary key,
 * so it reads an index range of about 5,000 rows, all cars', and keeps this one's 220 or so. A row is never
 * revealed before its `date`, so the playhead (`?2`) is the upper bound.
 */
export const SQL = `SELECT date, speed, rpm, n_gear, throttle, brake, drs FROM car_data
WHERE date > ?2 - ${TRACE_SECONDS * 1000} AND date <= ?2 AND driver_number = ?1 ORDER BY date`;

/** DRS as the feed's codes give it: open, available to open in the next zone, or shut. */
export type Drs = 'open' | 'available' | 'off';

const DRS_CODES: Record<number, Drs> = { 0: 'off', 1: 'off', 2: 'off', 3: 'off', 8: 'available', 9: 'available', 10: 'open', 12: 'open', 14: 'open' };

export interface TelemetryModel {
  speed: number | null;
  gear: number | null;
  rpm: number | null;
  /** 0 to 100. */
  throttle: number | null;
  /** 0 to 100: the feed only ever sends off or on. */
  brake: number | null;
  /** Null when the feed has no DRS channel, or one that isn't DRS: 2026's cars have none, and the channel carries other codes. */
  drs: Drs | null;
  /** Speed against seconds before the latest sample, oldest first; null breaks the line at a gap. */
  trace: Array<{ t: number; speed: number } | null>;
}

const pct = (v: number | null) => (v === null ? null : Math.max(0, Math.min(100, v)));

/**
 * The rows of `SQL` as the latest values and the trace. DRS shows only while every code in the minute is
 * one of DRS's own (0 to 3 shut, 8 and 9 available, 10, 12 and 14 open).
 */
export function telemetryModel(rows: ReadonlyArray<Record<string, unknown>>): TelemetryModel {
  const valid = rows.filter((r) => num(r.date) !== null).sort((a, b) => num(a.date)! - num(b.date)!);
  const last = valid.at(-1);
  if (!last) return { speed: null, gear: null, rpm: null, throttle: null, brake: null, drs: null, trace: [] };
  const end = num(last.date)!;
  const trace: TelemetryModel['trace'] = [];
  let previous: number | null = null;
  for (const r of valid) {
    const [date, speed] = [num(r.date)!, num(r.speed)];
    const t = (date - end) / 1000;
    if (speed === null || t < -TRACE_SECONDS) continue;
    if (previous !== null && t - previous > BREAK_SECONDS) trace.push(null);
    trace.push({ t, speed });
    previous = t;
  }
  const codes = valid.map((r) => num(r.drs)).filter((d): d is number => d !== null);
  const isDrs = codes.length > 0 && codes.every((d) => d in DRS_CODES);
  const drs = num(last.drs);
  return {
    speed: num(last.speed),
    gear: num(last.n_gear),
    rpm: num(last.rpm),
    throttle: pct(num(last.throttle)),
    brake: pct(num(last.brake)),
    drs: isDrs && drs !== null ? DRS_CODES[drs] : null,
    trace,
  };
}

interface Drawn extends TelemetryModel {
  style: DriverStyle;
}

const SHADE = '#161616';

/** "11 420": thousands set apart by a thin space, as the broadcast does. */
const grouped = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const pad = compact ? 4 : 10;
  const barW = compact ? 8 : Math.min(22, Math.max(14, width * 0.06));
  const barGap = compact ? 4 : 8;
  const barsLeft = width - pad - barW * 2 - barGap;
  const right = barsLeft - (compact ? 6 : 14);
  const labelRow = compact ? 0 : 14;

  // Throttle and brake, as bars filling from the bottom.
  const barTop = pad;
  const barBottom = height - pad - labelRow;
  ([
    ['THR', m.throttle, c.ink],
    ['BRK', m.brake, c.dim],
  ] as const).forEach(([label, value, colour], i) => {
    const x = barsLeft + i * (barW + barGap);
    ctx.fillStyle = SHADE;
    ctx.fillRect(x, barTop, barW, barBottom - barTop);
    if (value !== null && value > 0) {
      const h = ((barBottom - barTop) * value) / 100;
      ctx.fillStyle = colour;
      ctx.fillRect(x, barBottom - h, barW, h);
    }
    if (!compact) text(ctx, label, x + barW / 2, height - pad - 4, { align: 'center' });
  });

  // The speed now, and gear, revs and DRS under it.
  let traceTop = pad;
  if (!compact) {
    const big = Math.max(18, Math.min(40, height * 0.24));
    const y = pad + big / 2;
    const speed = m.speed === null ? '—' : String(Math.round(m.speed));
    text(ctx, speed, pad, y, { color: c.ink, size: big, weight: 700 });
    text(ctx, 'km/h', pad + textWidth(ctx, speed, big, 700) + 6, y + big * 0.22, { size: 10 });
    const row = pad + big + 12;
    let x = pad;
    const pair = (label: string, value: string, weight = 400) => {
      text(ctx, label, x, row);
      x += textWidth(ctx, label) + 6;
      text(ctx, value, x, row, { color: c.ink, size: 12, weight });
      x += textWidth(ctx, value, 12, weight) + 12;
    };
    pair('GEAR', m.gear === null ? '—' : m.gear === 0 ? 'N' : String(m.gear), 700);
    if (x + 80 < right) pair('RPM', m.rpm === null ? '—' : grouped(m.rpm));
    if (m.drs !== null && x + 36 <= right) {
      // Open is filled, available is outlined, shut is faint.
      const w = textWidth(ctx, 'DRS', 9, 700) + 10;
      const h = 14;
      const top = row - h / 2;
      if (m.drs === 'open') {
        ctx.fillStyle = c.ink;
        ctx.fillRect(x, top, w, h);
      } else {
        ctx.strokeStyle = m.drs === 'available' ? c.ink : c.faint;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(top) + 0.5, w - 1, h - 1);
      }
      text(ctx, 'DRS', x + w / 2, row + 0.5, { align: 'center', size: 9, weight: 700, color: m.drs === 'open' ? '#000' : m.drs === 'available' ? c.ink : c.faint });
    }
    traceTop = row + 14;
  }

  // The last minute of speed, newest at the right; no labels, so no grid lines.
  const traceBottom = height - pad - labelRow;
  if (traceBottom - traceTop < 12) return;
  const x = linear([-TRACE_SECONDS, 0], [pad, right]);
  const y = linear([0, 350], [traceBottom, traceTop]);
  polyline(
    ctx,
    m.trace.map((p) => (p ? ([x(p.t), y(Math.min(350, p.speed))] as const) : null)),
    { color: m.style.colour, dashed: m.style.dashed, width: compact ? 1 : 1.4 },
  );
  if (!compact) text(ctx, `last ${TRACE_SECONDS} s`, pad, height - pad - 4, { color: c.faint, size: 9 });
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
  const view = useSql(SQL, [driver, playhead ?? NO_PLAYHEAD]);
  const styles = useDriverStyles();
  const model = useMemo(() => (view.state === 'ready' ? { ...telemetryModel(view.rows), style: styleOf(styles, driver) } : null), [view, styles, driver]);
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'car_telemetry',
  title: 'Telemetry',
  description:
    "One car's speed, gear, revs, throttle, brake and DRS, as the driver is driving. Suggest it next to that driver's onboard.",
  replayOnly: true,
  args: Type.Object({ drivers: Drivers }),
  needs: NEEDS,
  size: { aspect: 1.6, min: [6, 5] },
  spec: ({ drivers }) => ({ key: `car_telemetry:${drivers[0]}`, label: `Telemetry ${codeOf(drivers[0])}` }),
  View: CarTelemetry,
});
