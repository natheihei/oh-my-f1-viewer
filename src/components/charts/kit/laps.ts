/**
 * What the lap-based charts share: which laps were neutralised, which laps count as clean, where racing
 * pace ends, medians, and the lap axis with its shading. The pure parts are tested on their own.
 */
import { colors } from './colors';
import { text, type Ctx } from './draw';
import type { Scale } from './scale';
import { gapSeconds, num } from './values';

/** A neutralised lap: under a safety car, a virtual one, or a red flag. */
export type Neutral = 'SC' | 'VSC' | 'RED';

/** `lap_summary.track_status` as a neutralisation, or null for racing (yellows included). */
export function neutralOf(status: unknown): Neutral | null {
  if (status === 'SCDeployed') return 'SC';
  if (status === 'VSCDeployed' || status === 'VSCEnding') return 'VSC';
  if (status === 'Red') return 'RED';
  return null;
}

/** Laps `first` to `last` under one neutralisation. */
export interface Band {
  first: number;
  last: number;
  kind: Neutral;
}

/**
 * The neutralised laps, as runs of laps. Each driver's lap counts the worst status during it, so a lap
 * is shaded when at least half the cars' laps of that number were neutralised, with the kind most of
 * them saw. That keeps one car's lap that ended as the safety car came out from widening the band.
 */
export function neutralBands(rows: ReadonlyArray<Record<string, unknown>>): Band[] {
  const byLap = new Map<number, { total: number; kinds: Map<Neutral, number> }>();
  for (const r of rows) {
    const lap = num(r.lap_number);
    if (lap === null) continue;
    const entry = byLap.get(lap) ?? { total: 0, kinds: new Map() };
    entry.total += 1;
    const kind = neutralOf(r.track_status);
    if (kind) entry.kinds.set(kind, (entry.kinds.get(kind) ?? 0) + 1);
    byLap.set(lap, entry);
  }
  const bands: Band[] = [];
  for (const lap of [...byLap.keys()].sort((a, b) => a - b)) {
    const { total, kinds } = byLap.get(lap)!;
    const counted = [...kinds].reduce((sum, [, n]) => sum + n, 0);
    if (counted * 2 < total) continue;
    // Red outranks a safety car, which outranks a virtual one, on a tie.
    const kind = (['RED', 'SC', 'VSC'] as const).reduce((best, k) => ((kinds.get(k) ?? 0) > (kinds.get(best) ?? 0) ? k : best));
    const last = bands.at(-1);
    if (last && last.kind === kind && last.last === lap - 1) last.last = lap;
    else bands.push({ first: lap, last: lap, kind });
  }
  return bands;
}

/**
 * A lap that shows pace: completed, not lap 1, not an in- or out-lap, and run entirely under green
 * (`AllClear`), so yellows don't count either.
 */
export function isCleanLap(r: Record<string, unknown>): boolean {
  const lap = num(r.lap_number);
  const time = num(r.lap_duration);
  return lap !== null && lap > 1 && time !== null && time > 0 && !r.is_pit_in_lap && !r.is_pit_out_lap && r.track_status === 'AllClear';
}

/**
 * Laps on the tyre now, from a driver's latest `lap_summary` row. That row's `tyre_age` counts the lap
 * in progress as done; the timing tower counts completed laps, so a lap without a time counts one less.
 */
export function tyreAgeNow(r: Record<string, unknown>): number | null {
  const age = num(r.tyre_age);
  if (age === null) return null;
  return num(r.lap_duration) === null ? Math.max(0, age - 1) : age;
}

/** `lap_summary.gap_to_leader` in seconds: the leader has none, which is 0; a lapped car's is null. */
export const toLeader = (r: Record<string, unknown>): number | null => (r.gap_to_leader == null ? 0 : gapSeconds(r.gap_to_leader));

/**
 * How much the gap between two drivers grew per lap over the last `over` laps both have finished,
 * from their gaps to the leader as each crossed the line: negative is closing. Takes `lap_summary`
 * rows of both, with `driver_number`, `lap_number`, `date_end`, `gap_to_leader` and `stint_number`.
 * Null without both ends, or when at either end one driver has stopped and the other not yet: the
 * gap there is a pit stop, not the battle. The line after an out-lap is where a stop shows in the gap.
 */
export function gapTrend(rows: ReadonlyArray<Record<string, unknown>>, [a, b]: readonly [number, number], over: number): number | null {
  const ended = (driver: number) =>
    new Map(rows.filter((r) => num(r.driver_number) === driver && r.date_end != null && num(r.lap_number) !== null).map((r) => [num(r.lap_number)!, r]));
  const [ea, eb] = [ended(a), ended(b)];
  const between = (lap: number): number | null => {
    const [ra, rb] = [ea.get(lap), eb.get(lap)];
    if (!ra || !rb) return null;
    const [sa, sb] = [num(ra.stint_number), num(rb.stint_number)];
    if (sa !== null && sb !== null && sa !== sb) return null;
    const [ga, gb] = [toLeader(ra), toLeader(rb)];
    return ga === null || gb === null ? null : Math.abs(gb - ga);
  };
  const common = [...ea.keys()].filter((lap) => eb.has(lap));
  if (!common.length) return null;
  const last = Math.max(...common);
  const [now, then] = [between(last), between(last - over)];
  return now !== null && then !== null ? (now - then) / over : null;
}

/** The middle value, or the mean of the two middle ones; null for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Racing pace from clean lap times, as [fastest, slowest] still counted as racing. A lap more than
 * twice the spread below the median, or 2 seconds, slower than the median isn't: a spin or a long
 * stop behind someone. Fuel burning off spreads a race's laps by a few seconds, which this keeps.
 */
export function paceRange(times: readonly number[]): [number, number] | null {
  const mid = median(times);
  if (mid === null) return null;
  const lo = Math.min(...times);
  const cut = mid + Math.max(2, 2 * (mid - lo));
  const hi = Math.max(...times.filter((t) => t <= cut));
  return [lo, hi];
}

/** Where a race chart's lap axis ends: the scheduled distance, so lines grow into empty space, or the latest lap. */
export const axisLaps = (latest: number, total: number | null | undefined): number => Math.max(1, latest, total ?? 0);

/** Round laps to label along `0` to `laps` in `width` pixels, ending on the distance when it isn't too close to a tick. */
export function lapTicks(laps: number, width: number): number[] {
  const room = Math.max(1, Math.floor(width / 34));
  const step = [1, 2, 5, 10, 20, 50].find((s) => laps / s <= room) ?? 50;
  const out: number[] = [];
  for (let v = step; v <= laps; v += step) out.push(v);
  if (laps - (out.at(-1) ?? 0) >= step * 0.6) out.push(laps);
  else if (out.length && out.at(-1) !== laps && laps % step !== 0) out[out.length - 1] = laps;
  return out;
}

const SHADE = '#161616';
const BAND_TEXT = { SC: 'SC', VSC: 'VSC', RED: 'RED' } as const;

/**
 * Shades neutralised laps from `top` to `bottom`. On a chart whose points sit at lap ends, lap n runs
 * from n − 1 to n; `centred` charts put lap n's point at n, so the band runs half a lap either side.
 */
export function drawBands(
  ctx: Ctx,
  options: { scale: Scale; bands: readonly Band[]; top: number; bottom: number; centred?: boolean; labels?: boolean },
): void {
  const { scale, bands, top, bottom, centred = false, labels = true } = options;
  const c = colors();
  for (const b of bands) {
    const x0 = scale(centred ? b.first - 0.5 : b.first - 1);
    const x1 = scale(centred ? b.last + 0.5 : b.last);
    ctx.fillStyle = SHADE;
    ctx.fillRect(x0, top, Math.max(1, x1 - x0), bottom - top);
    if (labels && x1 - x0 >= 14) text(ctx, BAND_TEXT[b.kind], (x0 + x1) / 2, top + 6, { align: 'center', color: c.faint, size: 8 });
  }
}

/** Lap numbers under a plot, with "LAP" at its start. */
export function lapAxis(ctx: Ctx, options: { scale: Scale; laps: number; y: number }): void {
  const { scale, laps, y } = options;
  const [left, right] = scale.range;
  for (const v of lapTicks(laps, right - left)) text(ctx, String(v), scale(v), y, { align: 'center' });
  text(ctx, 'LAP', left, y, { align: 'center', color: colors().faint, size: 8 });
}
