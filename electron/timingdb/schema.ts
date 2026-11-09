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
 */
import type { Dataset, SqlTable } from '../../shared/sessionData';

export type RowTable =
  | SqlTable
  | 'drivers'
  | 'championship_drivers'
  | 'championship_teams'
  | 'starting_grid'
  | 'session_result';

/** Bump when a processor or table changes: sessions are then ingested again the next time they open. */
export const INGEST_VERSION = 2;

export interface TableDefinition {
  name: RowTable;
  dataset: Dataset;
  /** Columns making a row unique within a session. Must never be null. */
  key: string[];
  /** Everything else. A type of '' keeps whatever's stored, for columns that can hold a number or text. */
  columns: Record<string, 'INTEGER' | 'REAL' | 'TEXT' | ''>;
  versioned: boolean;
  /** Stored as JSON text, for lists. */
  json?: string[];
  /** Stored as 0 or 1, and read back as true or false in objects. */
  booleans?: string[];
  /** Columns a consumer doesn't see: internal keys. */
  hidden?: string[];
  /** Row storage keyed directly on the primary key, for tables with very many rows. */
  compact?: boolean;
}

export const TABLES: TableDefinition[] = [
  {
    name: 'car_data',
    dataset: 'telemetry',
    key: ['date', 'driver_number'],
    columns: { rpm: 'INTEGER', speed: 'INTEGER', n_gear: 'INTEGER', throttle: 'INTEGER', brake: 'INTEGER', drs: 'INTEGER' },
    versioned: false,
    compact: true,
  },
  {
    name: 'location',
    dataset: 'telemetry',
    key: ['date', 'driver_number'],
    columns: { x: 'INTEGER', y: 'INTEGER', z: 'INTEGER' },
    versioned: false,
    compact: true,
  },
  {
    name: 'position',
    dataset: 'timing',
    key: ['date', 'driver_number'],
    columns: { position: 'INTEGER' },
    versioned: false,
    compact: true,
  },
  {
    name: 'intervals',
    dataset: 'timing',
    key: ['date', 'driver_number'],
    columns: { gap_to_leader: '', interval: '' },
    versioned: false,
    compact: true,
  },
  {
    name: 'weather',
    dataset: 'timing',
    key: ['date'],
    columns: {
      air_temperature: 'REAL',
      humidity: 'REAL',
      pressure: 'REAL',
      rainfall: 'INTEGER',
      track_temperature: 'REAL',
      wind_direction: 'INTEGER',
      wind_speed: 'REAL',
    },
    versioned: false,
  },
  {
    name: 'overtakes',
    dataset: 'timing',
    key: ['date', 'overtaking_driver_number', 'overtaken_driver_number'],
    columns: { position: 'INTEGER' },
    versioned: false,
  },
  {
    name: 'race_control',
    dataset: 'timing',
    key: ['row_key'],
    columns: {
      date: 'INTEGER',
      driver_number: 'INTEGER',
      lap_number: 'INTEGER',
      category: 'TEXT',
      flag: 'TEXT',
      scope: 'TEXT',
      sector: 'INTEGER',
      qualifying_phase: 'INTEGER',
      message: 'TEXT',
    },
    versioned: false,
    hidden: ['row_key'],
  },
  {
    name: 'pit',
    dataset: 'timing',
    key: ['driver_number', 'lap_number'],
    columns: { date: 'INTEGER', pit_duration: 'REAL', lane_duration: 'REAL', stop_duration: 'REAL' },
    versioned: true,
  },
  {
    name: 'stints',
    dataset: 'timing',
    key: ['driver_number', 'stint_number'],
    columns: { lap_start: 'INTEGER', lap_end: 'INTEGER', compound: 'TEXT', tyre_age_at_start: 'INTEGER' },
    versioned: true,
  },
  {
    name: 'laps',
    dataset: 'timing',
    key: ['driver_number', 'lap_number'],
    columns: {
      date_start: 'INTEGER',
      duration_sector_1: 'REAL',
      duration_sector_2: 'REAL',
      duration_sector_3: 'REAL',
      i1_speed: 'INTEGER',
      i2_speed: 'INTEGER',
      st_speed: 'INTEGER',
      is_pit_out_lap: 'INTEGER',
      lap_duration: 'REAL',
      segments_sector_1: 'TEXT',
      segments_sector_2: 'TEXT',
      segments_sector_3: 'TEXT',
    },
    versioned: true,
    json: ['segments_sector_1', 'segments_sector_2', 'segments_sector_3'],
    booleans: ['is_pit_out_lap'],
  },
  {
    name: 'drivers',
    dataset: 'timing',
    key: ['driver_number'],
    columns: {
      broadcast_name: 'TEXT',
      full_name: 'TEXT',
      name_acronym: 'TEXT',
      team_name: 'TEXT',
      team_colour: 'TEXT',
      first_name: 'TEXT',
      last_name: 'TEXT',
      headshot_url: 'TEXT',
      country_code: 'TEXT',
    },
    versioned: true,
  },
  {
    name: 'championship_drivers',
    dataset: 'timing',
    key: ['driver_number'],
    columns: { position_start: 'INTEGER', position_current: 'INTEGER', points_start: 'REAL', points_current: 'REAL' },
    versioned: true,
  },
  {
    name: 'championship_teams',
    dataset: 'timing',
    key: ['team_key'],
    columns: { team_name: 'TEXT', position_start: 'INTEGER', position_current: 'INTEGER', points_start: 'REAL', points_current: 'REAL' },
    versioned: true,
    hidden: ['team_key'],
  },
  {
    name: 'starting_grid',
    dataset: 'results',
    key: ['driver_number'],
    columns: { position: 'INTEGER', lap_duration: 'REAL' },
    versioned: false,
  },
  {
    name: 'session_result',
    dataset: 'results',
    key: ['driver_number'],
    columns: {
      position: 'INTEGER',
      number_of_laps: 'INTEGER',
      points: 'REAL',
      dnf: 'INTEGER',
      dns: 'INTEGER',
      dsq: 'INTEGER',
      duration: '',
      gap_to_leader: '',
    },
    versioned: false,
    json: ['duration', 'gap_to_leader'],
    booleans: ['dnf', 'dns', 'dsq'],
  },
];

export const TABLE_BY_NAME = new Map(TABLES.map((table) => [table.name, table]));

/** The columns a row of this table has, apart from the ones every table has. */
export function rowColumns(table: TableDefinition): string[] {
  return [...table.key, ...Object.keys(table.columns)];
}

export function visibleColumns(table: TableDefinition): string[] {
  return rowColumns(table).filter((column) => !table.hidden?.includes(column));
}

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
