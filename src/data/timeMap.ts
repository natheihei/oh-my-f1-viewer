/**
 * Places a video frame on a feed's timeline by the signals actually available, rather than assuming a
 * session type from F1 TV's catalog:
 *   1. Real DASH UTC wall clock (`wallClockMs`) — carried by live/DVR dynamic streams whose
 *      `video.currentTime` counts from `availabilityStartTime` (not VOD 0s). Accurate to 7.6-8.0s
 *      ahead of the picture (`liveLeadMs` from MultiViewer once published, else `LIVE_FRAME_LEAD_MS`).
 *      Must outrank curated VOD `session_start` so a live/DVR stream never applies a VOD offset to
 *      an availabilityStartTime-based `currentTime`.
 *   2. Curated MultiViewer `session_start` + feed `clock` — exact (< 0.5s) for VOD replays (whose
 *      DASH manifests carry no UTC wall clock), working for official archives and full static backfill
 *      captures alike.
 *   3. Otherwise wait: briefly (`awaiting-video`) while the video has not loaded media yet, or
 *      `no-anchor` / `no-feed-clock` once a loaded video proves it carries no UTC wall clock.
 */
import type { FeedClock } from '../../shared/feedTime';

/**
 * How far a live stream's frame time runs ahead of the picture when MultiViewer hasn't published the session's
 * own lead. The picture reached the start 7.6-8.0s after its frame time said so at Las Vegas FP2 2026, by the
 * countdown on screen, and MultiViewer's leads for nine practice and qualifying sessions in 2026 were 7.4-7.8s.
 */
export const LIVE_FRAME_LEAD_MS = 7_600;

export interface TimeMap {
  feedBaseUtc: number | null;
  /** feed offset = video seconds * 1000 + leadInMs. */
  leadInMs: number;
  /** leadInMs comes from MultiViewer's curated sync data, so a replay's frames can be placed. */
  curated: boolean;
  durationMs: number;
}

/** Why a frame can't be placed. */
export type Unplaced =
  /** The video stream hasn't loaded media yet, so we don't know yet whether it carries a UTC wall clock. */
  | 'awaiting-video'
  /** Loaded video carries no UTC wall clock and MultiViewer hasn't published `session_start` yet. */
  | 'no-anchor'
  /** Loaded video carries no UTC wall clock and the feed carries no time anchor. */
  | 'no-feed-clock';

export function buildTimeMap(clock: FeedClock, sessionStartSec: number | null): TimeMap {
  const curated = sessionStartSec != null && Number.isFinite(sessionStartSec);
  const leadInMs = curated
    ? (clock.clockStartOffsetMs ?? clock.scheduledStartOffsetMs ?? 0) - sessionStartSec * 1000
    : (clock.scheduledStartOffsetMs ?? 0);
  return { feedBaseUtc: clock.feedBaseUtc, leadInMs, curated, durationMs: clock.durationMs };
}

/** A replay frame's offset on the feed, kept within it. Only exact when the map is curated. */
export function videoToFeedOffset(map: TimeMap, timeSec: number): number {
  return Math.max(0, Math.min(timeSec * 1000 + map.leadInMs, map.durationMs));
}

/**
 * The frame on screen on the database's clock, or why it can't be placed:
 * real DASH wall clock (`wallClockMs`) first for live/DVR streams, then curated MultiViewer anchor
 * for VOD replays, else waiting.
 */
export function playheadOf(
  map: TimeMap | null,
  timeSec: number,
  wallClockMs: number | null,
  liveLeadMs: number | null = null,
  awaitingWallClock = false,
): number | Unplaced {
  if (wallClockMs !== null) {
    return wallClockMs - (liveLeadMs ?? LIVE_FRAME_LEAD_MS);
  }
  if (map && map.feedBaseUtc !== null && map.curated) {
    return map.feedBaseUtc + videoToFeedOffset(map, timeSec);
  }
  if (awaitingWallClock) return 'awaiting-video';
  if (!map || map.feedBaseUtc === null) return 'no-feed-clock';
  return 'no-anchor';
}

/**
 * The other way: the video second showing a moment on the database's clock, given where the video is
 * now. A wall-clock stream moves by the difference from the frame on screen. A curated replay inverts
 * exactly, kept within the feed. Null when the frame on screen can't be placed.
 */
export function videoTimeOf(
  map: TimeMap | null,
  dateMs: number,
  timeSec: number,
  wallClockMs: number | null,
  liveLeadMs: number | null = null,
  awaitingWallClock = false,
): number | null {
  const playhead = playheadOf(map, timeSec, wallClockMs, liveLeadMs, awaitingWallClock);
  if (typeof playhead !== 'number') return null;
  if (wallClockMs !== null) {
    return timeSec + (dateMs - playhead) / 1000;
  }
  const offset = Math.max(0, Math.min(dateMs - map!.feedBaseUtc!, map!.durationMs));
  return (offset - map!.leadInMs) / 1000;
}
