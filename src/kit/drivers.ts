/** Driver props as charts use them. */
import { useMemo } from 'react';

/** A driver-list prop as a set, the same set while the list doesn't change. Left out, empty. */
export function useDriverSet(drivers: readonly number[] | undefined): ReadonlySet<number> {
  const key = drivers?.join(',') ?? '';
  // Keyed on the list's value, so a new array with the same cars keeps the set.
  return useMemo(() => new Set(drivers ?? []), [key]);
}

/** Only the rows of the drivers in `shown`, or every row when it's left out. */
export const displayed = <R extends { driver: number }>(rows: R[], shown: readonly number[] | undefined): R[] =>
  shown?.length ? rows.filter((r) => shown.includes(r.driver)) : rows;
