/**
 * Which tile a component is drawing in, and what its queries last returned, so an outside agent looking
 * at a screenshot can tell a query that found nothing from a drawing that's wrong.
 */
import { createContext } from 'react';
import type { QueryInfo } from '../../shared/external';
import type { SqlView } from './useSql';

/** The key of the tile being drawn, or null outside a tile, as in the suggestion strip. */
export const TileContext = createContext<string | null>(null);

const SAMPLE_ROWS = 3;
const byTile = new Map<string, Map<string, QueryInfo>>();

export function recordQuery(tile: string, sql: string, view: SqlView): void {
  const queries = byTile.get(tile) ?? new Map<string, QueryInfo>();
  byTile.set(tile, queries);
  queries.set(
    sql,
    view.state === 'ready'
      ? { sql, state: 'ready', rowCount: view.rows.length, sample: view.rows.slice(0, SAMPLE_ROWS) }
      : view.state === 'failed'
        ? { sql, state: 'failed', reason: view.reason }
        : { sql, state: 'loading' },
  );
}

export function forgetQuery(tile: string, sql: string): void {
  byTile.get(tile)?.delete(sql);
}

/** The last result of each query the tile's component runs. */
export const tileQueries = (tile: string): QueryInfo[] => [...(byTile.get(tile)?.values() ?? [])];
