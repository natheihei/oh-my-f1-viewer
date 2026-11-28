/**
 * Fetches captured historical live records from static v1 manifest + immutable gzipped chunks
 * (hosted directly on Cloudflare R2 or any static HTTP/CDN server). Pure over `fetch` and
 * `Settings`: holds no database connection and never throws on network or parse errors.
 */
import zlib from 'node:zlib';
import type { LiveRecord } from './ingest';
import { LIVE_FEEDS, TELEMETRY_FEEDS } from './processors';
import { startedAt } from './sync';

export const BACKFILL_PROTOCOL_VERSION = 1;
export const SUPPORTED_CHUNK_ENCODING = 'ndjson+gzip';
/** Default public static backfill host (Cloudflare R2 custom domain). */
export const DEFAULT_REPLAY_URL = 'https://replay.oh-my-f1-viewer.yueyao.run';
export const DEFAULT_BACKFILL_TIMEOUT_MS = 10_000;
export const DEFAULT_CHUNK_CONCURRENCY = 12;
/** Longer than this between the end of backfill and the first direct record counts as a gap. */
export const SPLICE_GAP_THRESHOLD_MS = 5_000;
/** Safety limits to prevent OOM / gzip-bomb attacks from untrusted responses (M1). */
export const MAX_COMPRESSED_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_DECOMPRESSED_RESPONSE_BYTES = 32 * 1024 * 1024;

export type LiveBackfillStream = 'timing' | 'telemetry' | 'all';

export interface LiveBackfillGap {
  from: number;
  to: number | null;
}

export interface LiveBackfillChunk {
  id: number;
  stream: 'timing' | 'telemetry';
  encoding: string;
  path: string;
  seqStart: number;
  seqEnd: number;
  fromMs: number;
  toMs: number;
  recordCount: number;
  byteLen: number;
}

export interface LiveBackfillManifest {
  protocolVersion: number;
  sessionKey: number;
  meetingKey: number | null;
  sessionName: string | null;
  sessionType: string | null;
  meetingName: string | null;
  status: 'live' | 'finished';
  capturedFrom: number;
  lastReceivedAt: number;
  lastSeq: number;
  recordCount: number;
  hasTelemetry: boolean;
  gaps: LiveBackfillGap[];
  chunks: LiveBackfillChunk[];
  updatedAt: number | null;
  /** From JSON `server_now_ms` if present, else parsed from HTTP `Date` response header. */
  serverNowMs: number | null;
}

export interface LiveBackfillMeta {
  sessionKey: number;
  meetingKey: number | null;
  sessionName: string | null;
  sessionType: string | null;
  meetingName: string | null;
  status: 'live' | 'finished' | null;
  capturedFrom: number;
  fromMs: number | null;
  untilMs: number | null;
  lastReceivedAt: number | null;
  lastSeq: number | null;
  recordCount: number;
  hasTelemetry: boolean;
  gaps: LiveBackfillGap[];
  fetchedChunkIds: number[];
  serverNowMs: number | null;
}

export interface LiveBackfillSnapshot {
  meta: LiveBackfillMeta;
  records: LiveRecord[];
}

export interface LiveManifestOptions {
  timeoutMs?: number;
  clientVersion?: string;
  /** Suppress console warnings on HTTP 404 (used during quiet continuous background polling). */
  silent404?: boolean;
  fetchImpl?: typeof fetch;
}

export interface LiveStreamBackfillOptions {
  stream: LiveBackfillStream;
  untilMs: number;
  afterMs?: number | null;
  /** Chunk IDs already downloaded in earlier background catch-up passes. */
  excludeChunkIds?: ReadonlySet<number>;
  timeoutMs?: number;
  concurrency?: number;
  clientVersion?: string;
  fetchImpl?: typeof fetch;
  /**
   * Optional per-chunk batch consumer (M3). When provided, filtered records are delivered
   * incrementally as each chunk finishes instead of buffered in memory (returning `records: []`).
   */
  onBatch?: (records: LiveRecord[]) => Promise<void> | void;
}

export interface LiveBackfillOptions {
  untilMs: number;
  afterMs?: number | null;
  stream?: LiveBackfillStream;
  telemetry?: boolean;
  excludeChunkIds?: ReadonlySet<number>;
  timeoutMs?: number;
  concurrency?: number;
  clientVersion?: string;
  fetchImpl?: typeof fetch;
  onBatch?: (records: LiveRecord[]) => Promise<void> | void;
}

export interface SpliceResult {
  records: LiveRecord[];
  gap: { from: number; to: number } | null;
}

interface SequencedRecord {
  seq: number;
  record: LiveRecord;
}

const KNOWN_LIVE_FEEDS: ReadonlySet<string> = new Set(LIVE_FEEDS);
const TELEMETRY_FEED_SET: ReadonlySet<string> = new Set(TELEMETRY_FEEDS);

const isTelemetryTopic = (topic: string): boolean => TELEMETRY_FEED_SET.has(topic);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finiteNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nullableString = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

function requestHeaders(accept: string, clientVersion?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    'Accept-Encoding': 'gzip',
  };
  const version = clientVersion?.trim();
  if (version) headers['X-OMFV-Client-Version'] = version;
  return headers;
}

function assertSameOrigin(baseOrigin: string, resUrl: string | undefined): void {
  if (!resUrl) return;
  const parsed = new URL(resUrl);
  if (parsed.origin !== baseOrigin) {
    throw new Error(`cross-origin redirect blocked: ${parsed.origin} !== ${baseOrigin}`);
  }
}

function parseConfiguredUrl(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === false) return null;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || lower === '0' || lower === 'false' || lower === 'off' || lower === 'none') {
    return null;
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * Resolves the configured live backfill base URL (R2 custom domain or static host). Checks
 * `OMFV_REPLAY_URL`, then `OMFV_LIVE_SERVER_URL`, falling back to `replayUrl` then `liveServerUrl`
 * in app settings, and finally `DEFAULT_REPLAY_URL`. Set any of those to `""` / `"off"` (or `false`
 * / `null` in settings) to explicitly disable backfill.
 */
export function resolveLiveServerUrl(
  env: Record<string, string | undefined> = process.env,
  settings?: { get(key: string): unknown },
): string | null {
  for (const candidate of [
    env.OMFV_REPLAY_URL,
    env.OMFV_LIVE_SERVER_URL,
    settings?.get('replayUrl'),
    settings?.get('liveServerUrl'),
  ]) {
    const parsed = parseConfiguredUrl(candidate);
    if (parsed !== undefined) return parsed;
  }
  return DEFAULT_REPLAY_URL;
}

/** Builds the static v1 session manifest URL (`{baseUrl}/v1/sessions/{sessionKey}/manifest.json`). */
export function buildManifestUrl(baseUrl: string, sessionKey: number): string {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  return `${clean}/v1/sessions/${encodeURIComponent(String(sessionKey))}/manifest.json`;
}

/**
 * Resolves a manifest `chunk.path` against `baseUrl`, enforcing same-origin to prevent SSRF (M1).
 */
export function resolveChunkUrl(baseUrl: string, chunkPath: string): string {
  const clean = normalizeUrl(baseUrl);
  if (!clean) throw new Error('invalid backfill base URL');
  const trimmedPath = chunkPath.trim();
  if (!trimmedPath) throw new Error('empty chunk path');
  const base = new URL(`${clean}/`);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error(`unsupported backfill base protocol: ${base.protocol}`);
  }
  const resolved = new URL(trimmedPath, base);
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new Error(`unsupported chunk URL protocol: ${resolved.protocol}`);
  }
  if (resolved.origin !== base.origin) {
    throw new Error(`chunk URL origin ${resolved.origin} does not match backfill server origin ${base.origin}`);
  }
  if (resolved.username || resolved.password) {
    throw new Error('chunk URL must not contain credentials');
  }
  return resolved.toString();
}

function parseGaps(raw: unknown): LiveBackfillGap[] {
  if (!Array.isArray(raw)) return [];
  const gaps: LiveBackfillGap[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const from = finiteNumber(item.from);
    if (from === null) continue;
    const to = item.to === null || item.to === undefined ? null : finiteNumber(item.to);
    if (item.to !== null && item.to !== undefined && to === null) continue;
    gaps.push({ from, to });
  }
  return gaps;
}

/**
 * Filters and clamps server-reported gaps to `[capturedFrom, untilMs]`, dropping gaps that ended
 * at or before `afterMs` or start after `untilMs`.
 */
export function filterAndClampGaps(
  gaps: readonly LiveBackfillGap[],
  capturedFrom: number,
  untilMs: number,
  afterMs: number | null = null,
): LiveBackfillGap[] {
  const out: LiveBackfillGap[] = [];
  for (const gap of gaps) {
    if (gap.from > untilMs) continue;
    if (gap.to !== null && gap.to < capturedFrom) continue;
    if (afterMs !== null && gap.to !== null && gap.to <= afterMs) continue;
    const from = Math.max(gap.from, capturedFrom);
    const to = gap.to === null || gap.to > untilMs ? untilMs : gap.to;
    if (to <= from) continue;
    out.push({ from, to });
  }
  return out;
}

/**
 * Parses a v1 `SessionManifest` JSON payload tolerantly (ignoring unknown extra fields and
 * unknown chunk streams). Returns `null` with a clear warning if `protocol_version !== 1` so the
 * client falls back cleanly to the direct F1 live feed; throws on malformed payloads.
 */
export function parseLiveManifest(
  raw: unknown,
  expectedSessionKey?: number,
  httpDateMs: number | null = null,
): LiveBackfillManifest | null {
  if (!isRecord(raw)) throw new Error('manifest response is not a JSON object');
  const protocolVersion = finiteNumber(raw.protocol_version);
  if (protocolVersion !== BACKFILL_PROTOCOL_VERSION) {
    console.warn(
      `[timingdb] live backfill: unsupported protocol_version ${String(raw.protocol_version)} (expected ${BACKFILL_PROTOCOL_VERSION}); falling back to direct F1 live feed`,
    );
    return null;
  }

  const sessionKey = finiteNumber(raw.session_key);
  const capturedFrom = finiteNumber(raw.captured_from);
  if (sessionKey === null || capturedFrom === null) {
    throw new Error('manifest missing session_key or captured_from');
  }
  if (expectedSessionKey !== undefined && sessionKey !== expectedSessionKey) {
    throw new Error(`manifest session_key ${sessionKey} does not match requested ${expectedSessionKey}`);
  }
  if (raw.status !== 'live' && raw.status !== 'finished') {
    throw new Error(`manifest has invalid status: ${String(raw.status)}`);
  }

  const chunks: LiveBackfillChunk[] = [];
  if (Array.isArray(raw.chunks)) {
    for (const item of raw.chunks) {
      if (!isRecord(item)) continue;
      if (item.stream !== 'timing' && item.stream !== 'telemetry') continue;
      const id = finiteNumber(item.id);
      const seqStart = finiteNumber(item.seq_start);
      const seqEnd = finiteNumber(item.seq_end);
      const fromMs = finiteNumber(item.from_ms);
      const toMs = finiteNumber(item.to_ms);
      const encoding = typeof item.encoding === 'string' ? item.encoding : '';
      const chunkPath = typeof item.path === 'string' ? item.path.trim() : '';
      if (id === null || seqStart === null || seqEnd === null || fromMs === null || toMs === null || !encoding || !chunkPath) {
        continue;
      }
      chunks.push({
        id,
        stream: item.stream,
        encoding,
        path: chunkPath,
        seqStart,
        seqEnd,
        fromMs,
        toMs,
        recordCount: finiteNumber(item.record_count) ?? 0,
        byteLen: finiteNumber(item.byte_len) ?? 0,
      });
    }
  }

  return {
    protocolVersion,
    sessionKey,
    meetingKey: finiteNumber(raw.meeting_key),
    sessionName: nullableString(raw.session_name),
    sessionType: nullableString(raw.session_type),
    meetingName: nullableString(raw.meeting_name),
    status: raw.status,
    capturedFrom,
    lastReceivedAt: finiteNumber(raw.last_received_at) ?? capturedFrom,
    lastSeq: finiteNumber(raw.last_seq) ?? -1,
    recordCount: finiteNumber(raw.record_count) ?? 0,
    hasTelemetry: raw.has_telemetry === true,
    gaps: parseGaps(raw.gaps),
    chunks,
    updatedAt: finiteNumber(raw.updated_at),
    serverNowMs: finiteNumber(raw.server_now_ms) ?? httpDateMs,
  };
}

/** Selects chunks matching `stream` that overlap `(afterMs, untilMs]`, skipping unsupported encodings or excluded IDs. */
export function selectOverlappingChunks(
  chunks: readonly LiveBackfillChunk[],
  stream: LiveBackfillStream,
  untilMs: number,
  afterMs: number | null = null,
  excludeChunkIds?: ReadonlySet<number>,
): LiveBackfillChunk[] {
  const selected: LiveBackfillChunk[] = [];
  for (const chunk of chunks) {
    if (stream !== 'all' && chunk.stream !== stream) continue;
    if (excludeChunkIds?.has(chunk.id)) continue;
    if (chunk.fromMs > untilMs) continue;
    if (afterMs !== null && chunk.toMs <= afterMs) continue;
    if (chunk.encoding !== SUPPORTED_CHUNK_ENCODING) {
      console.warn(
        `[timingdb] live backfill: skipping chunk ${chunk.id} (${chunk.path}) with unsupported encoding "${chunk.encoding}"`,
      );
      continue;
    }
    selected.push(chunk);
  }
  return selected;
}

function splitLines(text: string): string[] {
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return cleaned.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function parseSequencedRecord(raw: unknown, lineNumber: number): SequencedRecord | null {
  if (!isRecord(raw) || typeof raw.topic !== 'string' || !('data' in raw)) {
    throw new Error(`malformed backfill record at line ${lineNumber}`);
  }
  const seq = finiteNumber(raw.seq);
  const receivedAt = finiteNumber(raw.received_at);
  if (seq === null || receivedAt === null) {
    throw new Error(`missing seq or received_at at line ${lineNumber}`);
  }
  // Ignore unknown future topics so newer ingestors never bloat older clients' SQLite.
  if (!KNOWN_LIVE_FEEDS.has(raw.topic)) return null;
  const record: LiveRecord = {
    topic: raw.topic,
    data: raw.data,
    receivedAt,
  };
  if (typeof raw.ts === 'string') record.ts = raw.ts;
  if (raw.snapshot === true) record.snapshot = true;
  return { seq, record };
}

/**
 * Parses an immutable chunk's NDJSON body into sequenced `LiveRecord`s (filtering unknown topics
 * and skipping individual malformed lines with a warning instead of failing the whole chunk — L5).
 */
export function parseChunkNdjson(text: string): SequencedRecord[] {
  const lines = splitLines(text);
  const out: SequencedRecord[] = [];
  let badLines = 0;
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = parseSequencedRecord(JSON.parse(lines[i]), i + 1);
      if (parsed) out.push(parsed);
    } catch {
      badLines++;
    }
  }
  if (badLines > 0) {
    console.warn(`[timingdb] live backfill: skipped ${badLines} malformed NDJSON line(s) in chunk`);
  }
  return out;
}

/**
 * Decodes an HTTP response body to UTF-8 text with strict compressed & decompressed size caps
 * to prevent memory exhaustion / gzip bombs (M1).
 */
async function decodeResponseText(
  res: Response,
  maxCompressedBytes = MAX_COMPRESSED_RESPONSE_BYTES,
  maxDecompressedBytes = MAX_DECOMPRESSED_RESPONSE_BYTES,
): Promise<string> {
  const cl = Number(res.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > maxDecompressedBytes) {
    throw new Error(`backfill response too large (${cl} bytes > ${maxDecompressedBytes})`);
  }

  let buf: Buffer;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const parts: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxDecompressedBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`backfill response exceeded ${maxDecompressedBytes} byte limit`);
        }
        parts.push(Buffer.from(value));
      }
    }
    buf = Buffer.concat(parts, total);
  } else {
    buf = Buffer.from(await res.arrayBuffer());
  }

  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    if (buf.byteLength > maxCompressedBytes) {
      throw new Error(`compressed backfill response exceeded ${maxCompressedBytes} byte limit`);
    }
    return zlib.gunzipSync(buf, { maxOutputLength: maxDecompressedBytes }).toString('utf8');
  }
  if (buf.byteLength > maxDecompressedBytes) {
    throw new Error(`backfill response exceeded ${maxDecompressedBytes} byte limit`);
  }
  return buf.toString('utf8');
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function parseHttpDateHeader(res: Response): number | null {
  const raw = res.headers.get('date');
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Fetches `GET {baseUrl}/v1/sessions/{sessionKey}/manifest.json` and parses the v1 manifest.
 * Returns `null` on HTTP 404, non-OK status, unsupported `protocol_version`, network error,
 * timeout, or parse error so the app always falls back cleanly to the direct live feed.
 */
export async function fetchLiveManifest(
  baseUrl: string,
  sessionKey: number,
  options: LiveManifestOptions = {},
): Promise<LiveBackfillManifest | null> {
  const clean = normalizeUrl(baseUrl);
  if (!clean) return null;
  const url = buildManifestUrl(clean, sessionKey);
  const baseOrigin = new URL(`${clean}/`).origin;
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_BACKFILL_TIMEOUT_MS;
  try {
    const res = await fetchFn(url, {
      headers: requestHeaders('application/json', options.clientVersion),
      signal: AbortSignal.timeout(timeoutMs),
    });
    assertSameOrigin(baseOrigin, res.url);
    if (res.status === 404) {
      if (!options.silent404) {
        console.warn(`[timingdb] live backfill: session ${sessionKey} not found on ${clean} (HTTP 404)`);
      }
      return null;
    }
    if (!res.ok) {
      console.warn(`[timingdb] live backfill: ${url} answered HTTP ${res.status}`);
      return null;
    }
    const httpDateMs = parseHttpDateHeader(res);
    const text = await decodeResponseText(res);
    return parseLiveManifest(JSON.parse(text), sessionKey, httpDateMs);
  } catch (e) {
    console.warn('[timingdb] live backfill manifest:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Fetches all un-fetched overlapping immutable chunks for a single stream (`timing`, `telemetry`,
 * or `all`) over `(afterMs, untilMs]` in parallel (default concurrency 12).
 * Supports optional `onBatch` per-chunk streaming (M3) so background telemetry does not accumulate
 * the entire race in Electron main RAM.
 */
export async function fetchLiveStreamBackfill(
  baseUrl: string,
  manifest: LiveBackfillManifest,
  options: LiveStreamBackfillOptions,
): Promise<LiveBackfillSnapshot | null> {
  const clean = normalizeUrl(baseUrl);
  if (!clean) return null;
  const baseOrigin = new URL(`${clean}/`).origin;
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_BACKFILL_TIMEOUT_MS;
  const concurrency = options.concurrency ?? DEFAULT_CHUNK_CONCURRENCY;
  const afterMs = options.afterMs != null && Number.isFinite(options.afterMs) ? options.afterMs : null;
  const { stream, untilMs, clientVersion, onBatch, excludeChunkIds } = options;

  const chunks = selectOverlappingChunks(manifest.chunks, stream, untilMs, afterMs, excludeChunkIds);

  try {
    const seenSeqs = new Set<number>();
    const bySeq = new Map<number, SequencedRecord>();
    const fetchedChunkIds: number[] = [];
    let streamedCount = 0;
    let streamedFromMs: number | null = null;
    let streamedLastMs: number | null = null;
    let streamedLastSeq: number | null = null;
    let streamedHasTelemetry = false;
    let batchChain: Promise<void> = Promise.resolve();

    const matchesWindow = (item: SequencedRecord): boolean => {
      const { receivedAt, topic } = item.record;
      if (receivedAt > untilMs) return false;
      if (afterMs !== null && receivedAt <= afterMs) return false;
      if (stream !== 'all' && isTelemetryTopic(topic) !== (stream === 'telemetry')) return false;
      return true;
    };

    const emitBatch = async (items: readonly SequencedRecord[]): Promise<void> => {
      if (!onBatch) {
        for (const item of items) {
          if (!matchesWindow(item)) continue;
          if (!bySeq.has(item.seq)) bySeq.set(item.seq, item);
        }
        return;
      }
      const fresh: SequencedRecord[] = [];
      for (const item of items) {
        if (!matchesWindow(item)) continue;
        if (seenSeqs.has(item.seq)) continue;
        seenSeqs.add(item.seq);
        fresh.push(item);
      }
      if (fresh.length === 0) return;
      fresh.sort((a, b) => a.seq - b.seq || a.record.receivedAt - b.record.receivedAt);
      const recs = fresh.map((item) => item.record);
      for (const item of fresh) {
        streamedCount++;
        const ts = item.record.receivedAt;
        if (streamedFromMs === null || ts < streamedFromMs) streamedFromMs = ts;
        if (streamedLastMs === null || ts > streamedLastMs) streamedLastMs = ts;
        if (streamedLastSeq === null || item.seq > streamedLastSeq) streamedLastSeq = item.seq;
        if (!streamedHasTelemetry && isTelemetryTopic(item.record.topic)) streamedHasTelemetry = true;
      }
      batchChain = batchChain.then(() => onBatch(recs));
      await batchChain;
    };

    const chunkResults = await mapWithConcurrency(chunks, concurrency, async (chunk) => {
      const url = resolveChunkUrl(clean, chunk.path);
      const res = await fetchFn(url, {
        headers: requestHeaders('application/x-ndjson', clientVersion),
        signal: AbortSignal.timeout(timeoutMs),
      });
      assertSameOrigin(baseOrigin, res.url);
      if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
      const text = await decodeResponseText(res);
      const items = parseChunkNdjson(text);
      fetchedChunkIds.push(chunk.id);
      if (onBatch) {
        await emitBatch(items);
        return [] as SequencedRecord[];
      }
      return items;
    });

    if (!onBatch) {
      for (const batch of chunkResults) {
        await emitBatch(batch);
      }
    }
    await batchChain;

    const gaps = filterAndClampGaps(manifest.gaps, manifest.capturedFrom, untilMs, afterMs);

    if (onBatch) {
      return {
        meta: {
          sessionKey: manifest.sessionKey,
          meetingKey: manifest.meetingKey,
          sessionName: manifest.sessionName,
          sessionType: manifest.sessionType,
          meetingName: manifest.meetingName,
          status: manifest.status,
          capturedFrom: manifest.capturedFrom,
          fromMs: streamedFromMs,
          untilMs,
          lastReceivedAt: streamedLastMs,
          lastSeq: streamedLastSeq,
          recordCount: streamedCount,
          hasTelemetry: streamedHasTelemetry,
          gaps,
          fetchedChunkIds,
          serverNowMs: manifest.serverNowMs,
        },
        records: [],
      };
    }

    const sorted = [...bySeq.values()].sort((a, b) => a.seq - b.seq || a.record.receivedAt - b.record.receivedAt);
    const records = sorted.map((item) => item.record);

    return {
      meta: {
        sessionKey: manifest.sessionKey,
        meetingKey: manifest.meetingKey,
        sessionName: manifest.sessionName,
        sessionType: manifest.sessionType,
        meetingName: manifest.meetingName,
        status: manifest.status,
        capturedFrom: manifest.capturedFrom,
        fromMs: records[0]?.receivedAt ?? null,
        untilMs,
        lastReceivedAt: records.at(-1)?.receivedAt ?? null,
        lastSeq: sorted.at(-1)?.seq ?? null,
        recordCount: records.length,
        hasTelemetry: records.some((r) => isTelemetryTopic(r.topic)),
        gaps,
        fetchedChunkIds,
        serverNowMs: manifest.serverNowMs,
      },
      records,
    };
  } catch (e) {
    console.warn(`[timingdb] live backfill (${stream}):`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Convenience wrapper that fetches the v1 manifest and then pulls overlapping chunks for the
 * requested stream (`timing`, `telemetry`, or `all`).
 */
export async function fetchLiveBackfill(
  baseUrl: string,
  sessionKey: number,
  options: LiveBackfillOptions,
): Promise<LiveBackfillSnapshot | null> {
  const manifest = await fetchLiveManifest(baseUrl, sessionKey, options);
  if (!manifest) return null;
  const stream: LiveBackfillStream = options.stream ?? (options.telemetry === false ? 'timing' : 'all');
  return fetchLiveStreamBackfill(baseUrl, manifest, { ...options, stream });
}

/**
 * Splices buffered direct F1 SignalR records onto the end of a timing backfill (`backfillEndMs`).
 */
export function spliceDirectRecords(
  buffer: readonly LiveRecord[],
  backfillEndMs: number,
  gapThresholdMs = SPLICE_GAP_THRESHOLD_MS,
): SpliceResult {
  if (buffer.length === 0) return { records: [], gap: null };
  let firstDirectMs = Infinity;
  for (const record of buffer) {
    if (record.receivedAt < firstDirectMs) firstDirectMs = record.receivedAt;
  }
  const hasGap = firstDirectMs - backfillEndMs > gapThresholdMs;
  const gap = hasGap ? { from: backfillEndMs, to: firstDirectMs } : null;
  const records = buffer.filter((record) => {
    if (isTelemetryTopic(record.topic)) return record.receivedAt >= backfillEndMs;
    return record.receivedAt > backfillEndMs;
  });
  return { records, gap };
}

/** Extracts session start time, circuit key, and telemetry presence from backfilled records. */
export function backfillMetadata(records: readonly LiveRecord[]): {
  startedUtc: number | null;
  circuitKey: number | null;
  hasTelemetry: boolean;
} {
  let startedUtc: number | null = null;
  let circuitKey: number | null = null;
  let hasTelemetry = false;
  for (const record of records) {
    if (record.topic === 'SessionData') {
      const at = startedAt(record.data);
      if (at !== null && (startedUtc === null || at < startedUtc)) startedUtc = at;
    } else if (record.topic === 'SessionInfo' && circuitKey === null) {
      const key = Number((record.data as { Meeting?: { Circuit?: { Key?: unknown } } })?.Meeting?.Circuit?.Key);
      if (key > 0) circuitKey = key;
    } else if (!hasTelemetry && isTelemetryTopic(record.topic)) {
      hasTelemetry = true;
    }
  }
  return { startedUtc, circuitKey, hasTelemetry };
}
