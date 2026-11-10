/**
 * The thread that owns the database. SQLite calls and parsing whole archives both block, and the main
 * process also serves DRM and sign-in, so none of it can run there. Holds no credentials: the main
 * process downloads the files and sends them here.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { setImmediate as yieldNow } from 'node:timers/promises';
import type { SessionResultEntry, StartingGridEntry } from '../../shared/sessionData';
import { ingestResults, ingestTelemetry, ingestTiming, LiveCapture, type FeedFiles, type LiveRecord } from './ingest';
import type { SessionMeta } from './processors';
import { TimingStore } from './store';

const store = new TimingStore((workerData as { file: string }).file);
let capture: LiveCapture | null = null;

const operations = {
  isComplete: (sessionKey: number, dataset: 'timing' | 'telemetry' | 'results') => store.isComplete(sessionKey, dataset),
  status: (sessionKey: number) => ({ coverage: store.coverage(sessionKey), clock: store.detail(sessionKey, 'timing').clock ?? null }),
  ingestTiming: (meta: SessionMeta, feeds: FeedFiles, scheduledEndMs: number | null) => ingestTiming(store, meta, feeds, scheduledEndMs, Date.now()),
  ingestTelemetry: (meta: SessionMeta, feeds: FeedFiles, scheduledEndMs: number | null) =>
    ingestTelemetry(store, meta, feeds, scheduledEndMs, Date.now(), () => yieldNow()),
  ingestResults: (meta: SessionMeta, results: { grid: StartingGridEntry[]; result: SessionResultEntry[]; final: boolean; failed: boolean }) =>
    ingestResults(store, meta, results, Date.now()),
  sql: (sessionKey: number, playheadMs: number, sql: string, params: unknown[]) => store.sql(sessionKey, playheadMs, sql, params),
  objects: (sessionKey: number, playheadMs: number) => store.sessionObjects(sessionKey, playheadMs),
  liveBegin: (meta: SessionMeta) => {
    capture = new LiveCapture(store, meta, Date.now());
  },
  liveAppend: (records: LiveRecord[]) => capture?.append(records),
  liveGap: (sessionKey: number, open: boolean, at: number) => (open ? store.openGap(sessionKey, at) : store.closeGap(sessionKey, at)),
  liveEnd: () => {
    capture = null;
  },
  saveSchedule: (schedule: Parameters<TimingStore['saveSchedule']>[0]) => store.saveSchedule(schedule),
  schedule: () => store.schedule(),
  saveCircuit: (circuit: Parameters<TimingStore['saveCircuit']>[0]) => store.saveCircuit(circuit),
  circuit: (circuitKey: number) => store.circuit(circuitKey),
};

export type WorkerOperations = typeof operations;

parentPort!.on('message', async ({ id, op, args }: { id: number; op: keyof WorkerOperations; args: unknown[] }) => {
  try {
    const result = await (operations[op] as (...a: unknown[]) => unknown)(...args);
    parentPort!.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort!.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
