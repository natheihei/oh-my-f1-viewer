import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataStatus } from '../../shared/sessionData';
import { TimingDb, type TimingDbDeps } from './index';
import { LiveCapture, readLiveFeedClock, type LiveBackfillData, type LiveRecord } from './ingest';
import {
  BACKFILL_PROTOCOL_VERSION,
  DEFAULT_REPLAY_URL,
  backfillMetadata,
  buildManifestUrl,
  fetchLiveBackfill,
  fetchLiveManifest,
  fetchLiveStreamBackfill,
  filterAndClampGaps,
  parseChunkNdjson,
  parseLiveManifest,
  resolveChunkUrl,
  resolveLiveServerUrl,
  selectOverlappingChunks,
  spliceDirectRecords,
} from './liveBackfill';
import type { SessionMeta } from './processors';
import { TimingStore } from './store';
import type { WorkerOperations } from './worker';

const SESSION_KEY = 11420;
const MEETING_KEY = 1275;
const BASE = Date.UTC(2026, 10, 22, 6, 0, 0);
const utc = (ms: number) => new Date(BASE + ms).toISOString();

interface ServerRecord {
  seq: number;
  topic: string;
  data: unknown;
  ts?: string | null;
  snapshot: boolean;
  received_at: number;
  [extra: string]: unknown;
}

interface MockChunkSpec {
  id: number;
  stream: 'timing' | 'telemetry';
  encoding?: string;
  path?: string;
  records: ServerRecord[];
  rawGzip?: boolean;
  extraFields?: Record<string, unknown>;
}

interface RecordedRequest {
  url: string;
  pathname: string;
  accept: string | undefined;
  acceptEncoding: string | undefined;
  clientVersion: string | undefined;
}

const isTelemetryTopic = (topic: string) => topic === 'CarData.z' || topic === 'Position.z';

/**
 * Minimal static HTTP server mirroring Cloudflare R2 / Nginx static serving for v1:
 * `GET /v1/sessions/:key/manifest.json` + immutable `GET {chunk.path}`.
 * Supports dynamically adding chunks mid-test to exercise continuous background catch-up!
 */
async function startMockStaticR2Server(opts: {
  sessionKey: number;
  meetingKey: number;
  protocolVersion?: number;
  status?: 'live' | 'finished';
  chunks?: MockChunkSpec[];
  gaps?: Array<{ from: number; to: number | null }>;
  manifestExtra?: Record<string, unknown>;
  /** Start with 404 on manifest until `setAvailable(true)` is called. */
  initiallyMissing?: boolean;
  beforeRespond?: (pathname: string) => Promise<void>;
}) {
  const requests: RecordedRequest[] = [];
  let status = opts.status ?? 'live';
  let available = !opts.initiallyMissing;
  const chunks: MockChunkSpec[] = [...(opts.chunks ?? [])];
  const chunkByPath = new Map<string, { spec: MockChunkSpec; body: Buffer }>();

  const registerChunk = (spec: MockChunkSpec) => {
    const filename = `${spec.stream}-${String(spec.id).padStart(6, '0')}.ndjson.gz`;
    const chunkPath = spec.path ?? `/v1/sessions/${opts.sessionKey}/chunks/${filename}`;
    const ndjson = `${spec.records.map((r) => JSON.stringify(r)).join('\n')}\n`;
    const gz = zlib.gzipSync(Buffer.from(ndjson, 'utf8'));
    chunkByPath.set(chunkPath, { spec, body: gz });
    const seqs = spec.records.map((r) => r.seq);
    const times = spec.records.map((r) => r.received_at);
    return {
      id: spec.id,
      stream: spec.stream,
      encoding: spec.encoding ?? 'ndjson+gzip',
      path: chunkPath,
      seq_start: seqs.length ? Math.min(...seqs) : 0,
      seq_end: seqs.length ? Math.max(...seqs) : 0,
      from_ms: times.length ? Math.min(...times) : BASE,
      to_ms: times.length ? Math.max(...times) : BASE,
      record_count: spec.records.length,
      byte_len: gz.byteLength,
      ...(spec.extraFields ?? {}),
    };
  };

  let manifestChunks = chunks.map(registerChunk);

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      url: req.url ?? '',
      pathname: parsed.pathname,
      accept: req.headers.accept,
      acceptEncoding: req.headers['accept-encoding'],
      clientVersion: typeof req.headers['x-omfv-client-version'] === 'string' ? req.headers['x-omfv-client-version'] : undefined,
    });

    if (opts.beforeRespond) await opts.beforeRespond(parsed.pathname);

    // Static manifest: GET /v1/sessions/:key/manifest.json
    const manifestMatch = /^\/v1\/sessions\/(\d+)\/manifest\.json$/.exec(parsed.pathname);
    if (manifestMatch) {
      if (!available || Number(manifestMatch[1]) !== opts.sessionKey) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const allRecords = chunks.flatMap((c) => c.records).sort((a, b) => a.seq - b.seq);
      const capturedFrom = allRecords.length ? allRecords[0].received_at : BASE;
      const lastReceivedAt = allRecords.length ? allRecords[allRecords.length - 1].received_at : BASE;
      const lastSeq = allRecords.length ? allRecords[allRecords.length - 1].seq : -1;
      const hasTelemetry = allRecords.some((r) => isTelemetryTopic(r.topic));
      const manifest = {
        protocol_version: opts.protocolVersion ?? 1,
        session_key: opts.sessionKey,
        meeting_key: opts.meetingKey,
        session_name: 'Race',
        session_type: 'Race',
        meeting_name: 'Las Vegas Grand Prix',
        status,
        captured_from: capturedFrom,
        last_received_at: lastReceivedAt,
        last_seq: lastSeq,
        record_count: allRecords.length,
        has_telemetry: hasTelemetry,
        gaps: opts.gaps ?? [],
        chunks: manifestChunks,
        tail: { timing_count: 0, telemetry_count: 0, from_ms: null, to_ms: null },
        updated_at: lastReceivedAt,
        ...(opts.manifestExtra ?? {}),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(manifest));
      return;
    }

    // Immutable chunk: exact match on chunk.path
    const chunkEntry = chunkByPath.get(parsed.pathname);
    if (chunkEntry) {
      if (chunkEntry.spec.rawGzip) {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
      } else {
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
      }
      res.end(chunkEntry.body);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind mock server');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    requests,
    addChunk(spec: MockChunkSpec) {
      chunks.push(spec);
      manifestChunks = [...manifestChunks, registerChunk(spec)];
    },
    setStatus(next: 'live' | 'finished') {
      status = next;
    },
    setAvailable(next: boolean) {
      available = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Creates an in-process worker harness backed by a real TimingStore (identical ops to worker.ts). */
function createInProcessWorker(store: TimingStore): {
  invoke: NonNullable<TimingDbDeps['invoke']>;
} {
  let capture: LiveCapture | null = null;
  let liveGeneration = 0;
  const ops: Partial<WorkerOperations> = {
    isComplete: (sessionKey, dataset) => store.isComplete(sessionKey, dataset),
    status: (sessionKey) => ({ coverage: store.coverage(sessionKey), clock: store.detail(sessionKey, 'timing').clock ?? null, tables: store.tables }),
    sql: (sessionKey, playheadMs, sql, params) => store.sql(sessionKey, playheadMs, sql, params),
    objects: (sessionKey, playheadMs) => store.sessionObjects(sessionKey, playheadMs),
    liveLastVisibleFrom: (sessionKey, stream) => store.liveLastVisibleFrom(sessionKey, stream),
    liveBegin: async (meta: SessionMeta, backfill: LiveBackfillData | null = null) => {
      const gen = ++liveGeneration;
      capture = null;
      const started = await LiveCapture.start(store, meta, Date.now(), backfill, async () => {}, () => gen !== liveGeneration);
      if (gen !== liveGeneration || !started) return { hasTelemetry: false };
      capture = started;
      return { hasTelemetry: started.hasTelemetry };
    },
    liveAppend: (records: LiveRecord[]) => capture?.append(records),
    liveMergeTimingBackfill: (records: LiveRecord[], gaps: Array<{ from: number; to: number | null }>) => {
      if (!capture) return { written: 0, capturedFrom: null };
      return capture.mergeTimingBackfill(records, gaps, Date.now());
    },
    liveAppendBackfill: async (records: LiveRecord[]) => {
      const gen = liveGeneration;
      const current = capture;
      if (!current) return { hasTelemetry: false, written: 0 };
      const written = await current.appendBackfill(records, async () => {}, () => gen !== liveGeneration || capture !== current);
      if (gen !== liveGeneration || capture !== current) return { hasTelemetry: false, written: 0 };
      return { hasTelemetry: current.hasTelemetry, written };
    },
    liveGap: (sessionKey: number, open: boolean, at: number) => (open ? store.openGap(sessionKey, at) : store.closeGap(sessionKey, at)),
    liveRecordGap: (sessionKey: number, from: number, to: number | null) => store.recordGap(sessionKey, from, to),
    liveEnd: () => {
      liveGeneration++;
      capture = null;
    },
    schedule: () => store.schedule(),
    saveSchedule: (s) => store.saveSchedule(s),
    circuit: (k) => store.circuit(k),
    saveCircuit: (c) => store.saveCircuit(c),
  };

  return {
    invoke: (async (op: keyof WorkerOperations, ...args: unknown[]) => {
      const fn = ops[op] as ((...a: unknown[]) => unknown) | undefined;
      if (!fn) throw new Error(`unhandled test op: ${op}`);
      return await fn(...args);
    }) as NonNullable<TimingDbDeps['invoke']>,
  };
}

function createHarness(
  store: TimingStore,
  opts: {
    backfillBaseUrl?: string | null;
    clientVersion?: string;
    fetchSync?: TimingDbDeps['fetchSync'];
    backfillPollMs?: number;
  } = {},
) {
  const statuses: DataStatus[] = [];
  const circuits: Array<{ query: unknown; circuit: unknown }> = [];
  let onDirectRecord: ((record: LiveRecord) => void) | null = null;
  let liveConnected = false;
  let liveDisconnected = false;
  const worker = createInProcessWorker(store);

  const db = new TimingDb({
    file: ':memory:',
    invoke: worker.invoke,
    fetchFeed: async () => null,
    fetchSeasonIndex: async () => ({}),
    fetchSync: opts.fetchSync ?? (async () => null),
    connectLive: (_feeds, onRecord) => {
      liveConnected = true;
      onDirectRecord = onRecord;
    },
    disconnectLive: () => {
      liveDisconnected = true;
      onDirectRecord = null;
    },
    hasLiveBackfill: () => Boolean(opts.backfillBaseUrl),
    fetchLiveManifest: (sessionKey, manifestOpts) =>
      opts.backfillBaseUrl
        ? fetchLiveManifest(opts.backfillBaseUrl, sessionKey, { ...manifestOpts, clientVersion: opts.clientVersion })
        : Promise.resolve(null),
    fetchLiveStreamBackfill: (manifest, streamOpts) =>
      opts.backfillBaseUrl
        ? fetchLiveStreamBackfill(opts.backfillBaseUrl, manifest, { ...streamOpts, clientVersion: opts.clientVersion })
        : Promise.resolve(null),
    backfillAnchorWaitMs: 30,
    backfillPollMs: opts.backfillPollMs ?? 40,
    fetchPage: async () => null,
    resolveSession: async () => null,
    listUpcoming: async () => ({ upcoming: [], events: [] }),
    fetchCircuit: async () => ({
      x: [0, 10, 0],
      y: [0, 10, 0],
      corners: [],
      rotation: 0,
      circuitName: 'Las Vegas',
      pitLaneTime: null,
      marshalSectors: [],
    }),
    send: (channel, payload) => {
      if (channel === 'data:status') statuses.push(payload as DataStatus);
      else if (channel === 'data:circuit') circuits.push(payload as { query: unknown; circuit: unknown });
    },
  });

  const waitForStatus = async (predicate: (s: DataStatus) => boolean, timeoutMs = 4_000): Promise<DataStatus> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hit = [...statuses].reverse().find(predicate);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`Timed out waiting for status; saw: ${JSON.stringify(statuses.map((s) => ({ state: s.state, backfill: s.backfill?.state })))}`);
  };

  return {
    db,
    statuses,
    circuits,
    isLiveConnected: () => liveConnected,
    isLiveDisconnected: () => liveDisconnected,
    pushDirect: (records: LiveRecord[]) => {
      for (const r of records) onDirectRecord?.(r);
    },
    waitForReady: () => waitForStatus((s) => s.state === 'ready'),
    waitForStatus,
  };
}

function sampleSessionChunks(): { initialChunks: MockChunkSpec[]; seamTimingChunk: MockChunkSpec; seamTelemetryChunk: MockChunkSpec } {
  const timingChunk1: MockChunkSpec = {
    id: 1,
    stream: 'timing',
    records: [
      { seq: 0, topic: 'SessionInfo', data: { Key: SESSION_KEY, Type: 'Race', Meeting: { Key: MEETING_KEY, Circuit: { Key: 152 } } }, ts: null, snapshot: true, received_at: BASE },
      { seq: 1, topic: 'DriverList', data: { '1': { RacingNumber: '1', FullName: 'Driver One', Tla: 'ONE', TeamName: 'A' } }, ts: null, snapshot: true, received_at: BASE },
      { seq: 2, topic: 'SessionData', data: { StatusSeries: [{ Utc: utc(10_000), SessionStatus: 'Started' }] }, ts: utc(10_000), snapshot: false, received_at: BASE + 10_000 },
      { seq: 3, topic: 'TimingAppData', data: { Lines: { '1': { Stints: [{ Compound: 'SOFT', StartLaps: 0, TotalLaps: 0 }] } } }, ts: utc(11_000), snapshot: false, received_at: BASE + 11_000 },
      { seq: 4, topic: 'TimingData', data: { Lines: { '1': { Line: 1, NumberOfLaps: 0 } } }, ts: utc(12_000), snapshot: false, received_at: BASE + 12_000 },
      { seq: 5, topic: 'TimingData', data: { Lines: { '1': { NumberOfLaps: 1, Line: 1 } } }, ts: utc(100_000), snapshot: false, received_at: BASE + 100_000 },
      { seq: 6, topic: 'TimingData', data: { Lines: { '1': { LastLapTime: { Value: '1:30.000' } } } }, ts: utc(101_000), snapshot: false, received_at: BASE + 101_000 },
    ],
  };

  const telemetryChunk1: MockChunkSpec = {
    id: 2,
    stream: 'telemetry',
    records: [
      {
        seq: 7,
        topic: 'CarData.z',
        data: { Entries: [{ Utc: utc(100_500), Cars: { '1': { Channels: { '0': 11400, '2': 312, '3': 8, '4': 100, '5': 0 } } } }] },
        ts: utc(101_000),
        snapshot: false,
        received_at: BASE + 101_500,
      },
    ],
  };

  const timingChunk2: MockChunkSpec = {
    id: 3,
    stream: 'timing',
    records: [
      { seq: 8, topic: 'TimingData', data: { Lines: { '1': { NumberOfLaps: 2, Line: 1 } } }, ts: utc(190_000), snapshot: false, received_at: BASE + 190_000 },
      { seq: 9, topic: 'TimingData', data: { Lines: { '1': { LastLapTime: { Value: '1:29.500' } } } }, ts: utc(191_000), snapshot: false, received_at: BASE + 191_000 },
    ],
  };

  const telemetryChunk2: MockChunkSpec = {
    id: 4,
    stream: 'telemetry',
    records: [
      {
        seq: 10,
        topic: 'Position.z',
        data: { Position: [{ Timestamp: utc(190_000), Entries: { '1': { Status: 'OnTrack', X: 100, Y: 200, Z: 3 } } }] },
        ts: utc(190_500),
        snapshot: false,
        received_at: BASE + 190_500,
      },
    ],
  };

  // Seam chunks published later by the ingestor covering past T1 = BASE + 283_000!
  const seamTimingChunk: MockChunkSpec = {
    id: 5,
    stream: 'timing',
    records: [
      { seq: 11, topic: 'TimingData', data: { Lines: { '1': { NumberOfLaps: 3, Line: 1 } } }, ts: utc(280_000), snapshot: false, received_at: BASE + 280_000 },
      { seq: 12, topic: 'TimingData', data: { Lines: { '1': { LastLapTime: { Value: '1:28.800' } } } }, ts: utc(281_000), snapshot: false, received_at: BASE + 281_000 },
      { seq: 13, topic: 'TrackStatus', data: { Status: '1', Message: 'AllClear' }, ts: utc(290_000), snapshot: false, received_at: BASE + 290_000 },
    ],
  };

  const seamTelemetryChunk: MockChunkSpec = {
    id: 6,
    stream: 'telemetry',
    records: [
      {
        seq: 14,
        topic: 'CarData.z',
        data: { Entries: [{ Utc: utc(280_500), Cars: { '1': { Channels: { '0': 11700, '2': 320, '3': 8, '4': 100, '5': 0 } } } }] },
        ts: utc(281_000),
        snapshot: false,
        received_at: BASE + 281_500,
      },
      {
        seq: 15,
        topic: 'CarData.z',
        data: { Entries: [{ Utc: utc(290_000), Cars: { '1': { Channels: { '0': 11700, '2': 333, '3': 8, '4': 100, '5': 0 } } } }] },
        ts: utc(290_500),
        snapshot: false,
        received_at: BASE + 290_500,
      },
    ],
  };

  return { initialChunks: [timingChunk1, telemetryChunk1, timingChunk2, telemetryChunk2], seamTimingChunk, seamTelemetryChunk };
}

describe('liveBackfill static v1 unit helpers', () => {
  it('resolves URL from env/settings precedence cleanly and supports explicit opt-out', () => {
    const settings = { get: (k: string) => (k === 'replayUrl' ? 'https://settings.replay.dev/' : undefined) };
    expect(resolveLiveServerUrl({ OMFV_REPLAY_URL: 'https://r2.example.com/' }, settings)).toBe('https://r2.example.com');
    expect(resolveLiveServerUrl({ OMFV_LIVE_SERVER_URL: 'https://legacy.example.com/' }, settings)).toBe('https://legacy.example.com');
    expect(resolveLiveServerUrl({}, settings)).toBe('https://settings.replay.dev');
    expect(resolveLiveServerUrl({}, { get: () => undefined })).toBe(DEFAULT_REPLAY_URL);
    expect(resolveLiveServerUrl({ OMFV_REPLAY_URL: '' }, settings)).toBeNull();
    expect(resolveLiveServerUrl({ OMFV_REPLAY_URL: 'off' }, settings)).toBeNull();
    expect(resolveLiveServerUrl({}, { get: () => '' })).toBeNull();
  });

  it('builds static v1 manifest.json URL and enforces same-origin chunk URLs (M1)', () => {
    expect(buildManifestUrl('https://replay.example.com/', 11420)).toBe('https://replay.example.com/v1/sessions/11420/manifest.json');
    expect(resolveChunkUrl('https://replay.example.com/', '/v1/sessions/11420/chunks/timing-000001.ndjson.gz')).toBe(
      'https://replay.example.com/v1/sessions/11420/chunks/timing-000001.ndjson.gz',
    );
    expect(() => resolveChunkUrl('https://replay.example.com', 'https://evil.example.com/chunks/timing-000001.ndjson.gz')).toThrow(/origin/i);
    expect(() => resolveChunkUrl('https://replay.example.com', '//169.254.169.254/latest/meta-data')).toThrow(/origin/i);
    expect(() => resolveChunkUrl('https://replay.example.com', 'file:///etc/passwd')).toThrow();
  });

  it('parses v1 manifest tolerantly, falls back to HTTP Date header, and returns null on protocol_version !== 1', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const httpDateMs = BASE + 25_000;
    const parsed = parseLiveManifest(
      {
        protocol_version: BACKFILL_PROTOCOL_VERSION,
        session_key: 11420,
        status: 'live',
        captured_from: BASE,
        last_received_at: BASE + 20_000,
        last_seq: 10,
        record_count: 11,
        has_telemetry: true,
        gaps: [{ from: BASE + 1000, to: BASE + 2000 }],
        chunks: [
          { id: 1, stream: 'timing', encoding: 'ndjson+gzip', path: '/v1/sessions/11420/chunks/timing-000001.ndjson.gz', seq_start: 0, seq_end: 5, from_ms: BASE, to_ms: BASE + 10_000, record_count: 6, byte_len: 512 },
          { id: 2, stream: 'future_audio', encoding: 'ndjson+gzip', path: '/v1/sessions/11420/chunks/audio-000002.ndjson.gz', seq_start: 6, seq_end: 7, from_ms: BASE, to_ms: BASE + 10_000, record_count: 2, byte_len: 100 },
        ],
        future_server_field: true,
      },
      11420,
      httpDateMs,
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.chunks).toHaveLength(1);
    expect(parsed!.serverNowMs).toBe(httpDateMs);

    expect(parseLiveManifest({ protocol_version: 2, session_key: 11420, captured_from: BASE, status: 'live' }, 11420)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unsupported protocol_version 2'));
    warn.mockRestore();
  });

  it('selects overlapping chunks with excludeChunkIds, skips malformed NDJSON lines (L5), clamps gaps, and validates readLiveFeedClock (H6)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = [
      { id: 1, stream: 'timing' as const, encoding: 'ndjson+gzip', path: '/c1', seqStart: 0, seqEnd: 5, fromMs: BASE, toMs: BASE + 10_000, recordCount: 6, byteLen: 100 },
      { id: 2, stream: 'timing' as const, encoding: 'ndjson+zstd', path: '/c2', seqStart: 6, seqEnd: 10, fromMs: BASE + 10_001, toMs: BASE + 20_000, recordCount: 5, byteLen: 100 },
      { id: 3, stream: 'timing' as const, encoding: 'ndjson+gzip', path: '/c3', seqStart: 11, seqEnd: 15, fromMs: BASE + 20_001, toMs: BASE + 30_000, recordCount: 5, byteLen: 100 },
    ];
    expect(selectOverlappingChunks(chunks, 'timing', BASE + 30_000, null, new Set([1])).map((c) => c.id)).toEqual([3]);

    const badChunk = [
      JSON.stringify({ seq: 0, topic: 'TrackStatus', data: { Status: '1' }, ts: null, snapshot: false, received_at: BASE }),
      '{corrupt-json',
      JSON.stringify({ seq: 1, topic: 'UnknownFutureFeed', data: {}, ts: null, snapshot: false, received_at: BASE + 500 }),
      JSON.stringify({ seq: 2, topic: 'TrackStatus', data: { Status: '2' }, ts: null, snapshot: false, received_at: BASE + 1_000 }),
    ].join('\n');
    expect(parseChunkNdjson(badChunk)).toHaveLength(2);

    expect(
      filterAndClampGaps(
        [{ from: BASE + 3_000, to: BASE + 5_000 }, { from: BASE + 8_000, to: null }],
        BASE,
        BASE + 10_000,
        BASE + 4_000,
      ),
    ).toEqual([{ from: BASE + 3_000, to: BASE + 5_000 }, { from: BASE + 8_000, to: BASE + 10_000 }]);

    // H6: Late-started snapshot returns null; observed false -> true transition returns FeedClock.
    expect(
      readLiveFeedClock([
        { topic: 'ExtrapolatedClock', content: { Utc: utc(1_500_000), Extrapolating: true }, visible_from: BASE + 1_500_000, snapshot: true },
      ]),
    ).toBeNull();
    expect(
      readLiveFeedClock([
        { topic: 'ExtrapolatedClock', content: { Utc: utc(0), Extrapolating: false }, visible_from: BASE, snapshot: true },
        { topic: 'ExtrapolatedClock', content: { Utc: utc(15_000), Extrapolating: true }, visible_from: BASE + 15_000, snapshot: false },
        { topic: 'TimingData', content: {}, visible_from: BASE + 60_000, snapshot: false },
      ]),
    ).toEqual({ feedBaseUtc: BASE, clockStartOffsetMs: 15_000, scheduledStartOffsetMs: null, durationMs: 60_000 });

    // H3: spliceDirectRecords preserves direct snapshots newer than backfillEndMs.
    expect(
      spliceDirectRecords(
        [
          { topic: 'TimingData', data: { snap: true }, snapshot: true, receivedAt: BASE + 101_500 },
          { topic: 'CarData.z', data: { tel: true }, snapshot: true, receivedAt: BASE + 100_000 },
        ],
        BASE + 100_000,
      ).records,
    ).toHaveLength(2);

    expect(
      backfillMetadata([
        { topic: 'SessionInfo', data: { Meeting: { Circuit: { Key: 152 } } }, snapshot: true, receivedAt: BASE },
        { topic: 'SessionData', data: { StatusSeries: [{ Utc: utc(10_000), SessionStatus: 'Started' }] }, receivedAt: BASE + 10_000 },
        { topic: 'Position.z', data: {}, receivedAt: BASE + 15_000 },
      ]),
    ).toEqual({ startedUtc: BASE + 10_000, circuitKey: 152, hasTelemetry: true });

    warn.mockRestore();
  });

  it('returns null without throwing on 404, 500, network failure, malformed body, or empty URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.fn();
    expect(await fetchLiveBackfill('', SESSION_KEY, { untilMs: BASE, fetchImpl: fetchSpy as unknown as typeof fetch })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    const makeFetch = (status: number, body: string) =>
      vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

    expect(await fetchLiveBackfill('https://r2.example.com', SESSION_KEY, { untilMs: BASE, fetchImpl: makeFetch(404, 'nope') })).toBeNull();
    expect(await fetchLiveBackfill('https://r2.example.com', SESSION_KEY, { untilMs: BASE, fetchImpl: makeFetch(500, 'err') })).toBeNull();
    expect(await fetchLiveBackfill('https://r2.example.com', SESSION_KEY, { untilMs: BASE, fetchImpl: makeFetch(200, 'not-json') })).toBeNull();
    expect(
      await fetchLiveBackfill('https://r2.example.com', SESSION_KEY, {
        untilMs: BASE,
        fetchImpl: vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch,
      }),
    ).toBeNull();
    warn.mockRestore();
  });
});

describe('TimingDb optional non-blocking continuous backfill integration', () => {
  let dir: string;
  const stores: TimingStore[] = [];
  const dbs: TimingDb[] = [];

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'omfv-backfill-'));
  });

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const store of stores.splice(0)) store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeStore = (name: string) => {
    const store = new TimingStore(path.join(dir, name));
    stores.push(store);
    return store;
  };

  it('maintains exact pre-backfill status quo when no backfill URL is configured or when ingestor is not running (404)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 1. Unconfigured backfill URL -> immediate ready, no backfill field, pure direct SignalR!
    const store1 = makeStore('no-url.sqlite');
    const h1 = createHarness(store1, { backfillBaseUrl: null });
    dbs.push(h1.db);
    h1.db.open({ year: 2026, sessionKey: SESSION_KEY, meetingKey: MEETING_KEY, sessionType: 'race' }, true);
    h1.pushDirect([{ topic: 'TimingData', data: { Lines: { '1': { NumberOfLaps: 10, Line: 2 } } }, snapshot: true, receivedAt: BASE + 500_000 }]);
    const ready1 = await h1.waitForReady();
    expect(ready1.backfill).toBeUndefined();
    await new Promise((r) => setTimeout(r, 30));
    expect(store1.sql(SESSION_KEY, BASE + 500_000, 'SELECT lap_number FROM laps').rows).toEqual([{ lap_number: 11 }]);

    // 2. Configured backfill URL, but ingestor was NOT run for this session (404) ->
    //    live session STILL becomes ready immediately and marks backfill: 'unavailable'!
    const server404 = await startMockStaticR2Server({
      sessionKey: SESSION_KEY,
      meetingKey: MEETING_KEY,
      initiallyMissing: true,
    });
    try {
      const store2 = makeStore('missing-404.sqlite');
      const h2 = createHarness(store2, { backfillBaseUrl: server404.baseUrl, backfillPollMs: 40 });
      dbs.push(h2.db);
      h2.db.open({ year: 2026, sessionKey: SESSION_KEY, meetingKey: MEETING_KEY, sessionType: 'race' }, true);
      h2.pushDirect([{ topic: 'TimingData', data: { Lines: { '1': { NumberOfLaps: 12, Line: 1 } } }, snapshot: true, receivedAt: BASE + 600_000 }]);
      const ready2 = await h2.waitForReady();
      expect(ready2.state).toBe('ready');
      const unavail = await h2.waitForStatus((s) => s.backfill?.state === 'unavailable');
      expect(unavail.backfill?.state).toBe('unavailable');
      expect(store2.sql(SESSION_KEY, BASE + 600_000, 'SELECT lap_number FROM laps').rows).toEqual([{ lap_number: 13 }]);
    } finally {
      warn.mockRestore();
      await server404.close();
    }
  });

  it('starts live immediately without blocking on a hung manifest, then continuously catches up until chunks cover >= T1', async () => {
    const parts = sampleSessionChunks();
    let releaseManifest!: () => void;
    const manifestGate = new Promise<void>((resolve) => {
      releaseManifest = resolve;
    });
    let manifestBlocked = true;

    const server = await startMockStaticR2Server({
      sessionKey: SESSION_KEY,
      meetingKey: MEETING_KEY,
      status: 'live',
      chunks: parts.initialChunks,
      beforeRespond: async (pathname) => {
        if (manifestBlocked && pathname.endsWith('/manifest.json')) {
          manifestBlocked = false;
          await manifestGate;
        }
      },
    });
    try {
      const store = makeStore('continuous-catchup.sqlite');
      const h = createHarness(store, {
        backfillBaseUrl: server.baseUrl,
        clientVersion: '0.1.0-e2e',
        backfillPollMs: 40,
        fetchSync: async () => ({ sessionStartSec: null, sessionStartPdtMs: BASE + 17_600 }),
      });
      dbs.push(h.db);

      // Join live at T1 = BASE + 283_000 while manifest is completely hung!
      h.db.open({ year: 2026, sessionKey: SESSION_KEY, meetingKey: MEETING_KEY, sessionType: 'race' }, true);
      h.pushDirect([
        { topic: 'SessionInfo', data: { Key: SESSION_KEY, Type: 'Race', Meeting: { Key: MEETING_KEY, Circuit: { Key: 152 } } }, snapshot: true, receivedAt: BASE + 283_000 },
        { topic: 'TimingData', data: { Lines: { '1': { NumberOfLaps: 3, Line: 1 } } }, snapshot: true, receivedAt: BASE + 283_000 },
        { topic: 'TimingData', data: { Lines: { '1': { NumberOfLaps: 4, Line: 1 } } }, ts: utc(370_000), receivedAt: BASE + 370_000 },
        {
          topic: 'CarData.z',
          data: { Entries: [{ Utc: utc(282_500), Cars: { '1': { Channels: { '0': 11900, '2': 325, '3': 8, '4': 100, '5': 0 } } } }] },
          ts: utc(283_000),
          snapshot: true,
          receivedAt: BASE + 283_000,
        },
      ]);

      // 1. Live session becomes READY immediately even while manifestGate is still held!
      const firstReady = await h.waitForReady();
      expect(firstReady.backfill?.state).toBe('catching-up');
      await new Promise((r) => setTimeout(r, 30));
      // Direct live data is already queryable!
      expect(store.sql(SESSION_KEY, BASE + 282_500, 'SELECT speed FROM car_data').rows).toEqual([{ speed: 325 }]);

      // 2. Release manifest gate -> initial chunks (up to BASE + 191_000 < T1) merge atomically, still catching-up!
      releaseManifest();
      await h.waitForStatus(
        (s) =>
          s.backfill?.state === 'catching-up' &&
          s.backfill.backfilledTo !== null &&
          s.coverage?.capturedFrom === BASE,
      );
      expect(store.sql(SESSION_KEY, BASE + 195_000, 'SELECT lap_number, lap_duration FROM laps ORDER BY lap_number').rows).toEqual([
        { lap_number: 1, lap_duration: 90 },
        { lap_number: 2, lap_duration: 89.5 },
        { lap_number: 3, lap_duration: null },
      ]);
      expect(store.sql(SESSION_KEY, BASE + 100_500, 'SELECT speed FROM car_data').rows).toEqual([{ speed: 312 }]);

      // 3. Ingestor publishes the seam chunks covering (191_000 .. 290_000] >= T1 ->
      //    continuous retry pulls ONLY the new chunks, closes the seam losslessly, and marks backfill: 'complete'!
      const reqCountBeforeSeam = server.requests.length;
      server.addChunk(parts.seamTimingChunk);
      server.addChunk(parts.seamTelemetryChunk);

      const doneStatus = await h.waitForStatus((s) => s.backfill?.state === 'complete');
      expect(doneStatus.backfill?.state).toBe('complete');
      expect(doneStatus.coverage?.capturedFrom).toBe(BASE);

      // Verify zero duplicate fetches of already-downloaded chunks 1..4!
      const postSeamChunkPaths = server.requests
        .slice(reqCountBeforeSeam)
        .filter((r) => r.pathname.includes('/chunks/'))
        .map((r) => r.pathname);
      expect(postSeamChunkPaths.some((p) => p.includes('timing-000001'))).toBe(false);
      expect(postSeamChunkPaths.some((p) => p.includes('timing-000005'))).toBe(true);
      expect(postSeamChunkPaths.some((p) => p.includes('telemetry-000006'))).toBe(true);

      // Full lossless race history (laps 1..5 including lap 3's 88.8s from seam chunk + lap 4/5 from direct live)!
      expect(store.sql(SESSION_KEY, BASE + 370_000, 'SELECT lap_number, lap_duration FROM laps ORDER BY lap_number').rows).toEqual([
        { lap_number: 1, lap_duration: 90 },
        { lap_number: 2, lap_duration: 89.5 },
        { lap_number: 3, lap_duration: 88.8 },
        { lap_number: 4, lap_duration: null },
        { lap_number: 5, lap_duration: null },
      ]);
      // Telemetry spoiler-gating: 333 km/h at BASE + 290_000 (> T1) is NOT backfilled from seam chunk!
      expect(store.sql(SESSION_KEY, BASE + 295_000, 'SELECT speed FROM car_data ORDER BY date').rows).toEqual([
        { speed: 312 },
        { speed: 320 },
        { speed: 325 },
      ]);
      // Circuit & liveLeadMs derived cleanly.
      expect(h.circuits.some((c) => (c.circuit as { state?: string })?.state === 'ready')).toBe(true);
      expect(doneStatus.liveLeadMs).toBe(7_600);
      expect(server.requests.every((r) => r.clientVersion === '0.1.0-e2e')).toBe(true);
    } finally {
      releaseManifest();
      await server.close();
    }
  });

  it('falls back to finished R2 chunks on VOD replay when F1 archive is missing and prevents wrong-session SignalR (H5)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parts = sampleSessionChunks();
    const timingWithClock: MockChunkSpec = {
      ...parts.initialChunks[0],
      records: [
        parts.initialChunks[0].records[0],
        { seq: 998, topic: 'ExtrapolatedClock', data: { Utc: utc(1_000), Extrapolating: false }, ts: utc(1_000), snapshot: true, received_at: BASE + 1_000 },
        { seq: 999, topic: 'ExtrapolatedClock', data: { Utc: utc(12_000), Extrapolating: true }, ts: utc(12_000), snapshot: false, received_at: BASE + 12_000 },
        ...parts.initialChunks[0].records.slice(1),
      ],
    };
    const server = await startMockStaticR2Server({
      sessionKey: SESSION_KEY,
      meetingKey: MEETING_KEY,
      status: 'finished',
      chunks: [timingWithClock, parts.initialChunks[1]],
    });
    try {
      const store = makeStore('vod-r2-fallback.sqlite');
      const h = createHarness(store, {
        backfillBaseUrl: server.baseUrl,
        fetchSync: async () => ({ sessionStartSec: 510, sessionStartPdtMs: null }),
      });
      dbs.push(h.db);

      h.db.open({ year: 2026, sessionKey: SESSION_KEY, meetingKey: MEETING_KEY, sessionType: 'race' }, false);
      const ready = await h.waitForReady();
      expect(h.isLiveConnected()).toBe(false);
      expect(ready.clock?.feedBaseUtc).toBe(BASE);
      expect(ready.clock?.clockStartOffsetMs).toBe(12_000);
      expect(ready.sessionStartSec).toBe(510);

      await h.waitForStatus((s) => s.state === 'ready' && s.coverage?.datasets.telemetry.state === 'partial');
      expect(store.sql(SESSION_KEY, BASE + 120_000, 'SELECT speed FROM car_data').rows).toEqual([{ speed: 312 }]);

      // H5: Live open disconnects and drops records if direct SignalR broadcasts a different sessionKey.
      const store2 = makeStore('wrong-session.sqlite');
      const h2 = createHarness(store2, { backfillBaseUrl: null });
      dbs.push(h2.db);
      h2.db.open({ year: 2026, sessionKey: SESSION_KEY, meetingKey: MEETING_KEY, sessionType: 'race' }, true);
      h2.pushDirect([
        { topic: 'SessionInfo', data: { Key: 99999, Type: 'Qualifying' }, snapshot: true, receivedAt: BASE },
        { topic: 'TimingData', data: { Lines: { '1': { NumberOfLaps: 50, Line: 1 } } }, receivedAt: BASE + 1_000 },
      ]);
      await new Promise((r) => setTimeout(r, 60));
      expect(h2.isLiveDisconnected()).toBe(true);
      expect(store2.sql(SESSION_KEY, BASE + 5_000, 'SELECT * FROM laps').rows).toEqual([]);
    } finally {
      warn.mockRestore();
      await server.close();
    }
  });
});
