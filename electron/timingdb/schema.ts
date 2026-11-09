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
export const INGEST_VERSION = 2;

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
  // SQLite takes the other columns from the row that MAX() picked.
  return `SELECT *, MAX(visible_from) FROM main.t_${table.name} WHERE ${where} GROUP BY ${table.key.map(quote).join(', ')}`;
}
