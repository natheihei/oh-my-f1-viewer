/**
 * The pit window's model: one driver's stop played out on the field, as a ring of one lap's time with every
 * car set back by its gap. The pit window chart draws it for one driver, and the pit windows table for every
 * car, so it lives here where both reach it.
 */
import { isCleanLap, median, tyreAgeNow } from './laps';
import { num, parseGap } from './values';

/** Rejoining more than this behind the car ahead on the road counts as clear air, in seconds: closer, its dirty air costs pace. */
export const CLEAR_AIR = 2;
/** The ring's lap time is the leader's median over this many of their latest clean laps. */
const RING_LAPS = 5;

/** Every driver's laps: what makes one clean, where they are, their tyre, and whether they retired. */
export const PIT_WINDOW_SQL = `SELECT driver_number, lap_number, date_start, date_end, lap_duration, position, gap_to_leader, interval, compound, tyre_age,
  is_pit_in_lap, is_pit_out_lap, track_status, is_out FROM lap_summary`;

export interface RingCar {
  driver: number;
  /** Seconds behind the leader in race time: more than a lap for a lapped car. */
  gap: number;
  /** Seconds round the ring from the leader: `gap` modulo the ring's lap time. */
  ring: number;
  position: number | null;
  /** The feed gives this car's gap in laps. */
  lapped: boolean;
}

export interface Neighbour {
  driver: number;
  /** Seconds between the two on the road. */
  by: number;
  /** The leader has lapped this car. */
  lapped: boolean;
  /**
   * Laps between this car and the driver after the stop, past the gap on the road: 0 when they're racing on the
   * same lap, more when this car is laps down on them, less when it's laps up, like the leader coming through.
   */
  laps: number;
}

/** Where a stop with one pit loss would put the driver. */
export interface Rejoin {
  gap: number;
  ring: number;
  /** The position they'd rejoin in, in race order. */
  position: number;
  /** The car just ahead on the road where they'd come out, and how far ahead it would be. */
  behind: Neighbour | null;
  /** The car just behind on the road, and how far back. */
  aheadOf: Neighbour | null;
  clearAir: boolean;
  /** Seconds more they'd need to come out a place higher, or null in the lead. */
  short: number | null;
  /** Seconds they could lose and still come out in `position`, or null with nobody behind. */
  spare: number | null;
}

/** Pit losses under a safety car and a virtual one, which are shorter: the field is slow while the car stops. */
export interface NeutralLoss {
  safetyCar: number | null;
  virtualSafetyCar: number | null;
}

export interface PitWindowModel {
  driver: number;
  /** The leader, at 12 o'clock. */
  leader: number | null;
  /** The ring's length in seconds, or null until there's a lap time to go by. */
  lapTime: number | null;
  /** Running cars with a gap, nearest the leader first. */
  cars: RingCar[];
  me: RingCar | null;
  /** MultiViewer's pit loss for the circuit, in seconds, or null without one. */
  pitLoss: number | null;
  /** The driver's position now. */
  from: number | null;
  out: Rejoin | null;
  /** The same stop under a safety car, and under a virtual one. */
  safetyCar: Rejoin | null;
  virtualSafetyCar: Rejoin | null;
  compound: string | null;
  age: number | null;
}

/** `value` modulo `m`, in [0, m). */
const wrap = (value: number, m: number) => ((value % m) + m) % m;

/**
 * The rows of `PIT_WINDOW_SQL` as the ring, with `driver`'s stop played out. Each car's gap is the latest the feed
 * gives. A lapped car's gap is text such as "+1 LAP", so it's the car ahead's gap plus the interval
 * between them, as the timing tower adds up, or failing that measured from lap ends: when it finished
 * its latest lap, after the first car to finish that lap. Either way it's more than a lap, which places
 * it on the ring where it is on the road, and counts it behind in race order. A retired car is left off.
 */
export function pitWindowModel(
  rows: ReadonlyArray<Record<string, unknown>>,
  driver: number,
  pitLoss: number | null,
  neutral: NeutralLoss = { safetyCar: null, virtualSafetyCar: null },
): PitWindowModel {
  const latest = new Map<number, Record<string, unknown>>();
  const ends = new Map<number, Map<number, number>>();
  const firstEnd = new Map<number, number>();
  const clean = new Map<number, Array<{ lap: number; time: number }>>();
  const retired = new Set<number>();
  for (const r of rows) {
    const d = num(r.driver_number);
    const lap = num(r.lap_number);
    if (d === null || lap === null) continue;
    if (r.is_out) retired.add(d);
    const last = latest.get(d);
    if (!last || lap >= (num(last.lap_number) ?? 0)) latest.set(d, r);
    const end = num(r.date_end);
    if (end !== null) {
      if (!ends.has(d)) ends.set(d, new Map());
      ends.get(d)!.set(lap, end);
      firstEnd.set(lap, Math.min(end, firstEnd.get(lap) ?? Infinity));
    }
    if (isCleanLap(r)) {
      if (!clean.has(d)) clean.set(d, []);
      clean.get(d)!.push({ lap, time: num(r.lap_duration)! });
    }
  }

  // The leader's recent clean laps, or the whole field's when the leader has none.
  const leader = [...latest].filter(([, r]) => num(r.position) !== null).sort(([, a], [, b]) => num(a.position)! - num(b.position)!)[0]?.[0];
  const recent = (clean.get(leader ?? -1) ?? []).sort((a, b) => b.lap - a.lap).slice(0, RING_LAPS);
  const lapTime = median((recent.length ? recent : [...clean.values()].flat()).map((l) => l.time));

  const lappedGap = (d: number, r: Record<string, unknown>, ahead: RingCar | null): number | null => {
    const interval = parseGap(r.interval);
    if (ahead && interval && 'seconds' in interval && ahead.position === (num(r.position) ?? 0) - 1) return ahead.gap + interval.seconds;
    const own = ends.get(d);
    const lap = own ? Math.max(...own.keys()) : null;
    const first = lap === null ? undefined : firstEnd.get(lap);
    return lap !== null && first !== undefined ? (own!.get(lap)! - first) / 1000 : null;
  };

  // In running order, so a lapped car's gap can build on the car ahead's.
  const order = [...latest].sort(([a, ra], [b, rb]) => (num(ra.position) ?? Infinity) - (num(rb.position) ?? Infinity) || a - b);
  const cars: RingCar[] = [];
  let ahead: RingCar | null = null;
  for (const [d, r] of order) {
    const position = num(r.position);
    const running = !retired.has(d);
    const parsed = parseGap(r.gap_to_leader);
    const lapped = !!parsed && 'laps' in parsed;
    let gap: number | null = null;
    if (d === leader) gap = 0;
    else if (parsed && 'seconds' in parsed) gap = parsed.seconds;
    else if (lapped) gap = lappedGap(d, r, ahead);
    const car = running && gap !== null && gap >= 0 ? { driver: d, gap, ring: lapTime ? wrap(gap, lapTime) : gap, position, lapped } : null;
    if (car) cars.push(car);
    // A retired car, or one without a gap, breaks the chain.
    ahead = car;
  }
  cars.sort((a, b) => a.gap - b.gap || a.driver - b.driver);

  const me = cars.find((c) => c.driver === driver) ?? null;
  const mine = latest.get(driver);
  const others = cars.filter((c) => c !== me);
  const rejoin = (loss: number | null): Rejoin | null => {
    if (!me || loss === null) return null;
    const gap = me.gap + loss;
    // On the road, round the ring; in race order without a lap time to wrap by.
    const inFront = (c: RingCar) => (lapTime ? wrap(gap - c.gap, lapTime) : gap - c.gap);
    const behindBy = (c: RingCar) => (lapTime ? wrap(c.gap - gap, lapTime) : c.gap - gap);
    const nearest = (cands: RingCar[], dist: (c: RingCar) => number, sign: number): Neighbour | null => {
      const best = cands.filter((c) => dist(c) >= 0).sort((a, b) => dist(a) - dist(b))[0];
      if (!best) return null;
      const by = dist(best);
      // What's left of the gap in race time once the road is taken off is whole laps.
      const laps = lapTime ? Math.round((best.gap - gap - sign * by) / lapTime) : 0;
      return { driver: best.driver, by, lapped: best.lapped, laps };
    };
    const behind = nearest(others, inFront, -1);
    const aheadOf = nearest(
      others.filter((c) => c.driver !== behind?.driver),
      behindBy,
      1,
    );
    const raceAhead = others.filter((c) => c.gap < gap).reduce<RingCar | null>((a, c) => (!a || c.gap > a.gap ? c : a), null);
    const raceBehind = others.filter((c) => c.gap >= gap).reduce<RingCar | null>((a, c) => (!a || c.gap < a.gap ? c : a), null);
    return {
      gap,
      ring: lapTime ? wrap(gap, lapTime) : gap,
      position: 1 + others.filter((c) => c.gap < gap).length,
      behind,
      aheadOf,
      clearAir: !behind || behind.by > CLEAR_AIR,
      short: raceAhead ? gap - raceAhead.gap : null,
      spare: raceBehind ? raceBehind.gap - gap : null,
    };
  };
  return {
    driver,
    leader: leader ?? null,
    lapTime,
    cars,
    me,
    pitLoss,
    from: me ? (me.position ?? 1 + others.filter((c) => c.gap < me.gap).length) : null,
    out: rejoin(pitLoss),
    safetyCar: rejoin(neutral.safetyCar),
    virtualSafetyCar: rejoin(neutral.virtualSafetyCar),
    compound: mine && typeof mine.compound === 'string' ? mine.compound : null,
    age: mine ? tyreAgeNow(mine) : null,
  };
}
