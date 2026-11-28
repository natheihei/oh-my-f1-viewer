/**
 * The main process's side of the session database. It does what needs the network or the F1 TV token
 * and leaves all else to the worker: refreshing the calendar, downloading a session's files unless they
 * are already ingested, fetching its circuit, and passing on a live feed.
 *
 * Live backfill is strictly optional and non-blocking: live sessions start immediately from F1's
 * direct SignalR feed (maintaining pre-backfill status quo when no ingestor is running), while a
 * background loop continuously catches up on static v1 manifest + immutable chunks until everything
 * up to join time has been backfilled.
 */
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { TimingQuery } from '../../shared/api';
import {
  FIRST_SUPPORTED_YEAR,
  type BackfillStatus,
  type CircuitView,
  type DataStatus,
  type Schedule,
  type SessionObjects,
  type SqlRows,
} from '../../shared/sessionData';
import { refreshCircuit } from './circuit';
import { archiveMissing } from './archive';
import type { FeedFiles, LiveBackfillData, LiveRecord } from './ingest';
import {
  backfillMetadata,
  selectOverlappingChunks,
  type LiveBackfillManifest,
  type LiveBackfillSnapshot,
  type LiveManifestOptions,
  type LiveStreamBackfillOptions,
} from './liveBackfill';
import { LIVE_FEEDS, TELEMETRY_FEEDS, TIMING_FEEDS, type SessionMeta } from './processors';
import { parseResults, parseStartingGrid, resultPages } from './results';
import { fromSeasonIndex, fromUpcoming, mergeSchedule } from './schedule';
import { anchorComplete, liveLeadMs, startedAt, type SyncAnchor } from './sync';
import type { WorkerOperations } from './worker';

/** What the database needs from the rest of the main process. */
export interface TimingDbDeps {
  file: string;
  /** A feed's text, or null when the archive doesn't have it. Throws if it couldn't be fetched. */
  fetchFeed(sessionPath: string, feed: string): Promise<string | null>;
  fetchSeasonIndex(year: number): Promise<unknown>;
  /** MultiViewer's anchor between the session and its video, or null when it has none yet. */
  fetchSync(meetingKey: number, sessionKey: number): Promise<SyncAnchor | null>;
  /** Connects to F1's live feed. Problems arrive through `onStatus`. */
  connectLive(feeds: readonly string[], onRecord: (record: LiveRecord) => void, onStatus: (status: string) => void): void;
  disconnectLive(): void;
  /** Fetches a session's static v1 `manifest.json`, or null when unconfigured or unavailable. */
  fetchLiveManifest?(sessionKey: number, options?: Pick<LiveManifestOptions, 'silent404'>): Promise<LiveBackfillManifest | null>;
  /** Fetches un-fetched overlapping immutable chunks for one stream (`timing` or `telemetry`). */
  fetchLiveStreamBackfill?(
    manifest: LiveBackfillManifest,
    options: Pick<LiveStreamBackfillOptions, 'stream' | 'untilMs' | 'afterMs' | 'excludeChunkIds' | 'onBatch'>,
  ): Promise<LiveBackfillSnapshot | null>;
  /** Whether a live backfill base URL is configured. Defaults to `Boolean(fetchLiveManifest && fetchLiveStreamBackfill)` when omitted. */
  hasLiveBackfill?(): boolean;
  /** How long the background backfill loop waits for the first direct live record to anchor `targetUntilMs` (default 1500ms). */
  backfillAnchorWaitMs?: number;
  /** Base polling interval (ms) for continuous background catch-up retries (default 10_000ms). */
  backfillPollMs?: number;
  /** Optional worker dispatcher override (used by tests to run in-process against a real TimingStore). */
  invoke?<K extends keyof WorkerOperations>(op: K, ...args: Parameters<WorkerOperations[K]>): Promise<Awaited<ReturnType<WorkerOperations[K]>>>;
  /** Null when the page doesn't exist yet. Throws if it couldn't be fetched. */
  fetchPage(url: string): Promise<string | null>;
  resolveSession(year: number, query: TimingQuery): Promise<{ path: string; meetingKey: number; sessionKey: number; type: string | null; name: string | null; endMs: number | null } | null>;
  listUpcoming(): Promise<{ upcoming: Parameters<typeof fromUpcoming>[0]; events: Parameters<typeof fromUpcoming>[1] }>;
  /** MultiViewer's circuit, as JSON. Throws if it couldn't be fetched. */
  fetchCircuit(circuitKey: number, year: number): Promise<unknown>;
  send(channel: string, payload: unknown): void;
}

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };

const LIVE_FLUSH_MS = 250;
/** How long the background backfill loop waits for the first direct record to anchor `targetUntilMs`. */
const BACKFILL_ANCHOR_WAIT_MS = 1_500;
/** Base interval between continuous background backfill catch-up polls. */
const BACKFILL_POLL_MS = 10_000;
/** Maximum backoff interval when manifest is 404 or unreachable. */
const BACKFILL_MAX_BACKOFF_MS = 60_000;
/** How often to ask MultiViewer again while a session's anchor isn't published. */
const ANCHOR_RETRY_MS = 5 * 60_000;
/** How often to look for a replay's archive again while F1 hasn't published it. */
const ARCHIVE_RETRY_MS = 5 * 60_000;

interface LiveSessionState {
  meta: SessionMeta | null;
  buffer: LiveRecord[];
  timer: ReturnType<typeof setInterval> | null;
  backfillTimer: ReturnType<typeof setTimeout> | null;
  query: TimingQuery;
  generation: number;
  telemetry: boolean;
  ready: boolean;
  wrongSession: boolean;
  firstDirectMs: number | null;
  onFirstDirect: (() => void) | null;
  backfill: BackfillStatus | null;
}

/** Thresholds for applying client-vs-server clock offset from `manifest.serverNowMs` / HTTP Date (H3). */
const CLOCK_OFFSET_MIN_MS = 2_000;
const CLOCK_OFFSET_MAX_MS = 10 * 60_000;
const CLOCK_REALTIME_TOLERANCE_MS = 60_000;

function estimateServerClockOffsetMs(reqMidMs: number, rawUntilMs: number, serverNowMs: number | null): number {
  if (serverNowMs === null) return 0;
  if (Math.abs(reqMidMs - rawUntilMs) > CLOCK_REALTIME_TOLERANCE_MS) return 0;
  const offset = serverNowMs - reqMidMs;
  if (Math.abs(offset) < CLOCK_OFFSET_MIN_MS || Math.abs(offset) > CLOCK_OFFSET_MAX_MS) return 0;
  return offset;
}

function shiftRecords(records: readonly LiveRecord[], deltaMs: number): LiveRecord[] {
  if (deltaMs === 0) return [...records];
  return records.map((r) => ({ ...r, receivedAt: r.receivedAt + deltaMs }));
}

function shiftGaps(
  gaps: ReadonlyArray<{ from: number; to: number | null }>,
  deltaMs: number,
): Array<{ from: number; to: number | null }> {
  if (deltaMs === 0) return gaps.map((g) => ({ ...g }));
  return gaps.map((g) => ({ from: g.from + deltaMs, to: g.to !== null ? g.to + deltaMs : null }));
}

function maxChunkToMs(manifest: LiveBackfillManifest, stream: 'timing' | 'telemetry'): number | null {
  let max: number | null = null;
  for (const c of manifest.chunks) {
    if (c.stream !== stream) continue;
    if (max === null || c.toMs > max) max = c.toMs;
  }
  return max;
}

export class TimingDb {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  /** Bumped per opened session, so work for one that's been closed stops. */
  private generation = 0;
  /** Bumped when a replay fallback is cancelled (e.g. upgraded to official archive — M4). */
  private fallbackGeneration = 0;
  /** The open session's anchor to its video, from MultiViewer. */
  private anchor: SyncAnchor | null = null;
  private anchorTimer: ReturnType<typeof setTimeout> | null = null;
  /** Looks for the open replay's archive again, while F1 hasn't published it. */
  private archiveTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the live session's clock first started, by the feed. */
  private liveStartedUtc: number | null = null;
  /** The session the last `ready` status was for: a newly published anchor is only sent after it. */
  private readyKey: number | null = null;
  private live: LiveSessionState | null = null;
  /** The open session's circuit: fetched once its key is known. */
  private circuit: { generation: number; query: TimingQuery; year: number; started: boolean } | null = null;

  constructor(private deps: TimingDbDeps) {}

  private call<K extends keyof WorkerOperations>(op: K, ...args: Parameters<WorkerOperations[K]>): Promise<Awaited<ReturnType<WorkerOperations[K]>>> {
    if (this.deps.invoke) return this.deps.invoke(op, ...args);
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject });
      worker.postMessage({ id, op, args });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: { file: this.deps.file } });
    worker.on('message', ({ id, ok, result, error }) => {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (ok) pending?.resolve(result);
      else pending?.reject(new Error(error));
    });
    const stop = (e: Error) => {
      console.error('[timingdb] worker stopped:', e.message);
      if (this.worker === worker) this.worker = null;
      for (const pending of this.pending.values()) pending.reject(e);
      this.pending.clear();
    };
    worker.on('error', stop);
    worker.on('exit', (code) => {
      if (this.worker === worker) stop(new Error(`The database worker exited (${code}).`));
    });
    this.worker = worker;
    return worker;
  }

  // --- The calendar ---

  /** What's known from last time, straight away. */
  async schedule(): Promise<Schedule | null> {
    return this.call('schedule');
  }

  /**
   * Fetched fresh on every start. The seasons are fetched separately, so one failing leaves the others
   * and what's known about it from last time.
   */
  async refreshSchedule(): Promise<void> {
    const failures: string[] = [];
    const known = (await this.call('schedule').catch(() => null)) ?? { meetings: [], sessions: [], refreshedAt: null };
    const seasons: number[] = [];
    for (let year = new Date().getUTCFullYear(); year >= FIRST_SUPPORTED_YEAR; year--) seasons.push(year);
    const parts = await Promise.all(
      seasons.map(async (year) => {
        try {
          return fromSeasonIndex(await this.deps.fetchSeasonIndex(year), year);
        } catch (e) {
          failures.push((e as Error).message);
          return null;
        }
      }),
    );
    let upcoming: ReturnType<typeof fromUpcoming> | null = null;
    try {
      const listed = await this.deps.listUpcoming();
      upcoming = fromUpcoming(listed.upcoming, listed.events);
    } catch (e) {
      failures.push((e as Error).message);
    }
    const fresh = [...parts, upcoming].filter((part): part is NonNullable<typeof part> => part !== null);
    const schedule = mergeSchedule([...fresh, known], Date.now());
    if (fresh.length === 0) schedule.refreshedAt = known.refreshedAt;
    await this.call('saveSchedule', schedule);
    this.deps.send('data:schedule', { schedule, reason: failures[0] ?? null });
  }

  // --- A session ---

  private async status(sessionKey: number, state: DataStatus['state'], reason: string | null = null): Promise<void> {
    const { coverage, clock, tables } = await this.call('status', sessionKey);
    if (state === 'ready') this.readyKey = sessionKey;
    const sessionStartSec = this.anchor?.sessionStartSec ?? null;
    const lead = this.liveStartedUtc !== null ? liveLeadMs(this.anchor?.sessionStartPdtMs ?? null, this.liveStartedUtc) : null;
    const backfill = this.live?.meta?.sessionKey === sessionKey ? this.live.backfill : null;
    this.deps.send('data:status', {
      sessionKey,
      state,
      reason,
      coverage,
      clock,
      sessionStartSec,
      liveLeadMs: lead,
      tables,
      ...(backfill ? { backfill } : {}),
    } satisfies DataStatus);
  }

  private refuse(state: 'unsupported' | 'failed', reason: string): void {
    this.deps.send('data:status', { sessionKey: null, state, reason, coverage: null, clock: null, sessionStartSec: null, liveLeadMs: null, tables: null } satisfies DataStatus);
  }

  /** Called when a session opens. Replies at once, and reports progress through `data:status`. */
  open(query: TimingQuery, live: boolean): void {
    const generation = ++this.generation;
    this.fallbackGeneration++;
    this.endLive();
    this.resetAnchor();
    const year = query.year ?? new Date().getUTCFullYear();
    this.circuit = { generation, query, year, started: false };
    this.sendCircuit(query, { state: 'loading' });
    if (year < FIRST_SUPPORTED_YEAR) {
      this.refuse('unsupported', `Session data covers ${FIRST_SUPPORTED_YEAR} onwards.`);
      return;
    }
    const run = live ? this.openLive(query, year, generation) : this.openArchive(query, year, generation);
    run.catch((e: Error) => {
      console.warn('[timingdb] opening failed:', e.message);
      if (generation === this.generation) this.refuse('failed', e.message);
    });
  }

  close(): void {
    this.generation++;
    this.fallbackGeneration++;
    this.circuit = null;
    this.endLive();
    this.resetAnchor();
  }

  // --- Lining up with the video ---

  private resetAnchor(): void {
    if (this.anchorTimer) clearTimeout(this.anchorTimer);
    this.anchorTimer = null;
    if (this.archiveTimer) clearTimeout(this.archiveTimer);
    this.archiveTimer = null;
    this.anchor = null;
    this.liveStartedUtc = null;
    this.readyKey = null;
  }

  /**
   * Asks MultiViewer for the session's anchor, and again every few minutes until it has what this needs: it
   * publishes some time after a session. Sends the status again when the anchor changes after `ready`.
   */
  private async fetchAnchor(meta: SessionMeta, generation: number, live: boolean): Promise<void> {
    if (this.anchorTimer) clearTimeout(this.anchorTimer);
    this.anchorTimer = null;
    const anchor = await this.deps.fetchSync(meta.meetingKey, meta.sessionKey).catch(() => null);
    if (generation !== this.generation) return;
    if (anchor && JSON.stringify(anchor) !== JSON.stringify(this.anchor)) {
      this.anchor = anchor;
      if (this.readyKey === meta.sessionKey) await this.status(meta.sessionKey, 'ready');
    }
    if (generation === this.generation && !anchorComplete(this.anchor, live)) {
      this.anchorTimer = setTimeout(() => void this.fetchAnchor(meta, generation, live), ANCHOR_RETRY_MS);
    }
  }

  // --- The circuit ---

  private sendCircuit(query: TimingQuery, circuit: CircuitView): void {
    this.deps.send('data:circuit', { query, circuit });
  }

  /** The schedule's meetings carry their circuit's key once they've happened. */
  private async circuitFromSchedule(generation: number, meetingKey: number): Promise<void> {
    const schedule = await this.call('schedule').catch(() => null);
    const key = schedule?.meetings.find((m) => m.meeting_key === meetingKey)?.circuit_key;
    if (key) this.startCircuit(generation, key);
  }

  /** Fetches the circuit once per opened session, from whichever source knows its key first. */
  private startCircuit(generation: number, circuitKey: number): void {
    const circuit = this.circuit;
    if (!circuit || circuit.started || circuit.generation !== generation || generation !== this.generation) return;
    circuit.started = true;
    void refreshCircuit(circuitKey, circuit.year, {
      load: (key) => this.call('circuit', key),
      save: (fresh) => this.call('saveCircuit', fresh),
      fetch: (key, year) => this.deps.fetchCircuit(key, year),
      publish: (view) => this.sendCircuit(circuit.query, view),
      stale: () => generation !== this.generation,
      now: () => Date.now(),
    }).catch((e: Error) => console.warn('[timingdb] circuit:', e.message));
  }

  private backfillEnabled(): boolean {
    return (
      Boolean(this.deps.fetchLiveManifest && this.deps.fetchLiveStreamBackfill) &&
      (this.deps.hasLiveBackfill ? this.deps.hasLiveBackfill() : true)
    );
  }

  private scheduleArchiveRetry(query: TimingQuery, year: number, generation: number, servingFallback: boolean): void {
    if (this.archiveTimer) clearTimeout(this.archiveTimer);
    this.archiveTimer = setTimeout(() => {
      this.archiveTimer = null;
      if (generation !== this.generation) return;
      this.openArchive(query, year, generation, servingFallback).catch((e: Error) => {
        if (!servingFallback && generation === this.generation) this.refuse('failed', e.message);
      });
    }, ARCHIVE_RETRY_MS);
  }

  private async openArchive(query: TimingQuery, year: number, generation: number, servingFallback = false): Promise<void> {
    const found = await this.deps.resolveSession(year, query);
    if (generation !== this.generation) return;
    const missing = archiveMissing(found, Date.now());
    if (missing || !found) {
      if (!servingFallback) {
        // Availability waterfall: when F1's static archive isn't published yet, fall back to static
        // R2 chunks if captured. Never attach direct live SignalR on a VOD open (H5).
        const fallbackKey = Number(query.sessionKey ?? found?.sessionKey);
        if (fallbackKey > 0 && this.backfillEnabled()) {
          const manifest = await this.deps
            .fetchLiveManifest!(fallbackKey)
            .catch((e: Error) => (console.warn('[timingdb] replay fallback manifest:', e.message), null));
          if (generation !== this.generation) return;
          if (manifest) {
            const meetingKey = Number(query.meetingKey ?? found?.meetingKey ?? manifest.meetingKey);
            if (meetingKey > 0) {
              const loaded = await this.openReplayFallback(
                { sessionKey: fallbackKey, meetingKey, isRace: this.isRace(query) ?? (manifest.sessionType?.toLowerCase() === 'race' ? true : null) },
                manifest,
                generation,
              );
              if (generation !== this.generation) return;
              if (loaded) {
                if (missing?.retry) this.scheduleArchiveRetry(query, year, generation, true);
                return;
              }
            }
          }
        }
        this.refuse('failed', missing?.reason ?? "This session wasn't found in the timing archive.");
      }
      if (missing?.retry) this.scheduleArchiveRetry(query, year, generation, servingFallback);
      return;
    }
    const meta: SessionMeta = { meetingKey: found.meetingKey, sessionKey: found.sessionKey, isRace: found.type ? found.type.toLowerCase() === 'race' : null };
    const stale = () => generation !== this.generation;
    void this.circuitFromSchedule(generation, meta.meetingKey);

    // M4: Cancel any active live capture / replay fallback background telemetry before upgrading to the official archive.
    if (servingFallback) {
      this.fallbackGeneration++;
      this.endLive();
      await this.call('liveEnd').catch(() => {});
      if (stale()) return;
    }

    if (!(await this.call('isComplete', meta.sessionKey, 'timing'))) {
      if (!servingFallback) await this.status(meta.sessionKey, 'loading');
      const feeds = await this.download(found.path, TIMING_FEEDS);
      if (stale()) return;
      await this.call('ingestTiming', meta, feeds, found.endMs);
    }
    if (stale()) return;
    const { coverage } = await this.call('status', meta.sessionKey);
    if (coverage.datasets.timing.state === 'failed') {
      if (!servingFallback) this.refuse('failed', coverage.datasets.timing.reason ?? 'The session data could not be loaded.');
      return;
    }
    await this.fetchAnchor(meta, generation, false);
    if (stale()) return;
    await this.status(meta.sessionKey, 'ready');

    if (!(await this.call('isComplete', meta.sessionKey, 'results'))) await this.fetchResults(meta, year, found.name ?? query.sessionName ?? '');
    if (stale()) return;
    await this.status(meta.sessionKey, 'ready');

    if (!(await this.call('isComplete', meta.sessionKey, 'telemetry'))) {
      const feeds = await this.download(found.path, TELEMETRY_FEEDS);
      if (stale()) return;
      await this.call('ingestTelemetry', meta, feeds, found.endMs);
      if (!stale()) await this.status(meta.sessionKey, 'ready');
    }
  }

  /**
   * Serves a captured session from R2/static chunks while F1's official static archive is still
   * unpublished. Derives `FeedClock` from an observed `ExtrapolatedClock` transition so
   * MultiViewer's `session_start` lines up with VOD playback, and streams telemetry in the background.
   */
  private async openReplayFallback(meta: SessionMeta, manifest: LiveBackfillManifest, generation: number): Promise<boolean> {
    const fallbackGen = ++this.fallbackGeneration;
    const stale = () => generation !== this.generation || fallbackGen !== this.fallbackGeneration;
    void this.circuitFromSchedule(generation, meta.meetingKey);
    await this.status(meta.sessionKey, 'loading');
    if (stale()) return false;

    const untilMs = Math.max(Date.now(), manifest.lastReceivedAt);
    const [timingAfterMs, telemetryAfterMs] = await Promise.all([
      this.call('liveLastVisibleFrom', meta.sessionKey, 'timing'),
      this.call('liveLastVisibleFrom', meta.sessionKey, 'telemetry'),
    ]);
    if (stale()) return false;

    const timingBackfill = await this.deps
      .fetchLiveStreamBackfill!(manifest, { stream: 'timing', untilMs, afterMs: timingAfterMs })
      .catch((e: Error) => (console.warn('[timingdb] replay fallback timing:', e.message), null));
    if (stale() || !timingBackfill) return false;

    if (timingBackfill.records.length === 0 && timingAfterMs === null) return false;
    if (timingBackfill.records.length > 0) {
      const info = backfillMetadata(timingBackfill.records);
      if (info.startedUtc !== null && this.liveStartedUtc === null) this.liveStartedUtc = info.startedUtc;
      if (info.circuitKey !== null) this.startCircuit(generation, info.circuitKey);
    }

    const backfillData: LiveBackfillData | null =
      timingBackfill.records.length > 0 ? { records: timingBackfill.records, gaps: timingBackfill.meta.gaps } : null;
    await this.call('liveBegin', meta, backfillData);
    if (stale()) return false;

    await this.fetchAnchor(meta, generation, false);
    if (stale()) return false;
    await this.status(meta.sessionKey, 'ready');

    if (manifest.hasTelemetry && this.deps.fetchLiveStreamBackfill) {
      void (async () => {
        let totalWritten = 0;
        const telemetryBackfill = await this.deps
          .fetchLiveStreamBackfill!(manifest, {
            stream: 'telemetry',
            untilMs,
            afterMs: telemetryAfterMs,
            onBatch: async (batch) => {
              if (stale() || batch.length === 0) return;
              const res = await this.call('liveAppendBackfill', batch).catch((e: Error) => {
                console.warn('[timingdb] replay fallback telemetry write failed:', e.message);
                return null;
              });
              if (res && res.written > 0) totalWritten += res.written;
            },
          })
          .catch((e: Error) => (console.warn('[timingdb] replay fallback telemetry:', e.message), null));
        if (stale() || !telemetryBackfill) return;
        if (totalWritten === 0 && telemetryBackfill.records.length > 0) {
          const res = await this.call('liveAppendBackfill', telemetryBackfill.records).catch((e: Error) => {
            console.warn('[timingdb] replay fallback telemetry write failed:', e.message);
            return null;
          });
          if (res && res.written > 0) totalWritten += res.written;
        }
        if (!stale() && totalWritten > 0) await this.status(meta.sessionKey, 'ready');
      })();
    }

    return true;
  }

  private async download(sessionPath: string, feeds: readonly string[]): Promise<FeedFiles> {
    const files: Record<string, string> = {};
    const failed: string[] = [];
    await Promise.all(
      feeds.map(async (feed) => {
        try {
          const text = await this.deps.fetchFeed(sessionPath, feed);
          if (text) files[feed] = text;
        } catch (e) {
          console.warn(`[timingdb] ${feed}:`, (e as Error).message);
          failed.push(feed);
        }
      }),
    );
    return { files, failed };
  }

  /** Its own step, so a change to the site can't hold up the timing data or force it to be ingested again. */
  private async fetchResults(meta: SessionMeta, year: number, sessionName: string): Promise<void> {
    const pages = resultPages(year, meta.meetingKey, sessionName);
    const fetchPage = async <T,>(url: string | null, parse: (html: string) => T[]): Promise<{ rows: T[]; failed: boolean }> => {
      if (!url) return { rows: [], failed: false };
      try {
        const html = await this.deps.fetchPage(url);
        return { rows: html ? parse(html) : [], failed: false };
      } catch (e) {
        console.warn('[timingdb] results page:', (e as Error).message);
        return { rows: [], failed: true };
      }
    };
    const [result, grid] = await Promise.all([fetchPage(pages.result, parseResults), fetchPage(pages.grid, parseStartingGrid)]);
    // A session with no results page at all, such as testing, is done. One whose page is still empty isn't.
    const final = !pages.result || result.rows.length > 0;
    await this.call('ingestResults', meta, { grid: grid.rows, result: result.rows, final, failed: result.failed || grid.failed });
  }

  // --- Live ---

  private async openLive(query: TimingQuery, year: number, generation: number): Promise<void> {
    const session: LiveSessionState = {
      meta: null,
      buffer: [],
      timer: null,
      backfillTimer: null,
      query,
      generation,
      telemetry: false,
      ready: false,
      wrongSession: false,
      firstDirectMs: null,
      onFirstDirect: null,
      backfill: null,
    };
    this.live = session;
    session.timer = setInterval(() => void this.flushLive(), LIVE_FLUSH_MS);
    this.deps.send('data:status', { sessionKey: null, state: 'loading', reason: null, coverage: null, clock: null, sessionStartSec: null, liveLeadMs: null, tables: null } satisfies DataStatus);
    this.deps.connectLive(LIVE_FEEDS, (record) => this.liveRecord(record), (status) => this.liveConnection(status));
    const found = await this.deps.resolveSession(year, query).catch(() => null);
    if (this.live !== session) return;
    const sessionKey = Number(query.sessionKey ?? found?.sessionKey);
    const meetingKey = Number(query.meetingKey ?? found?.meetingKey);
    if (meetingKey) void this.circuitFromSchedule(generation, meetingKey);
    if (!session.meta && sessionKey && meetingKey) await this.beginLive(session, { sessionKey, meetingKey, isRace: this.isRace(query) });
  }

  private isRace(query: TimingQuery): boolean | null {
    return query.sessionType ? query.sessionType === 'race' : null;
  }

  /** Waits briefly inside the background backfill loop for the first direct live record to anchor `targetUntilMs`. */
  private waitForDirectAnchor(session: LiveSessionState): Promise<void> {
    if (session.firstDirectMs !== null || this.live !== session) return Promise.resolve();
    const waitMs = this.deps.backfillAnchorWaitMs ?? BACKFILL_ANCHOR_WAIT_MS;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (session.onFirstDirect === done) session.onFirstDirect = null;
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      session.onFirstDirect = done;
    });
  }

  /**
   * Starts live capture IMMEDIATELY from F1's direct SignalR feed — never blocks on backfill.
   * When a backfill URL is configured, spawns a non-blocking background catch-up loop that
   * continuously polls `manifest.json` until timing & telemetry chunks cover up to join time.
   */
  private async beginLive(session: LiveSessionState, meta: SessionMeta): Promise<void> {
    if (session.meta || this.live !== session) return;
    session.meta = meta;

    const backfillEnabled = this.backfillEnabled();
    const [timingAfterMs, telemetryAfterMs] = backfillEnabled
      ? await Promise.all([
          this.call('liveLastVisibleFrom', meta.sessionKey, 'timing'),
          this.call('liveLastVisibleFrom', meta.sessionKey, 'telemetry'),
        ])
      : [null, null];
    if (this.live !== session) return;

    const began = await this.call('liveBegin', meta, null);
    if (this.live !== session) return;
    if (began.hasTelemetry) session.telemetry = true;

    if (backfillEnabled) {
      session.backfill = {
        state: 'catching-up',
        capturedFrom: timingAfterMs,
        backfilledTo: null,
        targetUntilMs: session.firstDirectMs,
      };
    }

    session.ready = true;
    await this.status(meta.sessionKey, 'ready');
    if (this.live !== session) return;
    void this.flushLive();
    void this.fetchAnchor(meta, session.generation, true);

    if (backfillEnabled) {
      void this.runLiveBackfillLoop(session, meta, { timingAfterMs, telemetryAfterMs });
    }
  }

  /**
   * Optional, non-blocking background backfill loop: continuously fetches newly published
   * immutable chunks from `manifest.json` until timing and telemetry cover up to `targetUntilMs`
   * (or the manifest is `finished`), updating `session.backfill` for the agent as progress happens.
   */
  private async runLiveBackfillLoop(
    session: LiveSessionState,
    meta: SessionMeta,
    { timingAfterMs, telemetryAfterMs }: { timingAfterMs: number | null; telemetryAfterMs: number | null },
  ): Promise<void> {
    if (session.firstDirectMs === null) {
      await this.waitForDirectAnchor(session);
      if (this.live !== session || session.wrongSession) return;
    }

    let targetUntilMs = session.firstDirectMs ?? Date.now();
    if (timingAfterMs !== null && targetUntilMs < timingAfterMs) targetUntilMs = timingAfterMs;

    const fetchedTimingIds = new Set<number>();
    const fetchedTelemetryIds = new Set<number>();
    let backfilledTimingTo: number | null = null;
    let backfilledTelemetryTo: number | null = null;
    let capturedFrom: number | null = timingAfterMs;
    let attempts = 0;
    let consecutiveMisses = 0;
    const basePollMs = this.deps.backfillPollMs ?? BACKFILL_POLL_MS;

    const publishBackfill = async (next: BackfillStatus, force = false) => {
      if (this.live !== session || session.wrongSession) return;
      const prev = session.backfill;
      const changed =
        force ||
        !prev ||
        prev.state !== next.state ||
        prev.capturedFrom !== next.capturedFrom ||
        prev.backfilledTo !== next.backfilledTo ||
        prev.targetUntilMs !== next.targetUntilMs;
      session.backfill = next;
      if (changed) await this.status(meta.sessionKey, 'ready');
    };

    const scheduleNext = (delayMs: number) => {
      if (this.live !== session || session.wrongSession) return;
      if (session.backfillTimer) clearTimeout(session.backfillTimer);
      session.backfillTimer = setTimeout(() => {
        session.backfillTimer = null;
        void step();
      }, delayMs);
    };

    const step = async (): Promise<void> => {
      if (this.live !== session || session.wrongSession) return;
      const attemptIndex = attempts++;

      const reqStart = Date.now();
      const manifest = await this.deps
        .fetchLiveManifest!(meta.sessionKey, { silent404: attemptIndex > 0 })
        .catch((e: Error) => {
          if (attemptIndex === 0) console.warn('[timingdb] live backfill manifest:', e.message);
          return null;
        });
      const reqEnd = Date.now();
      if (this.live !== session || session.wrongSession) return;

      if (!manifest) {
        consecutiveMisses++;
        await publishBackfill({
          state: 'unavailable',
          capturedFrom,
          backfilledTo: backfilledTimingTo,
          targetUntilMs,
        });
        const backoff = Math.min(BACKFILL_MAX_BACKOFF_MS, basePollMs * 2 ** Math.min(3, consecutiveMisses - 1));
        scheduleNext(backoff);
        return;
      }

      consecutiveMisses = 0;
      const clockOffsetMs = estimateServerClockOffsetMs(
        Math.round((reqStart + reqEnd) / 2),
        targetUntilMs,
        manifest.serverNowMs,
      );
      const serverUntilMs = targetUntilMs + clockOffsetMs;
      const serverTimingAfterMs = timingAfterMs !== null ? timingAfterMs + clockOffsetMs : null;
      const serverTelemetryAfterMs = telemetryAfterMs !== null ? telemetryAfterMs + clockOffsetMs : null;

      let statusDirty = false;

      // 1. Fetch any un-fetched overlapping timing chunks and atomically merge into TimingStore.
      const pendingTimingChunks = selectOverlappingChunks(
        manifest.chunks,
        'timing',
        serverUntilMs,
        serverTimingAfterMs,
        fetchedTimingIds,
      );
      if (pendingTimingChunks.length > 0) {
        const timingSnap = await this.deps
          .fetchLiveStreamBackfill!(manifest, {
            stream: 'timing',
            untilMs: serverUntilMs,
            afterMs: serverTimingAfterMs,
            excludeChunkIds: fetchedTimingIds,
          })
          .catch((e: Error) => (console.warn('[timingdb] live timing backfill:', e.message), null));
        if (this.live !== session || session.wrongSession) return;

        if (timingSnap) {
          for (const id of timingSnap.meta.fetchedChunkIds) fetchedTimingIds.add(id);
          // Fallback for mocks that don't populate fetchedChunkIds.
          if (timingSnap.meta.fetchedChunkIds.length === 0) {
            for (const c of pendingTimingChunks) fetchedTimingIds.add(c.id);
          }
          const shiftedRecords = shiftRecords(timingSnap.records, -clockOffsetMs);
          const shiftedGaps = shiftGaps(timingSnap.meta.gaps, -clockOffsetMs);
          if (shiftedRecords.length > 0 || shiftedGaps.length > 0) {
            const info = backfillMetadata(shiftedRecords);
            if (info.startedUtc !== null && this.liveStartedUtc === null) this.liveStartedUtc = info.startedUtc;
            if (info.circuitKey !== null) this.startCircuit(session.generation, info.circuitKey);
            const merged = await this.call('liveMergeTimingBackfill', shiftedRecords, shiftedGaps).catch((e: Error) => {
              console.warn('[timingdb] live timing backfill merge failed:', e.message);
              return null;
            });
            if (this.live !== session || session.wrongSession) return;
            if (merged) {
              if (merged.capturedFrom !== null) capturedFrom = merged.capturedFrom;
              const maxRec = shiftedRecords.reduce((m, r) => Math.max(m, r.receivedAt), -Infinity);
              if (Number.isFinite(maxRec)) {
                backfilledTimingTo = backfilledTimingTo === null ? maxRec : Math.max(backfilledTimingTo, maxRec);
              }
              if (merged.written > 0) statusDirty = true;
            }
          }
        }
      }

      // 2. Fetch any un-fetched overlapping telemetry chunks, streaming each chunk directly to the worker.
      const pendingTelChunks = manifest.hasTelemetry
        ? selectOverlappingChunks(
            manifest.chunks,
            'telemetry',
            serverUntilMs,
            serverTelemetryAfterMs,
            fetchedTelemetryIds,
          )
        : [];
      if (pendingTelChunks.length > 0) {
        let totalTelWritten = 0;
        let sawTel = false;
        const telSnap = await this.deps
          .fetchLiveStreamBackfill!(manifest, {
            stream: 'telemetry',
            untilMs: serverUntilMs,
            afterMs: serverTelemetryAfterMs,
            excludeChunkIds: fetchedTelemetryIds,
            onBatch: async (batch) => {
              if (this.live !== session || session.wrongSession || batch.length === 0) return;
              const shifted = shiftRecords(batch, -clockOffsetMs);
              const res = await this.call('liveAppendBackfill', shifted).catch((e: Error) => {
                console.warn('[timingdb] live telemetry backfill write failed:', e.message);
                return null;
              });
              if (res && res.written > 0) {
                totalTelWritten += res.written;
                if (res.hasTelemetry) sawTel = true;
              }
            },
          })
          .catch((e: Error) => (console.warn('[timingdb] live telemetry backfill:', e.message), null));
        if (this.live !== session || session.wrongSession) return;

        if (telSnap) {
          for (const id of telSnap.meta.fetchedChunkIds) fetchedTelemetryIds.add(id);
          if (telSnap.meta.fetchedChunkIds.length === 0) {
            for (const c of pendingTelChunks) fetchedTelemetryIds.add(c.id);
          }
          if (totalTelWritten === 0 && telSnap.records.length > 0) {
            const shifted = shiftRecords(telSnap.records, -clockOffsetMs);
            const res = await this.call('liveAppendBackfill', shifted).catch((e: Error) => {
              console.warn('[timingdb] live telemetry backfill write failed:', e.message);
              return null;
            });
            if (res && res.written > 0) {
              totalTelWritten += res.written;
              if (res.hasTelemetry) sawTel = true;
            }
          }
          const lastTelMs = telSnap.meta.lastReceivedAt !== null ? telSnap.meta.lastReceivedAt - clockOffsetMs : null;
          if (lastTelMs !== null) {
            backfilledTelemetryTo = backfilledTelemetryTo === null ? lastTelMs : Math.max(backfilledTelemetryTo, lastTelMs);
          }
          if (totalTelWritten > 0) {
            if (sawTel) session.telemetry = true;
            statusDirty = true;
          }
        }
      }

      // 3. Determine whether backfill has caught up to join time (or the session finished).
      const remainingTiming = selectOverlappingChunks(
        manifest.chunks,
        'timing',
        serverUntilMs,
        serverTimingAfterMs,
        fetchedTimingIds,
      );
      const remainingTel = manifest.hasTelemetry
        ? selectOverlappingChunks(
            manifest.chunks,
            'telemetry',
            serverUntilMs,
            serverTelemetryAfterMs,
            fetchedTelemetryIds,
          )
        : [];

      const manifestTimingMax = maxChunkToMs(manifest, 'timing');
      const manifestTelMax = maxChunkToMs(manifest, 'telemetry');

      const timingComplete =
        remainingTiming.length === 0 &&
        (manifest.status === 'finished' || (manifestTimingMax !== null && manifestTimingMax >= serverUntilMs));
      const telemetryComplete =
        !manifest.hasTelemetry ||
        (remainingTel.length === 0 &&
          (manifest.status === 'finished' || (manifestTelMax !== null && manifestTelMax >= serverUntilMs)));

      const latestBackfilled =
        backfilledTimingTo !== null && backfilledTelemetryTo !== null
          ? Math.max(backfilledTimingTo, backfilledTelemetryTo)
          : (backfilledTimingTo ?? backfilledTelemetryTo);

      if (timingComplete && telemetryComplete) {
        await publishBackfill(
          {
            state: 'complete',
            capturedFrom: capturedFrom ?? manifest.capturedFrom - clockOffsetMs,
            backfilledTo: latestBackfilled,
            targetUntilMs,
          },
          statusDirty,
        );
        return;
      }

      await publishBackfill(
        {
          state: 'catching-up',
          capturedFrom,
          backfilledTo: latestBackfilled,
          targetUntilMs,
        },
        statusDirty,
      );
      scheduleNext(basePollMs);
    };

    await step();
  }

  /** A message from the live feed. */
  private liveRecord(record: LiveRecord): void {
    const session = this.live;
    if (!session || session.wrongSession) return;

    // H5: Verify incoming SessionInfo.Key matches the session we opened so F1's global live socket
    // can never contaminate another session's tables.
    if (record.topic === 'SessionInfo') {
      const incomingKey = Number((record.data as { Key?: unknown })?.Key);
      const expectedKey = session.meta?.sessionKey ?? (session.query.sessionKey != null ? Number(session.query.sessionKey) : null);
      if (incomingKey > 0 && expectedKey != null && expectedKey > 0 && incomingKey !== expectedKey) {
        console.warn(`[timingdb] live socket is broadcasting session ${incomingKey}, expected ${expectedKey}; disconnecting direct live feed`);
        session.wrongSession = true;
        session.buffer = [];
        if (session.backfillTimer) {
          clearTimeout(session.backfillTimer);
          session.backfillTimer = null;
        }
        if (session.onFirstDirect) {
          const notify = session.onFirstDirect;
          session.onFirstDirect = null;
          notify();
        }
        this.deps.disconnectLive();
        return;
      }
    }

    if (session.firstDirectMs === null || record.receivedAt < session.firstDirectMs) {
      session.firstDirectMs = record.receivedAt;
    }
    session.buffer.push(record);
    if (session.onFirstDirect) {
      const notify = session.onFirstDirect;
      session.onFirstDirect = null;
      notify();
    }
    if (record.topic === 'SessionData' && this.liveStartedUtc === null) {
      this.liveStartedUtc = startedAt(record.data);
      if (this.liveStartedUtc !== null && this.anchor?.sessionStartPdtMs != null && session.meta && session.ready) {
        void this.status(session.meta.sessionKey, 'ready');
      }
    }
    // The catalog doesn't always know a live session's keys, nor the schedule its circuit, but the feed's own details do.
    if (record.topic === 'SessionInfo') {
      const circuitKey = Number((record.data as { Meeting?: { Circuit?: { Key?: unknown } } })?.Meeting?.Circuit?.Key);
      if (circuitKey > 0) this.startCircuit(session.generation, circuitKey);
    }
    if (!session.meta && record.topic === 'SessionInfo') {
      const info = record.data as { Key?: unknown; Meeting?: { Key?: unknown } };
      const sessionKey = Number(info?.Key);
      const meetingKey = Number(info?.Meeting?.Key);
      if (sessionKey && meetingKey) {
        void this.beginLive(session, { sessionKey, meetingKey, isRace: this.isRace(session.query) }).catch((e: Error) => {
          console.warn('[timingdb] opening failed:', e.message);
          if (this.live === session) this.refuse('failed', e.message);
        });
      }
    }
  }

  /** The connection dropped or came back, so the capture has a gap or the gap is over. */
  private liveConnection(status: string, at = Date.now()): void {
    const session = this.live;
    if (!session?.ready || !session.meta) return;
    const key = session.meta.sessionKey;
    if (status === 'connected') void this.call('liveGap', key, false, at);
    else if (status === 'disconnected' || status === 'reconnecting') void this.call('liveGap', key, true, at);
  }

  private async flushLive(): Promise<void> {
    const session = this.live;
    if (!session?.meta || !session.ready || session.buffer.length === 0) return;
    const records = session.buffer;
    session.buffer = [];
    const written = await this.call('liveAppend', records).then(
      () => true,
      (e: Error) => (console.warn('[timingdb] live write failed:', e.message), false),
    );
    // Telemetry comes only on a socket with the F1 TV token, so the status sent on opening said it had none.
    if (written && !session.telemetry && this.live === session && records.some((r) => (TELEMETRY_FEEDS as readonly string[]).includes(r.topic))) {
      session.telemetry = true;
      await this.status(session.meta.sessionKey, 'ready');
    }
  }

  private endLive(): void {
    const session = this.live;
    if (!session) return;
    this.live = null;
    if (session.backfillTimer) {
      clearTimeout(session.backfillTimer);
      session.backfillTimer = null;
    }
    if (session.onFirstDirect) {
      const notify = session.onFirstDirect;
      session.onFirstDirect = null;
      notify();
    }
    this.deps.disconnectLive();
    if (session.timer) clearInterval(session.timer);
    if (session.ready && session.meta && session.buffer.length) void this.call('liveAppend', session.buffer).catch(() => {});
    void this.call('liveEnd').catch(() => {});
  }

  // --- Reads ---

  objects(sessionKey: number, playheadMs: number): Promise<SessionObjects> {
    return this.call('objects', sessionKey, playheadMs);
  }

  sql(sessionKey: number, playheadMs: number, sql: string, params: unknown[]): Promise<SqlRows> {
    return this.call('sql', sessionKey, playheadMs, sql, params);
  }
}
