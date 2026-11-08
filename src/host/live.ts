/** One read surface over the core's stores. A consumer selects what it needs and re-renders only when that changes. */
import { useSyncExternalStore } from 'react';
import type { Channel, SessionInfo } from '../../shared/api';
import { useSession, type ClockState, type StreamView } from '../data/session';
import { useTiming, type TimingView } from '../data/timing/timingSource';
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
  timing: TimingView;
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
    timing: useTiming.getState(),
  };
}

function subscribe(onChange: () => void): () => void {
  const stops = [useSession.subscribe(onChange), useLayout.subscribe(onChange), useCountdown.subscribe(onChange), useTiming.subscribe(onChange)];
  return () => stops.forEach((stop) => stop());
}

/** Selectors must return a value or an existing reference, not build a new object each call. */
export function useLive<T>(select: (live: Live) => T): T {
  return useSyncExternalStore(subscribe, () => select(read()));
}
