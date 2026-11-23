/**
 * The gap between two drivers over the last laps, moving within a lap as interval samples arrive, with each
 * one's tyre and last lap beside it and whether the car behind is in DRS or Overtake range.
 */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, Driver, useLive, useSql, type ChaseAid, type Part } from 'omfv';
import {
  ChartCanvas,
  ChartFrame,
  colors,
  compoundLetter,
  dot,
  drawCode,
  drawParts,
  formatLapTime,
  gapSeconds,
  gapTrend,
  hline,
  linear,
  niceCeil,
  niceStep,
  num,
  partsWidth,
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
} from 'omfv/kit';

/** Laps the chart looks back over. */
const WINDOW = 15;
/** The trend is the change over this many laps. */
const TREND_LAPS = 3;
/** A sample this far, in seconds, from its neighbours' median is a glitch. */
const SPIKE = 1;
/**
 * Updates from the two drivers arriving within this many milliseconds are the same timing loop:
 * replace the half-updated stale difference with the synchronised pair instead of drawing a sawtooth spike.
 */
const PAIR_WINDOW_MS = 2_000;

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
  let pending: { driver: number; date: number; idx: number } | null = null;
  for (const r of rows) {
    const date = num(r.date);
    if (r.kind !== 'gap' || date === null || date < laps[0].date) continue;
    const driver = num(r.n);
    if (driver !== a && driver !== b) continue;
    const hadBoth = last.has(a) && last.has(b);
    last.set(driver, r.gap == null ? 0 : gapSeconds(r.gap));
    if (!last.has(a) || !last.has(b)) continue;
    const ga = last.get(a);
    const gb = last.get(b);
    if (ga == null || gb == null) {
      if (points.at(-1) !== null) points.push(null);
      pending = null;
      continue;
    }
    const pt = { x: lapAt(laps, date), gap: gb - ga };
    if (pending && pending.driver !== driver && date - pending.date <= PAIR_WINDOW_MS) {
      points[pending.idx] = pt;
      pending = null;
    } else {
      pending = hadBoth ? { driver, date, idx: points.length } : null;
      points.push(pt);
    }
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
function yTop(gaps: readonly number[], line: number): number {
  const sorted = gaps.map(Math.abs).sort((x, y) => x - y);
  const high = sorted[Math.floor((sorted.length - 1) * 0.9)] ?? 0;
  return niceCeil(Math.max(line * 2, high * 1.15), 4);
}

/**
 * Whether the plotted gap trades the lead between both drivers within the visible scale:
 * both sides spend time ahead beyond the level deadband, so the plot switches to a signed view around 0.
 */
export function isSigned(points: ReadonlyArray<{ gap: number }>, cap: number): boolean {
  let pos = false;
  let neg = false;
  for (const p of points) {
    if (p.gap >= LEVEL && p.gap <= cap) pos = true;
    else if (p.gap <= -LEVEL && p.gap >= -cap) neg = true;
    if (pos && neg) return true;
  }
  return false;
}

/**
 * The y-axis domain: `[0, yMax]` while one car stays ahead, or an asymmetric `[yMin, yMax]` spanning 0
 * when both spend time ahead within the scale so neither side wastes space. Both sides keep room past ±`within`.
 */
export function gapDomain(
  drawn: ReadonlyArray<{ gap: number }>,
  scaleGaps: readonly number[],
  within: number,
): { min: number; max: number; signed: boolean } {
  const cap = yTop(scaleGaps, within);
  if (!isSigned(drawn, cap)) return { min: 0, max: cap, signed: false };
  const pct90 = (values: number[]) => {
    const s = values.sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) * 0.9)] ?? 0;
  };
  const posScale = scaleGaps.filter((g) => g > 0 && g <= cap);
  const negScale = scaleGaps.filter((g) => g < 0 && g >= -cap).map((g) => -g);
  const posAll = drawn.map((p) => p.gap).filter((g) => g > 0 && g <= cap);
  const negAll = drawn.map((p) => p.gap).filter((g) => g < 0 && g >= -cap).map((g) => -g);
  const rawUp = Math.max(within * 1.2, pct90(posScale.length ? posScale : posAll) * 1.15);
  const rawDown = Math.max(within * 1.2, pct90(negScale.length ? negScale : negAll) * 1.15);
  const step = niceStep(rawUp + rawDown, 5);
  const ceilTo = (v: number) => Number((Math.ceil(v / step - 1e-9) * step).toPrecision(12));
  return { min: -ceilTo(rawDown), max: ceilTo(rawUp), signed: true };
}

/** Between a mark's line and its label, in pixels. */
const MARK_PAD = 3;
/** The least space, in pixels, between two labels in a row. */
const MARK_GAP = 4;
/** From one row of marks to the next, in pixels. */
const MARK_ROW = 12;

/** A mark's label: at its line `at`, on the `align` side of the text (left means it runs right of the line), in row `row` from the top. */
export interface MarkLabel {
  at: number;
  driver: number;
  align: 'left' | 'right';
  row: number;
}

/**
 * Lays out mark labels so none covers another: each stays at its own line, right of it or left of it where
 * it would pass `right`, in the first row from the top where it clears the labels already there. Marks are
 * `at` an x in pixels; `width` is how wide the label naming that driver draws.
 */
export function layoutMarks(marks: ReadonlyArray<{ at: number; driver: number }>, width: (driver: number) => number, right: number): MarkLabel[] {
  const rows: Array<Array<{ from: number; to: number }>> = [];
  return [...marks]
    .sort((p, q) => p.at - q.at)
    .map(({ at, driver }) => {
      const w = width(driver);
      const room = right - at - MARK_PAD >= w;
      const box = room ? { from: at + MARK_PAD, to: at + MARK_PAD + w } : { from: at - MARK_PAD - w, to: at - MARK_PAD };
      let row = rows.findIndex((r) => r.every((o) => o.to + MARK_GAP <= box.from || box.to + MARK_GAP <= o.from));
      if (row < 0) row = rows.push([]) - 1;
      rows[row].push(box);
      return { at, driver, align: room ? ('left' as const) : ('right' as const), row };
    });
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

export function drawGap(ctx: Ctx, m: Drawn, { width, height, compact }: Box): void {
  const c = colors();
  const big = compact ? 15 : BIG;
  const left = compact ? 6 : LEFT;
  const right = width - (compact ? 6 : SIDE + 8);
  const top = compact ? 8 : TOP;
  const bottom = height - (compact ? 6 : AXIS);
  const drawn = m.points.filter((p) => p !== null);
  const within = m.aid.within;
  const styles = new Map([m.first, m.second].map((s) => [s.number, s]));
  // The scale fits the laps since the last stop, so the stop itself runs off the edge.
  const lastPit = m.pits.length ? Math.max(...m.pits.map((p) => p.lap)) : null;
  const since = lastPit === null ? [] : drawn.filter((p) => p.x > lastPit + 0.3);
  const { min: yMin, max: yMax, signed } = gapDomain(drawn, (since.length ? since : drawn).map((p) => p.gap), within);
  const val = (g: number) => (signed ? g : Math.abs(g));
  const x = linear([m.from, m.to], [left, right]);
  const y = linear([yMin, yMax], [bottom, top]);

  // The DRS or Overtake zone, filled, so inside it reads as a place: [0, within] normally, [-within, +within] when signed.
  const bandTop = Math.min(within, yMax);
  const bandBottom = signed ? Math.max(-within, yMin) : 0;
  ctx.fillStyle = c.quiet;
  ctx.fillRect(left, y(bandTop), right - left, y(bandBottom) - y(bandTop));

  const fmt = (v: number) => {
    const a = Math.abs(v);
    const s = a.toFixed(a >= 10 || Number.isInteger(a) ? 0 : 1);
    if (!signed || v === 0) return s;
    return `${v < 0 ? '−' : '+'}${s}`;
  };

  if (!compact) {
    const room = Math.max(1, Math.floor((right - left) / 44));
    const step = [1, 2, 5, 10].find((s) => (m.to - m.from) / s <= room) ?? 10;
    for (const l of ticks(Math.ceil(m.from), Math.floor(m.to), 0, step)) text(ctx, `L${l}`, x(l), height - 9, { align: 'center', size: TYPE });
    if (signed) {
      const aidSplit = Math.abs(y(0) - y(within)) >= 12;
      const values = ticks(yMin, yMax, Math.max(2, Math.floor((bottom - top) / 34))).filter((v) =>
        aidSplit ? Math.abs(y(v) - y(within)) >= 12 && Math.abs(y(v) - y(-within)) >= 12 : Math.abs(y(v) - y(0)) >= 12,
      );
      for (const v of values) {
        if (v !== 0) hline(ctx, left, right, y(v));
        text(ctx, fmt(v), left - 5, y(v), { align: 'right', color: v === 0 ? c.ink : undefined, size: TYPE });
      }
      if (aidSplit) {
        text(ctx, m.aid.label, left - 5, y(within), { align: 'right', color: c.ink, size: TYPE });
        text(ctx, m.aid.label, left - 5, y(-within), { align: 'right', color: c.ink, size: TYPE });
      } else {
        text(ctx, m.aid.label, left - 5, y(0), { align: 'right', color: c.ink, size: TYPE });
      }
    } else {
      const values = ticks(0, yMax, Math.max(2, Math.floor((bottom - top) / 34))).filter((v) => Math.abs(y(v) - y(within)) >= 12);
      for (const v of values) {
        hline(ctx, left, right, y(v));
        text(ctx, fmt(v), left - 5, y(v), { align: 'right', size: TYPE });
      }
      text(ctx, m.aid.label, left - 5, y(within), { align: 'right', color: c.ink, size: TYPE });
    }
  } else {
    text(ctx, m.aid.label, left + 2, y(within) - 7, { size: TYPE });
  }
  if (signed) {
    // Emphasise the 0 lead-change line: brighter and thicker than the regular grid and dashed aid lines.
    ctx.fillStyle = c.dim;
    ctx.fillRect(left, Math.round(y(0)) - 1, right - left, compact ? 1.5 : 2);
  }
  hline(ctx, left, right, y(within), c.dim, [3, 3]);
  if (signed) hline(ctx, left, right, y(-within), c.dim, [3, 3]);

  if (!compact) {
    // Each stop label sits at its own dashed line, right of it or left of it by the panel, stacked a row down where it
    // would cover another. Passes are shown directly by the trace crossing the 0 line between the two AHEAD sections.
    const pits = m.pits.filter((p) => p.lap >= m.from);
    for (const p of pits) vline(ctx, x(p.lap), top, bottom, c.faint, [2, 3]);
    const pitStyle = { size: TYPE };
    const pitParts = (driver: number): Part[] => ['PIT ', { driver }];
    const pitLabels = layoutMarks(
      pits.map((p) => ({ at: x(p.lap), driver: p.driver })),
      (d) => partsWidth(ctx, pitParts(d), styles, pitStyle),
      right,
    );
    for (const l of pitLabels) {
      drawParts(ctx, pitParts(l.driver), styles, l.align === 'left' ? l.at + MARK_PAD : l.at - MARK_PAD, top + 6 + l.row * MARK_ROW, { ...pitStyle, align: l.align });
    }
    // In signed view, name which driver is ahead in each half, centred at ±0.5 s inside the chase-aid band.
    if (signed) {
      const sideLook = { size: TYPE, color: c.dim, align: 'left' as const, look: { strong: false } };
      drawParts(ctx, [{ driver: m.first.number }, ' AHEAD'], styles, left + 4, Math.max(top + 6, Math.min(y(0) - 9, y(within / 2))), sideLook);
      drawParts(ctx, [{ driver: m.second.number }, ' AHEAD'], styles, left + 4, Math.min(bottom - 7, Math.max(y(0) + 9, y(-within / 2))), sideLook);
    }
  }

  // The live instantaneous trace, highlighted in ink, broken across a stop.
  const trace: Array<readonly [number, number] | null> = [];
  let prev: number | null = null;
  for (const p of m.points) {
    if (p && prev !== null && m.pits.some((q) => q.lap > prev! && q.lap <= p.x + 0.15)) trace.push(null);
    trace.push(p ? [x(p.x), y(val(p.gap))] : null);
    prev = p ? p.x : prev;
  }
  // Behind it, the per-lap gap at each crossing of the line, faint, broken where either driver's stint changed.
  const shown = m.lapGaps.filter((g) => g.gap !== null && g.x >= m.from);
  const laps: Array<readonly [number, number] | null> = [];
  shown.forEach((g, i) => {
    const before = shown[i - 1];
    if (before && (g.stints[0] !== before.stints[0] || g.stints[1] !== before.stints[1])) laps.push(null);
    laps.push([x(g.x), y(val(g.gap!))]);
  });
  const end = drawn[drawn.length - 1];
  ctx.save();
  ctx.beginPath();
  ctx.rect(left - 4, top - 2, right - left + 8, bottom - top + 6);
  ctx.clip();
  polyline(ctx, laps, { color: c.faint, width: 1 });
  if (!compact) for (const g of shown) dot(ctx, x(g.x), y(val(g.gap!)), 2, c.faint);
  polyline(ctx, trace, { color: c.ink, width: compact ? 1.4 : 1.6 });
  if (end) dot(ctx, x(end.x), y(val(end.gap)), compact ? 2.5 : 3, c.ink);
  ctx.restore();
  // A stop off the scale is named at the edge it leaves.
  if (!compact) {
    if (signed) {
      const above = drawn.filter((p) => p.gap > yMax);
      if (above.length) text(ctx, `▲ ${Math.max(...above.map((p) => p.gap)).toFixed(1)}`, left + 2, top - 3, { size: TYPE });
      const below = drawn.filter((p) => p.gap < yMin);
      if (below.length) text(ctx, `▼ ${Math.max(...below.map((p) => -p.gap)).toFixed(1)}`, left + 2, bottom - 6, { size: TYPE });
    } else if (drawn.some((p) => Math.abs(p.gap) > yMax)) {
      const peak = Math.max(...drawn.map((p) => Math.abs(p.gap)));
      text(ctx, `▲ ${peak.toFixed(1)}`, left + 2, top - 3, { size: TYPE });
    }
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
    drawParts(ctx, [{ driver: behind.number }, ' to ', { driver: ahead.number }], styles, vx, top + big + 8, { align: 'right', size: TYPE });
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
    drawCode(ctx, style, vx - SIDE + 12, at, { size: TYPE, strong: true });
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

function GapEvolution({ props }: { props: { driver_a: number; driver_b: number } }) {
  const { driver_a: a, driver_b: b } = props;
  const view = useSql(SQL, [a, b]);
  const styles = useDriverStyles();
  const aid = useLive((s) => s.spec.chaseAid);
  const model = useMemo(
    () => (view.state === 'ready' ? { ...gapModel(view.rows, [a, b]), first: styleOf(styles, a), second: styleOf(styles, b), aid } : null),
    [view, styles, a, b, aid],
  );
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={drawGap} extent={gapExtent} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'gap_evolution',
  title: 'Gap evolution',
  description:
"Two drivers' battle: the gap between them over the last laps and whether it is closing, the line where DRS opens (Overtake from 2026) and whether the car behind is inside it, and each one's tyre and last lap. The one chart for how a battle or chase between two named drivers is going, next to both drivers' onboards.",
  args: Type.Object({ driver_a: Driver('One of the two drivers'), driver_b: Driver('The other') }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 16 / 9, min: LEAST },
  fit: FIT,
  // Which is a and which is b only sets the colours, so either way round is the same tile.
  spec: ({ driver_a, driver_b }) => {
    if (driver_a === driver_b) throw new Error('gap_evolution needs two different drivers');
    return { key: `gap_evolution:${[driver_a, driver_b].sort((x, y) => x - y).join('-')}`, label: 'Gap', drivers: [driver_a, driver_b] };
  },
  View: GapEvolution,
});
