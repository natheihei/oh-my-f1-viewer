/** One read surface over the core's stores. A consumer selects what it needs and re-renders only when that changes. */
import { useSyncExternalStore } from 'react';
import type { Channel, ScheduleView, SessionDataView, SessionInfo } from '../../shared/api';
import { useSession, type ClockState, type StreamView } from '../data/session';
import { useSchedule, useSessionData } from '../data/sessionData';
import type { LayoutState } from '../layout/model';
import { useLayout } from '../layout/store';
import { useCountdown, type Countdown } from './viewing';

export interface Live {
  session: SessionInfo | null;
  feeds: Channel[];
  streams: Record<string, StreamView>;
  /** The feed that's audible, if any. */
  audio: string | null;
  /** Master level from 0 to 1. */
  volume: number;
  clock: ClockState;
  layout: LayoutState;
  countdown: Countdown | null;
  /** Every meeting and session from 2023 on. Refreshed each time the app starts. */
  schedule: ScheduleView;
  /** The open session's roster and results, as they stood at the frame on screen. */
  sessionData: SessionDataView;
}

export function read(): Live {
  const { session, channels, streams, audioChannelId, volume, clock } = useSession.getState();
  return {
    session,
    feeds: channels,
    streams,
    audio: audioChannelId,
    volume,
    clock,
    layout: useLayout.getState(),
    countdown: useCountdown.getState().countdown,
    schedule: useSchedule.getState(),
    sessionData: useSessionData.getState(),
  };
}

function subscribe(onChange: () => void): () => void {
  const stops = [
    useSession.subscribe(onChange),
    useLayout.subscribe(onChange),
    useCountdown.subscribe(onChange),
    useSchedule.subscribe(onChange),
    useSessionData.subscribe(onChange),
  ];
  return () => stops.forEach((stop) => stop());
}

/** Selectors must return a value or an existing reference, not build a new object each call. */
export function useLive<T>(select: (live: Live) => T): T {
  return useSyncExternalStore(subscribe, () => select(read()));
}
