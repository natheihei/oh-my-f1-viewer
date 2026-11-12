/**
 * Lap times for one to four drivers, or the top three when none are named, lap by lap, with the y axis held to racing pace, and a trend line through
 * each stint with its slope: how much the tyres lose a lap.
 */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql } from '../../host';
import {
  axisLaps,
  ChartCanvas,
  ChartFrame,
  codeOf,
  colors,
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

/** Drivers shown when none are named: the top three at the playhead. */
const TOP = 3;

/**
 * Every lap of the drivers, the one in progress included for its tyre. With none named, the top three by
 * latest position, which the query picks itself, ranked.
 */
export const sqlFor = (count: number) =>
  count
    ? `SELECT driver_number, lap_number, lap_duration, stint_number, compound, tyre_age, is_pit_in_lap, is_pit_out_lap, track_status, NULL AS rank
FROM lap_summary WHERE driver_number IN (${Array.from({ length: count }, () => '?').join(', ')})`
    : `WITH pos AS (SELECT driver_number, position, MAX(date) FROM position GROUP BY driver_number),
top AS (SELECT driver_number, position AS rank FROM pos WHERE position IS NOT NULL ORDER BY position LIMIT ${TOP})
SELECT l.driver_number, l.lap_number, l.lap_duration, l.stint_number, l.compound, l.tyre_age, l.is_pit_in_lap, l.is_pit_out_lap, l.track_status, top.rank
FROM lap_summary l JOIN top USING (driver_number)`;

/** Fewer clean laps than this in a stint draw no trend: two or three laps only give noise. */
const MIN_FIT = 5;

/** A stint's trend: the least-squares line through its clean laps, by tyre age, drawn from its first clean lap to its last. */
export interface StintTrend {
  compound: string | null;
  /** Seconds lost per lap: positive is getting slower. Not corrected for fuel. */
  slope: number;
  from: { lap: number; time: number };
  to: { lap: number; time: number };
}

/** The slope and intercept of the least-squares line through the points, or null for fewer than `min` or all at one age. */
export function fitLine(points: ReadonlyArray<{ age: number; time: number }>, min = 3): { slope: number; intercept: number } | null {
  const n = points.length;
  if (n < Math.max(2, min)) return null;
  const mx = points.reduce((s, p) => s + p.age, 0) / n;
  const my = points.reduce((s, p) => s + p.time, 0) / n;
  const sxx = points.reduce((s, p) => s + (p.age - mx) ** 2, 0);
  if (sxx === 0) return null;
  const slope = points.reduce((s, p) => s + (p.age - mx) * (p.time - my), 0) / sxx;
  return { slope, intercept: my - slope * mx };
}

/** "+0.035" or "−0.012": seconds a lap. */
export const formatSlope = (slope: number): string => `${slope < 0 ? '−' : '+'}${Math.abs(slope).toFixed(3)}`;

export interface LapSeries {
  driver: number;
  /** Laps drawn: racing laps within the pace range. Laps between them that aren't break the line. */
  laps: Array<{ lap: number; time: number }>;
  /** In-laps, marked PIT. */
  pits: number[];
  /** Each stint with enough clean laps, in order. Only clean laps count, so a lap in traffic under yellow doesn't bend a line. */
  trends: StintTrend[];
  /** The tyre on the latest lap, and its age. */
  compound: string | null;
  age: number | null;
}

export interface CompareModel {
  /** In the order asked for, or by position when the chart picked them. */
  series: LapSeries[];
  bands: Band[];
  lap: number;
  /** The y axis, in seconds, or null with no racing lap yet. */
  range: [number, number] | null;
}

/**
 * The rows of the query as one series per driver. The y range is racing pace from the clean laps;
 * a lap is drawn if it isn't a pit lap or neutralised and falls in that range, so a stop or a safety
 * car breaks the line rather than flattening it. `drivers` gives the order; without it the query's rank does.
 */
export function compareModel(rows: ReadonlyArray<Record<string, unknown>>, drivers: readonly number[] = []): CompareModel {
  const clean = rows.filter(isCleanLap).map((r) => num(r.lap_duration)!);
  const range = paceRange(clean);
  let lap = 0;
  const order = drivers.length
    ? drivers
    : [...new Map(rows.map((r) => [num(r.driver_number), num(r.rank) ?? Infinity])).entries()]
        .filter((e): e is [number, number] => e[0] !== null)
        .sort((a, b) => a[1] - b[1])
        .map(([d]) => d);
  const series = order.map((driver): LapSeries => {
    const own = rows.filter((r) => num(r.driver_number) === driver).sort((a, b) => num(a.lap_number)! - num(b.lap_number)!);
    const laps: LapSeries['laps'] = [];
    const pits: number[] = [];
    const byStint = new Map<number, { compound: string | null; points: Array<{ age: number; time: number; lap: number }> }>();
    for (const r of own) {
      const n = num(r.lap_number);
      const time = num(r.lap_duration);
      if (n === null) continue;
      if (time !== null) lap = Math.max(lap, n);
      if (r.is_pit_in_lap) pits.push(n);
      if (time === null || !range || r.is_pit_in_lap || r.is_pit_out_lap || neutralOf(r.track_status)) continue;
      if (time < range[0] || time > range[1]) continue;
      laps.push({ lap: n, time });
      const age = num(r.tyre_age);
      if (age === null || !isCleanLap(r)) continue;
      const stint = num(r.stint_number) ?? 0;
      const entry = byStint.get(stint) ?? { compound: typeof r.compound === 'string' ? r.compound : null, points: [] };
      entry.points.push({ age, time, lap: n });
      byStint.set(stint, entry);
    }
    const trends: StintTrend[] = [];
    for (const stint of [...byStint.keys()].sort((x, y) => x - y)) {
      const { compound, points } = byStint.get(stint)!;
      const fit = fitLine(points, MIN_FIT);
      if (!fit) continue;
      const [first, last] = [points[0], points.at(-1)!];
      const at = (p: { age: number; lap: number }) => ({ lap: p.lap, time: fit.intercept + fit.slope * p.age });
      trends.push({ compound, slope: fit.slope, from: at(first), to: at(last) });
    }
    const latest = own.at(-1);
    return {
      driver,
      laps,
      pits,
      trends,
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
  // The end labels get a column on the right: "VER M23 +0.052" is 14 characters.
  const right = width - (compact ? 4 : 104);
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

  const ends: Array<{ y: number; label: string; color: string; past?: boolean }> = [];
  m.series.forEach((s, k) => {
    const style = styleOf(m.styles, s.driver);
    const path: Array<readonly [number, number] | null> = [];
    s.laps.forEach((p, i) => {
      if (i && p.lap !== s.laps[i - 1].lap + 1) path.push(null);
      path.push([x(p.lap), y(p.time)]);
    });
    polyline(ctx, path, { color: style.colour, dashed: style.dashed, width: compact ? 1.2 : 1.4 });
    // Each stint's trend, fainter and straight, under the laps it was fitted to.
    ctx.globalAlpha = 0.45;
    for (const t of s.trends) polyline(ctx, [[x(t.from.lap), y(t.from.time)], [x(t.to.lap), y(t.to.time)]], { color: style.colour, width: compact ? 2 : 3 });
    ctx.globalAlpha = 1;
    if (x(1) - x(0) >= 4) for (const p of s.laps) dot(ctx, x(p.lap), y(p.time), compact ? 1.2 : 1.8, style.colour);
    if (compact) return;
    for (const lap of s.pits) text(ctx, 'PIT', x(lap), top + 16 + k * 10, { align: 'center', color: style.colour, size: 8 });
    const last = s.laps.at(-1);
    if (!last) return;
    const tyre = s.compound ? ` ${compoundLetter(s.compound)}${s.age ?? ''}` : '';
    // The latest stint's slope goes with the label, when its trend reaches the latest lap. Earlier stints get a
    // label of their own in the same column, level with where their trend ended.
    const current = s.trends.at(-1)?.to.lap === last.lap ? s.trends.at(-1)! : null;
    for (const t of s.trends) {
      if (t !== current) ends.push({ y: y(t.to.time), label: `${style.code} ${compoundLetter(t.compound)} ${formatSlope(t.slope)}`, color: style.colour, past: true });
    }
    ends.push({ y: y(last.time), label: `${style.code}${tyre}${current ? ` ${formatSlope(current.slope)}` : ''}`, color: style.colour });
  });
  if (compact) return;
  const x0 = x(Math.max(...m.series.map((s) => s.laps.at(-1)?.lap ?? 0))) + 6;
  const ys = spreadLabels(
    ends.map((e) => e.y),
    11,
    top + 4,
    bottom - 14,
  );
  ends.forEach((e, i) => {
    ctx.globalAlpha = e.past ? 0.6 : 1;
    text(ctx, e.label, x0, ys[i], { color: e.color, size: 10 });
  });
  ctx.globalAlpha = 1;
  if (m.series.some((s) => s.trends.length)) {
    const faint = colors().faint;
    text(ctx, 'trend in s/lap', width - 6, height - 18, { align: 'right', color: faint, size: 8 });
    text(ctx, 'not fuel-corrected', width - 6, height - 8, { align: 'right', color: faint, size: 8 });
  }
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 1,
  maxItems: 4,
  description: 'The drivers to compare, as car numbers. Left out, it shows the top three.',
});

function LapTimeCompare({ props }: { props: { drivers?: number[] } }) {
  const key = props.drivers?.join(',') ?? '';
  const drivers = useMemo(() => (key ? key.split(',').map(Number) : []), [key]);
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
"Lap times for one to four drivers, or the top three when none are named, lap by lap over the whole session, with a trend line through each stint and its slope in seconds lost per lap. Suggest it when the user asks how a driver's pace has changed, how their tyres are holding up, or to compare a few drivers' pace over time.",
  args: Type.Object({ drivers: Type.Optional(Drivers) }),
  needs: NEEDS,
  size: { aspect: 16 / 9, min: [10, 6] },
  spec: ({ drivers }) => ({
    key: `lap_time_compare:${drivers?.join('-') ?? 'top'}`,
    label: drivers?.length ? `Lap times ${drivers.map(codeOf).join(' · ')}` : 'Lap times',
  }),
  View: LapTimeCompare,
});
