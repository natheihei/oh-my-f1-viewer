/**
 * Lining a live session's data up with its video. F1 TV's live stream says what time each frame shows (its
 * program date time), but that time runs ahead of the picture: 7.6-8.0s at the start of Las Vegas FP2 2026, by
 * the countdown on screen. MultiViewer publishes the frame time at the session's start, `session_start_pdt`,
 * and against the feed's own start that gives the lead exactly. It's published some time after the session, so
 * live this is mostly the default in the renderer, and the exact lead takes over when MultiViewer has it.
 */

/** MultiViewer's anchor for a session: the video second of the start on a replay, and the stream's frame time then. */
export interface SyncAnchor {
  sessionStartSec: number | null;
  sessionStartPdtMs: number | null;
}

/**
 * When the session's clock first started, from a `SessionData` message: practice and qualifying go green then.
 * The status series is a list in the snapshot and an object keyed by index in updates. Null when it hasn't started.
 */
export function startedAt(data: unknown): number | null {
  const series = (data as { StatusSeries?: unknown } | null)?.StatusSeries;
  const entries = Array.isArray(series) ? series : series && typeof series === 'object' ? Object.values(series) : [];
  let first: number | null = null;
  for (const entry of entries as Array<{ SessionStatus?: unknown; Utc?: unknown }>) {
    if (entry?.SessionStatus !== 'Started') continue;
    const at = Date.parse(String(entry.Utc));
    if (Number.isFinite(at) && (first === null || at < first)) first = at;
  }
  return first;
}

/** The leads seen are 7.4-8.0s. Outside this, the two times aren't the same moment, as in a race, whose start is lights out. */
const PLAUSIBLE_LEAD_MS = { min: 3_000, max: 15_000 };

/**
 * How far the live stream's frame time runs ahead of the feed: MultiViewer's frame time at the start, less
 * when the feed says the session started. Null without both, or when they can't be the same moment.
 */
export function liveLeadMs(sessionStartPdtMs: number | null, startedUtc: number | null): number | null {
  if (sessionStartPdtMs === null || startedUtc === null) return null;
  const lead = sessionStartPdtMs - startedUtc;
  return lead >= PLAUSIBLE_LEAD_MS.min && lead <= PLAUSIBLE_LEAD_MS.max ? lead : null;
}

/** Whether there's nothing more to wait for from MultiViewer: a replay needs the video second, live the frame time. */
export function anchorComplete(anchor: SyncAnchor | null, live: boolean): boolean {
  return live ? anchor?.sessionStartPdtMs != null : anchor?.sessionStartSec != null;
}
