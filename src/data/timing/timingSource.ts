/**
 * Timing data locked to the session clock. Upper layers read `useTiming` and only ever see the
 * state of the race at the frame on screen, whether replaying or live. Missing data is part of the
 * data: the state says why there's none. A failure here never affects video.
 */
import { create } from 'zustand';
import type { SessionInfo, TimingQuery } from '../../../shared/api';
import { buildTimeline, timelineDuration, type FeedRecord } from '../vendor/replay';
import { ReplayController } from '../vendor/replayController';
import {
  applyRecord,
  createStore,
  selectClock,
  selectDrivers,
  selectLapCount,
  selectRaceControl,
  selectTeamRadio,
  selectTrackStatus,
  selectWeather,
  stabilizeRows,
  type DriverRow,
  type RaceControlMessage,
  type TeamRadioClip,
  type TimingStore,
  type WeatherView,
} from '../vendor/timing';
import { buildTimeMap, LiveFeedBuffer, videoToFeedOffset, type TimeMap } from './timeMap';

export interface TimingData {
  drivers: DriverRow[];
  weather: WeatherView | null;
  trackStatus: { status: string; label: string } | null;
  raceControl: RaceControlMessage[];
  sessionClock: { remaining: string; extrapolating: boolean } | null;
  lapCount: { current: number; total: number } | null;
  teamRadio: TeamRadioClip[];
  /** Live records received but held back because the video hasn't reached them. */
  heldRecords: number;
}

/** Whether there's timing, and why not if there isn't. The data only exists once it's ready. */
export type TimingView =
  | { state: 'idle' } // No session is open.
  | { state: 'loading'; heldRecords: number }
  | { state: 'failed'; reason: string }
  | ({ state: 'ready' } & TimingData);

const IDLE: TimingView = { state: 'idle' };
const LOADING: TimingView = { state: 'loading', heldRecords: 0 };

const NO_DATA: TimingData = {
  drivers: [],
  weather: null,
  trackStatus: null,
  raceControl: [],
  sessionClock: null,
  lapCount: null,
  teamRadio: [],
  heldRecords: 0,
};

export const useTiming = create<TimingView>(() => IDLE);

function set(view: TimingView): void {
  useTiming.setState(view, true);
}

function fail(e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  set({ state: 'failed', reason: message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '') });
}

function currentRows(): DriverRow[] {
  const view = useTiming.getState();
  return view.state === 'ready' ? view.drivers : [];
}

function currentHeld(): number {
  const view = useTiming.getState();
  return view.state === 'ready' || view.state === 'loading' ? view.heldRecords : 0;
}

function publish(store: TimingStore, previous: DriverRow[]): void {
  set({
    state: 'ready',
    drivers: stabilizeRows(previous, selectDrivers(store)),
    weather: selectWeather(store),
    trackStatus: selectTrackStatus(store),
    raceControl: selectRaceControl(store),
    sessionClock: selectClock(store),
    lapCount: selectLapCount(store),
    teamRadio: selectTeamRadio(store),
    heldRecords: currentHeld(),
  });
}

/** The archive files sprints as type Race and sprint qualifying as Qualifying. */
const ARCHIVE_TYPES: Partial<Record<SessionInfo['type'], string>> = {
  race: 'race',
  sprint: 'race',
  qualifying: 'qualifying',
  'sprint-qualifying': 'qualifying',
  practice: 'practice',
};

function archiveQuery(session: SessionInfo): TimingQuery {
  return {
    year: session.year,
    sessionName: session.title,
    sessionType: ARCHIVE_TYPES[session.type],
    ...(session.meetingKey ? { meetingKey: session.meetingKey } : {}),
    ...(session.sessionKey ? { sessionKey: session.sessionKey } : {}),
  };
}

export interface TimingSource {
  update(timeSec: number, wallClockMs: number | null): void;
  destroy(): void;
}

export function createReplayTiming(session: SessionInfo): TimingSource {
  let controller: ReplayController | null = null;
  let map: TimeMap | null = null;
  let version = -1;
  let destroyed = false;

  set(LOADING);
  void (async () => {
    try {
      const ref = await window.f1a.timing.resolve(session.year, archiveQuery(session));
      if (destroyed) return;
      if (!ref) throw new Error("This session wasn't found in the timing archive.");
      const [byFeed, sync] = await Promise.all([
        window.f1a.timing.load(ref.path),
        ref.meetingKey != null && ref.sessionKey != null
          ? window.f1a.timing.syncData(ref.meetingKey, ref.sessionKey).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (destroyed) return;
      const feeds = byFeed as Record<string, FeedRecord[]>;
      const timeline = buildTimeline(feeds);
      controller = new ReplayController(timeline);
      map = buildTimeMap(feeds as never, timelineDuration(timeline), sync?.sessionStartSec ?? null);
      set({ state: 'ready', ...NO_DATA });
    } catch (e) {
      // A session closed while loading must not write over the one that replaced it.
      if (destroyed) return;
      console.warn('[timing] replay timing unavailable:', (e as Error).message);
      fail(e);
    }
  })();

  return {
    update(timeSec, wallClockMs) {
      if (!controller || !map) return;
      const store = controller.seekTo(videoToFeedOffset(map, timeSec, wallClockMs));
      if (controller.version !== version) {
        version = controller.version;
        publish(store, currentRows());
      }
    },
    destroy() {
      destroyed = true;
      controller = null;
      set(IDLE);
    },
  };
}

export function createLiveTiming(session: SessionInfo): TimingSource {
  let store = createStore();
  let destroyed = false;
  const buffer = new LiveFeedBuffer<{ feed: string; data: unknown }>();
  set(LOADING);
  const unsubscribe = window.f1a.timing.onLiveUpdate((record) => buffer.push(record, Date.now()));
  void window.f1a.timing.liveStart(archiveQuery(session)).catch((e: Error) => {
    if (destroyed) return;
    console.warn('[timing] live timing unavailable:', e.message);
    fail(e);
  });

  return {
    update(_timeSec, wallClockMs) {
      const { reset, records } = buffer.advance(wallClockMs);
      const view = useTiming.getState();
      if (view.state === 'ready' || view.state === 'loading') set({ ...view, heldRecords: buffer.held });
      if (!reset && records.length === 0) return;
      if (reset) store = createStore();
      for (const { feed, data } of records) applyRecord(store, feed, data);
      // Row identity only helps going forward: after a rewind, nothing of the old table may survive.
      publish(store, reset ? [] : currentRows());
    },
    destroy() {
      destroyed = true;
      unsubscribe();
      void window.f1a.timing.liveStop().catch(() => {});
      set(IDLE);
    },
  };
}
