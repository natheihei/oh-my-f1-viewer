/**
 * Who is fighting whom at the playhead, for the battle and chase components: the running order with
 * each car's interval to the one ahead. A fight is two cars next to each other in the order, the one
 * behind within the season's chase aid of the one ahead (DRS, or Overtake from 2026).
 */
import type { Channel } from '../host';
import { num, parseGap } from './values';

// Each driver's latest position and interval, and whether they're out, in running order.
export const ORDER_SQL = `
WITH pos AS (SELECT driver_number, position, MAX(date) FROM position GROUP BY driver_number),
gap AS (SELECT driver_number, interval, MAX(date) FROM intervals GROUP BY driver_number),
out AS (SELECT DISTINCT driver_number FROM laps WHERE is_out)
SELECT pos.driver_number, pos.position, gap.interval, out.driver_number IS NOT NULL AS is_out
FROM pos LEFT JOIN gap USING (driver_number) LEFT JOIN out USING (driver_number)
ORDER BY is_out, pos.position`;

export interface Running {
  driver: number;
  position: number | null;
  /** Seconds to the car ahead, or null for the leader, a lapped car or none yet. */
  interval: number | null;
  out: boolean;
}

/** The rows of `ORDER_SQL`, in running order. */
export function runningOrder(rows: ReadonlyArray<Record<string, unknown>>): Running[] {
  return rows.flatMap((r): Running[] => {
    const driver = num(r.driver_number);
    if (driver === null) return [];
    const gap = parseGap(r.interval);
    return [{ driver, position: num(r.position), interval: gap && 'seconds' in gap ? gap.seconds : null, out: Boolean(r.is_out) }];
  });
}

export interface Fight {
  ahead: number;
  behind: number;
  /** Seconds between them. */
  gap: number;
  /** The position the car ahead is fighting for. */
  position: number | null;
}

/** Every fight in the order, front to back. A train of three is two fights. */
export function fightsOf(order: readonly Running[], within: number): Fight[] {
  const running = order.filter((r) => !r.out);
  const fights: Fight[] = [];
  for (let i = 1; i < running.length; i += 1) {
    const [ahead, behind] = [running[i - 1], running[i]];
    if (behind.interval !== null && behind.interval >= 0 && behind.interval < within) {
      fights.push({ ahead: ahead.driver, behind: behind.driver, gap: behind.interval, position: ahead.position });
    }
  }
  return fights;
}

/** The closest fight, the one further up the order on a tie. Null with none. */
export function closest(fights: readonly Fight[]): Fight | null {
  return fights.reduce<Fight | null>((best, f) => (best === null || f.gap < best.gap ? f : best), null);
}

/** The car ahead of a driver on the road and the gap to it, or null for the leader, a car that's out or one not running. */
export function aheadOf(order: readonly Running[], driver: number): { driver: number; gap: number | null } | null {
  const running = order.filter((r) => !r.out);
  const i = running.findIndex((r) => r.driver === driver);
  if (i <= 0) return null;
  return { driver: running[i - 1].driver, gap: running[i].interval };
}

/** A driver's onboard feed, or null when the session has none for them. */
export const onboardOf = (feeds: readonly Channel[], driver: number): string | null =>
  feeds.find((c) => c.kind === 'onboard' && c.number === driver)?.id ?? null;
