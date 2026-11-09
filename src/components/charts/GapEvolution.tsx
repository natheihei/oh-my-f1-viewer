/** The gap between two drivers over the last laps, moving within a lap as interval samples arrive. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useSql } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  codeOf,
  colors,
  dot,
  gapSeconds,
  hline,
  linear,
  niceCeil,
  num,
  polyline,
  styleOf,
  text,
  ticks,
  useDriverStyles,
  xAxis,
  yAxis,
  type Box,
  type Ctx,
  type DriverStyle,
} from './kit';

/** Laps the chart looks back over. */
const WINDOW = 15;
/** The trend is the change over this many laps. */
const TREND_LAPS = 3;
/** A sample this far, in seconds, from its neighbours' median is a glitch. */
const SPIKE = 1;
/** Within a second of the car ahead at the detection point, DRS opens. */
const DRS = 1;

// The pair's lap starts over the window, then both drivers' gaps to the leader since its first lap.
export const SQL = `
WITH pair AS (
  SELECT lap_number, MIN(date_start) AS date_start FROM laps
  WHERE driver_number IN (?1, ?2) AND date_start IS NOT NULL GROUP BY lap_number
),
win AS (SELECT MAX(MAX(lap_number) - ${WINDOW}, 1) AS first FROM pair)
SELECT 'lap' AS kind, lap_number AS n, date_start AS date, NULL AS gap FROM pair WHERE lap_number >= (SELECT first FROM win)
UNION ALL
SELECT 'gap', driver_number, date, gap_to_leader FROM intervals
WHERE driver_number IN (?1, ?2) AND date >= COALESCE((SELECT date_start FROM pair WHERE lap_number = (SELECT first FROM win)), 0)
ORDER BY date`;

export interface GapModel {
  /** `x` is the lap, with a fraction for how far into it; `gap` is the second driver's gap behind the first, in seconds. Null breaks the line. */
  points: Array<{ x: number; gap: number } | null>;
  from: number;
  to: number;
  /** The latest gap, second driver behind first, or null when it can't be told (a lapped car). */
  current: number | null;
  /** How much the gap grew per lap over the last laps: negative is closing. */
  trend: number | null;
}

/** Where `t` falls in laps: lap n's start is n, and halfway through it is n.5. */
function lapAt(laps: Array<{ n: number; date: number }>, t: number): number {
  let i = laps.length - 1;
  while (i > 0 && laps[i].date > t) i--;
  const { n, date } = laps[i];
  const next = laps[i + 1]?.date;
  // The lap in progress is assumed as long as the one before it.
  const length = next !== undefined ? next - date : i > 0 ? date - laps[i - 1].date : 90_000;
  return n + Math.min(Math.max((t - date) / length, 0), next !== undefined ? 1 : 0.999);
}

/** The rows of `SQL` as a line: each sample of either driver's gap to the leader moves it. */
export function gapModel(rows: ReadonlyArray<Record<string, unknown>>, [a, b]: readonly [number, number]): GapModel {
  const laps: Array<{ n: number; date: number }> = [];
  for (const r of rows) {
    const n = num(r.n);
    const date = num(r.date);
    if (r.kind === 'lap' && n !== null && date !== null) laps.push({ n, date });
  }
  laps.sort((x, y) => x.n - y.n);
  const empty: GapModel = { points: [], from: 0, to: 1, current: null, trend: null };
  if (laps.length === 0) return empty;

  // The leader has no gap to itself: null means 0 there. Text such as "+1 LAP" is not a time.
  const last = new Map<number, number | null>();
  const points: GapModel['points'] = [];
  for (const r of rows) {
    const date = num(r.date);
    if (r.kind !== 'gap' || date === null || date < laps[0].date) continue;
    const driver = num(r.n);
    if (driver !== a && driver !== b) continue;
    last.set(driver, r.gap == null ? 0 : gapSeconds(r.gap));
    if (!last.has(a) || !last.has(b)) continue;
    const ga = last.get(a);
    const gb = last.get(b);
    if (ga == null || gb == null) {
      if (points.at(-1) !== null) points.push(null);
      continue;
    }
    points.push({ x: lapAt(laps, date), gap: gb - ga });
  }
  while (points.at(-1) === null) points.pop();
  smooth(points);
  const drawn = points.filter((p) => p !== null);
  if (drawn.length === 0) return empty;

  const now = drawn[drawn.length - 1];
  const from = laps[0].n;
  // A lapped car's latest gap isn't a time, so there's no current value to tell.
  const known = last.get(a) != null && last.get(b) != null;
  const then = drawn.findLast((p) => p.x <= now.x - TREND_LAPS);
  return {
    points,
    from,
    to: Math.max(now.x, from + 1),
    current: known ? now.gap : null,
    trend: known && then ? (Math.abs(now.gap) - Math.abs(then.gap)) / (now.x - then.x) : null,
  };
}

/**
 * Takes out one- and two-sample spikes, in place: when the leader changes, one driver's gap is
 * briefly against the new leader and the other's against the old. A pit stop lasts long enough to stay.
 */
function smooth(points: GapModel['points']): void {
  const gaps = points.map((p) => p?.gap ?? null);
  points.forEach((p, i) => {
    // Only between neighbours on the same stretch of line: the latest sample is never changed.
    if (!p || gaps[i - 1] == null || gaps[i + 1] == null) return;
    const near: number[] = [];
    for (let j = i - 1; j >= i - 2 && gaps[j] != null; j--) near.push(gaps[j]!);
    for (let j = i; j <= i + 2 && gaps[j] != null; j++) near.push(gaps[j]!);
    if (near.length < 3) return;
    near.sort((x, y) => x - y);
    const median = near[near.length >> 1];
    if (Math.abs(p.gap - median) > SPIKE) p.gap = median;
  });
}

/** Most of the window, so a pit stop runs off the top rather than flattening the battle. */
function yTop(gaps: number[]): number {
  const sorted = gaps.map(Math.abs).sort((x, y) => x - y);
  const high = sorted[Math.floor((sorted.length - 1) * 0.9)] ?? 0;
  return niceCeil(Math.max(DRS * 2, high * 1.15), 4);
}

interface Drawn extends GapModel {
  first: DriverStyle;
  second: DriverStyle;
}

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const big = compact ? 15 : 22;
  // The value sits top right, beside the plot.
  const side = compact ? 0 : 92;
  const left = compact ? 6 : 38;
  const right = width - (compact ? 6 : side + 8);
  const top = compact ? 8 : 12;
  const bottom = height - (compact ? 6 : 22);
  const drawn = m.points.filter((p) => p !== null);
  const yMax = yTop(drawn.map((p) => p.gap));
  const x = linear([m.from, m.to], [left, right]);
  const y = linear([0, yMax], [bottom, top]);

  if (!compact) {
    const room = Math.max(1, Math.floor((right - left) / 44));
    const step = [1, 2, 5, 10].find((s) => (m.to - m.from) / s <= room) ?? 10;
    const laps = ticks(Math.ceil(m.from), Math.floor(m.to), 0, step);
    xAxis(ctx, { scale: x, values: laps, y: height - 9, format: (l) => `L${l}` });
    const values = ticks(0, yMax, Math.max(2, Math.floor((bottom - top) / 34))).filter((v) => Math.abs(y(v) - y(DRS)) >= 11);
    yAxis(ctx, { scale: y, values, x0: left, x1: right, format: (v) => v.toFixed(1) });
    text(ctx, 'DRS', left - 5, y(DRS), { align: 'right', color: c.ink });
  }
  hline(ctx, left, right, y(DRS), c.dim, [3, 3]);

  const line = m.points.map((p) => (p ? ([x(p.x), y(Math.abs(p.gap))] as const) : null));
  ctx.save();
  ctx.beginPath();
  ctx.rect(left - 4, top - 2, right - left + 8, bottom - top + 6);
  ctx.clip();
  polyline(ctx, line, { color: c.ink, width: compact ? 1.4 : 1.6 });
  const end = drawn[drawn.length - 1];
  if (end) dot(ctx, x(end.x), y(Math.abs(end.gap)), compact ? 2.5 : 3, c.ink);
  ctx.restore();

  const value = m.current === null ? '—' : Math.abs(m.current).toFixed(2);
  const vx = width - (compact ? 8 : 10);
  text(ctx, value, vx, top + big / 2, { align: 'right', color: c.ink, size: big, weight: 500 });
  if (compact) return;
  if (m.current !== null) {
    const [behind, ahead] = m.current >= 0 ? [m.second, m.first] : [m.first, m.second];
    text(ctx, `${behind.code} to ${ahead.code}`, vx, top + big + 8, { align: 'right' });
  }
  if (m.trend !== null) {
    const sign = m.trend < 0 ? '−' : '+';
    text(ctx, `${sign}${Math.abs(m.trend).toFixed(2)} s/lap`, vx, top + big + 22, { align: 'right', color: c.ink });
    text(ctx, `last ${TREND_LAPS} laps`, vx, top + big + 35, { align: 'right' });
  }
}

const NEEDS = ['timing' as const];

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 2,
  maxItems: 2,
  description: 'The two drivers, as car numbers',
});

function GapEvolution({ props }: { props: { drivers: number[] } }) {
  const [a, b] = props.drivers;
  const view = useSql(SQL, [a, b]);
  const styles = useDriverStyles();
  const model = useMemo(
    () => (view.state === 'ready' ? { ...gapModel(view.rows, [a, b]), first: styleOf(styles, a), second: styleOf(styles, b) } : null),
    [view, styles, a, b],
  );
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'gap_evolution',
  title: 'Gap evolution',
  description:
    "The gap between two drivers over the last laps, with the 1 second DRS line. Suggest it for a battle or a chase, next to both drivers' onboards.",
  args: Type.Object({ drivers: Drivers }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 16 / 9, min: [8, 6] },
  spec: ({ drivers }) => ({ key: `gap_evolution:${drivers.join('-')}`, label: `Gap ${drivers.map(codeOf).join(' · ')}` }),
  View: GapEvolution,
});
