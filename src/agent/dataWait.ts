/**
 * Waits for the open session's timing data inside a tool call, so a request made as the session opens, such as
 * "open the race and jump to the start", isn't refused because the data was a few seconds from ready.
 *
 * What's worth waiting for is what clears by itself in seconds: the data still loading, or a live video that
 * hasn't said what time it shows. Everything else is told to the agent at once, since no wait in this turn
 * changes it: data that failed or isn't supported, a replay MultiViewer hasn't lined up, a live video still
 * behind where the capture began.
 *
 * The wait says so in the palette, through whoever the shell registers, and ends with the agent's turn.
 */
import type { SessionDataView } from '../../shared/sessionData';
import { read } from '../host';

/** A tool call gets 60s in electron/agent/agent.ts. This leaves the call itself time to run. */
export const DATA_WAIT_MS = 30_000;
/** Opening a session waits less: it has already spent time opening, and nothing fails if the data isn't there yet. */
export const OPEN_WAIT_MS = 20_000;
const POLL_MS = 200;

export type Readiness =
  | { is: 'ready' }
  /** It should clear by itself: `note` is what the viewer is told meanwhile, and `done` once it has. */
  | { is: 'pending'; note: string; done: string }
  /** It won't clear in this turn: `message` is for the agent, and `settled` is what the viewer is told when a wait ends here. */
  | { is: 'unavailable'; message: string; settled?: string };

const NO_RETRY = "Waiting or trying again in this turn won't change that: tell the user.";

/** Whether the data can be read now. `wholeSession` is a read that doesn't depend on the frame on screen. */
export function readiness(data: SessionDataView, wholeSession = false): Readiness {
  switch (data.state) {
    case 'ready':
      return { is: 'ready' };
    case 'idle':
      // An open session's data is `loading` from the moment it opens, so this is no session's data at all.
      return { is: 'unavailable', message: "This session's timing data isn't available." };
    case 'loading':
      return { is: 'pending', note: 'Loading the timing data…', done: 'Timing data loaded.' };
    case 'waiting':
      if (wholeSession) return { is: 'ready' };
      if (data.brief) return { is: 'pending', note: 'Lining the timing data up with the video…', done: 'Timing data lined up.' };
      return {
        is: 'unavailable',
        message: `The timing data can't be read at the frame on screen yet: ${data.reason}. ${data.detail} ${NO_RETRY}`,
        // The data did load. A wait that began with "Loading…" says so, and why nothing shows yet.
        settled: data.ahead ? "Timing data loaded. It's ahead of the live video, and shows once the video catches up." : `Timing data loaded. ${data.reason}.`,
      };
    case 'failed':
    case 'unsupported':
      return { is: 'unavailable', message: `This session's timing data isn't available. ${data.reason} ${NO_RETRY}` };
  }
}

export type Settled =
  | { is: 'ready' }
  | { is: 'unavailable'; message: string; settled?: string }
  /** Still pending when the time was up. */
  | { is: 'timeout' }
  /** The turn ended or the session changed while waiting. */
  | { is: 'ended'; message: string };

/** Says a line in the palette. */
type Notifier = (text: string) => void;
let notify: Notifier | null = null;

/** Registers who tells the viewer about a wait. Returns a function that unregisters it. */
export function setWaitNotifier(next: Notifier): () => void {
  notify = next;
  return () => {
    if (notify === next) notify = null;
  };
}

/** The turn in progress. Its waits end when it does, so a stopped turn's call never goes on to act. */
let turn = new AbortController();

/** A new turn: the last one's waits end. Returns what ends this one's. */
export function beginTurn(): () => void {
  turn.abort();
  const mine = new AbortController();
  turn = mine;
  return () => mine.abort();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the data can be read, can't be, or the time is up. Resolves at once when nothing is pending. */
export async function settleData({ wholeSession = false, timeoutMs = DATA_WAIT_MS } = {}): Promise<Settled> {
  const first = readiness(read().sessionData, wholeSession);
  if (first.is !== 'pending') return first;
  const { signal } = turn;
  const session = read().session;
  const deadline = Date.now() + timeoutMs;
  notify?.(first.note);
  let { done } = first;
  for (;;) {
    await sleep(POLL_MS);
    if (signal.aborted) return { is: 'ended', message: 'The request ended.' };
    if (read().session !== session) return { is: 'ended', message: 'The session was closed or changed while its timing data was loading.' };
    const now = readiness(read().sessionData, wholeSession);
    if (now.is === 'ready') notify?.(done);
    // Never leave the line that began the wait hanging: say where it ended.
    if (now.is === 'unavailable' && now.settled) notify?.(now.settled);
    if (now.is !== 'pending') return now;
    done = now.done;
    if (Date.now() >= deadline) {
      notify?.('Still loading the timing data.');
      return { is: 'timeout' };
    }
  }
}

/** A gate: waits for the data, and refuses the call when it can't be read. */
export async function requireData(wholeSession = false): Promise<void> {
  const settled = await settleData({ wholeSession });
  if (settled.is === 'ready') return;
  if (settled.is === 'timeout') {
    throw new Error(
      `The timing data still isn't ready after ${DATA_WAIT_MS / 1000}s of waiting. Tell the user it is taking longer than usual and that they can ask again in a moment. Do not call this again in this turn.`,
    );
  }
  throw new Error(settled.message);
}
