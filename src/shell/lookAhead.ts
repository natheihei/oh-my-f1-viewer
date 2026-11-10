/**
 * The spoiler check: asks the viewer before the agent peeks past where they are, and remembers a yes
 * for the rest of the agent's turn or for the open session. One yes covers both reading ahead and
 * seeking forward. See docs/DESIGN.md (Spoiler approval).
 */
import { create } from 'zustand';
import type { SpoilerAsker, SpoilerDecision } from '../agent/spoilerGate';
import { read } from '../host';
import { palette } from './palette';

export type LookAheadAnswer = 'once' | 'session' | 'no';

interface LookAheadState {
  /** A spoiler check is waiting for the viewer. */
  asking: boolean;
  /** The contentId of the session the viewer allowed peeking for, if any. */
  sessionAllowed: number | null;
}

export const useLookAhead = create<LookAheadState>(() => ({ asking: false, sessionAllowed: null }));

let turnAllowed = false;
let pending: ((decision: SpoilerDecision) => void) | null = null;

const APPROVED: SpoilerDecision = { approved: true };

function settle(decision: SpoilerDecision): void {
  const resolve = pending;
  pending = null;
  useLookAhead.setState({ asking: false });
  resolve?.(decision);
}

const currentSession = (): number | null => read().session?.contentId ?? null;

/** Whether peeking is allowed for the open session, without asking. */
export function sessionAllowed(state: LookAheadState, contentId: number | null): boolean {
  return contentId != null && state.sessionAllowed === contentId;
}

export const askViewer: SpoilerAsker = (_request, timedOut) => {
  if (turnAllowed || sessionAllowed(useLookAhead.getState(), currentSession())) return Promise.resolve(APPROVED);
  // Tool calls run one at a time, so an earlier check still open belongs to a call that has gone.
  if (pending) settle({ approved: false });
  return new Promise((resolve) => {
    pending = resolve;
    useLookAhead.setState({ asking: true });
    palette.show();
    timedOut.addEventListener(
      'abort',
      () => {
        if (pending !== resolve) return;
        palette.push('system', "No answer, so the agent didn't look ahead.");
        settle({ approved: false, reason: "they didn't answer" });
      },
      { once: true },
    );
  });
};

export const lookAhead = {
  answer(answer: LookAheadAnswer): void {
    if (!pending) return;
    if (answer === 'no') {
      palette.push('system', 'Not looking ahead.');
      settle({ approved: false });
      return;
    }
    if (answer === 'session') {
      useLookAhead.setState({ sessionAllowed: currentSession() });
      palette.push('system', 'Looking ahead allowed for this session.');
    } else {
      turnAllowed = true;
    }
    settle(APPROVED);
  },
  /** The agent's turn ended or stopped: a yes (once) lapses, and an open check is refused. */
  endTurn(): void {
    turnAllowed = false;
    if (pending) settle({ approved: false, reason: 'the request ended' });
  },
  revokeSession(): void {
    useLookAhead.setState({ sessionAllowed: null });
    palette.push('system', 'Looking ahead will ask again.');
  },
};
