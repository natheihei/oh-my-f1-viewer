/** Lap times for one to four drivers, lap by lap, with the y axis held to racing pace. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql } from '../../host';
import {
  axisLaps,
  ChartCanvas,
  ChartFrame,
  codeOf,
  compoundLetter,
  dot,
  drawBands,
  formatLapTime,
  isCleanLap,
  lapAxis,
  linear,
  neutralBands,
  neutralOf,
  niceStep,
  num,
  paceRange,
  polyline,
  spreadLabels,
  styleOf,
  text,
  ticks,
  tyreAgeNow,
  useDriverStyles,
  yAxis,
  type Band,
  type Box,
  type Ctx,
  type DriverStyle,
} from './kit';

const NEEDS = ['timing' as const];

/** Every lap of the drivers, the one in progress included for its tyre. */
export const sqlFor = (count: number) =>
  `SELECT driver_number, lap_number, lap_duration, compound, tyre_age, is_pit_in_lap, is_pit_out_lap, track_status
FROM lap_summary WHERE driver_number IN (${Array.from({ length: count }, () => '?').join(', ')})`;

export interface LapSeries {
  driver: number;
  /** Laps drawn: racing laps within the pace range. Laps between them that aren't break the line. */
  laps: Array<{ lap: number; time: number }>;
  /** In-laps, marked PIT. */
  pits: number[];
  /** The tyre on the latest lap, and its age. */
  compound: string | null;
  age: number | null;
}

export interface CompareModel {
  /** In the order asked for. */
  series: LapSeries[];
  bands: Band[];
  lap: number;
  /** The y axis, in seconds, or null with no racing lap yet. */
  range: [number, number] | null;
}

/**
 * The rows of the query as one series per driver. The y range is racing pace from the clean laps;
 * a lap is drawn if it isn't a pit lap or neutralised and falls in that range, so a stop or a safety
 * car breaks the line rather than flattening it.
 */
export function compareModel(rows: ReadonlyArray<Record<string, unknown>>, drivers: readonly number[]): CompareModel {
  const clean = rows.filter(isCleanLap).map((r) => num(r.lap_duration)!);
  const range = paceRange(clean);
  let lap = 0;
  const series = drivers.map((driver): LapSeries => {
    const own = rows.filter((r) => num(r.driver_number) === driver).sort((a, b) => num(a.lap_number)! - num(b.lap_number)!);
    const laps: LapSeries['laps'] = [];
    const pits: number[] = [];
    for (const r of own) {
      const n = num(r.lap_number);
      const time = num(r.lap_duration);
      if (n === null) continue;
      if (time !== null) lap = Math.max(lap, n);
      if (r.is_pit_in_lap) pits.push(n);
      if (time === null || !range || r.is_pit_in_lap || r.is_pit_out_lap || neutralOf(r.track_status)) continue;
      if (time >= range[0] && time <= range[1]) laps.push({ lap: n, time });
    }
    const latest = own.at(-1);
    return {
      driver,
      laps,
      pits,
      compound: typeof latest?.compound === 'string' ? latest.compound : null,
      age: latest ? tyreAgeNow(latest) : null,
    };
  });
  return { series, bands: neutralBands(rows), lap, range };
}

interface Drawn extends CompareModel {
  styles: Map<number, DriverStyle>;
  total: number | null;
}

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const left = compact ? 4 : 46;
  const right = width - (compact ? 4 : 70);
  const top = compact ? 4 : 10;
  const bottom = height - (compact ? 4 : 20);
  const laps = axisLaps(m.lap, m.total);
  const x = linear([0, laps], [left, right]);
  drawBands(ctx, { scale: x, bands: m.bands, top, bottom, centred: true, labels: !compact });
  if (!m.range) return;
  // A little room above and below, on round values.
  const step = niceStep(Math.max(1, m.range[1] - m.range[0]), Math.max(2, Math.floor((bottom - top) / 30)));
  const lo = Math.floor((m.range[0] - 0.1) / step) * step;
  const hi = Math.ceil((m.range[1] + 0.1) / step) * step;
  const y = linear([lo, hi], [bottom, top]);
  if (!compact) {
    yAxis(ctx, { scale: y, values: ticks(lo, hi, 0, step), x0: left, x1: right, format: (v) => formatLapTime(v, step < 1 ? 1 : 0) });
    lapAxis(ctx, { scale: x, laps, y: height - 8 });
  }

  const ends: Array<{ y: number; label: string; color: string }> = [];
  m.series.forEach((s, k) => {
    const style = styleOf(m.styles, s.driver);
    const path: Array<readonly [number, number] | null> = [];
    s.laps.forEach((p, i) => {
      if (i && p.lap !== s.laps[i - 1].lap + 1) path.push(null);
      path.push([x(p.lap), y(p.time)]);
    });
    polyline(ctx, path, { color: style.colour, dashed: style.dashed, width: compact ? 1.2 : 1.4 });
    if (x(1) - x(0) >= 4) for (const p of s.laps) dot(ctx, x(p.lap), y(p.time), compact ? 1.2 : 1.8, style.colour);
    if (compact) return;
    for (const lap of s.pits) text(ctx, 'PIT', x(lap), top + 16 + k * 10, { align: 'center', color: style.colour, size: 8 });
    const last = s.laps.at(-1);
    if (!last) return;
    const tyre = s.compound ? ` ${compoundLetter(s.compound)}${s.age ?? ''}` : '';
    ends.push({ y: y(last.time), label: `${style.code}${tyre}`, color: style.colour });
  });
  if (compact) return;
  const x0 = x(Math.max(...m.series.map((s) => s.laps.at(-1)?.lap ?? 0))) + 6;
  const ys = spreadLabels(
    ends.map((e) => e.y),
    11,
    top + 4,
    bottom,
  );
  ends.forEach((e, i) => text(ctx, e.label, x0, ys[i], { color: e.color, size: 10 }));
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 1,
  maxItems: 4,
  description: 'The drivers to compare, as car numbers',
});

function LapTimeCompare({ props }: { props: { drivers: number[] } }) {
  const key = props.drivers.join(',');
  const drivers = useMemo(() => key.split(',').map(Number), [key]);
  const view = useSql(sqlFor(drivers.length), drivers);
  const styles = useDriverStyles();
  const total = useLive((live) => (live.sessionData.state === 'ready' ? (live.sessionData.lapCount?.total ?? null) : null));
  const model = useMemo(() => (view.state === 'ready' ? { ...compareModel(view.rows, drivers), styles, total } : null), [view, drivers, styles, total]);
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'lap_time_compare',
  title: 'Lap times',
  description:
    "Lap times for one to four drivers, lap by lap. Suggest it when the user asks who is faster, or how a driver's pace has changed.",
  args: Type.Object({ drivers: Drivers }),
  needs: NEEDS,
  size: { aspect: 16 / 9, min: [10, 6] },
  spec: ({ drivers }) => ({ key: `lap_time_compare:${drivers.join('-')}`, label: `Lap times ${drivers.map(codeOf).join(' · ')}` }),
  View: LapTimeCompare,
});
