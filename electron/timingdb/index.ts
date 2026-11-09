/**
 * The main process's side of the session database. It does what needs the network or the F1 TV token
 * and leaves all else to the worker: refreshing the calendar, downloading a session's files unless they
 * are already ingested, and passing on a live feed.
 */
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { TimingQuery } from '../../shared/api';
import {
  FIRST_SUPPORTED_YEAR,
  type DataStatus,
  type Schedule,
  type SessionObjects,
  type SqlRows,
} from '../../shared/sessionData';
import type { FeedFiles, LiveRecord } from './ingest';
import { TELEMETRY_FEEDS, TIMING_FEEDS, type SessionMeta } from './processors';
import { parseResults, parseStartingGrid, resultPages } from './results';
import { fromSeasonIndex, fromUpcoming, mergeSchedule } from './schedule';
import type { WorkerOperations } from './worker';

/** What the database needs from the rest of the main process. */
export interface TimingDbDeps {
  file: string;
  /** A feed's text, or null when the archive doesn't have it. Throws if it couldn't be fetched. */
  fetchFeed(sessionPath: string, feed: string): Promise<string | null>;
  fetchSeasonIndex(year: number): Promise<unknown>;
  /** The video second of lights out, from F1 TV's sync data, or null when there's none. */
  fetchSessionStart(meetingKey: number, sessionKey: number): Promise<number | null>;
  /** Connects to F1's live feed. Problems arrive through `onStatus`. */
  connectLive(feeds: readonly string[], onRecord: (record: LiveRecord) => void, onStatus: (status: string) => void): void;
  disconnectLive(): void;
  /** Null when the page doesn't exist yet. Throws if it couldn't be fetched. */
  fetchPage(url: string): Promise<string | null>;
  resolveSession(year: number, query: TimingQuery): Promise<{ path: string; meetingKey: number; sessionKey: number; type: string | null; name: string | null; endMs: number | null } | null>;
  listUpcoming(): Promise<{ upcoming: Parameters<typeof fromUpcoming>[0]; events: Parameters<typeof fromUpcoming>[1] }>;
  send(channel: string, payload: unknown): void;
}

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };

const LIVE_FLUSH_MS = 250;

export class TimingDb {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  /** Bumped per opened session, so work for one that's been closed stops. */
  private generation = 0;
  /** The open session's video second of lights out. */
  private sessionStartSec: number | null = null;
  private live: { meta: SessionMeta | null; buffer: LiveRecord[]; timer: ReturnType<typeof setInterval> | null; query: TimingQuery } | null = null;

  constructor(private deps: TimingDbDeps) {}

  private call<K extends keyof WorkerOperations>(op: K, ...args: Parameters<WorkerOperations[K]>): Promise<Awaited<ReturnType<WorkerOperations[K]>>> {
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
    const { coverage, clock } = await this.call('status', sessionKey);
    this.deps.send('data:status', { sessionKey, state, reason, coverage, clock, sessionStartSec: this.sessionStartSec } satisfies DataStatus);
  }

  private refuse(state: 'unsupported' | 'failed', reason: string): void {
    this.deps.send('data:status', { sessionKey: null, state, reason, coverage: null, clock: null, sessionStartSec: null } satisfies DataStatus);
  }

  /** Called when a session opens. Replies at once, and reports progress through `data:status`. */
  open(query: TimingQuery, live: boolean): void {
    const generation = ++this.generation;
    this.endLive();
    this.sessionStartSec = null;
    const year = query.year ?? new Date().getUTCFullYear();
    if (year < FIRST_SUPPORTED_YEAR) {
      this.refuse('unsupported', `Session data covers ${FIRST_SUPPORTED_YEAR} onwards.`);
      return;
    }
    const run = live ? this.openLive(query, year) : this.openArchive(query, year, generation);
    run.catch((e: Error) => {
      console.warn('[timingdb] opening failed:', e.message);
      if (generation === this.generation) this.refuse('failed', e.message);
    });
  }

  close(): void {
    this.generation++;
    this.endLive();
  }

  private async openArchive(query: TimingQuery, year: number, generation: number): Promise<void> {
    const found = await this.deps.resolveSession(year, query);
    if (generation !== this.generation) return;
    if (!found) {
      this.refuse('failed', "This session wasn't found in the timing archive.");
      return;
    }
    const meta: SessionMeta = { meetingKey: found.meetingKey, sessionKey: found.sessionKey, isRace: found.type ? found.type.toLowerCase() === 'race' : null };
    const stale = () => generation !== this.generation;

    if (!(await this.call('isComplete', meta.sessionKey, 'timing'))) {
      await this.status(meta.sessionKey, 'loading');
      const feeds = await this.download(found.path, TIMING_FEEDS);
      if (stale()) return;
      await this.call('ingestTiming', meta, feeds, found.endMs);
    }
    if (stale()) return;
    const { coverage } = await this.call('status', meta.sessionKey);
    if (coverage.datasets.timing.state === 'failed') {
      this.refuse('failed', coverage.datasets.timing.reason ?? 'The session data could not be loaded.');
      return;
    }
    this.sessionStartSec = await this.deps.fetchSessionStart(meta.meetingKey, meta.sessionKey).catch(() => null);
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

  private async openLive(query: TimingQuery, year: number): Promise<void> {
    const session = { meta: null as SessionMeta | null, buffer: [] as LiveRecord[], timer: null as ReturnType<typeof setInterval> | null, query };
    this.live = session;
    session.timer = setInterval(() => void this.flushLive(), LIVE_FLUSH_MS);
    this.deps.send('data:status', { sessionKey: null, state: 'loading', reason: null, coverage: null, clock: null, sessionStartSec: null } satisfies DataStatus);
    this.deps.connectLive(TIMING_FEEDS, (record) => this.liveRecord(record), (status) => this.liveConnection(status));
    const found = await this.deps.resolveSession(year, query).catch(() => null);
    if (this.live !== session) return;
    const sessionKey = Number(query.sessionKey ?? found?.sessionKey);
    const meetingKey = Number(query.meetingKey ?? found?.meetingKey);
    if (sessionKey && meetingKey) await this.beginLive(session, { sessionKey, meetingKey, isRace: this.isRace(query) });
  }

  private isRace(query: TimingQuery): boolean | null {
    return query.sessionType ? query.sessionType === 'race' : null;
  }

  private async beginLive(session: NonNullable<TimingDb['live']>, meta: SessionMeta): Promise<void> {
    session.meta = meta;
    await this.call('liveBegin', meta);
    await this.status(meta.sessionKey, 'ready');
  }

  /** A message from the live feed. */
  private liveRecord(record: LiveRecord): void {
    const session = this.live;
    if (!session) return;
    session.buffer.push(record);
    // The catalog doesn't always know a live session's keys, but the feed's own details do.
    if (!session.meta && record.topic === 'SessionInfo') {
      const info = record.data as { Key?: unknown; Meeting?: { Key?: unknown } };
      const sessionKey = Number(info?.Key);
      const meetingKey = Number(info?.Meeting?.Key);
      if (sessionKey && meetingKey) void this.beginLive(session, { sessionKey, meetingKey, isRace: this.isRace(session.query) });
    }
  }

  /** The connection dropped or came back, so the capture has a gap or the gap is over. */
  private liveConnection(status: string, at = Date.now()): void {
    const key = this.live?.meta?.sessionKey;
    if (!key) return;
    if (status === 'connected') void this.call('liveGap', key, false, at);
    else if (status === 'disconnected' || status === 'reconnecting') void this.call('liveGap', key, true, at);
  }

  private async flushLive(): Promise<void> {
    const session = this.live;
    if (!session?.meta || session.buffer.length === 0) return;
    const records = session.buffer;
    session.buffer = [];
    await this.call('liveAppend', records).catch((e: Error) => console.warn('[timingdb] live write failed:', e.message));
  }

  private endLive(): void {
    const session = this.live;
    if (!session) return;
    this.live = null;
    this.deps.disconnectLive();
    if (session.timer) clearInterval(session.timer);
    if (session.meta && session.buffer.length) void this.call('liveAppend', session.buffer).catch(() => {});
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
