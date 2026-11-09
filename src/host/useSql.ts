/** A SQL query that stays current: it runs again as the playhead moves and as more of the session arrives. */
import { useEffect, useState } from 'react';
import type { SqlRows } from '../../shared/sessionData';
import { sessionSql } from '../data/sessionData';
import { useLive } from './live';

export type SqlView = { state: 'loading' } | { state: 'failed'; reason: string } | ({ state: 'ready' } & SqlRows);

export function useSql(sql: string, params: unknown[] = []): SqlView {
  const revision = useLive((live) => (live.sessionData.state === 'ready' ? live.sessionData.revision : null));
  const [view, setView] = useState<SqlView>({ state: 'loading' });
  const key = JSON.stringify(params);

  useEffect(() => {
    if (revision === null) {
      setView({ state: 'loading' });
      return;
    }
    let cancelled = false;
    sessionSql(sql, JSON.parse(key)).then(
      (rows) => {
        if (!cancelled) setView({ state: 'ready', ...rows });
      },
      (e: Error) => {
        if (!cancelled) setView({ state: 'failed', reason: e.message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sql, key, revision]);

  return view;
}
