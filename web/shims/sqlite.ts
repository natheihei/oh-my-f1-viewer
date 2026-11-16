/**
 * `node:sqlite` over SQLite's WebAssembly build, for the session database's worker. Files live in the
 * origin's private file system through the `opfs-sahpool` VFS, which needs no cross-origin isolation.
 * `initSqlite` must finish before a database is opened: Node's API is synchronous, and loading isn't.
 *
 * What differs from Node's SQLite, and why it doesn't matter here:
 * - No WAL. The VFS has no shared memory, so `journal_mode = WAL` leaves the rollback journal on. A
 *   second connection to a file then reads the file itself, so the writer keeps its changes in memory until
 *   it commits (`cache_spill = OFF`), and a commit is written without yielding. A reader therefore never
 *   sees half a transaction.
 * - One tab at a time. The VFS holds its files exclusively: see `web/backend/main.ts`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

let sqlite3: any = null;
let pool: any = null;

/** Loads SQLite and opens the pool of files in `directory`. */
export async function initSqlite(directory = '/f1a-sqlite'): Promise<void> {
  if (sqlite3) return;
  const module = await (sqlite3InitModule as any)({ print: () => {}, printErr: (...args: unknown[]) => console.warn('[sqlite]', ...args) });
  pool = await module.installOpfsSAHPoolVfs({ name: 'opfs-sahpool', directory, initialCapacity: 6, clearOnInit: false });
  sqlite3 = module;
}

type Value = null | number | bigint | string | Uint8Array;

function need(): any {
  if (!sqlite3) throw new Error('SQLite is not loaded yet');
  return sqlite3;
}

class StatementSync {
  constructor(
    private readonly statement: any,
    private readonly db: any,
  ) {}

  private bind(params: Value[]): void {
    this.statement.reset(true);
    if (params.length) this.statement.bind(params);
  }

  columns(): Array<{ name: string }> {
    return this.statement.getColumnNames().map((name: string) => ({ name }));
  }

  get(...params: Value[]): Record<string, unknown> | undefined {
    this.bind(params);
    try {
      return this.statement.step() ? this.statement.get({}) : undefined;
    } finally {
      this.statement.reset();
    }
  }

  all(...params: Value[]): Array<Record<string, unknown>> {
    this.bind(params);
    const rows: Array<Record<string, unknown>> = [];
    try {
      while (this.statement.step()) rows.push(this.statement.get({}));
    } finally {
      this.statement.reset();
    }
    return rows;
  }

  *iterate(...params: Value[]): IterableIterator<Record<string, unknown>> {
    this.bind(params);
    try {
      while (this.statement.step()) yield this.statement.get({});
    } finally {
      this.statement.reset();
    }
  }

  run(...params: Value[]): { changes: number; lastInsertRowid: number } {
    this.bind(params);
    try {
      while (this.statement.step()) {
        // Rows from a RETURNING clause are read and dropped, as Node's `run` does.
      }
    } finally {
      this.statement.reset();
    }
    return { changes: this.db.changes(), lastInsertRowid: Number(need().capi.sqlite3_last_insert_rowid(this.db)) };
  }
}

export class DatabaseSync {
  private db: any;

  constructor(file: string, options: { readOnly?: boolean } = {}) {
    const s = need();
    const name = file.startsWith('/') ? file : `/${file}`;
    this.db = new s.oo1.DB({ filename: name, flags: options.readOnly ? 'r' : 'c', vfs: pool.vfsName });
    if (!options.readOnly) this.db.exec('PRAGMA cache_spill = OFF;');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return new StatementSync(this.db.prepare(sql), this.db);
  }

  function(name: string, options: { deterministic?: boolean; varargs?: boolean } | ((...args: any[]) => unknown), fn?: (...args: any[]) => unknown): void {
    const run = (typeof options === 'function' ? options : fn)!;
    const settings = typeof options === 'function' ? {} : options;
    this.db.createFunction({
      name,
      arity: settings.varargs ? -1 : run.length,
      deterministic: !!settings.deterministic,
      xFunc: (_context: number, ...args: unknown[]) => run(...args),
    });
  }

  /** `callback(action, a, b, database, trigger)` returns one of the `constants` below. */
  setAuthorizer(callback: ((action: number, a: string | null, b: string | null, database: string | null, trigger: string | null) => number) | null): void {
    const { capi, wasm } = need();
    const text = (value: unknown) => (typeof value === 'number' ? (value ? wasm.cstrToJs(value) : null) : ((value as string | null) ?? null));
    capi.sqlite3_set_authorizer(
      this.db,
      callback
        ? (_user: number, action: number, a: unknown, b: unknown, database: unknown, trigger: unknown) => {
            try {
              return callback(action, text(a), text(b), text(database), text(trigger));
            } catch (e) {
              console.error('[sqlite] authorizer failed:', e);
              return capi.SQLITE_DENY;
            }
          }
        : 0,
      0,
    );
  }

  close(): void {
    this.db.close();
  }
}

/** The authorizer's action codes and answers, which are fixed by SQLite. */
export const constants = {
  SQLITE_OK: 0,
  SQLITE_DENY: 1,
  SQLITE_IGNORE: 2,
  SQLITE_CREATE_INDEX: 1,
  SQLITE_CREATE_TABLE: 2,
  SQLITE_CREATE_TEMP_INDEX: 3,
  SQLITE_CREATE_TEMP_TABLE: 4,
  SQLITE_CREATE_TEMP_TRIGGER: 5,
  SQLITE_CREATE_TEMP_VIEW: 6,
  SQLITE_CREATE_TRIGGER: 7,
  SQLITE_CREATE_VIEW: 8,
  SQLITE_DELETE: 9,
  SQLITE_DROP_INDEX: 10,
  SQLITE_DROP_TABLE: 11,
  SQLITE_DROP_TEMP_INDEX: 12,
  SQLITE_DROP_TEMP_TABLE: 13,
  SQLITE_DROP_TEMP_TRIGGER: 14,
  SQLITE_DROP_TEMP_VIEW: 15,
  SQLITE_DROP_TRIGGER: 16,
  SQLITE_DROP_VIEW: 17,
  SQLITE_INSERT: 18,
  SQLITE_PRAGMA: 19,
  SQLITE_READ: 20,
  SQLITE_SELECT: 21,
  SQLITE_TRANSACTION: 22,
  SQLITE_UPDATE: 23,
  SQLITE_ATTACH: 24,
  SQLITE_DETACH: 25,
  SQLITE_ALTER_TABLE: 26,
  SQLITE_REINDEX: 27,
  SQLITE_ANALYZE: 28,
  SQLITE_CREATE_VTABLE: 29,
  SQLITE_DROP_VTABLE: 30,
  SQLITE_FUNCTION: 31,
  SQLITE_SAVEPOINT: 32,
  SQLITE_COPY: 0,
  SQLITE_RECURSIVE: 33,
};
