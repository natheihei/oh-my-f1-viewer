/**
 * The tables behind the session database: names, keys and columns. Shared so the renderer can describe
 * them, to the agent for one. Building SQL from them is electron/timingdb/schema.ts's job.
 */
import type { Dataset, SqlTable } from './sessionData';

/** `lap_summary` is a view over the others, built in electron/timingdb/schema.ts. */
export type RowTable =
  | Exclude<SqlTable, 'lap_summary'>
  | 'drivers'
  | 'championship_drivers'
  | 'championship_teams'
  | 'starting_grid'
  | 'session_result'
  | 'lap_count';

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
    // F1's own words for the status: AllClear, Yellow, SCDeployed, VSCDeployed, VSCEnding, Red.
    name: 'track_status',
    dataset: 'timing',
    key: ['date'],
    columns: { status: 'TEXT' },
    versioned: false,
  },
  {
    // One row per session: the lap the leader is on, and the scheduled distance.
    name: 'lap_count',
    dataset: 'timing',
    key: [],
    columns: { current_lap: 'INTEGER', total_laps: 'INTEGER' },
    versioned: true,
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

/** What a SQL query sees of a table: the view over it, in this column order. */
export function sqlColumns(table: TableDefinition): string[] {
  return ['session_key', 'meeting_key', ...visibleColumns(table), 'visible_from'];
}

/** What a query sees of `lap_summary`, which is a view and so has no table definition. Kept in step with LAP_SUMMARY_SQL by a test. */
export const LAP_SUMMARY_COLUMNS = [
  'driver_number',
  'lap_number',
  'date_start',
  'date_end',
  'lap_duration',
  'duration_sector_1',
  'duration_sector_2',
  'duration_sector_3',
  'position',
  'gap_to_leader',
  'interval',
  'stint_number',
  'compound',
  'tyre_age',
  'is_pit_in_lap',
  'is_pit_out_lap',
  'track_status',
];
