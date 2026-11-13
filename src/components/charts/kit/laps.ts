/**
 * What the lap-based charts share: which laps were neutralised, which laps count as clean, tyre age,
 * medians, and where the lap axis ends.
 */
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
 * Null without both ends, or when one driver stopped between them and the other didn't: that change is
 * a pit stop, not the battle. Stops by both in that time roughly cancel, and stops before it don't
 * count, so a two-stopper catching a one-stopper shows. A stop appears as a new `stint_number`.
 */
export function gapTrend(rows: ReadonlyArray<Record<string, unknown>>, [a, b]: readonly [number, number], over: number): number | null {
  const ended = (driver: number) =>
    new Map(rows.filter((r) => num(r.driver_number) === driver && r.date_end != null && num(r.lap_number) !== null).map((r) => [num(r.lap_number)!, r]));
  const [ea, eb] = [ended(a), ended(b)];
  const common = [...ea.keys()].filter((lap) => eb.has(lap));
  if (!common.length) return null;
  const last = Math.max(...common);
  const ends = [ea.get(last), eb.get(last), ea.get(last - over), eb.get(last - over)];
  if (ends.some((r) => !r)) return null;
  const [aNow, bNow, aThen, bThen] = ends as Array<Record<string, unknown>>;
  // Without stint numbers there's nothing to tell a stop by, so the trend stands.
  const stops = (now: Record<string, unknown>, then: Record<string, unknown>) => {
    const [n, t] = [num(now.stint_number), num(then.stint_number)];
    return n === null || t === null ? null : n - t;
  };
  const [stopsA, stopsB] = [stops(aNow, aThen), stops(bNow, bThen)];
  if (stopsA !== null && stopsB !== null && stopsA !== stopsB) return null;
  const between = (ra: Record<string, unknown>, rb: Record<string, unknown>): number | null => {
    const [ga, gb] = [toLeader(ra), toLeader(rb)];
    return ga === null || gb === null ? null : Math.abs(gb - ga);
  };
  const [now, then] = [between(aNow, bNow), between(aThen, bThen)];
  return now !== null && then !== null ? (now - then) / over : null;
}

/** The middle value, or the mean of the two middle ones; null for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Where a race chart's lap axis ends: the scheduled distance, so lines grow into empty space, or the latest lap. */
export const axisLaps = (latest: number, total: number | null | undefined): number => Math.max(1, latest, total ?? 0);
