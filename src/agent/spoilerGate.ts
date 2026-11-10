/**
 * Asks before the agent learns or shows what the viewer hasn't seen yet: reading the session past the
 * playhead, or seeking forward. Every such tool call asks once, before anything runs, so no row reaches
 * the model and no stream moves unapproved. The shell registers the asker, which shows the viewer a
 * spoiler check and remembers their approvals. See docs/DESIGN.md.
 */
import { read } from '../host';

/** What a prompt to the user would show. Times are UTC milliseconds on the session data clock. */
export type SpoilerRequest =
  | {
      kind: 'read_ahead';
      session: string;
      /** The frame on screen, if it's known. */
      playheadMs: number | null;
      sql: string;
    }
  | {
      kind: 'seek_forward';
      session: string;
      playheadMs: number | null;
      targetMs: number;
    };

export interface SpoilerDecision {
  approved: boolean;
  /** Why not, in words the agent can pass on. */
  reason?: string;
}

/** Answers a request. The signal aborts when the viewer took too long, which the asker must treat as a refusal. */
export type SpoilerAsker = (request: SpoilerRequest, timedOut: AbortSignal) => Promise<SpoilerDecision>;

/** Under the 60s a tool call gets in electron/agent/agent.ts, so an unanswered prompt reads as a refusal, not a broken app. */
export const ASK_TIMEOUT_MS = 50_000;

let asker: SpoilerAsker | null = null;

/** Registers who asks the viewer. Returns a function that unregisters it. */
export function setSpoilerAsker(next: SpoilerAsker): () => void {
  asker = next;
  return () => {
    if (asker === next) asker = null;
  };
}

export async function spoilerGate(request: SpoilerRequest): Promise<SpoilerDecision> {
  // At the live edge, reading ahead only sees the seconds the feed is ahead of the video.
  const { clock } = read();
  if (request.kind === 'read_ahead' && clock.live && clock.atLiveEdge) return { approved: true };
  if (!asker) return { approved: false, reason: 'the app could not ask them' };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), ASK_TIMEOUT_MS);
  try {
    return await asker(request, timeout.signal);
  } finally {
    clearTimeout(timer);
  }
}
