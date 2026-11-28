/**
 * Fills the database from F1's archive files or a live capture, and decides when a session is done.
 * Knows nothing of the network: whoever calls it brings the files.
 *
 * `visible_from` is when each message reached the feed: the clock base plus the message's offset for an
 * archive, or the arrival time for a live capture. A replay's playhead uses the same clock base, and a
 * live one the same wall clock, so a row only ever shows once the video has reached it.
 */
import zlib from 'node:zlib';
import { computeFeedBaseUtc, localToUtc, parseUtc, readFeedClock, type FeedClock } from '../../shared/feedTime';
import type { Dataset, SessionResultEntry, StartingGridEntry } from '../../shared/sessionData';
import { telemetryRouter, TELEMETRY_FEEDS, timingRouter, TIMING_FEEDS, type Message, type SessionMeta } from './processors';
import { ARCHIVE_SETTLE_MS } from './archive';
import type { IngestDetail, TimingStore } from './store';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** How many rows to write before letting queries in. */
const TELEMETRY_BATCH_MESSAGES = 2_000;

export interface FeedFiles {
  /** Text of each feed that exists. A feed that's left out doesn't exist for this session. */
  files: Record<string, string>;
  /** Feeds that couldn't be fetched, so what's here may be incomplete. */
  failed: string[];
}

const OFFSET = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;

/** Plain feeds hold JSON on each line. Compressed ones hold quoted base64 of deflated JSON. */
function decode(payload: string): any {
  try {
    const value = JSON.parse(payload);
    if (typeof value !== 'string') return value;
    return JSON.parse(zlib.inflateRawSync(Buffer.from(value, 'base64')).toString('utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function* parseStream(text: string): Iterable<{ offsetMs: number; data: any }> {
  let start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).trim();
    start = end + 1;
    const m = OFFSET.exec(line);
    if (!m) continue;
    const offsetMs = Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4]);
    const data = decode(line.slice(m[0].length));
    if (data !== null) yield { offsetMs, data };
  }
}

const FINISH_STATUSES = ['Finalised', 'Ends'];

/** The first time the feed reports the session over, on the feed's offsets. */
function finishOffset(records: Array<{ offsetMs: number; data: any }>): number | null {
  for (const { offsetMs, data } of records) {
    const series = data?.StatusSeries;
    const items: any[] = Array.isArray(series) ? series : series && typeof series === 'object' ? Object.values(series) : [];
    if (items.some((item) => FINISH_STATUSES.includes(item?.SessionStatus))) return offsetMs;
  }
  return null;
}

/**
 * A dataset is complete when everything needed was fetched and the session is really over: the feed
 * says so, or its scheduled end is long past. Some archives never report the end, and `ArchiveStatus`
 * still says "Generating" in files that have been final for years, so neither can be the only test.
 */
export function isFinal(failed: string[], finishedInFeed: boolean, scheduledEndMs: number | null, now: number): boolean {
  if (failed.length) return false;
  return finishedInFeed || (scheduledEndMs !== null && now - scheduledEndMs > ARCHIVE_SETTLE_MS);
}

/** Replaces a session's timing data with what the archive has. */
export function ingestTiming(store: TimingStore, meta: SessionMeta, { files, failed }: FeedFiles, scheduledEndMs: number | null, now: number): void {
  const records = new Map<string, Array<{ offsetMs: number; data: any }>>();
  for (const feed of TIMING_FEEDS) if (files[feed]) records.set(feed, [...parseStream(files[feed])]);

  const fail = (reason: string) => store.transaction(() => store.mark(meta.sessionKey, 'timing', 'failed', 'archive', null, { reason }, now));
  if (!records.get('TimingData')?.length) {
    fail(failed.length ? "The timing archive couldn't be downloaded." : 'The archive has no timing for this session.');
    return;
  }
  const timeBase = computeFeedBaseUtc(Object.fromEntries(records));
  if (timeBase === null) {
    fail("The archive doesn't say when this session took place.");
    return;
  }

  const messages: Array<Message & { offsetMs: number }> = [];
  for (const [topic, list] of records) {
    if (topic === 'ExtrapolatedClock') continue;
    for (const { offsetMs, data } of list) messages.push({ topic, content: data, time: timeBase + offsetMs, offsetMs });
  }
  messages.sort((a, b) => a.offsetMs - b.offsetMs || (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));

  const router = timingRouter(meta);
  const finished = finishOffset(records.get('SessionData') ?? []);
  const lastOffset = messages[messages.length - 1]?.offsetMs ?? 0;
  const detail: IngestDetail = {
    missingFeeds: TIMING_FEEDS.filter((feed) => !files[feed] && !failed.includes(feed)),
    firstMs: timeBase + (messages[0]?.offsetMs ?? 0),
    finishedMs: timeBase + (finished ?? lastOffset),
    clock: readFeedClock(Object.fromEntries(records), lastOffset),
  };
  const final = isFinal(failed, finished !== null, scheduledEndMs, now);
  if (!final) detail.reason = failed.length ? 'Part of the archive could not be downloaded.' : 'The session may still be in progress.';

  store.transaction(() => {
    store.clearDataset(meta.sessionKey, 'timing');
    for (const message of messages) store.write(router.process(message), message.time);
    store.mark(meta.sessionKey, 'timing', final ? 'complete' : 'partial', 'archive', timeBase, detail, now);
    if (final) store.clearCapture(meta.sessionKey);
  });
}

/** Telemetry is many times larger than the rest, so it comes in batches and lets queries through in between. */
export async function ingestTelemetry(
  store: TimingStore,
  meta: SessionMeta,
  { files, failed }: FeedFiles,
  scheduledEndMs: number | null,
  now: number,
  yieldToQueries: () => Promise<void>,
): Promise<void> {
  const timeBase = store.timeBase(meta.sessionKey);
  if (timeBase === null) return;
  const router = telemetryRouter(meta);
  store.transaction(() => store.clearDataset(meta.sessionKey, 'telemetry'));

  for (const feed of TELEMETRY_FEEDS) {
    if (!files[feed]) continue;
    const pending: Message[] = [];
    const flush = () => {
      store.transaction(() => {
        for (const message of pending) store.write(router.process(message), message.time);
      });
      pending.length = 0;
    };
    for (const { offsetMs, data } of parseStream(files[feed])) {
      pending.push({ topic: feed, content: data, time: timeBase + offsetMs });
      if (pending.length >= TELEMETRY_BATCH_MESSAGES) {
        flush();
        await yieldToQueries();
      }
    }
    flush();
  }

  const missing = TELEMETRY_FEEDS.filter((feed) => !files[feed] && !failed.includes(feed));
  const finishedInFeed = store.isComplete(meta.sessionKey, 'timing');
  const final = isFinal(failed, finishedInFeed, scheduledEndMs, now);
  const detail: IngestDetail = { missingFeeds: missing };
  if (!final) detail.reason = failed.length ? 'Part of the telemetry could not be downloaded.' : 'The session may still be in progress.';
  store.transaction(() => store.mark(meta.sessionKey, 'telemetry', final ? 'complete' : 'partial', 'archive', timeBase, detail, now));
}

/**
 * Stores the published grid and results. The grid can be seen from the moment a session's feed begins,
 * since it's on screen by then, and the results once the session has finished at the playhead.
 */
export function ingestResults(
  store: TimingStore,
  meta: SessionMeta,
  { grid, result, final, failed }: { grid: StartingGridEntry[]; result: SessionResultEntry[]; final: boolean; failed: boolean },
  now: number,
): void {
  const { firstMs, finishedMs } = store.detail(meta.sessionKey, 'timing');
  const key = { session_key: meta.sessionKey, meeting_key: meta.meetingKey };
  const timingFinal = store.isComplete(meta.sessionKey, 'timing');
  store.transaction(() => {
    store.clearDataset(meta.sessionKey, 'results');
    if (firstMs !== undefined) store.write(grid.map((row) => ({ table: 'starting_grid' as const, row: { ...key, ...row } })), firstMs);
    if (finishedMs !== undefined && timingFinal) store.write(result.map((row) => ({ table: 'session_result' as const, row: { ...key, ...row } })), finishedMs);
    const complete = final && !failed && timingFinal;
    store.mark(meta.sessionKey, 'results', complete ? 'complete' : 'partial', 'archive', store.timeBase(meta.sessionKey), complete ? {} : { reason: "The published results aren't available yet." }, now);
  });
}

/** One live feed message as the main process received it. */
export interface LiveRecord {
  topic: string;
  data: unknown;
  /** The time the feed put on it, as sent. */
  ts?: string;
  snapshot?: boolean;
  receivedAt: number;
}

/** Historical live records and known server gaps fetched from the live backfill server. */
export interface LiveBackfillData {
  records: LiveRecord[];
  gaps: Array<{ from: number; to: number | null }>;
}

/**
 * Builds a session from a live feed as it comes. Every message is also kept, since the processors'
 * state is only in memory: restarting the app mid-session rebuilds from them, then carries on.
 */
/** Longer than this between a kept capture's last message and resuming it counts as a gap. Telemetry alone comes about once a second. */
const RESUME_GAP_MS = 5000;
/** How many live messages to replay per transaction before yielding to queries. */
const LIVE_REPLAY_BATCH_MESSAGES = 1_000;

/**
 * Builds a `FeedClock` from live / static backfill capture messages stored in `t_live_messages`, so a full
 * capture can line up with a VOD replay using MultiViewer's curated `session_start` just like an archive.
 *
 * Requires an observed non-snapshot `ExtrapolatedClock` transition (`Extrapolating: false -> true`),
 * anchored on `visible_from` (consistent with `feedBaseUtc`). Late-started captures whose first
 * `ExtrapolatedClock` is already `Extrapolating: true` (e.g. Q2/Q3 or post-red-flag snapshot) return
 * `null` so a VOD replay never shifts ahead and spoils the session (H6).
 */
export function readLiveFeedClock(
  messages: ReadonlyArray<{ topic: string; content: unknown; visible_from: number; snapshot?: boolean }>,
): FeedClock | null {
  if (messages.length === 0) return null;
  let firstMs = Infinity;
  let lastMs = -Infinity;
  let sawNonExtrapolating = false;
  let clockStartVisibleMs: number | null = null;
  let scheduledUtc: number | null = null;
  for (const m of messages) {
    if (m.visible_from < firstMs) firstMs = m.visible_from;
    if (m.visible_from > lastMs) lastMs = m.visible_from;
    if (m.topic === 'ExtrapolatedClock' && clockStartVisibleMs === null) {
      const data = m.content as { Extrapolating?: unknown } | null;
      if (data?.Extrapolating === false) {
        sawNonExtrapolating = true;
      } else if (data?.Extrapolating === true && m.snapshot !== true && sawNonExtrapolating) {
        clockStartVisibleMs = m.visible_from;
      }
    } else if (m.topic === 'SessionInfo' && scheduledUtc === null) {
      const info = m.content as { StartDate?: unknown; GmtOffset?: unknown } | null;
      scheduledUtc = localToUtc(info?.StartDate, info?.GmtOffset ?? '00:00:00');
    }
  }
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || clockStartVisibleMs === null) return null;
  return {
    feedBaseUtc: firstMs,
    clockStartOffsetMs: clockStartVisibleMs - firstMs,
    scheduledStartOffsetMs: scheduledUtc !== null ? scheduledUtc - firstMs : null,
    durationMs: Math.max(0, lastMs - firstMs),
  };
}

export class LiveCapture {
  private router;
  private telemetry;
  private telemetryMarked = false;
  private seq = 0;

  constructor(private store: TimingStore, readonly meta: SessionMeta, private now: number, init = true) {
    this.router = timingRouter(meta);
    this.telemetry = telemetryRouter(meta);
    if (!init) return;
    const kept = store.liveMessages(meta.sessionKey);
    store.transaction(() => {
      store.clearDataset(meta.sessionKey, 'timing');
      store.clearDataset(meta.sessionKey, 'telemetry');
      for (const message of kept) {
        const parsed: Message = { topic: message.topic, content: JSON.parse(message.content), time: message.time, snapshot: message.snapshot === 1 };
        this.write(parsed, message.visible_from);
        this.seq = message.seq + 1;
      }
      const clock = readLiveFeedClock(
        kept.map((m) => ({ topic: m.topic, content: JSON.parse(m.content), visible_from: m.visible_from, snapshot: m.snapshot === 1 })),
      );
      store.mark(meta.sessionKey, 'timing', 'partial', 'live', clock?.feedBaseUtc ?? null, { reason: 'Captured live, so it may have gaps.', ...(clock ? { clock } : {}) }, now);
      // Resuming a capture, after a restart or reopening the session, leaves out what came while nothing listened.
      if (kept.length) {
        const last = kept.reduce((latest, message) => Math.max(latest, message.visible_from), -Infinity);
        if (now - last > RESUME_GAP_MS) store.openGap(meta.sessionKey, last);
        store.closeGap(meta.sessionKey, now);
      }
    });
  }

  /** Whether telemetry rows have been written (from kept messages, backfill, or live updates). */
  get hasTelemetry(): boolean {
    return this.telemetryMarked;
  }

  /**
   * Starts a live capture asynchronously, replaying any locally kept messages and optional server backfill
   * in chunks so large backfills don't block the worker thread. Returns null if cancelled mid-replay.
   */
  static async start(
    store: TimingStore,
    meta: SessionMeta,
    now: number,
    backfill: LiveBackfillData | null,
    yieldToQueries: () => Promise<void>,
    cancelled?: () => boolean,
    batchSize = LIVE_REPLAY_BATCH_MESSAGES,
  ): Promise<LiveCapture | null> {
    const capture = new LiveCapture(store, meta, now, false);
    const kept = store.liveMessages(meta.sessionKey);
    const lastKept = kept.length ? kept.reduce((latest, message) => Math.max(latest, message.visible_from), -Infinity) : null;
    const incoming = backfill
      ? lastKept !== null
        ? backfill.records.filter((record) => record.receivedAt > lastKept)
        : backfill.records
      : [];

    store.transaction(() => {
      store.clearDataset(meta.sessionKey, 'timing');
      store.clearDataset(meta.sessionKey, 'telemetry');
    });

    const clockMessages: Array<{ topic: string; content: unknown; visible_from: number; snapshot?: boolean }> = [];
    for (let i = 0; i < kept.length; i += batchSize) {
      if (cancelled?.()) return null;
      const chunk = kept.slice(i, i + batchSize);
      store.transaction(() => {
        for (const message of chunk) {
          const content = JSON.parse(message.content);
          const parsed: Message = { topic: message.topic, content, time: message.time, snapshot: message.snapshot === 1 };
          capture.write(parsed, message.visible_from);
          capture.seq = message.seq + 1;
          clockMessages.push({ topic: message.topic, content, visible_from: message.visible_from, snapshot: message.snapshot === 1 });
        }
      });
      if (i + batchSize < kept.length) await yieldToQueries();
    }

    for (let i = 0; i < incoming.length; i += batchSize) {
      if (cancelled?.()) return null;
      const chunk = incoming.slice(i, i + batchSize);
      store.transaction(() => {
        for (const { topic, data, ts, snapshot, receivedAt } of chunk) {
          const time = parseUtc(ts) ?? receivedAt;
          store.appendLiveMessage(meta.sessionKey, capture.seq++, topic, time, receivedAt, snapshot === true, data);
          capture.write({ topic, content: data, time, snapshot }, receivedAt);
          clockMessages.push({ topic, content: data, visible_from: receivedAt, snapshot: snapshot === true });
        }
      });
      if (i + batchSize < incoming.length) await yieldToQueries();
    }

    if (cancelled?.()) return null;

    const clock = readLiveFeedClock(clockMessages);
    store.transaction(() => {
      if (incoming.length > 0) {
        if (lastKept !== null) {
          const firstBackfillMs = incoming[0].receivedAt;
          if (firstBackfillMs - lastKept > RESUME_GAP_MS) store.openGap(meta.sessionKey, lastKept);
          store.closeGap(meta.sessionKey, firstBackfillMs);
        }
        for (const gap of backfill?.gaps ?? []) {
          if (lastKept !== null && gap.to !== null && gap.to <= lastKept) continue;
          store.recordGap(meta.sessionKey, gap.from, gap.to);
        }
      } else if (lastKept !== null) {
        if (now - lastKept > RESUME_GAP_MS) store.openGap(meta.sessionKey, lastKept);
        store.closeGap(meta.sessionKey, now);
      }
      store.mark(meta.sessionKey, 'timing', 'partial', 'live', clock?.feedBaseUtc ?? null, { reason: 'Captured live, so it may have gaps.', ...(clock ? { clock } : {}) }, now);
    });

    return capture;
  }

  append(records: LiveRecord[]): void {
    this.store.transaction(() => {
      for (const { topic, data, ts, snapshot, receivedAt } of records) {
        const time = parseUtc(ts) ?? receivedAt;
        this.store.appendLiveMessage(this.meta.sessionKey, this.seq++, topic, time, receivedAt, snapshot === true, data);
        this.write({ topic, content: data, time, snapshot }, receivedAt);
      }
    });
  }

  /**
   * Atomically merges newly arrived background timing backfill records with any already-captured
   * local timing messages inside a single SQLite WAL transaction so live charts never flash empty
   * and telemetry rows are untouched.
   */
  mergeTimingBackfill(
    records: readonly LiveRecord[],
    gaps: ReadonlyArray<{ from: number; to: number | null }>,
    now: number,
  ): { written: number; capturedFrom: number | null } {
    const incomingTiming = records.filter((r) => !(TELEMETRY_FEEDS as readonly string[]).includes(r.topic));
    if (incomingTiming.length === 0 && gaps.length === 0) {
      return { written: 0, capturedFrom: this.store.coverage(this.meta.sessionKey).capturedFrom };
    }

    type NormalizedMsg = {
      topic: string;
      content: unknown;
      contentJson: string;
      time: number;
      visible_from: number;
      snapshot: boolean;
      fromBackfill: boolean;
      order: number;
    };

    const existing = this.store.liveTimingMessages(this.meta.sessionKey);
    const seenKeys = new Set<string>();
    const combined: NormalizedMsg[] = [];
    let order = 0;

    for (const r of incomingTiming) {
      const contentJson = JSON.stringify(r.data);
      const dedupKey = `${r.receivedAt}|${r.topic}|${r.snapshot ? 1 : 0}|${contentJson}`;
      if (seenKeys.has(dedupKey)) continue;
      seenKeys.add(dedupKey);
      combined.push({
        topic: r.topic,
        content: r.data,
        contentJson,
        time: parseUtc(r.ts) ?? r.receivedAt,
        visible_from: r.receivedAt,
        snapshot: r.snapshot === true,
        fromBackfill: true,
        order: order++,
      });
    }

    let addedCount = 0;
    const existingKeys = new Set<string>();
    for (const m of existing) {
      const dedupKey = `${m.visible_from}|${m.topic}|${m.snapshot}|${m.content}`;
      existingKeys.add(dedupKey);
    }
    for (const msg of combined) {
      const dedupKey = `${msg.visible_from}|${msg.topic}|${msg.snapshot ? 1 : 0}|${msg.contentJson}`;
      if (!existingKeys.has(dedupKey)) addedCount++;
    }

    for (const m of existing) {
      const dedupKey = `${m.visible_from}|${m.topic}|${m.snapshot}|${m.content}`;
      if (seenKeys.has(dedupKey)) continue;
      seenKeys.add(dedupKey);
      combined.push({
        topic: m.topic,
        content: JSON.parse(m.content),
        contentJson: m.content,
        time: m.time,
        visible_from: m.visible_from,
        snapshot: m.snapshot === 1,
        fromBackfill: false,
        order: order++,
      });
    }

    combined.sort(
      (a, b) =>
        a.visible_from - b.visible_from ||
        (a.fromBackfill === b.fromBackfill ? a.order - b.order : a.fromBackfill ? -1 : 1),
    );

    const nextRouter = timingRouter(this.meta);
    const clock = readLiveFeedClock(
      combined.map((m) => ({ topic: m.topic, content: m.content, visible_from: m.visible_from, snapshot: m.snapshot })),
    );

    this.store.transaction(() => {
      const startSeq = Math.max(this.seq, this.store.liveMaxSeq(this.meta.sessionKey) + 1);
      this.store.clearLiveTimingMessages(this.meta.sessionKey);
      this.store.clearDataset(this.meta.sessionKey, 'timing');
      let seq = startSeq;
      for (const m of combined) {
        this.store.appendLiveMessage(this.meta.sessionKey, seq++, m.topic, m.time, m.visible_from, m.snapshot, m.content);
        this.store.write(nextRouter.process({ topic: m.topic, content: m.content, time: m.time, snapshot: m.snapshot }), m.visible_from);
      }
      this.seq = seq;
      for (const gap of gaps) {
        this.store.recordGap(this.meta.sessionKey, gap.from, gap.to);
      }
      this.store.mark(
        this.meta.sessionKey,
        'timing',
        'partial',
        'live',
        clock?.feedBaseUtc ?? null,
        { reason: 'Captured live, so it may have gaps.', ...(clock ? { clock } : {}) },
        now,
      );
    });

    this.router = nextRouter;
    return { written: addedCount, capturedFrom: this.store.coverage(this.meta.sessionKey).capturedFrom };
  }

  /**
   * Appends backfilled records (such as background telemetry) to an active live capture in chunked
   * transactions so queries and live updates can interleave between batches. Stops cleanly if
   * `cancelled()` becomes true between batches.
   */
  async appendBackfill(
    records: readonly LiveRecord[],
    yieldToQueries: () => Promise<void>,
    cancelled?: () => boolean,
    batchSize = LIVE_REPLAY_BATCH_MESSAGES,
  ): Promise<number> {
    let written = 0;
    for (let i = 0; i < records.length; i += batchSize) {
      if (cancelled?.()) return written;
      const chunk = records.slice(i, i + batchSize);
      this.store.transaction(() => {
        for (const { topic, data, ts, snapshot, receivedAt } of chunk) {
          const time = parseUtc(ts) ?? receivedAt;
          this.store.appendLiveMessage(this.meta.sessionKey, this.seq++, topic, time, receivedAt, snapshot === true, data);
          this.write({ topic, content: data, time, snapshot }, receivedAt);
          written++;
        }
      });
      if (i + batchSize < records.length) await yieldToQueries();
    }
    return written;
  }

  /**
   * Telemetry comes only when the socket carries the F1 TV token, so its dataset is marked once some arrives.
   * Like the timing, a row is held back until the video reaches the moment it arrived.
   */
  private write(message: Message, visibleFrom: number): void {
    if ((TELEMETRY_FEEDS as readonly string[]).includes(message.topic)) {
      this.store.write(this.telemetry.process(message), visibleFrom);
      if (!this.telemetryMarked) {
        this.telemetryMarked = true;
        this.store.mark(this.meta.sessionKey, 'telemetry', 'partial', 'live', null, { reason: 'Captured live, so it may have gaps.' }, this.now);
      }
      return;
    }
    this.store.write(this.router.process(message), visibleFrom);
  }
}

export const DATASETS: Dataset[] = ['timing', 'results', 'telemetry'];
