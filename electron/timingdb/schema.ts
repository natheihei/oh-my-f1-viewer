/**
 * The tables behind the session database. Each stores `visible_from`: the moment the feed revealed
 * that row, on the same clock as the playhead. The row's own `date` can't serve, since a message
 * often reports something earlier than when it was sent.
 *
 * Two kinds of table:
 * - Events never change once sent, so they hold one row per thing.
 * - Versioned tables hold rows that fill in over time, such as a lap or a stint. Each change is a new
 *   version, and a read picks the newest one the playhead has reached. So the table reads as it stood
 *   at that moment, and a stint's `lap_end` can't reveal a pit stop that hasn't happened yet.
 *
 * The definitions live in shared/sessionTables.ts, so the renderer can describe them. This builds the SQL.
 */
import type { TableDefinition } from '../../shared/sessionTables';

export { rowColumns, sqlColumns, TABLE_BY_NAME, TABLES, visibleColumns, type RowTable, type TableDefinition } from '../../shared/sessionTables';

/** Bump when a processor or table changes: sessions are then ingested again the next time they open. */
export const INGEST_VERSION = 3;

/** Column types for key columns. Dates and numbers are integers; the rest are text. */
function keyType(column: string): string {
  return column === 'row_key' || column === 'team_key' ? 'TEXT' : 'INTEGER';
}

export const quote = (name: string): string => `"${name}"`;

export function createTableSql(table: TableDefinition): string {
  const columns = [
    'session_key INTEGER NOT NULL',
    'meeting_key INTEGER',
    ...table.key.map((column) => `${quote(column)} ${keyType(column)} NOT NULL`),
    ...Object.entries(table.columns).map(([column, type]) => `${quote(column)} ${type}`.trim()),
    'visible_from INTEGER NOT NULL',
  ];
  const primaryKey = ['session_key', ...table.key.map(quote), ...(table.versioned ? ['visible_from'] : [])];
  const tail = table.compact ? ' WITHOUT ROWID' : '';
  return `CREATE TABLE IF NOT EXISTS t_${table.name} (${columns.join(', ')}, PRIMARY KEY (${primaryKey.join(', ')}))${tail}`;
}

/**
 * Rows of one session as of the playhead: for a versioned table, the newest version of each row that
 * the playhead has reached. `session` and `playhead` are SQL expressions.
 */
export function asOfSql(table: TableDefinition, session: string, playhead: string): string {
  const where = `session_key = ${session} AND visible_from <= ${playhead}`;
  if (!table.versioned) return `SELECT * FROM main.t_${table.name} WHERE ${where}`;
  // A table with no key holds one row per session.
  if (!table.key.length) return `SELECT * FROM main.t_${table.name} WHERE ${where} ORDER BY visible_from DESC LIMIT 1`;
  // The newest version of each row from the primary key's index alone, then just those rows. Reading
  // every version's full row instead took ten times as long on a race's laps.
  const key = table.key.map(quote);
  const join = [...['session_key', ...key].map((column) => `t.${column} = v.${column}`), 't.visible_from = v.newest'].join(' AND ');
  return `SELECT t.* FROM (SELECT session_key, ${key.join(', ')}, MAX(visible_from) AS newest FROM main.t_${table.name} WHERE ${where} GROUP BY ${key.join(', ')}) v JOIN main.t_${table.name} t ON ${join}`;
}

/** How bad a track status is, for picking the worst during a lap. Unknown words count as clear. */
const STATUS_RANK = `CASE status WHEN 'Red' THEN 5 WHEN 'SCDeployed' THEN 4 WHEN 'VSCDeployed' THEN 3 WHEN 'VSCEnding' THEN 2 WHEN 'Yellow' THEN 1 ELSE 0 END`;

/** Later than any date: the open end of the lap in progress. */
const OPEN_END = Number.MAX_SAFE_INTEGER;

/**
 * One row per driver per lap, built from the other views, so it can only show what they show at the
 * playhead. A lap ends where the next one starts, or else at its start plus its time. Position and
 * gaps are the last before the lap's end, and the lap in progress, which has no end yet, gets the latest.
 * `track_status` is the worst during the lap: Red, SCDeployed, VSCDeployed, VSCEnding, Yellow, then AllClear.
 */
export const LAP_SUMMARY_SQL = `
WITH l AS MATERIALIZED (
  SELECT session_key, meeting_key, driver_number, lap_number, date_start, lap_duration,
    duration_sector_1, duration_sector_2, duration_sector_3, is_pit_out_lap,
    LEAD(lap_number) OVER w AS next_lap, LEAD(date_start) OVER w AS next_start
  FROM laps WINDOW w AS (PARTITION BY driver_number ORDER BY lap_number)
),
e AS (
  SELECT *,
    CASE WHEN next_lap = lap_number + 1 AND next_start IS NOT NULL THEN next_start
      ELSE date_start + CAST(ROUND(lap_duration * 1000) AS INTEGER) END AS date_end
  FROM l
),
b AS (
  SELECT *, COALESCE(date_end, ${OPEN_END}) AS upto,
    COALESCE(date_start, date_end - CAST(ROUND(lap_duration * 1000) AS INTEGER), date_end, ${OPEN_END}) AS since
  FROM e
),
s AS MATERIALIZED (SELECT driver_number, stint_number, lap_start, compound, tyre_age_at_start FROM stints),
p AS MATERIALIZED (SELECT driver_number, lap_number FROM pit),
t AS MATERIALIZED (SELECT date, status, ${STATUS_RANK} AS severity FROM track_status)
SELECT b.session_key, b.meeting_key, b.driver_number, b.lap_number, b.date_start, b.date_end, b.lap_duration,
  b.duration_sector_1, b.duration_sector_2, b.duration_sector_3,
  (SELECT position FROM position WHERE driver_number = b.driver_number AND date <= b.upto ORDER BY date DESC LIMIT 1) AS position,
  (SELECT gap_to_leader FROM intervals WHERE driver_number = b.driver_number AND date <= b.upto ORDER BY date DESC LIMIT 1) AS gap_to_leader,
  (SELECT interval FROM intervals WHERE driver_number = b.driver_number AND date <= b.upto ORDER BY date DESC LIMIT 1) AS interval,
  st.stint_number, st.compound,
  st.tyre_age_at_start + b.lap_number - st.lap_start + 1 AS tyre_age,
  EXISTS (SELECT 1 FROM p WHERE p.driver_number = b.driver_number AND p.lap_number = b.lap_number) AS is_pit_in_lap,
  b.is_pit_out_lap OR EXISTS (SELECT 1 FROM p WHERE p.driver_number = b.driver_number AND p.lap_number = b.lap_number - 1) AS is_pit_out_lap,
  (SELECT status FROM (
    SELECT status, severity FROM t WHERE date > b.since AND date <= b.upto
    UNION ALL SELECT * FROM (SELECT status, severity FROM t WHERE date <= b.since ORDER BY date DESC LIMIT 1)
  ) ORDER BY severity DESC LIMIT 1) AS track_status
FROM b
LEFT JOIN s st ON st.driver_number = b.driver_number
  AND st.stint_number = (SELECT MAX(stint_number) FROM s WHERE driver_number = b.driver_number AND lap_start <= b.lap_number)`;
