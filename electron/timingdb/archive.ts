/** Whether F1's archive has a session's files yet. Shared by the main process, which fetches them, and the worker, which ingests them. */

/** A finished session's files can still change for a while. After this they're final even if the feed never said so. */
export const ARCHIVE_SETTLE_MS = 3 * 24 * 3600 * 1000;

/**
 * Why a session has no archive files to fetch, and whether to look again while it's open, or null when it has some.
 * F1 lists a session in its index before it publishes the files, with no path: Las Vegas FP2 2026 was listed without
 * one an hour after it ended. One that isn't listed at all may be added later too.
 */
export function archiveMissing(found: { path: string | null | undefined; endMs: number | null } | null, now: number): { reason: string; retry: boolean } | null {
  if (found?.path) return null;
  if (!found) return { reason: "This session wasn't found in the timing archive.", retry: true };
  if (found.endMs !== null && now - found.endMs > ARCHIVE_SETTLE_MS) return { reason: 'The timing archive has nothing for this session.', retry: false };
  return { reason: "F1 hasn't published this session's timing yet. It's checked again every 5 minutes.", retry: true };
}
