/**
 * Places a video frame on a feed's timeline. Ported from F1OpenViewer's useReplayTiming.
 *
 * Neither timeline starts at the race start: a replay video has a lead-in (lights out at 512.9s
 * for the 2026 Mexico race), and the feed's offset 0 is its first record, 30-50 minutes before that.
 *
 * A frame is only placed when it can be placed to within a second or so. Otherwise the data waits, and
 * says why, rather than show something early:
 *   - a replay needs MultiViewer's curated session_start, bridged by where the feed's clock starts. Its
 *     video has no wall clock, and the scheduled start is only good to about a minute.
 *   - live, the stream's wall clock says what time each frame shows, but it runs ahead of the picture by
 *     MultiViewer's lead when it has published one, or by LIVE_FRAME_LEAD_MS.
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
  /** A replay MultiViewer hasn't published an anchor for. */
  | 'no-anchor'
  /** A replay whose feed has no time on it. */
  | 'no-feed-clock'
  /** A live stream that hasn't said what time it shows. */
  | 'no-wall-clock';

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
 * The frame on screen on the database's clock, or why it can't be placed. A live row is visible from when
 * it arrived, so a live frame is the stream's wall clock less its lead: `liveLeadMs` from MultiViewer, or
 * the default.
 */
export function playheadOf(live: boolean, map: TimeMap | null, timeSec: number, wallClockMs: number | null, liveLeadMs: number | null = null): number | Unplaced {
  if (live) return wallClockMs === null ? 'no-wall-clock' : wallClockMs - (liveLeadMs ?? LIVE_FRAME_LEAD_MS);
  if (!map || map.feedBaseUtc === null) return 'no-feed-clock';
  if (!map.curated) return 'no-anchor';
  return map.feedBaseUtc + videoToFeedOffset(map, timeSec);
}

/**
 * The other way: the video second showing a moment on the database's clock, given where the video is
 * now. A curated replay inverts exactly, kept within the feed. Live moves by the difference from the frame
 * on screen, as the wall clock has no fixed origin. Null when the frame on screen can't be placed.
 */
export function videoTimeOf(
  live: boolean,
  map: TimeMap | null,
  dateMs: number,
  timeSec: number,
  wallClockMs: number | null,
  liveLeadMs: number | null = null,
): number | null {
  const playhead = playheadOf(live, map, timeSec, wallClockMs, liveLeadMs);
  if (typeof playhead !== 'number') return null;
  if (live) return timeSec + (dateMs - playhead) / 1000;
  const offset = Math.max(0, Math.min(dateMs - map!.feedBaseUtc!, map!.durationMs));
  return (offset - map!.leadInMs) / 1000;
}
