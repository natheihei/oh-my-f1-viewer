/**
 * The SQLite database. One connection writes. A second, read-only one serves consumers' SQL, which can
 * only reach views limited to one session and to what the playhead has revealed: the authorizer
 * refuses everything else, including the tables behind those views.
 */
import { constants, DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import type { FeedClock } from '../../shared/feedTime';
import {
  SQL_TABLES,
  type Circuit,
  type Dataset,
  type DatasetState,
  type Schedule,
  type SessionCoverage,
  type SessionObjects,
  type SqlRows,
  type SqlTableInfo,
} from '../../shared/sessionData';
import type { Emission } from './processors';
import {
  asOfSql,
  createTableSql,
  INGEST_VERSION,
  DERIVED_VIEWS,
  quote,
  rowColumns,
  sqlColumns,
  TABLE_BY_NAME,
  TABLES,
  visibleColumns,
  type RowTable,
  type TableDefinition,
} from './schema';

/** A consumer asking for more than this is told to narrow the query. */
const MAX_SQL_ROWS = 200_000;

/** Bump when table definitions change. It's a cache of what F1 publishes, so old tables are just dropped. */
const SCHEMA_VERSION = 3;

const EMPTY_COVERAGE: DatasetState = { state: 'absent', reason: null };

interface IngestRow {
  dataset: Dataset;
  status: 'partial' | 'complete' | 'failed';
  version: number;
  source: 'archive' | 'live';
  time_base_ms: number | null;
  detail: string | null;
}

export interface IngestDetail {
  /** Why it isn't complete. */
  reason?: string;
  missingFeeds?: string[];
  /** When the feed's first message came. */
  firstMs?: number;
  /** When the session finished, on the feed's clock, or its last message if it never said so. */
  finishedMs?: number;
  /** Where the feed's timeline sits, for placing a replay's video on it. */
  clock?: FeedClock;
}

function toSql(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') return value;
  return JSON.stringify(value);
}

export class TimingStore {
  readonly db: DatabaseSync;
  private readonly reader: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  private querySession = -1;
  private queryPlayhead = -1;
  /** Every table SQL can read, and its columns, as SQLite reports them, by name. */
  readonly tables: SqlTableInfo[];

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.migrate();
    this.reader = new DatabaseSync(file, { readOnly: true });
    this.tables = this.setUpReader();
  }

  close(): void {
    this.reader.close();
    this.db.close();
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version !== SCHEMA_VERSION) {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 't\\_%' ESCAPE '\\'").all() as Array<{ name: string }>;
      for (const { name } of tables) this.db.exec(`DROP TABLE ${quote(name)}`);
    }
    for (const table of TABLES) this.db.exec(createTableSql(table));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS t_ingest (
        session_key INTEGER NOT NULL,
        dataset TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        source TEXT NOT NULL,
        time_base_ms INTEGER,
        detail TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_key, dataset)
      );
      CREATE TABLE IF NOT EXISTS t_capture_gaps (
        session_key INTEGER NOT NULL,
        from_ms INTEGER NOT NULL,
        to_ms INTEGER,
        PRIMARY KEY (session_key, from_ms)
      );
      CREATE TABLE IF NOT EXISTS t_live_messages (
        session_key INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        topic TEXT NOT NULL,
        time INTEGER NOT NULL,
        visible_from INTEGER NOT NULL,
        snapshot INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (session_key, seq)
      );
      CREATE TABLE IF NOT EXISTS t_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  // --- Reads for consumers ---

  /** Builds the views consumers read, and returns what they are. */
  private setUpReader(): SqlTableInfo[] {
    // Marked deterministic so SQLite reads each once per query instead of once per row. They only
    // change between queries.
    this.reader.function('f1a_session', { deterministic: true }, () => this.querySession);
    this.reader.function('f1a_playhead', { deterministic: true }, () => this.queryPlayhead);
    // One view per stored table, limited to the session and the playhead.
    const derived = new Map(DERIVED_VIEWS.map((view) => [view.name as string, view]));
    for (const name of SQL_TABLES) {
      if (derived.has(name)) continue;
      const table = TABLE_BY_NAME.get(name as RowTable)!;
      const columns = sqlColumns(table).map(quote).join(', ');
      this.reader.exec(`CREATE TEMP VIEW ${quote(name)} AS SELECT ${columns} FROM (${asOfSql(table, 'f1a_session()', 'f1a_playhead()')})`);
    }
    // Built on the views above, so they're limited to the playhead just as those are.
    for (const view of DERIVED_VIEWS) this.reader.exec(`CREATE TEMP VIEW ${quote(view.name)} AS ${view.sql}`);
    // What there is to read, as SQLite sees it. Asked before the authorizer below, which would refuse it.
    const columns = this.reader.prepare("SELECT name FROM pragma_table_info(?, 'temp') ORDER BY cid");
    const views = this.reader.prepare("SELECT name FROM sqlite_temp_master WHERE type = 'view' ORDER BY name").all() as Array<{ name: string }>;
    const tables = views.map(({ name }) => {
      const about = derived.get(name)?.about ?? TABLE_BY_NAME.get(name as RowTable)?.about;
      return { name, columns: (columns.all(name) as Array<{ name: string }>).map((column) => column.name), ...(about ? { about } : {}) };
    });
    this.reader.setAuthorizer((action, a, b, database, view) => {
      switch (action) {
        case constants.SQLITE_SELECT:
        case constants.SQLITE_RECURSIVE:
          return constants.SQLITE_OK;
        case constants.SQLITE_FUNCTION:
          return b === 'load_extension' ? constants.SQLITE_DENY : constants.SQLITE_OK;
        case constants.SQLITE_READ:
          // Only through one of the views above. A temp view can't be anything but ours: this
          // connection denies creating others.
          return view || (database === 'temp' && a) ? constants.SQLITE_OK : constants.SQLITE_DENY;
        default:
          return constants.SQLITE_DENY;
      }
    });
    return tables;
  }

  /** Runs a consumer's query as of the playhead. Fails on anything but reading the views. */
  sql(sessionKey: number, playheadMs: number, sql: string, params: unknown[] = []): SqlRows {
    this.querySession = sessionKey;
    this.queryPlayhead = playheadMs;
    const statement = this.reader.prepare(sql);
    const columns = statement.columns().map((column) => column.name);
    const rows: Array<Record<string, unknown>> = [];
    for (const row of statement.iterate(...params.map(toSql))) {
      if (rows.length === MAX_SQL_ROWS) throw new Error(`The query returned more than ${MAX_SQL_ROWS} rows. Narrow it down with a filter, on date for example.`);
      rows.push({ ...(row as Record<string, unknown>) });
    }
    return { columns, rows };
  }

  /** One table's rows as of the playhead, with lists and booleans restored. */
  private objects<T>(name: RowTable, sessionKey: number, playheadMs: number, orderBy: string): T[] {
    const table = TABLE_BY_NAME.get(name)!;
    const columns = visibleColumns(table);
    const rows = this.db
      .prepare(`SELECT ${columns.map(quote).join(', ')} FROM (${asOfSql(table, '?', '?')}) ORDER BY ${orderBy}`)
      .all(sessionKey, playheadMs) as Array<Record<string, unknown>>;
    for (const row of rows) {
      for (const column of table.booleans ?? []) row[column] = row[column] === 1;
      for (const column of table.json ?? []) {
        const value = row[column];
        if (typeof value === 'string' && value.startsWith('[')) row[column] = JSON.parse(value);
      }
    }
    return rows.map((row) => ({ ...row })) as T[];
  }

  sessionObjects(sessionKey: number, playheadMs: number): SessionObjects {
    return {
      drivers: this.objects('drivers', sessionKey, playheadMs, 'driver_number'),
      lapCount: this.lapCount(sessionKey, playheadMs),
    };
  }

  private lapCount(sessionKey: number, playheadMs: number): SessionObjects['lapCount'] {
    const [row] = this.objects<{ current_lap: number | null; total_laps: number | null }>('lap_count', sessionKey, playheadMs, 'current_lap');
    return row && row.current_lap !== null && row.total_laps !== null ? { current: row.current_lap, total: row.total_laps } : null;
  }

  // --- Writes ---

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }

  private insertSql(table: TableDefinition): string {
    const columns = ['session_key', 'meeting_key', ...rowColumns(table), 'visible_from'];
    const insert = `INSERT INTO t_${table.name} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    const conflict = ['session_key', ...table.key, ...(table.versioned ? ['visible_from'] : [])].map(quote).join(', ');
    const updates = Object.keys(table.columns).map((column) => `${quote(column)} = excluded.${quote(column)}`);
    // Sent again, as a reconnect's snapshot does, a row stays visible from the first time it was seen.
    if (!table.versioned) updates.push('visible_from = MIN(visible_from, excluded.visible_from)');
    return updates.length ? `${insert} ON CONFLICT (${conflict}) DO UPDATE SET ${updates.join(', ')}` : `${insert} ON CONFLICT (${conflict}) DO NOTHING`;
  }

  write(emissions: Emission[], visibleFrom: number): void {
    for (const { table: name, row } of emissions) this.writeRow(TABLE_BY_NAME.get(name)!, row, visibleFrom);
  }

  private writeRow(table: TableDefinition, row: Record<string, unknown>, visibleFrom: number): void {
    if (table.key.some((column) => row[column] === null || row[column] === undefined)) return;
    const columns = rowColumns(table);
    const values = [row.session_key, row.meeting_key, ...columns.map((column) => row[column]), visibleFrom].map(toSql);
    this.statement(this.insertSql(table)).run(...values);
  }

  transaction<T>(run: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  clearDataset(sessionKey: number, dataset: Dataset): void {
    for (const table of TABLES) {
      if (table.dataset === dataset) this.statement(`DELETE FROM t_${table.name} WHERE session_key = ?`).run(sessionKey);
    }
  }

  // --- What has been ingested ---

  mark(sessionKey: number, dataset: Dataset, status: IngestRow['status'], source: IngestRow['source'], timeBaseMs: number | null, detail: IngestDetail, now: number): void {
    this.statement(
      `INSERT OR REPLACE INTO t_ingest (session_key, dataset, status, version, source, time_base_ms, detail, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionKey, dataset, status, INGEST_VERSION, source, timeBaseMs, JSON.stringify(detail), now);
  }

  private ingestRow(sessionKey: number, dataset: Dataset): IngestRow | null {
    const row = this.statement('SELECT * FROM t_ingest WHERE session_key = ? AND dataset = ?').get(sessionKey, dataset);
    return row ? ({ ...row } as unknown as IngestRow) : null;
  }

  /** Whether this dataset can be skipped: it's final, and built by the current code. */
  isComplete(sessionKey: number, dataset: Dataset): boolean {
    const row = this.ingestRow(sessionKey, dataset);
    return row?.status === 'complete' && row.version === INGEST_VERSION;
  }

  detail(sessionKey: number, dataset: Dataset): IngestDetail {
    return JSON.parse(this.ingestRow(sessionKey, dataset)?.detail ?? '{}');
  }

  timeBase(sessionKey: number): number | null {
    return this.ingestRow(sessionKey, 'timing')?.time_base_ms ?? null;
  }

  coverage(sessionKey: number): SessionCoverage {
    const of = (dataset: Dataset): DatasetState => {
      const row = this.ingestRow(sessionKey, dataset);
      if (!row || row.version !== INGEST_VERSION) return EMPTY_COVERAGE;
      return { state: row.status, reason: (JSON.parse(row.detail ?? '{}') as IngestDetail).reason ?? null };
    };
    const timing = this.ingestRow(sessionKey, 'timing');
    const gaps = this.statement('SELECT from_ms, to_ms FROM t_capture_gaps WHERE session_key = ? ORDER BY from_ms').all(sessionKey) as Array<{ from_ms: number; to_ms: number | null }>;
    const first = this.statement('SELECT MIN(visible_from) AS first FROM t_live_messages WHERE session_key = ?').get(sessionKey) as { first: number | null };
    return {
      source: timing?.source ?? null,
      datasets: { timing: of('timing'), telemetry: of('telemetry'), results: of('results') },
      missingFeeds: this.detail(sessionKey, 'timing').missingFeeds ?? [],
      gaps: gaps.map((gap) => ({ from: gap.from_ms, to: gap.to_ms })),
      capturedFrom: first.first,
    };
  }

  // --- Live capture ---

  openGap(sessionKey: number, at: number): void {
    const open = this.statement('SELECT 1 FROM t_capture_gaps WHERE session_key = ? AND to_ms IS NULL').get(sessionKey);
    if (!open) this.statement('INSERT OR REPLACE INTO t_capture_gaps (session_key, from_ms, to_ms) VALUES (?, ?, NULL)').run(sessionKey, at);
  }

  closeGap(sessionKey: number, at: number): void {
    this.statement('UPDATE t_capture_gaps SET to_ms = ? WHERE session_key = ? AND to_ms IS NULL').run(at, sessionKey);
  }

  /** Drops a live capture's raw log once the archive has replaced it. */
  clearCapture(sessionKey: number): void {
    this.statement('DELETE FROM t_live_messages WHERE session_key = ?').run(sessionKey);
    this.statement('DELETE FROM t_capture_gaps WHERE session_key = ?').run(sessionKey);
  }

  appendLiveMessage(sessionKey: number, seq: number, topic: string, time: number, visibleFrom: number, snapshot: boolean, content: unknown): void {
    this.statement('INSERT OR REPLACE INTO t_live_messages (session_key, seq, topic, time, visible_from, snapshot, content) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      sessionKey,
      seq,
      topic,
      time,
      visibleFrom,
      snapshot ? 1 : 0,
      JSON.stringify(content),
    );
  }

  liveMessages(sessionKey: number): Array<{ seq: number; topic: string; time: number; visible_from: number; snapshot: number; content: string }> {
    return this.statement('SELECT seq, topic, time, visible_from, snapshot, content FROM t_live_messages WHERE session_key = ? ORDER BY seq').all(sessionKey) as never;
  }

  // --- The calendar ---

  saveSchedule(schedule: Schedule): void {
    this.statement("INSERT OR REPLACE INTO t_kv (key, value) VALUES ('schedule', ?)").run(JSON.stringify(schedule));
  }

  schedule(): Schedule | null {
    const row = this.statement("SELECT value FROM t_kv WHERE key = 'schedule'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Schedule) : null;
  }

  // --- Circuits, from MultiViewer ---

  saveCircuit(circuit: Circuit): void {
    this.statement('INSERT OR REPLACE INTO t_kv (key, value) VALUES (?, ?)').run(`circuit:${circuit.circuitKey}`, JSON.stringify(circuit));
  }

  circuit(circuitKey: number): Circuit | null {
    const row = this.statement('SELECT value FROM t_kv WHERE key = ?').get(`circuit:${circuitKey}`) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Circuit) : null;
  }
}
