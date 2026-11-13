/**
 * What opening a session means for the whole app: data opens it, the layout starts with the main
 * broadcast. Also owns the countdown to an upcoming session.
 */
import { create } from 'zustand';
import type { Channel, SessionInfo } from '../../shared/api';
import { catalog } from '../data/catalog';
import { closeSession, openSession } from '../data/session';
import { layout } from '../layout/store';
import { specOf } from './components';

export interface Countdown {
  title: string;
  startMs: number;
  session: SessionInfo;
}

export const useCountdown = create<{ countdown: Countdown | null }>(() => ({ countdown: null }));

let countdownTimer: ReturnType<typeof setInterval> | null = null;

function stopCountdown(): void {
  if (countdownTimer != null) clearInterval(countdownTimer);
  countdownTimer = null;
  useCountdown.setState({ countdown: null });
}

export function mainChannel(channels: Channel[]): Channel | undefined {
  return channels.find((c) => c.kind === 'main') ?? channels[0];
}

export async function openViewingSession(session: SessionInfo, options: { fromStart?: boolean } = {}): Promise<Channel[]> {
  stopCountdown();
  layout.clear();
  const channels = await openSession(session, options);
  const main = mainChannel(channels);
  if (main) {
    layout.add(specOf({ type: 'video', props: { feed: main.id } }));
    // The one tile that is given the main place: nothing else is, unless something asks for it.
    layout.setMain(main.id);
  }
  return channels;
}

export function closeViewingSession(): void {
  stopCountdown();
  layout.clear();
  closeSession();
}

/** Polling starts this close to the start, and continues while the session is late going live. */
const POLL_WINDOW_MS = 20 * 60_000;
const POLL_INTERVAL_MS = 15_000;

/**
 * Waits for one specific session to go live. Matching is on contentId alone: F1 TV assigns it ahead
 * of time and the live list reports the same one, while matching on the event would also fire for a
 * pre-race show going on air first.
 */
export function startCountdown(session: SessionInfo, onLive: (session: SessionInfo) => void): void {
  closeViewingSession();
  const startMs = session.startMs ?? Date.now();
  useCountdown.setState({ countdown: { title: session.title, startMs, session } });
  countdownTimer = setInterval(() => {
    void (async () => {
      if (Date.now() < startMs - POLL_WINDOW_MS) return;
      const items = await catalog.liveNow().catch(() => []);
      if (!items.some((i) => i.contentId === session.contentId)) return;
      stopCountdown();
      onLive({ ...session, status: 'live' });
    })();
  }, POLL_INTERVAL_MS);
}
