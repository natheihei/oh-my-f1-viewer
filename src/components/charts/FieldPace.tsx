/** Who is quick right now: each driver's median over their last five clean laps, ranked, as bars of the deficit. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useSql } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  colors,
  compoundLetter,
  formatLapTime,
  isCleanLap,
  median,
  num,
  styleOf,
  text,
  textWidth,
  tyreAgeNow,
  tyreColour,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
} from './kit';

const NEEDS = ['timing' as const];

/** Clean laps the median is over. */
const LAPS = 5;
/** Fewer clean laps than this shows a dash. */
const MIN_LAPS = 3;
/** Only laps this recent count. */
const LOOKBACK = 10;

/** Every lap with what makes it clean, the tyre on it, and whether the car retired on it. */
export const SQL = `SELECT driver_number, lap_number, lap_duration, compound, tyre_age, is_pit_in_lap, is_pit_out_lap, track_status, is_out FROM lap_summary`;

export interface PaceRow {
  driver: number;
  /** Seconds, or null with fewer than three clean laps. */
  pace: number | null;
  compound: string | null;
  age: number | null;
}

/**
 * The rows of `SQL` as one row per driver, quickest first, with those without enough clean laps last.
 * Only laps from the last ten the field has finished count, and a car that has retired gets a dash.
 */
export function paceModel(rows: ReadonlyArray<Record<string, unknown>>): PaceRow[] {
  let latest = 0;
  for (const r of rows) if (num(r.lap_duration) !== null) latest = Math.max(latest, num(r.lap_number) ?? 0);
  const retired = new Set(rows.filter((r) => r.is_out).map((r) => num(r.driver_number)));
  const byDriver = new Map<number, { laps: Array<{ lap: number; time: number }>; last: Record<string, unknown> }>();
  for (const r of rows) {
    const driver = num(r.driver_number);
    const lap = num(r.lap_number);
    if (driver === null || lap === null) continue;
    const entry = byDriver.get(driver) ?? { laps: [], last: r };
    if (lap >= (num(entry.last.lap_number) ?? 0)) entry.last = r;
    if (isCleanLap(r) && lap > latest - LOOKBACK) entry.laps.push({ lap, time: num(r.lap_duration)! });
    byDriver.set(driver, entry);
  }
  const out = [...byDriver].map(([driver, { laps, last }]): PaceRow => {
    const recent = laps.sort((a, b) => b.lap - a.lap).slice(0, LAPS);
    return {
      driver,
      pace: !retired.has(driver) && recent.length >= MIN_LAPS ? median(recent.map((l) => l.time)) : null,
      compound: typeof last.compound === 'string' ? last.compound : null,
      age: tyreAgeNow(last),
    };
  });
  return out.sort((a, b) => (a.pace ?? Infinity) - (b.pace ?? Infinity) || a.driver - b.driver);
}

interface Drawn {
  rows: PaceRow[];
  styles: Map<number, DriverStyle>;
}

/** The deficit the bars span at full width, in seconds: at least one, at most three. */
const scaleOf = (rows: PaceRow[], best: number): number =>
  Math.min(3, Math.max(1, ...rows.map((r) => (r.pace === null ? 0 : r.pace - best))));

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const pad = compact ? 4 : 8;
  const head = compact ? 0 : 16;
  const pitch = Math.min(20, Math.max(compact ? 3 : 10, (height - head - pad) / Math.max(1, m.rows.length)));
  const size = Math.min(11, Math.max(8, Math.floor(pitch * 0.6)));
  const ch = textWidth(ctx, '0', size);
  const best = m.rows[0]?.pace ?? null;
  const span = best === null ? 1 : scaleOf(m.rows, best);

  // Code, tyre and age on the left, the value on the right, the bar between.
  const barLeft = compact ? pad : pad + 9 * ch;
  const valueWidth = compact ? 0 : 9 * ch;
  const barRight = width - pad - valueWidth - (compact ? 0 : ch);
  if (head) text(ctx, `median of last ${LAPS} clean laps`, pad, head / 2 + 1, { color: c.faint, size: 8 });

  m.rows.forEach((row, i) => {
    const top = head + i * pitch;
    if (top + pitch > height + 1) return;
    const y = top + pitch / 2 + 0.5;
    const style = styleOf(m.styles, row.driver);
    if (!compact) {
      text(ctx, style.code, pad, y, { color: c.ink, size, weight: 500 });
      if (row.compound) text(ctx, compoundLetter(row.compound), pad + 4.5 * ch, y, { color: tyreColour(row.compound), size, weight: 500 });
      if (row.age !== null) text(ctx, String(row.age), pad + 8 * ch, y, { align: 'right', size: size - 1 });
    }
    if (row.pace === null || best === null) {
      if (!compact) text(ctx, '—', width - pad, y, { align: 'right', size });
      return;
    }
    const deficit = row.pace - best;
    const bar = Math.max(1.5, ((barRight - barLeft) * Math.min(deficit, span)) / span);
    const h = Math.max(2, Math.round(pitch * 0.55));
    ctx.fillStyle = style.colour;
    ctx.fillRect(barLeft, top + (pitch - h) / 2, bar, h);
    if (!compact) text(ctx, i === 0 ? formatLapTime(row.pace) : `+${deficit.toFixed(2)}`, width - pad, y, { align: 'right', color: c.ink, size });
  });
}

function FieldPace() {
  const view = useSql(SQL);
  const styles = useDriverStyles();
  const model = useMemo(() => (view.state === 'ready' ? { rows: paceModel(view.rows), styles } : null), [view, styles]);
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'field_pace',
  title: 'Pace',
  description:
    'The whole field ranked by pace right now: each driver\'s median over their last five clean laps, with their tyre and its age. It takes no drivers. Suggest it when the user asks who is fastest at the moment.',
  args: Type.Object({}),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 0.7, min: { width: 300, height: 320 } },
  spec: () => ({ key: 'field_pace', label: 'Pace' }),
  View: FieldPace,
});
