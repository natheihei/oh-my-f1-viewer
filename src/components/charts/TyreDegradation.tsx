/** Lap time against tyre age for each stint: one dot per clean lap and a fitted line with its slope. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useSql } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  codeOf,
  colors,
  compoundLetter,
  dot,
  formatLapTime,
  isCleanLap,
  linear,
  niceStep,
  num,
  paceRange,
  polyline,
  styleOf,
  text,
  textWidth,
  ticks,
  useDriverStyles,
  xAxis,
  yAxis,
  type Box,
  type Ctx,
  type DriverStyle,
} from './kit';

const NEEDS = ['timing' as const];

/** Drivers shown when none are named: the top three at the playhead. */
const TOP = 3;
/** Fewer clean laps than this in a stint draw no line: two or three laps only give noise. */
const MIN_FIT = 5;

/**
 * The drivers' laps with what makes one clean. With none named, the top three by latest position,
 * which the query picks itself, ranked.
 */
export const sqlFor = (count: number) =>
  count
    ? `SELECT driver_number, lap_number, lap_duration, stint_number, compound, tyre_age, is_pit_in_lap, is_pit_out_lap, track_status, NULL AS rank
FROM lap_summary WHERE driver_number IN (${Array.from({ length: count }, () => '?').join(', ')})`
    : `WITH pos AS (SELECT driver_number, position, MAX(date) FROM position GROUP BY driver_number),
top AS (SELECT driver_number, position AS rank FROM pos WHERE position IS NOT NULL ORDER BY position LIMIT ${TOP})
SELECT l.driver_number, l.lap_number, l.lap_duration, l.stint_number, l.compound, l.tyre_age, l.is_pit_in_lap, l.is_pit_out_lap, l.track_status, top.rank
FROM lap_summary l JOIN top USING (driver_number)`;

export interface DegStint {
  driver: number;
  compound: string | null;
  /** Clean laps in the pace range: tyre age in laps, and lap time in seconds. */
  laps: Array<{ age: number; time: number }>;
  /** The least-squares line through `laps`, with `MIN_FIT` or more of them. */
  fit: { slope: number; intercept: number } | null;
}

export interface DegModel {
  /** By driver in the order shown, then stint. */
  stints: DegStint[];
  /** The oldest tyre drawn. */
  maxAge: number;
  range: [number, number] | null;
}

/** The slope and intercept of the least-squares line through the points, or null for fewer than `min` or all at one age. */
export function fitLine(points: ReadonlyArray<{ age: number; time: number }>, min = 3): DegStint['fit'] {
  const n = points.length;
  if (n < Math.max(2, min)) return null;
  const mx = points.reduce((s, p) => s + p.age, 0) / n;
  const my = points.reduce((s, p) => s + p.time, 0) / n;
  const sxx = points.reduce((s, p) => s + (p.age - mx) ** 2, 0);
  if (sxx === 0) return null;
  const slope = points.reduce((s, p) => s + (p.age - mx) * (p.time - my), 0) / sxx;
  return { slope, intercept: my - slope * mx };
}

/**
 * The rows of the query as stints. Only clean laps count, and of those only racing pace (see
 * `paceRange`), so one lap stuck behind a slower car doesn't bend a line. `drivers` gives the order;
 * without it the query's rank does.
 */
export function degModel(rows: ReadonlyArray<Record<string, unknown>>, drivers: readonly number[] = []): DegModel {
  const clean = rows.filter(isCleanLap);
  const range = paceRange(clean.map((r) => num(r.lap_duration)!));
  const order = drivers.length
    ? [...drivers]
    : [...new Map(rows.map((r) => [num(r.driver_number), num(r.rank) ?? Infinity])).entries()]
        .filter((e): e is [number, number] => e[0] !== null)
        .sort((a, b) => a[1] - b[1])
        .map(([d]) => d);
  const stints: DegStint[] = [];
  let maxAge = 0;
  for (const driver of order) {
    const byStint = new Map<number, DegStint>();
    for (const r of clean) {
      if (num(r.driver_number) !== driver || !range) continue;
      const age = num(r.tyre_age);
      const time = num(r.lap_duration)!;
      if (age === null || time < range[0] || time > range[1]) continue;
      const n = num(r.stint_number) ?? 0;
      const stint = byStint.get(n) ?? { driver, compound: typeof r.compound === 'string' ? r.compound : null, laps: [], fit: null };
      stint.laps.push({ age, time });
      byStint.set(n, stint);
      maxAge = Math.max(maxAge, age);
    }
    for (const n of [...byStint.keys()].sort((a, b) => a - b)) {
      const stint = byStint.get(n)!;
      stint.laps.sort((a, b) => a.age - b.age);
      stints.push({ ...stint, fit: fitLine(stint.laps, MIN_FIT) });
    }
  }
  return { stints, maxAge, range };
}

/** "+0.035" or "−0.012": seconds a lap. */
export const formatSlope = (slope: number): string => `${slope < 0 ? '−' : '+'}${Math.abs(slope).toFixed(3)}`;

interface Drawn extends DegModel {
  styles: Map<number, DriverStyle>;
}

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  if (!m.range) {
    if (!compact) text(ctx, 'No clean laps yet', width / 2, height / 2, { align: 'center' });
    return;
  }
  const left = compact ? 4 : 46;
  // The slopes get a column on the right: "VER S +0.052" is 12 characters.
  const fitted = m.stints.filter((s) => s.fit);
  const legend = compact || fitted.length === 0 ? 0 : Math.ceil(textWidth(ctx, '0', 10) * 12) + 14;
  const right = width - (compact ? 4 : 12) - legend;
  const top = compact ? 4 : 10;
  const bottom = height - (compact ? 4 : 24);
  const ages = Math.max(5, Math.ceil((m.maxAge + 1) / 5) * 5);
  const x = linear([0, ages], [left, right]);
  const step = niceStep(Math.max(1, m.range[1] - m.range[0]), Math.max(2, Math.floor((bottom - top) / 30)));
  const lo = Math.floor((m.range[0] - 0.1) / step) * step;
  const hi = Math.ceil((m.range[1] + 0.1) / step) * step;
  const y = linear([lo, hi], [bottom, top]);
  if (!compact) {
    yAxis(ctx, { scale: y, values: ticks(lo, hi, 0, step), x0: left, x1: right, format: (v) => formatLapTime(v, step < 1 ? 1 : 0) });
    const room = Math.max(1, Math.floor((right - left) / 34));
    xAxis(ctx, { scale: x, values: ticks(0, ages, 0, [1, 2, 5, 10, 20].find((s) => ages / s <= room) ?? 20), y: bottom + 11 });
    text(ctx, 'tyre age, laps · not fuel-corrected', right, height - 3, { align: 'right', color: c.faint, size: 8 });
  }

  for (const s of m.stints) {
    const style = styleOf(m.styles, s.driver);
    ctx.globalAlpha = 0.7;
    for (const p of s.laps) dot(ctx, x(p.age), y(p.time), compact ? 1.4 : 2, style.colour);
    ctx.globalAlpha = 1;
    if (!s.fit) continue;
    const a0 = s.laps[0].age;
    const a1 = s.laps.at(-1)!.age;
    const at = (age: number) => [x(age), y(s.fit!.intercept + s.fit!.slope * age)] as const;
    polyline(ctx, [at(a0), at(a1)], { color: style.colour, dashed: style.dashed, width: compact ? 1.4 : 1.8 });
  }
  if (compact) return;

  // The slopes in their column, one line per fitted stint; the latest stints when there isn't room.
  const lx = width - 10;
  text(ctx, 's/lap', lx, top + 4, { align: 'right', color: c.faint, size: 8 });
  const room = Math.max(0, Math.floor((bottom - top - 14) / 13));
  const listed = fitted.length > room ? fitted.slice(fitted.length - room) : fitted;
  listed.forEach((s, i) => {
    const style = styleOf(m.styles, s.driver);
    text(ctx, `${style.code} ${compoundLetter(s.compound)} ${formatSlope(s.fit!.slope)}`, lx, top + 18 + i * 13, { align: 'right', color: style.colour, size: 10 });
  });
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 1,
  maxItems: 4,
  description: 'Drivers to show, as car numbers. Left out, it shows the top three.',
});

function TyreDegradation({ props }: { props: { drivers?: number[] } }) {
  const key = props.drivers?.join(',') ?? '';
  const drivers = useMemo(() => (key ? key.split(',').map(Number) : []), [key]);
  const view = useSql(sqlFor(drivers.length), drivers);
  const styles = useDriverStyles();
  const model = useMemo(() => (view.state === 'ready' ? { ...degModel(view.rows, drivers), styles } : null), [view, drivers, styles]);
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'tyre_degradation',
  title: 'Tyre degradation',
  description:
    'Lap time against tyre age for each stint, with a trend line and its slope in seconds per lap. Suggest it when the user asks how the tyres are holding up, or who is losing pace.',
  args: Type.Object({ drivers: Type.Optional(Drivers) }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 16 / 9, min: [10, 6] },
  spec: ({ drivers }) => ({
    key: `tyre_degradation:${drivers?.join('-') ?? 'top'}`,
    label: drivers?.length ? `Deg ${drivers.map(codeOf).join(' · ')}` : 'Deg',
  }),
  View: TyreDegradation,
});
