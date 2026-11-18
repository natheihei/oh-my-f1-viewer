/**
 * Rows in a window of dates that moves on with the playhead, such as a car's last lap of telemetry. Read whole
 * once, then only what's new as the playhead moves on, so a chart ten times a second reads a sample or two
 * instead of its whole window.
 */
import { useEffect, useRef, useState } from 'react';
import type { SqlRows } from '../../shared/sessionData';
import { sessionSql } from '../data/sessionData';
import { useLive } from './live';
import { nextView, type SqlView } from './useSql';

type Row = Record<string, unknown>;

/** What's asked: the query, its parameters, when it was asked, and the window, rows dated after `from` up to `to`. */
export interface WindowAsk {
  sql: string;
  /** The parameters, as JSON. */
  key: string;
  /** The session and its revision. */
  revision: string;
  from: number;
  to: number;
}

/** The last answer, and what it answered. */
export interface Held extends WindowAsk {
  columns: string[];
  rows: Row[];
}

/** The rows to read: all of the window, or only those after the last answer. Either way, after `lo` up to `hi`. */
export type WindowRead = { kind: 'all' | 'new'; lo: number; hi: number };

/**
 * Reads only what's new when the window has only moved on and still overlaps the last one. Anything else
 * reads it all: another query or parameters, a new revision, which also catches rows that arrived late, a
 * window that starts earlier, or a playhead that went back or jumped past the window.
 */
export function nextRead(held: Held | null, ask: WindowAsk): WindowRead {
  const same = held && held.sql === ask.sql && held.key === ask.key && held.revision === ask.revision;
  if (!same || ask.from < held.from || ask.to < held.to || ask.from >= held.to) return { kind: 'all', lo: ask.from, hi: ask.to };
  return { kind: 'new', lo: held.to, hi: ask.to };
}

const dateOf = (row: Row) => Number(row.date);

/**
 * The rows held, without those dated `from` or before, then `added`. Both are in date order, and every
 * added row is after every held one. The same array when nothing is dropped or added.
 */
export function mergeRows(rows: Row[], added: readonly Row[], from: number): Row[] {
  let keep = 0;
  while (keep < rows.length && dateOf(rows[keep]) <= from) keep++;
  if (keep === 0 && added.length === 0) return rows;
  return Object.freeze([...rows.slice(keep), ...added]) as Row[];
}

const LOADING: SqlView = { state: 'loading' };
const NONE: SqlRows = { columns: [], rows: [] };

/**
 * `sql` over the window of dates after `range.from` up to `range.to`, as of the playhead. `?1` is `from` and
 * `?2` is `to`; `params` follow from `?3`. Its rows must have a `date` and be in date order, and `to` is
 * usually the playhead, so it never reads past the frame.
 *
 * It reads the whole window on every revision, about once a second, and when its query or parameters
 * change. In between, as the window moves on, it reads only the rows after the last read and drops those
 * that fell out. The view keeps its reference while its rows are the same.
 */
export function useSqlWindow(sql: string, params: unknown[], range: { from: number; to: number }): SqlView {
  const revision = useLive((live) => (live.sessionData.state === 'ready' ? `${live.sessionData.sessionKey}:${live.sessionData.revision}` : null));
  const [view, setView] = useState<SqlView>(LOADING);
  const shown = useRef<SqlView>(LOADING);
  const held = useRef<Held | null>(null);
  const key = JSON.stringify(params);
  const { from, to } = range;

  useEffect(() => {
    const show = (next: SqlView) => {
      shown.current = next;
      setView(next);
    };
    if (revision === null) {
      held.current = null;
      show(nextView(shown.current, LOADING));
      return;
    }
    const ask: WindowAsk = { sql, key, revision, from, to };
    const read = nextRead(held.current, ask);
    const base = read.kind === 'new' ? held.current! : null;
    let cancelled = false;
    // Nothing new to read when only the start moved.
    const rows = base && read.lo === read.hi ? Promise.resolve(NONE) : sessionSql(sql, [read.lo, read.hi, ...(JSON.parse(key) as unknown[])]);
    rows.then(
      (result) => {
        if (cancelled) return;
        if (base) {
          const merged = mergeRows(base.rows, result.rows, from);
          held.current = { ...ask, columns: base.columns, rows: merged };
          if (merged !== base.rows) show({ state: 'ready', columns: base.columns, rows: merged });
          return;
        }
        const next = nextView(shown.current, { state: 'ready', ...result }) as { state: 'ready' } & SqlRows;
        // The view's own rows, which may be the last read's: then a read that adds nothing keeps the view too.
        held.current = { ...ask, columns: next.columns, rows: next.rows };
        show(next);
      },
      (e: Error) => {
        if (cancelled) return;
        held.current = null;
        show(nextView(shown.current, { state: 'failed', reason: e.message }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sql, key, revision, from, to]);

  return view;
}
