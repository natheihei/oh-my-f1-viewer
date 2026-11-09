/** Reading times out of F1's timing feeds. Pure, and shared by both processes. */

type Rec = { offsetMs: number; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
export type FeedsByName = Record<string, Rec[] | undefined>;

/**
 * Wall-clock UTC of feed offset 0. Any record with a Utc anchors it: baseUtc = Utc - offsetMs.
 * The replay's playhead and the database's `visible_from` both use this, so they always agree.
 */
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

/** What it takes to place a video frame on a feed's timeline. Read once, when a session is ingested. */
export interface FeedClock {
  /** Wall-clock UTC of feed offset 0. */
  feedBaseUtc: number | null;
  /** Feed offset of lights out or green. */
  clockStartOffsetMs: number | null;
  /** Feed offset of the scheduled start, which is a formation lap early. */
  scheduledStartOffsetMs: number | null;
  /** Feed offset of the last message. */
  durationMs: number;
}

export function readFeedClock(byFeed: FeedsByName, durationMs: number): FeedClock {
  const feedBaseUtc = computeFeedBaseUtc(byFeed);
  const info = byFeed.SessionInfo?.[0]?.data;
  const scheduled = localToUtc(info?.StartDate, info?.GmtOffset ?? '00:00:00');
  return {
    feedBaseUtc,
    clockStartOffsetMs: computeClockStartOffset(byFeed),
    scheduledStartOffsetMs: scheduled !== null && feedBaseUtc !== null ? scheduled - feedBaseUtc : null,
    durationMs,
  };
}

/** A feed timestamp as UTC milliseconds. The feeds often leave off the time zone, and always mean UTC. */
export function parseUtc(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const t = Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(t) ? t : null;
}

/** Local time plus a GmtOffset such as "-03:00:00", as UTC milliseconds. */
export function localToUtc(local: unknown, gmtOffset: unknown): number | null {
  if (typeof local !== 'string' || !local) return null;
  const t = Date.parse(`${local.replace(/[zZ]$/, '')}Z`);
  if (!Number.isFinite(t)) return null;
  const m = String(gmtOffset ?? '').match(/^([+-])?(\d{1,2}):(\d{2})/);
  if (!m) return t;
  const offsetMs = (Number(m[2]) * 60 + Number(m[3])) * 60_000;
  return m[1] === '-' ? t + offsetMs : t - offsetMs;
}
