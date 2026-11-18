/** A SQL query that stays current: it runs again as the playhead moves and as more of the session arrives. */
import { useEffect, useState } from 'react';
import type { SqlRows } from '../../shared/sessionData';
import { sessionSql, type SqlAsOf } from '../data/sessionData';
import { useLive } from './live';

export type SqlView = { state: 'loading' } | { state: 'failed'; reason: string } | ({ state: 'ready' } & SqlRows);

const LOADING: SqlView = { state: 'loading' };

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Lists stored as JSON come back as arrays.
  return typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
}

/** Whether two results hold the same columns and rows, in the same order. */
export function sameRows(a: SqlRows, b: SqlRows): boolean {
  if (a.columns.length !== b.columns.length || a.rows.length !== b.rows.length) return false;
  if (a.columns.some((c, i) => c !== b.columns[i])) return false;
  return a.rows.every((row, i) => {
    const other = b.rows[i];
    return a.columns.every((c) => sameValue(row[c], other[c]));
  });
}

/** The view to show next: the previous one, untouched, when nothing in it changed. */
export function nextView(previous: SqlView, next: SqlView): SqlView {
  if (previous.state !== next.state) return next;
  if (previous.state === 'loading') return previous;
  if (previous.state === 'failed') return previous.reason === (next as { reason: string }).reason ? previous : next;
  return sameRows(previous as SqlRows, next as SqlRows) ? previous : next;
}

/**
 * Runs `sql` now and again on every `sessionData.revision`, about once a second while playing, and whenever
 * `params` change. Passing `sessionData.playheadMs`, which moves ten times a second, reads at that rate.
 * The returned view keeps its reference until its rows change, so a chart can redraw only then.
 *
 * It reads as of the playhead. `asOf: 'session'` reads the whole session, which can spoil it: a
 * component that does should declare `looksAhead`, so the viewer is asked before it's drawn.
 */
export function useSql(sql: string, params: unknown[] = [], options: { asOf?: SqlAsOf } = {}): SqlView {
  const asOf = options.asOf ?? 'playhead';
  const revision = useLive((live) => (live.sessionData.state === 'ready' ? live.sessionData.revision : null));
  const [view, setView] = useState<SqlView>(LOADING);
  const key = JSON.stringify(params);

  useEffect(() => {
    if (revision === null) {
      setView((previous) => nextView(previous, LOADING));
      return;
    }
    let cancelled = false;
    sessionSql(sql, JSON.parse(key), asOf).then(
      (rows) => {
        if (!cancelled) setView((previous) => nextView(previous, { state: 'ready', ...rows }));
      },
      (e: Error) => {
        if (!cancelled) setView((previous) => nextView(previous, { state: 'failed', reason: e.message }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sql, key, revision, asOf]);

  return view;
}
