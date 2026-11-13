/**
 * The gap between two drivers over the last laps, moving within a lap as interval samples arrive, with each
 * one's tyre and last lap beside it and whether the car behind is in DRS or Overtake range.
 */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql, type ChaseAid } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  codeOf,
  colors,
  compoundLetter,
  dot,
  formatLapTime,
  gapSeconds,
  gapTrend,
  hline,
  linear,
  niceCeil,
  num,
  polyline,
  styleOf,
  text,
  textWidth,
  ticks,
  tyreAgeNow,
  tyreColour,
  useDriverStyles,
  vline,
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

// The pair's lap starts over the window, both drivers' gaps to the leader since its first lap, and
// each one's laps of the window: the gap as it crossed the line, for the trend, and its time and tyre.
export const SQL = `
WITH pair AS (
  SELECT lap_number, MIN(date_start) AS date_start FROM laps
  WHERE driver_number IN (?1, ?2) AND date_start IS NOT NULL GROUP BY lap_number
),
win AS (SELECT MAX(MAX(lap_number) - ${WINDOW}, 1) AS first FROM pair)
SELECT 'lap' AS kind, lap_number AS n, date_start AS date, NULL AS gap, NULL AS lap, NULL AS stint, NULL AS lap_duration, NULL AS compound, NULL AS tyre_age FROM pair WHERE lap_number >= (SELECT first FROM win)
UNION ALL
SELECT 'gap', driver_number, date, gap_to_leader, NULL, NULL, NULL, NULL, NULL FROM intervals
WHERE driver_number IN (?1, ?2) AND date >= COALESCE((SELECT date_start FROM pair WHERE lap_number = (SELECT first FROM win)), 0)
UNION ALL
SELECT 'end', driver_number, date_end, gap_to_leader, lap_number, stint_number, lap_duration, compound, tyre_age FROM lap_summary
WHERE driver_number IN (?1, ?2) AND lap_number >= (SELECT first FROM win)
ORDER BY date`;

/** One driver beside the gap: the tyre they're on and the last lap they finished. */
export interface GapSide {
  driver: number;
  compound: string | null;
  age: number | null;
  /** Seconds. */
  last: number | null;
}

/** The gap as both crossed the line at the end of `lap`, and the stint each was on then. */
export interface LapGap {
  lap: number;
  x: number;
  gap: number | null;
  stints: [number | null, number | null];
}

export interface GapModel {
  /** `x` is the lap, with a fraction for how far into it; `gap` is the second driver's gap behind the first, in seconds. Null breaks the line. */
  points: Array<{ x: number; gap: number } | null>;
  from: number;
  to: number;
  /** The latest gap, second driver behind first, or null when it can't be told (a lapped car). */
  current: number | null;
  /** How much the gap grew per lap over the last laps: negative is closing. */
  trend: number | null;
  /** In the order asked for. */
  sides: [GapSide, GapSide];
  /** Each lap of the window both have finished, oldest first. */
  lapGaps: LapGap[];
  /** Stops: `lap` is the first lap of the new stint, so the line breaks where that lap starts. */
  pits: Array<{ driver: number; lap: number }>;
  /** Where the order flipped on track, and who was ahead after. */
  passes: Array<{ x: number; ahead: number }>;
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

/** Under this, in seconds, the cars are level: a pass is the sign of the gap flipping across it. */
const LEVEL = 0.08;

/** The rows of `SQL` as a line: each sample of either driver's gap to the leader moves it. */
export function gapModel(rows: ReadonlyArray<Record<string, unknown>>, [a, b]: readonly [number, number]): GapModel {
  const laps: Array<{ n: number; date: number }> = [];
  for (const r of rows) {
    const n = num(r.n);
    const date = num(r.date);
    if (r.kind === 'lap' && n !== null && date !== null) laps.push({ n, date });
  }
  laps.sort((x, y) => x.n - y.n);
  // Each driver's laps of the window, the one in progress last: it has the tyre, and no time yet.
  const own = (driver: number) => rows.filter((r) => r.kind === 'end' && num(r.n) === driver).sort((x, y) => (num(x.lap) ?? 0) - (num(y.lap) ?? 0));
  const side = (driver: number): GapSide => {
    const mine = own(driver);
    const latest = mine.at(-1);
    return {
      driver,
      compound: typeof latest?.compound === 'string' ? latest.compound : null,
      age: latest ? tyreAgeNow(latest) : null,
      last: num(mine.filter((r) => num(r.lap_duration) !== null).at(-1)?.lap_duration),
    };
  };
  const sides: [GapSide, GapSide] = [side(a), side(b)];
  const empty: GapModel = { points: [], from: 0, to: 1, current: null, trend: null, sides, lapGaps: [], pits: [], passes: [] };
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
  // The trend from the gaps at the line, rather than a sample that may sit on a pit stop.
  const ends = rows
    .filter((r) => r.kind === 'end' && r.date != null)
    .map((r) => ({ driver_number: r.n, lap_number: r.lap, date_end: r.date, gap_to_leader: r.gap, stint_number: r.stint }));

  // The gap at each crossing of the line, read off the trace so the lap's point sits on it: each car's
  // `gap_to_leader` in lap_summary is taken at its own moment, and the two can disagree by a second.
  const ended = (driver: number) => new Map(own(driver).filter((r) => num(r.date) !== null && num(r.lap) !== null).map((r) => [num(r.lap)!, r]));
  const [ea, eb] = [ended(a), ended(b)];
  const lapGaps: LapGap[] = [...ea.keys()]
    .filter((lap) => eb.has(lap))
    .sort((p, q) => p - q)
    .map((lap) => {
      const [ra, rb] = [ea.get(lap)!, eb.get(lap)!];
      const x = lapAt(laps, Math.max(num(ra.date)!, num(rb.date)!));
      let at: { x: number; gap: number } | null = null;
      for (const p of drawn) {
        if (p.x <= x) at = p;
        else break;
      }
      const [ga, gb] = [ra.gap == null ? 0 : gapSeconds(ra.gap), rb.gap == null ? 0 : gapSeconds(rb.gap)];
      const gap = at && x - at.x < 0.05 ? at.gap : ga === null || gb === null ? null : gb - ga;
      return { lap, x, gap, stints: [num(ra.stint), num(rb.stint)] };
    });

  // A stop is a new stint number on a driver's next lap.
  const pits: GapModel['pits'] = [];
  for (const driver of [a, b]) {
    const mine = own(driver);
    for (let i = 1; i < mine.length; i++) {
      const [s, before] = [num(mine[i].stint), num(mine[i - 1].stint)];
      const lap = num(mine[i].lap);
      if (s !== null && before !== null && lap !== null && s > before) pits.push({ driver, lap });
    }
  }

  // A pass: the gap's sign flips and stays, away from a stop and while they're close.
  const passes: GapModel['passes'] = [];
  let sign = 0;
  let level: number | null = null;
  for (const p of drawn) {
    if (Math.abs(p.gap) < LEVEL) {
      level ??= p.x;
      continue;
    }
    const s = Math.sign(p.gap);
    if (sign && s !== sign) {
      const x = level ?? p.x;
      if (!pits.some((q) => Math.abs(q.lap - x) < 1.6) && Math.abs(p.gap) < 5) passes.push({ x, ahead: s > 0 ? a : b });
    }
    sign = s;
    level = null;
  }

  return {
    points,
    from,
    to: Math.max(now.x, from + 1),
    current: known ? now.gap : null,
    trend: known ? gapTrend(ends, [a, b], TREND_LAPS) : null,
    sides,
    lapGaps,
    pits,
    passes,
  };
}

/** Samples either side a glitch is judged against. */
const NEAR = 8;

/**
 * Takes out spikes, in place: when the leader changes, one driver's gap is briefly against the new
 * leader and the other's against the old, sometimes for several samples. A sample far from the median
 * of the samples around it is a glitch; a pit stop lasts longer than half of them, so it stays.
 */
function smooth(points: GapModel['points']): void {
  const gaps = points.map((p) => p?.gap ?? null);
  points.forEach((p, i) => {
    // Only on the same stretch of line, and the latest sample is never changed.
    if (!p || i === points.length - 1) return;
    const near: number[] = [];
    for (let j = i - 1; j >= i - NEAR && gaps[j] != null; j--) near.push(gaps[j]!);
    for (let j = i; j <= i + NEAR && gaps[j] != null; j++) near.push(gaps[j]!);
    if (near.length < 5) return;
    near.sort((x, y) => x - y);
    const median = near[near.length >> 1];
    if (Math.abs(p.gap - median) > SPIKE) p.gap = median;
  });
}

/** Most of what's shown, so a lone glitch doesn't flatten the battle. */
function yTop(gaps: number[], line: number): number {
  const sorted = gaps.map(Math.abs).sort((x, y) => x - y);
  const high = sorted[Math.floor((sorted.length - 1) * 0.9)] ?? 0;
  return niceCeil(Math.max(line * 2, high * 1.15), 4);
}

interface Drawn extends GapModel {
  first: DriverStyle;
  second: DriverStyle;
  /** The season's DRS or Overtake line, from the spec. */
  aid: ChaseAid;
}

/** The app's smallest type. */
const TYPE = 11;
const BIG = 22;
/** The panel right of the plot: the gap, the trend, and each driver's tyre and last lap. */
const SIDE = 106;
const LEFT = 38;
const TOP = 12;
/** Under the plot, for the lap numbers. */
const AXIS = 22;
const ROW = 32;

/** The panel's rows, top down, and how far down the last one reaches. */
function panel(m: Drawn): { trendAt: number | null; rangeAt: number | null; rowsAt: number; height: number } {
  let at = TOP + BIG + 22;
  const trendAt = m.trend === null ? null : at;
  if (trendAt !== null) at += 13;
  at += 8;
  const inRange = m.current !== null && Math.abs(m.current) < m.aid.within;
  const rangeAt = inRange ? at : null;
  if (inRange) at += 18;
  // The second row's lap time, then room under it.
  return { trendAt, rangeAt, rowsAt: at, height: at + ROW + 13 + 8 + AXIS - 8 };
}

/** The tile while the panel fits it, and taller once it doesn't, for the host to mark the cut: nothing in the panel is dropped. */
export function gapExtent(m: Drawn, box: Box): { width: number; height: number } {
  if (box.compact) return box;
  return { width: box.width, height: Math.max(box.height, panel(m).height) };
}

function draw(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const big = compact ? 15 : BIG;
  const left = compact ? 6 : LEFT;
  const right = width - (compact ? 6 : SIDE + 8);
  const top = compact ? 8 : TOP;
  const bottom = height - (compact ? 6 : AXIS);
  const drawn = m.points.filter((p) => p !== null);
  const within = m.aid.within;
  const codeOfDriver = (driver: number) => (driver === m.sides[0].driver ? m.first.code : m.second.code);
  // The scale fits the laps since the last stop, so the stop itself runs off the top.
  const lastPit = m.pits.length ? Math.max(...m.pits.map((p) => p.lap)) : null;
  const since = lastPit === null ? [] : drawn.filter((p) => p.x > lastPit + 0.3);
  const yMax = yTop((since.length ? since : drawn).map((p) => p.gap), within);
  const x = linear([m.from, m.to], [left, right]);
  const y = linear([0, yMax], [bottom, top]);

  // The DRS or Overtake zone, filled, so inside it reads as a place.
  ctx.fillStyle = c.quiet;
  ctx.fillRect(left, y(Math.min(within, yMax)), right - left, bottom - y(Math.min(within, yMax)));
  if (!compact) {
    const room = Math.max(1, Math.floor((right - left) / 44));
    const step = [1, 2, 5, 10].find((s) => (m.to - m.from) / s <= room) ?? 10;
    for (const l of ticks(Math.ceil(m.from), Math.floor(m.to), 0, step)) text(ctx, `L${l}`, x(l), height - 9, { align: 'center', size: TYPE });
    const values = ticks(0, yMax, Math.max(2, Math.floor((bottom - top) / 34))).filter((v) => Math.abs(y(v) - y(within)) >= 12);
    for (const v of values) {
      hline(ctx, left, right, y(v));
      text(ctx, v.toFixed(v >= 10 || Number.isInteger(v) ? 0 : 1), left - 5, y(v), { align: 'right', size: TYPE });
    }
    text(ctx, m.aid.label, left - 5, y(within), { align: 'right', color: c.ink, size: TYPE });
  } else text(ctx, m.aid.label, left + 2, y(within) - 7, { size: TYPE });
  hline(ctx, left, right, y(within), c.dim, [3, 3]);

  if (!compact) {
    // A mark's label sits right of its line, or left of it where it would run into the panel.
    const mark = (label: string, at: number, y: number, style: { color?: string; weight?: number }) => {
      const room = right - at - 3 >= textWidth(ctx, label, TYPE, style.weight);
      text(ctx, label, room ? at + 3 : at - 3, y, { ...style, size: TYPE, align: room ? 'left' : 'right' });
    };
    for (const p of m.pits) {
      if (p.lap < m.from) continue;
      vline(ctx, x(p.lap), top, bottom, c.faint, [2, 3]);
      mark(`PIT ${codeOfDriver(p.driver)}`, x(p.lap), top + 6, {});
    }
    for (const p of m.passes) {
      vline(ctx, x(p.x), top, bottom, c.dim);
      mark(`${codeOfDriver(p.ahead)} AHEAD`, x(p.x), top + (m.pits.length ? 18 : 6), { color: c.ink, weight: 600 });
    }
  }

  // The live trace, faint, broken across a stop.
  const trace: Array<readonly [number, number] | null> = [];
  let prev: number | null = null;
  for (const p of m.points) {
    if (p && prev !== null && m.pits.some((q) => q.lap > prev! && q.lap <= p.x + 0.15)) trace.push(null);
    trace.push(p ? [x(p.x), y(Math.abs(p.gap))] : null);
    prev = p ? p.x : prev;
  }
  // Over it, the gap at each crossing of the line, broken where either driver's stint changed.
  const shown = m.lapGaps.filter((g) => g.gap !== null && g.x >= m.from);
  const laps: Array<readonly [number, number] | null> = [];
  shown.forEach((g, i) => {
    const before = shown[i - 1];
    if (before && (g.stints[0] !== before.stints[0] || g.stints[1] !== before.stints[1])) laps.push(null);
    laps.push([x(g.x), y(Math.abs(g.gap!))]);
  });
  const end = drawn[drawn.length - 1];
  if (end && (!shown.length || end.x > shown[shown.length - 1].x)) laps.push([x(end.x), y(Math.abs(end.gap))]);
  ctx.save();
  ctx.beginPath();
  ctx.rect(left - 4, top - 2, right - left + 8, bottom - top + 6);
  ctx.clip();
  polyline(ctx, trace, { color: c.faint, width: 1 });
  polyline(ctx, laps, { color: c.ink, width: compact ? 1.4 : 1.6 });
  if (!compact) for (const g of shown) dot(ctx, x(g.x), y(Math.abs(g.gap!)), 2, c.ink);
  if (end) dot(ctx, x(end.x), y(Math.abs(end.gap)), compact ? 2.5 : 3, c.ink);
  ctx.restore();
  // A stop off the top of the scale is named there.
  if (!compact && drawn.some((p) => Math.abs(p.gap) > yMax)) {
    const peak = Math.max(...drawn.map((p) => Math.abs(p.gap)));
    text(ctx, `▲ ${peak.toFixed(1)}`, left + 2, top - 3, { size: TYPE });
  }

  const value = m.current === null ? '—' : Math.abs(m.current).toFixed(2);
  const vx = width - (compact ? 8 : 10);
  text(ctx, value, vx, top + big / 2, { align: 'right', color: c.ink, size: big, weight: 500 });
  if (compact) {
    // Which way it's going, beside the number.
    if (m.trend !== null && Math.abs(m.trend) >= 0.05) {
      text(ctx, m.trend < 0 ? '▼' : '▲', vx - textWidth(ctx, value, big, 500) - 4, top + big / 2, { align: 'right', color: c.ink, size: TYPE });
    }
    return;
  }
  const secondAhead = m.current !== null && m.current < 0;
  if (m.current !== null) {
    const [behind, ahead] = secondAhead ? [m.first, m.second] : [m.second, m.first];
    text(ctx, `${behind.code} to ${ahead.code}`, vx, top + big + 8, { align: 'right', size: TYPE });
  }
  const place = panel(m);
  if (place.trendAt !== null && m.trend !== null) {
    const t = m.trend;
    const word = Math.abs(t) < 0.05 ? 'holding' : `${t < 0 ? 'closing' : 'opening'} ${Math.abs(t).toFixed(2)}/lap`;
    text(ctx, word, vx, place.trendAt, { align: 'right', color: c.ink, size: TYPE });
  }
  if (place.rangeAt !== null) text(ctx, `${m.aid.label} IN RANGE`, vx, place.rangeAt, { align: 'right', color: c.ink, size: TYPE, weight: 600 });
  // The car ahead on top.
  let at = place.rowsAt;
  for (const i of secondAhead ? [1, 0] : [0, 1]) {
    const s = m.sides[i];
    const style = i === 0 ? m.first : m.second;
    hline(ctx, vx - SIDE + 12, vx, at - 9);
    text(ctx, style.code, vx - SIDE + 12, at, { color: c.ink, size: TYPE, weight: 600 });
    if (s.compound) {
      const age = s.age === null ? '' : ` ${s.age}`;
      text(ctx, age, vx, at, { align: 'right', color: c.ink, size: TYPE });
      text(ctx, compoundLetter(s.compound), vx - textWidth(ctx, age, TYPE), at, { align: 'right', color: tyreColour(s.compound), size: TYPE, weight: 600 });
    }
    text(ctx, formatLapTime(s.last) || '—', vx, at + 13, { align: 'right', size: TYPE });
    at += ROW;
  }
}

const NEEDS = ['timing' as const];

/** Least: the plot beside the whole panel, the car behind in range. */
const LEAST = { width: 330, height: 162 };
/** Past this a battle's 15 laps gain nothing. */
const FIT = { width: 640, height: 340 };

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 2,
  maxItems: 2,
  description: 'The two drivers, as car numbers',
});

function GapEvolution({ props }: { props: { drivers: number[] } }) {
  const [a, b] = props.drivers;
  const view = useSql(SQL, [a, b]);
  const styles = useDriverStyles();
  const aid = useLive((s) => s.spec.chaseAid);
  const model = useMemo(
    () => (view.state === 'ready' ? { ...gapModel(view.rows, [a, b]), first: styleOf(styles, a), second: styleOf(styles, b), aid } : null),
    [view, styles, a, b, aid],
  );
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} extent={gapExtent} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'gap_evolution',
  title: 'Gap evolution',
  description:
"Two drivers' battle: the gap between them over the last laps and whether it is closing, the line where DRS opens (Overtake from 2026) and whether the car behind is inside it, and each one's tyre and last lap. The one chart for a battle or a chase, next to both drivers' onboards.",
  args: Type.Object({ drivers: Drivers }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 16 / 9, min: LEAST },
  fit: FIT,
  spec: ({ drivers }) => ({ key: `gap_evolution:${drivers.join('-')}`, label: `Gap ${drivers.map(codeOf).join(' · ')}` }),
  View: GapEvolution,
});
