/**
 * Fills the database from F1's archive files or a live capture, and decides when a session is done.
 * Knows nothing of the network: whoever calls it brings the files.
 *
 * `visible_from` is when each message reached the feed: the clock base plus the message's offset for an
 * archive, or the arrival time for a live capture. A replay's playhead uses the same clock base, and a
 * live one the same wall clock, so a row only ever shows once the video has reached it.
 */
import zlib from 'node:zlib';
import { computeFeedBaseUtc, parseUtc, readFeedClock } from '../../shared/feedTime';
import type { Dataset, SessionResultEntry, StartingGridEntry } from '../../shared/sessionData';
import { telemetryRouter, TELEMETRY_FEEDS, timingRouter, TIMING_FEEDS, type Message, type SessionMeta } from './processors';
import type { IngestDetail, TimingStore } from './store';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A finished session's files can still change for a while. After this they're final even if the feed never said so. */
const ARCHIVE_SETTLE_MS = 3 * 24 * 3600 * 1000;
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

/**
 * Builds a session from a live feed as it comes. Every message is also kept, since the processors'
 * state is only in memory: restarting the app mid-session rebuilds from them, then carries on.
 */
export class LiveCapture {
  private router;
  private seq = 0;

  constructor(private store: TimingStore, readonly meta: SessionMeta, now: number) {
    this.router = timingRouter(meta);
    const kept = store.liveMessages(meta.sessionKey);
    store.transaction(() => {
      store.clearDataset(meta.sessionKey, 'timing');
      for (const message of kept) {
        const parsed: Message = { topic: message.topic, content: JSON.parse(message.content), time: message.time, snapshot: message.snapshot === 1 };
        store.write(this.router.process(parsed), message.visible_from);
        this.seq = message.seq + 1;
      }
      store.mark(meta.sessionKey, 'timing', 'partial', 'live', null, { reason: 'Captured live, so it may have gaps.' }, now);
    });
  }

  append(records: LiveRecord[]): void {
    this.store.transaction(() => {
      for (const { topic, data, ts, snapshot, receivedAt } of records) {
        const time = parseUtc(ts) ?? receivedAt;
        this.store.appendLiveMessage(this.meta.sessionKey, this.seq++, topic, time, receivedAt, snapshot === true, data);
        this.store.write(this.router.process({ topic, content: data, time, snapshot }), receivedAt);
      }
    });
  }
}

export const DATASETS: Dataset[] = ['timing', 'results', 'telemetry'];
