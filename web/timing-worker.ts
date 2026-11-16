/**
 * The session database's worker in the browser: electron/timingdb/worker.ts as it is, started once
 * SQLite's WebAssembly build has loaded, since the store opens its database as it's imported.
 */
import './shims/worker_threads';
import { initSqlite } from './shims/sqlite';

await initSqlite();
await import('../electron/timingdb/worker');
