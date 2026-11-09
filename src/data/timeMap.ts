/**
 * Places a video frame on a feed's timeline. Ported from F1OpenViewer's useReplayTiming.
 *
 * Neither timeline starts at the race start: a replay video has a lead-in (lights out at 512.9s
 * for the 2026 Mexico race), and the feed's offset 0 is its first record, 30-50 minutes before that.
 *
 * In order of preference:
 *   1. the curated session_start from the sync API, bridged by where the feed's clock starts;
 *   2. the stream's wall clock, minus the UTC the feed started;
 *   3. an estimate from the scheduled start, within about a minute.
 *
 * F1OpenViewer treats the wall clock as exact, but measured against the curated lights-out on
 * replays that have one, it runs about 15s ahead (14.73s for 2024 Mexico, 14.99s for 2023 Mexico).
 * Used first, data would show events 15s before they happen on screen.
 */
import type { FeedClock } from '../../shared/feedTime';

export interface TimeMap {
  feedBaseUtc: number | null;
  /** feed offset = video seconds * 1000 + leadInMs. */
  leadInMs: number;
  /** leadInMs comes from the curated sync data, so it beats the wall clock. */
  curated: boolean;
  durationMs: number;
}

export function buildTimeMap(clock: FeedClock, sessionStartSec: number | null): TimeMap {
  const curated = sessionStartSec != null && Number.isFinite(sessionStartSec);
  const leadInMs = curated
    ? (clock.clockStartOffsetMs ?? clock.scheduledStartOffsetMs ?? 0) - sessionStartSec * 1000
    : (clock.scheduledStartOffsetMs ?? 0);
  return { feedBaseUtc: clock.feedBaseUtc, leadInMs, curated, durationMs: clock.durationMs };
}

export function videoToFeedOffset(map: TimeMap, timeSec: number, wallClockMs: number | null): number {
  const useWallClock = !map.curated && wallClockMs != null && map.feedBaseUtc != null;
  const raw = useWallClock ? wallClockMs - map.feedBaseUtc! : timeSec * 1000 + map.leadInMs;
  return Math.max(0, Math.min(raw, map.durationMs));
}

/**
 * The frame on screen on the database's clock. A replay is placed by the map above. A live row is
 * visible from when it arrived, and F1 TV's live video runs tens of seconds behind the feed, so the
 * stream's own wall clock is the right comparison. With no clock to align to, everything is due.
 * Null means the frame can't be placed yet, which shows nothing.
 */
export function playheadOf(live: boolean, map: TimeMap | null, timeSec: number, wallClockMs: number | null): number | 'everything' | null {
  if (live) return wallClockMs ?? 'everything';
  if (!map || map.feedBaseUtc === null) return null;
  return map.feedBaseUtc + videoToFeedOffset(map, timeSec, wallClockMs);
}
