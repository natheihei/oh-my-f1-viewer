/**
 * Maps video positions to timing-feed offsets. Ported from F1OpenViewer's useReplayTiming.
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
 * Used first, timing would show events 15s before they happen on screen.
 */

type Rec = { offsetMs: number; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
export type FeedsByName = Record<string, Rec[] | undefined>;

/** Wall-clock UTC of feed offset 0. Any record with a Utc anchors it: baseUtc = Utc - offsetMs. */
export function computeFeedBaseUtc(byFeed: FeedsByName): number | null {
  const anchor = (offsetMs: number, utc: unknown): number | null => {
    const t = Date.parse(String(utc));
    return Number.isFinite(t) ? t - offsetMs : null;
  };
  for (const rec of byFeed.ExtrapolatedClock ?? []) {
    const base = rec?.data?.Utc != null ? anchor(rec.offsetMs, rec.data.Utc) : null;
    if (base != null) return base;
  }
  for (const rec of byFeed.RaceControlMessages ?? []) {
    const msgs = rec?.data?.Messages;
    const list = Array.isArray(msgs) ? msgs : msgs ? Object.values(msgs) : [];
    for (const m of list as Array<{ Utc?: unknown }>) {
      if (m?.Utc) {
        const base = anchor(rec.offsetMs, m.Utc);
        if (base != null) return base;
      }
    }
  }
  return null;
}

/** Scheduled start as UTC ms, from SessionInfo (StartDate is local time plus a GmtOffset field). */
export function computeSessionStartUtc(byFeed: FeedsByName): number | null {
  const info = byFeed.SessionInfo?.[0]?.data;
  if (!info?.StartDate) return null;
  const localMs = Date.parse(`${info.StartDate}Z`);
  if (!Number.isFinite(localMs)) return null;
  const m = String(info.GmtOffset || '00:00:00').match(/^(-)?(\d{1,2}):(\d{2})/);
  const offsetMs = m ? (m[1] ? -1 : 1) * ((Number(m[2]) * 60 + Number(m[3])) * 60_000) : 0;
  return localMs - offsetMs;
}

/**
 * Feed offset where the session clock starts running: lights out for a race, green for practice
 * and qualifying. SessionInfo's scheduled start is one formation lap earlier, so it is only a fallback.
 */
export function computeClockStartOffset(byFeed: FeedsByName): number | null {
  for (const rec of byFeed.ExtrapolatedClock ?? []) {
    if (rec?.data?.Extrapolating === true) return rec.offsetMs;
  }
  return null;
}

export interface TimeMap {
  feedBaseUtc: number | null;
  /** feed offset = video seconds * 1000 + leadInMs. */
  leadInMs: number;
  /** leadInMs comes from the curated sync data, so it beats the wall clock. */
  curated: boolean;
  durationMs: number;
}

export function buildTimeMap(byFeed: FeedsByName, durationMs: number, sessionStartSec: number | null): TimeMap {
  const feedBaseUtc = computeFeedBaseUtc(byFeed);
  let leadInMs = 0;
  const curated = sessionStartSec != null && Number.isFinite(sessionStartSec);
  if (sessionStartSec != null && curated) {
    let clockStart = computeClockStartOffset(byFeed);
    if (clockStart == null) {
      const startUtc = computeSessionStartUtc(byFeed);
      clockStart = startUtc != null && feedBaseUtc != null ? startUtc - feedBaseUtc : 0;
    }
    leadInMs = clockStart - sessionStartSec * 1000;
  } else {
    const startUtc = computeSessionStartUtc(byFeed);
    if (startUtc != null && feedBaseUtc != null) leadInMs = startUtc - feedBaseUtc;
  }
  return { feedBaseUtc, leadInMs, curated, durationMs };
}

export function videoToFeedOffset(map: TimeMap, timeSec: number, wallClockMs: number | null): number {
  const useWallClock = !map.curated && wallClockMs != null && map.feedBaseUtc != null;
  const raw = useWallClock ? wallClockMs - map.feedBaseUtc! : timeSec * 1000 + map.leadInMs;
  return Math.max(0, Math.min(raw, map.durationMs));
}

/**
 * Holds live timing records until the video reaches them. F1 TV's live video runs tens of seconds
 * behind the feed, so applying records on arrival would show what has not happened on screen yet.
 * Records are stamped on arrival, which is close enough to broadcast time for this purpose.
 *
 * Every record is kept, because rewinding the live video has to rewind timing too, and records are
 * deltas that can't be undone: the store has to be rebuilt from the start.
 */
export class LiveFeedBuffer<T> {
  private log: Array<{ atMs: number; record: T }> = [];
  private applied = 0;
  private position = -Infinity;

  push(record: T, arrivedAtMs: number): void {
    this.log.push({ atMs: arrivedAtMs, record });
  }

  /**
   * What to apply to reach this video wall-clock time. With no clock to align to, everything is
   * due. `reset` means the video moved backward, so the store must start over from these records.
   */
  advance(videoWallClockMs: number | null): { reset: boolean; records: T[] } {
    const target = videoWallClockMs ?? Infinity;
    const reset = target < this.position;
    this.position = target;
    if (reset) this.applied = 0;
    const start = this.applied;
    while (this.applied < this.log.length && this.log[this.applied].atMs <= target) this.applied += 1;
    return { reset, records: this.log.slice(start, this.applied).map((q) => q.record) };
  }

  /** Records that have arrived but aren't on screen yet. */
  get held(): number {
    return this.log.length - this.applied;
  }
}
