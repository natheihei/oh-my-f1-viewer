/**
 * Timing data locked to the session clock. Upper layers read `useTiming` and only ever see the
 * state of the race at the frame on screen, whether replaying or live. A failure here never
 * affects video: the session just has no timing.
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

export interface TimingView {
  available: boolean;
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

const EMPTY: TimingView = {
  available: false,
  drivers: [],
  weather: null,
  trackStatus: null,
  raceControl: [],
  sessionClock: null,
  lapCount: null,
  teamRadio: [],
  heldRecords: 0,
};

export const useTiming = create<TimingView>(() => EMPTY);

function publish(store: TimingStore, previous: DriverRow[]): void {
  useTiming.setState({
    available: true,
    drivers: stabilizeRows(previous, selectDrivers(store)),
    weather: selectWeather(store),
    trackStatus: selectTrackStatus(store),
    raceControl: selectRaceControl(store),
    sessionClock: selectClock(store),
    lapCount: selectLapCount(store),
    teamRadio: selectTeamRadio(store),
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

  void (async () => {
    try {
      const ref = await window.f1a.timing.resolve(session.year, archiveQuery(session));
      if (!ref || destroyed) return;
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
      useTiming.setState({ available: true });
    } catch (e) {
      console.warn('[timing] replay timing unavailable:', (e as Error).message);
    }
  })();

  return {
    update(timeSec, wallClockMs) {
      if (!controller || !map) return;
      const store = controller.seekTo(videoToFeedOffset(map, timeSec, wallClockMs));
      if (controller.version !== version) {
        version = controller.version;
        publish(store, useTiming.getState().drivers);
      }
    },
    destroy() {
      destroyed = true;
      controller = null;
      useTiming.setState(EMPTY);
    },
  };
}

export function createLiveTiming(session: SessionInfo): TimingSource {
  let store = createStore();
  const buffer = new LiveFeedBuffer<{ feed: string; data: unknown }>();
  const unsubscribe = window.f1a.timing.onLiveUpdate((record) => buffer.push(record, Date.now()));
  void window.f1a.timing.liveStart(archiveQuery(session)).catch((e: Error) => {
    console.warn('[timing] live timing unavailable:', e.message);
  });

  return {
    update(_timeSec, wallClockMs) {
      const { reset, records } = buffer.advance(wallClockMs);
      useTiming.setState({ heldRecords: buffer.held });
      if (!reset && records.length === 0) return;
      if (reset) store = createStore();
      for (const { feed, data } of records) applyRecord(store, feed, data);
      // Row identity only helps going forward: after a rewind, nothing of the old table may survive.
      publish(store, reset ? [] : useTiming.getState().drivers);
    },
    destroy() {
      unsubscribe();
      void window.f1a.timing.liveStop().catch(() => {});
      useTiming.setState(EMPTY);
    },
  };
}
