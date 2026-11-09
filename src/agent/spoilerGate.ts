/**
 * Asks before the agent learns or shows what the viewer hasn't seen yet: reading the session past the
 * playhead, or seeking forward. Every such tool call asks once, before anything runs, so no row reaches
 * the model and no stream moves unapproved. See docs/DESIGN.md.
 */

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

/** Approves everything for now. It will become a prompt asking the user. */
export async function spoilerGate(_request: SpoilerRequest): Promise<SpoilerDecision> {
  return { approved: true };
}
