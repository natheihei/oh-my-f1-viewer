/**
 * What opening a session means for the whole app: data opens it, the layout starts with the main
 * broadcast. Also owns the countdown to an upcoming session. Agent tools and commands both go
 * through here instead of each coordinating the layers themselves.
 */
import { create } from 'zustand';
import type { Channel, SessionInfo } from '../../shared/api';
import { videoSpec } from '../components/VideoTile';
import { closeSession, openSession, useSession } from '../data/session';
import { layout } from '../layout/store';

export interface Countdown {
  title: string;
  startMs: number;
  meetingKey?: number;
  sessionKey?: number;
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

export async function openViewingSession(session: SessionInfo): Promise<Channel[]> {
  stopCountdown();
  layout.clear();
  const channels = await openSession(session);
  const main = mainChannel(channels);
  if (main) layout.add(videoSpec(main.id, main.label));
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

export function startCountdown(target: Countdown, onLive: (session: SessionInfo) => void): void {
  closeViewingSession();
  useCountdown.setState({ countdown: target });
  countdownTimer = setInterval(() => {
    void (async () => {
      if (Date.now() < target.startMs - POLL_WINDOW_MS) return;
      const items = await window.f1a.f1tv.liveNow().catch(() => []);
      const match =
        items.find((i) => target.sessionKey != null && String(i.sessionKey) === String(target.sessionKey)) ??
        items.find((i) => target.meetingKey != null && String(i.meetingKey) === String(target.meetingKey)) ??
        null;
      if (!match) return;
      stopCountdown();
      onLive({
        contentId: match.contentId,
        title: match.title || target.title,
        type: 'other',
        year: new Date(target.startMs).getUTCFullYear(),
        startMs: target.startMs,
        endMs: null,
        meetingKey: match.meetingKey ?? (target.meetingKey != null ? String(target.meetingKey) : null),
        sessionKey: match.sessionKey ?? (target.sessionKey != null ? String(target.sessionKey) : null),
        hasOnboards: true,
        series: 'FORMULA 1',
        status: 'live',
      });
    })();
  }, POLL_INTERVAL_MS);
}

export function isSessionOpen(): boolean {
  return useSession.getState().session != null;
}
