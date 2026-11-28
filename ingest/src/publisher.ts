/**
 * Direct-to-R2 / local-dir chunk publisher for omfv-live-ingest.
 *
 * Buffers timing and telemetry records locally in memory, seals immutable gzipped NDJSON chunks
 * every `chunkIntervalMs` (default 30s, configurable at startup) or size/record threshold, and
 * atomically updates `v1/sessions/{key}/manifest.json` using ETag conditional PUT (`If-Match` /
 * `If-None-Match`) with single-writer lease protection (`writer_id` + `lease_expires_at`).
 */

import { randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { extractSessionInfo, isSessionFinishedData } from './protocol.js';
import {
  FatalStorageError,
  PreconditionFailedError,
  type ObjectStore,
} from './storage.js';
import {
  CHUNK_ENCODING,
  COMPRESSED_FEEDS,
  PROTOCOL_VERSION,
  SESSIONS_INDEX_KEY,
  chunkObjectKey,
  chunkPublicPath,
  formatChunkFilename,
  manifestObjectKey,
  streamForTopic,
  toSessionSummary,
  type ChunkMeta,
  type Gap,
  type GapEvent,
  type LeaseConflictDetail,
  type LiveRecord,
  type ParsedLiveRecord,
  type SessionManifest,
  type SessionMetaUpdate,
  type SessionsIndex,
  type StreamKind,
} from './types.js';

export const PUBLISHER_DEFAULTS = {
  chunkIntervalMs: 30_000,
  chunkMaxRecords: 2_000,
  chunkMaxBytes: 2 * 1024 * 1024, // 2 MiB uncompressed NDJSON per chunk
  maxPendingRecords: 50_000,
  maxPendingBytes: 32 * 1024 * 1024, // 32 MiB cap during prolonged outage
  liveCheckGraceMs: 500,
  retryBaseMs: 1_000,
  retryMaxMs: 30_000,
  maxPreSessionBuffer: 5_000,
  writerRestartGapMs: 5_000,
  indexThrottleMs: 30_000,
} as const;

export interface PublisherStats {
  writerId: string;
  sessionKey: number | null;
  lastSeq: number | null;
  pendingTimingRecords: number;
  pendingTelemetryRecords: number;
  totalPublishedRecords: number;
  totalPublishedChunks: number;
  droppedRecords: number;
  consecutiveFailures: number;
  finished: boolean;
  finishedPublished: boolean;
  leaseConflict: boolean;
  fatalError: string | null;
}

export interface ChunkPublisherOptions {
  store: ObjectStore;
  writerId?: string;
  /** Take over an active writer lease from another ingestor on initial attach. */
  takeover?: boolean;
  /** Ignore an already-Finalised initial Subscribe snapshot and wait for the next live session. */
  waitForLive?: boolean;
  liveCheckGraceMs?: number;
  /** How often (ms) to flush buffered records into immutable chunks (startup configurable). */
  chunkIntervalMs?: number;
  chunkMaxRecords?: number;
  chunkMaxBytes?: number;
  /** Writer lease TTL in manifest.json (defaults to max(60_000, chunkIntervalMs * 3)). */
  leaseTtlMs?: number;
  maxPendingRecords?: number;
  maxPendingBytes?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxPreSessionBuffer?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  onSessionStart?: (sessionKey: number, meta: SessionMetaUpdate) => void;
  onSessionIgnored?: (sessionKey: number, meta: SessionMetaUpdate) => void;
  onChunkPublished?: (sessionKey: number, chunks: ChunkMeta[], manifest: SessionManifest) => void;
  onSessionFinished?: (sessionKey: number) => void;
  onLeaseConflict?: (sessionKey: number, detail: LeaseConflictDetail) => void;
  onFatalError?: (sessionKey: number, message: string) => void;
}

interface BufferedRecord {
  parsed: ParsedLiveRecord;
  receivedAt: number;
  approxBytes: number;
}

interface StreamBuffer {
  records: BufferedRecord[];
  bytes: number;
  firstEnqueuedAt: number | null;
}

interface SessionState {
  sessionKey: number;
  meta: SessionMetaUpdate;
  timing: StreamBuffer;
  telemetry: StreamBuffer;
  pendingGapEvents: GapEvent[];
  finished: boolean;
  finishedPublished: boolean;
  releasePending: boolean;
  pendingLiveCheck: boolean;
  takeoverUsed: boolean;
  manifestLoaded: boolean;
  manifest: SessionManifest | null;
  manifestEtag: string | null;
  nextSeq: number;
  nextChunkId: number;
  lastIndexSyncMs: number;
  overflowWarned: boolean;
}

class LeaseConflictError extends Error {
  constructor(readonly detail: LeaseConflictDetail) {
    super(detail.error);
    this.name = 'LeaseConflictError';
  }
}

function emptyStreamBuffer(): StreamBuffer {
  return { records: [], bytes: 0, firstEnqueuedAt: null };
}

function mergeMeta(prev: SessionMetaUpdate, next: SessionMetaUpdate): SessionMetaUpdate {
  return {
    meeting_key: next.meeting_key ?? prev.meeting_key,
    session_name: next.session_name ?? prev.session_name,
    session_type: next.session_type ?? prev.session_type,
    meeting_name: next.meeting_name ?? prev.meeting_name,
  };
}

function estimateBytes(parsed: ParsedLiveRecord): number {
  try {
    return Buffer.byteLength(JSON.stringify(parsed), 'utf8') + 48;
  } catch {
    return 256;
  }
}

function applyGapEventsToList(gaps: Gap[], events: readonly GapEvent[]): Gap[] {
  const next = gaps.map((g) => ({ ...g }));
  for (const ev of events) {
    if (ev.kind === 'open') {
      const existing = next.find((g) => g.to === null || g.from === ev.at);
      if (!existing) next.push({ from: ev.at, to: null });
    } else if (ev.kind === 'close') {
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i]!.to === null) {
          next[i]!.to = Math.max(next[i]!.from, ev.at);
          break;
        }
      }
    }
  }
  return next;
}

export class ChunkPublisher {
  readonly writerId: string;
  private readonly store: ObjectStore;
  private readonly takeover: boolean;
  private readonly waitForLive: boolean;
  private readonly liveCheckGraceMs: number;
  private readonly chunkIntervalMs: number;
  private readonly chunkMaxRecords: number;
  private readonly chunkMaxBytes: number;
  private readonly leaseTtlMs: number;
  private readonly maxPendingRecords: number;
  private readonly maxPendingBytes: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxPreSessionBuffer: number;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly onSessionStart?: (sessionKey: number, meta: SessionMetaUpdate) => void;
  private readonly onSessionIgnored?: (sessionKey: number, meta: SessionMetaUpdate) => void;
  private readonly onChunkPublished?: (sessionKey: number, chunks: ChunkMeta[], manifest: SessionManifest) => void;
  private readonly onSessionFinished?: (sessionKey: number) => void;
  private readonly onLeaseConflict?: (sessionKey: number, detail: LeaseConflictDetail) => void;
  private readonly onFatalError?: (sessionKey: number, message: string) => void;

  private preSessionBuffer: Array<{ parsed: ParsedLiveRecord; receivedAt: number }> = [];
  private archivedSessions: SessionState[] = [];
  private current: SessionState | null = null;
  private ignoredFinishedSessions = new Set<number>();

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private liveCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<boolean> | null = null;
  private stopped = false;
  private leaseConflict = false;
  private fatalError: string | null = null;

  private lastSeq: number | null = null;
  private consecutiveFailures = 0;
  private totalPublishedRecords = 0;
  private totalPublishedChunks = 0;
  private droppedRecords = 0;

  constructor(options: ChunkPublisherOptions) {
    this.writerId = options.writerId?.trim() || randomUUID();
    this.store = options.store;
    this.takeover = options.takeover === true;
    this.waitForLive = options.waitForLive === true;
    this.liveCheckGraceMs = options.liveCheckGraceMs ?? PUBLISHER_DEFAULTS.liveCheckGraceMs;
    this.chunkIntervalMs = Math.max(1_000, options.chunkIntervalMs ?? PUBLISHER_DEFAULTS.chunkIntervalMs);
    this.chunkMaxRecords = Math.max(1, options.chunkMaxRecords ?? PUBLISHER_DEFAULTS.chunkMaxRecords);
    this.chunkMaxBytes = Math.max(4_096, options.chunkMaxBytes ?? PUBLISHER_DEFAULTS.chunkMaxBytes);
    this.leaseTtlMs = options.leaseTtlMs ?? Math.max(60_000, this.chunkIntervalMs * 3);
    this.maxPendingRecords = Math.max(10, options.maxPendingRecords ?? PUBLISHER_DEFAULTS.maxPendingRecords);
    this.maxPendingBytes = Math.max(16_384, options.maxPendingBytes ?? PUBLISHER_DEFAULTS.maxPendingBytes);
    this.retryBaseMs = options.retryBaseMs ?? PUBLISHER_DEFAULTS.retryBaseMs;
    this.retryMaxMs = options.retryMaxMs ?? PUBLISHER_DEFAULTS.retryMaxMs;
    this.maxPreSessionBuffer = options.maxPreSessionBuffer ?? PUBLISHER_DEFAULTS.maxPreSessionBuffer;
    this.log = options.logger ?? console;
    this.onSessionStart = options.onSessionStart;
    this.onSessionIgnored = options.onSessionIgnored;
    this.onChunkPublished = options.onChunkPublished;
    this.onSessionFinished = options.onSessionFinished;
    this.onLeaseConflict = options.onLeaseConflict;
    this.onFatalError = options.onFatalError;
  }

  private get halted(): boolean {
    return this.leaseConflict || this.fatalError !== null;
  }

  /** Starts the periodic chunk-seal & lease-renewal check timer. Idempotent. */
  start(): void {
    if (this.halted) return;
    this.stopped = false;
    if (this.tickTimer) return;
    const pollMs = Math.min(1_000, Math.max(100, Math.floor(this.chunkIntervalMs / 5)));
    this.tickTimer = setInterval(() => {
      if (this.retryTimer || this.stopped) return;
      if (this.hasDueWork()) {
        void this.flush(false);
      }
    }, pollMs);
  }

  pushRecord(parsed: ParsedLiveRecord, receivedAt = Date.now()): void {
    if (this.halted) return;

    if (parsed.topic === 'SessionInfo') {
      const info = extractSessionInfo(parsed.data);
      if (info) {
        if (this.ignoredFinishedSessions.has(info.sessionKey)) return;
        if (!this.current) {
          const checkLive = this.waitForLive && parsed.snapshot;
          const started = this.initSession(info.sessionKey, info.meta, checkLive);
          this.enqueue(started, parsed, receivedAt);
          this.drainPreSessionBuffer();
          if (!started.pendingLiveCheck) this.maybeTriggerThresholdFlush();
          return;
        }
        if (info.sessionKey !== this.current.sessionKey) {
          this.clearLiveCheckTimer();
          this.current.pendingLiveCheck = false;
          if (!this.current.finished && !this.current.finishedPublished && this.current.manifest) {
            this.current.releasePending = true;
          }
          if (this.sessionHasAnyWork(this.current)) {
            this.archivedSessions.push(this.current);
          }
          const next = this.initSession(info.sessionKey, info.meta, false);
          this.enqueue(next, parsed, receivedAt);
          void this.flush(false);
          return;
        }
        if (this.current.finished || this.current.finishedPublished) return;
        this.current.meta = mergeMeta(this.current.meta, info.meta);
        this.enqueue(this.current, parsed, receivedAt);
        if (!this.current.pendingLiveCheck) this.maybeTriggerThresholdFlush();
        return;
      }
    }

    if (!this.current) {
      if (this.ignoredFinishedSessions.size > 0) return;
      this.preSessionBuffer.push({ parsed, receivedAt });
      if (this.preSessionBuffer.length > this.maxPreSessionBuffer) {
        this.preSessionBuffer.shift();
      }
      return;
    }

    // H4: Drop trailing post-finish frames so finished sessions never reopen.
    if (this.current.finished || this.current.finishedPublished) return;

    const hitFinish = parsed.topic === 'SessionData' && isSessionFinishedData(parsed.data);

    if (this.current.pendingLiveCheck) {
      if (hitFinish && parsed.snapshot) {
        this.discardStaleFinishedSession(this.current);
        return;
      }
      this.enqueue(this.current, parsed, receivedAt);
      if (!parsed.snapshot) {
        this.confirmLiveSession();
        if (hitFinish && !this.current.finished) {
          this.current.finished = true;
          void this.flush(true);
          return;
        }
        this.maybeTriggerThresholdFlush();
      }
      return;
    }

    this.enqueue(this.current, parsed, receivedAt);
    if (hitFinish && !this.current.finished) {
      this.current.finished = true;
      void this.flush(true);
      return;
    }

    this.maybeTriggerThresholdFlush();
  }

  pushGapEvent(event: GapEvent): void {
    if (
      !this.current ||
      this.current.pendingLiveCheck ||
      this.current.finished ||
      this.current.finishedPublished ||
      this.halted
    ) {
      return;
    }
    this.current.pendingGapEvents.push(event);
  }

  getStats(): PublisherStats {
    const active = this.current && !this.current.pendingLiveCheck ? this.current : null;
    return {
      writerId: this.writerId,
      sessionKey: this.current?.sessionKey ?? null,
      lastSeq: this.lastSeq,
      pendingTimingRecords:
        (active?.timing.records.length ?? 0) +
        this.archivedSessions.reduce((s, q) => s + q.timing.records.length, 0),
      pendingTelemetryRecords:
        (active?.telemetry.records.length ?? 0) +
        this.archivedSessions.reduce((s, q) => s + q.telemetry.records.length, 0),
      totalPublishedRecords: this.totalPublishedRecords,
      totalPublishedChunks: this.totalPublishedChunks,
      droppedRecords: this.droppedRecords,
      consecutiveFailures: this.consecutiveFailures,
      finished: this.current?.finished ?? false,
      finishedPublished: this.current?.finishedPublished ?? false,
      leaseConflict: this.leaseConflict,
      fatalError: this.fatalError,
    };
  }

  /**
   * Flushes due chunks (or all buffered chunks when `force = true`).
   * Returns true if no retryable errors occurred.
   */
  flush(force = true): Promise<boolean> {
    if (this.halted) return Promise.resolve(false);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runFlushLoop(force).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Stops timers, flushes all remaining buffered records as final chunks, and clears the writer
   * lease in `manifest.json` so a quick restart can resume immediately.
   */
  async flushAndStop(timeoutMs = 10_000): Promise<boolean> {
    this.stopped = true;
    this.clearTimers();
    if (this.halted) return false;

    if (this.current && !this.current.pendingLiveCheck) {
      if (!this.current.finished && !this.current.finishedPublished) {
        if (this.current.manifest || this.sessionHasAnyWork(this.current)) {
          this.current.releasePending = true;
        }
      }
    }

    const deadline = Date.now() + timeoutMs;
    while (this.hasAnyPendingWork() && Date.now() < deadline && !this.halted) {
      const ok = await this.flush(true);
      if (ok || !this.hasAnyPendingWork() || this.halted) return !this.hasAnyPendingWork();
      const waitMs = Math.min(500, Math.max(50, deadline - Date.now()));
      if (waitMs <= 0) break;
      await new Promise((r) => setTimeout(r, waitMs));
    }
    return !this.hasAnyPendingWork();
  }

  private clearLiveCheckTimer(): void {
    if (this.liveCheckTimer) {
      clearTimeout(this.liveCheckTimer);
      this.liveCheckTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.clearLiveCheckTimer();
  }

  private initSession(sessionKey: number, meta: SessionMetaUpdate, pendingLiveCheck: boolean): SessionState {
    this.clearLiveCheckTimer();
    const state: SessionState = {
      sessionKey,
      meta: { ...meta },
      timing: emptyStreamBuffer(),
      telemetry: emptyStreamBuffer(),
      pendingGapEvents: [],
      finished: false,
      finishedPublished: false,
      releasePending: false,
      pendingLiveCheck,
      takeoverUsed: false,
      manifestLoaded: false,
      manifest: null,
      manifestEtag: null,
      nextSeq: 0,
      nextChunkId: 1,
      lastIndexSyncMs: 0,
      overflowWarned: false,
    };
    this.current = state;
    if (pendingLiveCheck) {
      this.liveCheckTimer = setTimeout(() => {
        this.liveCheckTimer = null;
        this.confirmLiveSession();
      }, this.liveCheckGraceMs);
    } else {
      this.onSessionStart?.(sessionKey, { ...meta });
    }
    return state;
  }

  private confirmLiveSession(): void {
    if (!this.current || !this.current.pendingLiveCheck) return;
    this.clearLiveCheckTimer();
    this.current.pendingLiveCheck = false;
    this.onSessionStart?.(this.current.sessionKey, { ...this.current.meta });
    if (!this.stopped && this.hasDueWork()) {
      void this.flush(false);
    }
  }

  private discardStaleFinishedSession(state: SessionState): void {
    this.clearLiveCheckTimer();
    this.ignoredFinishedSessions.add(state.sessionKey);
    const meta = { ...state.meta };
    this.current = null;
    this.preSessionBuffer = [];
    this.onSessionIgnored?.(state.sessionKey, meta);
  }

  private enqueue(state: SessionState, parsed: ParsedLiveRecord, receivedAt: number): void {
    const stream = streamForTopic(parsed.topic);
    const buf = stream === 'telemetry' ? state.telemetry : state.timing;
    const approxBytes = estimateBytes(parsed);
    if (buf.records.length === 0) buf.firstEnqueuedAt = Date.now();
    buf.records.push({ parsed, receivedAt, approxBytes });
    buf.bytes += approxBytes;
    this.enforceMemoryCaps(state);
  }

  /** M6: Bound memory during prolonged storage outages by shedding oldest telemetry first. */
  private enforceMemoryCaps(state: SessionState): void {
    const totalCount = () => state.timing.records.length + state.telemetry.records.length;
    const totalBytes = () => state.timing.bytes + state.telemetry.bytes;
    if (totalCount() <= this.maxPendingRecords && totalBytes() <= this.maxPendingBytes) return;

    let dropped = 0;
    let droppedTimingFrom = Infinity;
    let droppedTimingTo = -Infinity;

    while (
      state.telemetry.records.length > 0 &&
      (totalCount() > this.maxPendingRecords || totalBytes() > this.maxPendingBytes)
    ) {
      const removed = state.telemetry.records.shift()!;
      state.telemetry.bytes = Math.max(0, state.telemetry.bytes - removed.approxBytes);
      dropped++;
    }

    while (
      state.timing.records.length > 1 &&
      (totalCount() > this.maxPendingRecords || totalBytes() > this.maxPendingBytes)
    ) {
      const removed = state.timing.records.shift()!;
      state.timing.bytes = Math.max(0, state.timing.bytes - removed.approxBytes);
      dropped++;
      if (removed.receivedAt < droppedTimingFrom) droppedTimingFrom = removed.receivedAt;
      if (removed.receivedAt > droppedTimingTo) droppedTimingTo = removed.receivedAt;
    }

    if (dropped > 0) {
      this.droppedRecords += dropped;
      if (Number.isFinite(droppedTimingFrom) && Number.isFinite(droppedTimingTo)) {
        state.pendingGapEvents.push(
          { kind: 'open', at: droppedTimingFrom },
          { kind: 'close', at: droppedTimingTo },
        );
      }
      if (!state.overflowWarned) {
        state.overflowWarned = true;
        this.log.warn(
          `[publisher] Pending buffer for session ${state.sessionKey} hit memory cap; shed ${dropped} oldest record(s) (telemetry prioritized).`,
        );
      }
    }
  }

  private drainPreSessionBuffer(): void {
    if (!this.current || this.preSessionBuffer.length === 0) return;
    const buffered = this.preSessionBuffer;
    this.preSessionBuffer = [];
    for (const item of buffered) {
      const hitFinish = item.parsed.topic === 'SessionData' && isSessionFinishedData(item.parsed.data);
      if (this.current.pendingLiveCheck && hitFinish && item.parsed.snapshot) {
        this.discardStaleFinishedSession(this.current);
        return;
      }
      this.enqueue(this.current, item.parsed, item.receivedAt);
      if (hitFinish) {
        this.current.finished = true;
        break;
      }
    }
  }

  private isStreamDue(buf: StreamBuffer, now: number, force: boolean): boolean {
    if (buf.records.length === 0) return false;
    if (force) return true;
    if (buf.records.length >= this.chunkMaxRecords) return true;
    if (buf.bytes >= this.chunkMaxBytes) return true;
    if (buf.firstEnqueuedAt !== null && now - buf.firstEnqueuedAt >= this.chunkIntervalMs) return true;
    return false;
  }

  private sessionHasAnyWork(state: SessionState): boolean {
    return (
      state.timing.records.length > 0 ||
      state.telemetry.records.length > 0 ||
      state.pendingGapEvents.length > 0 ||
      (state.finished && !state.finishedPublished) ||
      state.releasePending
    );
  }

  private hasAnyPendingWork(): boolean {
    if (this.halted) return false;
    if (this.archivedSessions.some((s) => this.sessionHasAnyWork(s))) return true;
    return this.current && !this.current.pendingLiveCheck
      ? this.sessionHasAnyWork(this.current)
      : false;
  }

  private needsLeaseRenewal(state: SessionState, now: number): boolean {
    if (state.finished || state.finishedPublished || !state.manifest) return false;
    if (state.manifest.writer_id !== this.writerId) return false;
    const expiresAt = state.manifest.lease_expires_at ?? 0;
    return expiresAt > 0 && expiresAt - now <= Math.floor(this.leaseTtlMs / 3);
  }

  private hasDueWork(now = Date.now()): boolean {
    if (this.halted) return false;
    if (this.archivedSessions.some((s) => this.sessionHasAnyWork(s))) return true;
    const s = this.current;
    if (!s || s.pendingLiveCheck) return false;
    if ((s.finished && !s.finishedPublished) || s.releasePending) return true;
    if (this.isStreamDue(s.timing, now, false) || this.isStreamDue(s.telemetry, now, false)) return true;
    return this.needsLeaseRenewal(s, now);
  }

  private maybeTriggerThresholdFlush(): void {
    if (this.stopped || this.retryTimer || this.halted || !this.current || this.current.pendingLiveCheck) return;
    const s = this.current;
    const timingHit = s.timing.records.length >= this.chunkMaxRecords || s.timing.bytes >= this.chunkMaxBytes;
    const telHit = s.telemetry.records.length >= this.chunkMaxRecords || s.telemetry.bytes >= this.chunkMaxBytes;
    if (timingHit || telHit) {
      void this.flush(false);
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer || this.halted) return;
    const delay = Math.min(
      this.retryMaxMs,
      this.retryBaseMs * 2 ** Math.max(0, this.consecutiveFailures - 1),
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped && !this.halted && (this.hasDueWork() || this.hasAnyPendingWork())) {
        void this.flush(false);
      }
    }, delay);
  }

  private async loadExistingManifest(state: SessionState): Promise<void> {
    const key = manifestObjectKey(state.sessionKey);
    const existing = await this.store.get(key);
    state.manifestLoaded = true;
    if (!existing) {
      state.manifest = null;
      state.manifestEtag = null;
      state.nextSeq = 0;
      state.nextChunkId = 1;
      return;
    }

    const parsed = JSON.parse(existing.body.toString('utf8')) as SessionManifest;
    const now = Date.now();
    if (
      parsed.writer_id &&
      parsed.writer_id !== this.writerId &&
      parsed.lease_expires_at != null &&
      now < parsed.lease_expires_at &&
      !(this.takeover && !state.takeoverUsed)
    ) {
      throw new LeaseConflictError({
        error: `Another ingestor (${parsed.writer_id}) holds an active lease for session ${state.sessionKey}`,
        active_writer_id: parsed.writer_id,
        lease_expires_at: parsed.lease_expires_at,
      });
    }

    state.manifest = parsed;
    state.manifestEtag = existing.etag;
    state.nextSeq = parsed.record_count > 0 ? parsed.last_seq + 1 : 0;
    const maxChunkId = parsed.chunks.reduce((max, c) => Math.max(max, c.id), 0);
    state.nextChunkId = maxChunkId + 1;
  }

  private takeStreamSlice(buf: StreamBuffer): BufferedRecord[] {
    const maxCount = Math.min(buf.records.length, this.chunkMaxRecords);
    let bytes = 0;
    let count = 0;
    for (let i = 0; i < maxCount; i++) {
      const recBytes = buf.records[i]!.approxBytes;
      if (count > 0 && bytes + recBytes > this.chunkMaxBytes) break;
      bytes += recBytes;
      count++;
    }
    return buf.records.slice(0, count);
  }

  private consumeStreamSlice(buf: StreamBuffer, count: number): void {
    const removed = buf.records.splice(0, count);
    let bytes = 0;
    for (const r of removed) bytes += r.approxBytes;
    buf.bytes = Math.max(0, buf.bytes - bytes);
    buf.firstEnqueuedAt = buf.records.length > 0 ? Date.now() : null;
  }

  private async publishSession(state: SessionState, force: boolean): Promise<boolean> {
    if (!state.manifestLoaded) {
      await this.loadExistingManifest(state);
    }

    // H4: If existing manifest on storage is already finished, ignore trailing records unless finished itself.
    if (state.manifest?.status === 'finished') {
      state.timing = emptyStreamBuffer();
      state.telemetry = emptyStreamBuffer();
      state.pendingGapEvents = [];
      state.finished = true;
      state.finishedPublished = true;
      state.releasePending = false;
      return true;
    }

    const now = Date.now();
    const forceAll = force || state.finished || state.releasePending;
    const flushTiming = this.isStreamDue(state.timing, now, forceAll);
    const flushTelemetry = this.isStreamDue(state.telemetry, now, forceAll);
    const needFinish = state.finished && !state.finishedPublished;
    const needRelease = state.releasePending;
    const needRenewal = this.needsLeaseRenewal(state, now);

    if (!flushTiming && !flushTelemetry && !needFinish && !needRelease && !needRenewal) {
      return true;
    }

    const timingSlice = flushTiming ? this.takeStreamSlice(state.timing) : [];
    const telemetrySlice = flushTelemetry ? this.takeStreamSlice(state.telemetry) : [];
    const gapSlice = state.pendingGapEvents.slice();

    // Assign monotonic seqs across timing + telemetry in arrival order, preserving stream grouping.
    const tagged = [
      ...timingSlice.map((item) => ({ stream: 'timing' as const, item })),
      ...telemetrySlice.map((item) => ({ stream: 'telemetry' as const, item })),
    ].sort((a, b) => a.item.receivedAt - b.item.receivedAt);

    let seqCursor = state.nextSeq;
    const timingLive: LiveRecord[] = [];
    const telemetryLive: LiveRecord[] = [];
    for (const entry of tagged) {
      const rec: LiveRecord = {
        seq: seqCursor++,
        topic: entry.item.parsed.topic,
        data: entry.item.parsed.data,
        ts: entry.item.parsed.ts,
        snapshot: entry.item.parsed.snapshot,
        received_at: entry.item.receivedAt,
      };
      if (entry.stream === 'timing') timingLive.push(rec);
      else telemetryLive.push(rec);
    }

    // Upload immutable gzipped chunk(s) first (safe to retry: unused orphan chunks are harmless).
    let chunkIdCursor = state.nextChunkId;
    const newChunks: ChunkMeta[] = [];

    const uploadChunk = async (stream: StreamKind, records: LiveRecord[]): Promise<void> => {
      if (records.length === 0) return;
      const id = chunkIdCursor++;
      const filename = formatChunkFilename(stream, id);
      const key = chunkObjectKey(state.sessionKey, filename);
      const ndjson = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
      const gz = zlib.gzipSync(Buffer.from(ndjson, 'utf8'));
      await this.store.put(key, gz, {
        contentType: 'application/x-ndjson; charset=utf-8',
        contentEncoding: 'gzip',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      newChunks.push({
        id,
        stream,
        encoding: CHUNK_ENCODING,
        path: chunkPublicPath(state.sessionKey, filename),
        seq_start: records[0]!.seq,
        seq_end: records[records.length - 1]!.seq,
        from_ms: records.reduce((m, r) => Math.min(m, r.received_at), records[0]!.received_at),
        to_ms: records.reduce((m, r) => Math.max(m, r.received_at), records[0]!.received_at),
        record_count: records.length,
        byte_len: gz.byteLength,
      });
    };

    await uploadChunk('timing', timingLive);
    await uploadChunk('telemetry', telemetryLive);

    const remainingTiming = state.timing.records.length - timingSlice.length;
    const remainingTelemetry = state.telemetry.records.length - telemetrySlice.length;
    const drainedAll = remainingTiming === 0 && remainingTelemetry === 0;
    const markFinished = needFinish && drainedAll;
    const markReleased = needRelease && drainedAll;

    const prev = state.manifest;
    const allNewRecords = [...timingLive, ...telemetryLive];
    const minNewTs = allNewRecords.length
      ? allNewRecords.reduce((m, r) => Math.min(m, r.received_at), allNewRecords[0]!.received_at)
      : null;
    const maxNewTs = allNewRecords.length
      ? allNewRecords.reduce((m, r) => Math.max(m, r.received_at), allNewRecords[0]!.received_at)
      : null;

    let nextGaps = applyGapEventsToList(prev?.gaps ?? [], gapSlice);
    // Auto-record a capture gap if resuming an existing manifest from a new writer after > 5s.
    if (
      prev &&
      prev.record_count > 0 &&
      prev.writer_id !== this.writerId &&
      minNewTs !== null &&
      gapSlice.length === 0 &&
      minNewTs - prev.last_received_at > PUBLISHER_DEFAULTS.writerRestartGapMs
    ) {
      nextGaps = applyGapEventsToList(nextGaps, [
        { kind: 'open', at: prev.last_received_at },
        { kind: 'close', at: minNewTs },
      ]);
    }

    const updatedAt = Date.now();
    const nextManifest: SessionManifest = {
      protocol_version: PROTOCOL_VERSION,
      session_key: state.sessionKey,
      meeting_key: state.meta.meeting_key ?? prev?.meeting_key ?? null,
      session_name: state.meta.session_name ?? prev?.session_name ?? null,
      session_type: state.meta.session_type ?? prev?.session_type ?? null,
      meeting_name: state.meta.meeting_name ?? prev?.meeting_name ?? null,
      status: markFinished ? 'finished' : (prev?.status ?? 'live'),
      captured_from:
        prev && prev.record_count > 0
          ? minNewTs !== null
            ? Math.min(prev.captured_from, minNewTs)
            : prev.captured_from
          : (minNewTs ?? updatedAt),
      last_received_at:
        prev && prev.record_count > 0
          ? maxNewTs !== null
            ? Math.max(prev.last_received_at, maxNewTs)
            : prev.last_received_at
          : (maxNewTs ?? updatedAt),
      last_seq: allNewRecords.length > 0 ? seqCursor - 1 : (prev?.last_seq ?? -1),
      record_count: (prev?.record_count ?? 0) + allNewRecords.length,
      has_telemetry: (prev?.has_telemetry ?? false) || telemetryLive.length > 0,
      gaps: nextGaps,
      chunks: [...(prev?.chunks ?? []), ...newChunks],
      tail: { timing_count: 0, telemetry_count: 0, from_ms: null, to_ms: null },
      writer_id: markFinished || markReleased ? null : this.writerId,
      lease_expires_at: markFinished || markReleased ? null : updatedAt + this.leaseTtlMs,
      updated_at: updatedAt,
    };

    const mKey = manifestObjectKey(state.sessionKey);
    const nextEtag = await this.store.put(mKey, JSON.stringify(nextManifest), {
      contentType: 'application/json; charset=utf-8',
      cacheControl: markFinished ? 'public, max-age=60' : 'no-store',
      ...(state.manifestEtag ? { ifMatch: state.manifestEtag } : { ifNoneMatch: '*' }),
    });

    // Commit in-memory state after manifest CAS succeeds.
    state.manifest = nextManifest;
    state.manifestEtag = nextEtag;
    state.nextSeq = seqCursor;
    state.nextChunkId = chunkIdCursor;
    state.takeoverUsed = true;
    this.consumeStreamSlice(state.timing, timingSlice.length);
    this.consumeStreamSlice(state.telemetry, telemetrySlice.length);
    state.pendingGapEvents.splice(0, gapSlice.length);
    if (state.timing.records.length === 0 && state.telemetry.records.length === 0) {
      state.overflowWarned = false;
    }

    this.consecutiveFailures = 0;
    this.totalPublishedRecords += allNewRecords.length;
    this.totalPublishedChunks += newChunks.length;
    if (nextManifest.last_seq >= 0) this.lastSeq = nextManifest.last_seq;

    if (newChunks.length > 0) {
      this.onChunkPublished?.(state.sessionKey, newChunks, nextManifest);
    }

    if (markReleased) state.releasePending = false;
    if (markFinished) {
      state.finishedPublished = true;
      this.onSessionFinished?.(state.sessionKey);
    }

    // Best-effort index update (never blocks chunk publishing).
    const shouldSyncIndex =
      !prev ||
      markFinished ||
      updatedAt - state.lastIndexSyncMs >= PUBLISHER_DEFAULTS.indexThrottleMs;
    if (shouldSyncIndex) {
      state.lastIndexSyncMs = updatedAt;
      void this.upsertSessionsIndex(nextManifest).catch((e) => {
        this.log.warn(
          `[publisher] Failed to update ${SESSIONS_INDEX_KEY}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }

    return true;
  }

  private async upsertSessionsIndex(manifest: SessionManifest): Promise<void> {
    const existing = await this.store.get(SESSIONS_INDEX_KEY);
    let sessions: SessionsIndex['sessions'] = [];
    if (existing) {
      try {
        const parsed = JSON.parse(existing.body.toString('utf8')) as Partial<SessionsIndex>;
        if (Array.isArray(parsed.sessions)) sessions = parsed.sessions;
      } catch {
        // Rewrite corrupted index cleanly
      }
    }
    const next = sessions.filter((s) => s.session_key !== manifest.session_key);
    next.push(toSessionSummary(manifest));
    next.sort((a, b) => b.updated_at - a.updated_at);
    const payload: SessionsIndex = {
      protocol_version: PROTOCOL_VERSION,
      sessions: next,
      updated_at: Date.now(),
    };
    await this.store.put(SESSIONS_INDEX_KEY, JSON.stringify(payload), {
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'no-store',
    });
  }

  private pickNextSession(force: boolean): SessionState | null {
    for (const q of this.archivedSessions) {
      if (this.sessionHasAnyWork(q)) return q;
    }
    const s = this.current;
    if (!s || s.pendingLiveCheck) return null;
    if (force && this.sessionHasAnyWork(s)) return s;
    const now = Date.now();
    if (
      (s.finished && !s.finishedPublished) ||
      s.releasePending ||
      this.isStreamDue(s.timing, now, false) ||
      this.isStreamDue(s.telemetry, now, false) ||
      this.needsLeaseRenewal(s, now)
    ) {
      return s;
    }
    return null;
  }

  private async runFlushLoop(force: boolean): Promise<boolean> {
    let casRetries = 0;
    while (true) {
      const target = this.pickNextSession(force);
      if (!target) return true;
      const isArchived = target !== this.current;

      try {
        await this.publishSession(target, force || isArchived);
        casRetries = 0;
        if (isArchived && !this.sessionHasAnyWork(target)) {
          const idx = this.archivedSessions.indexOf(target);
          if (idx >= 0) this.archivedSessions.splice(idx, 1);
        }
        // Keep looping if more records remain above threshold or forced.
        if (!force && !this.hasDueWork()) return true;
      } catch (err) {
        if (err instanceof PreconditionFailedError) {
          // Reload remote manifest to inspect whether another writer took the lease.
          target.manifestLoaded = false;
          try {
            await this.loadExistingManifest(target);
            if (++casRetries <= 3) continue;
          } catch (reloadErr) {
            err = reloadErr;
          }
        }

        if (err instanceof LeaseConflictError) {
          if (isArchived) {
            this.log.warn(
              `[publisher] Lease conflict draining previous session ${target.sessionKey}; dropping stale queue.`,
            );
            const idx = this.archivedSessions.indexOf(target);
            if (idx >= 0) this.archivedSessions.splice(idx, 1);
            continue;
          }
          this.leaseConflict = true;
          this.stopped = true;
          this.clearTimers();
          this.onLeaseConflict?.(target.sessionKey, err.detail);
          return false;
        }

        if (err instanceof FatalStorageError) {
          this.fatalError = err.message;
          this.stopped = true;
          this.clearTimers();
          this.log.error(`[publisher] Fatal storage error for session ${target.sessionKey}: ${err.message}`);
          this.onFatalError?.(target.sessionKey, err.message);
          return false;
        }

        this.consecutiveFailures += 1;
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(
          `[publisher] Publish failed for session ${target.sessionKey} (attempt ${this.consecutiveFailures}): ${msg}`,
        );
        this.scheduleRetry();
        return false;
      }
    }
  }
}

export { COMPRESSED_FEEDS };
