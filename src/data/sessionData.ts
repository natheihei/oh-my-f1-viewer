/**
 * The session database, from this side of the process boundary. Ingesting happens by itself when a
 * session opens, and nothing up here can write to it. Everything read is as of the frame on screen,
 * never later, even for results, unless a caller asks for the whole session by name. The video is what
 * moves it: see timeMap.ts for how the two connect.
 */
import { create } from 'zustand';
import type { SessionInfo, TimingQuery } from '../../shared/api';
import type {
  CircuitView,
  DataStatus,
  Dataset,
  DatasetState,
  Schedule,
  ScheduleView,
  SessionDataView,
  SessionObjects,
  SqlRows,
} from '../../shared/sessionData';
import { buildTimeMap, playheadOf, videoTimeOf, type TimeMap } from './timeMap';

/** A playhead past anything a session could hold. */
const EVERYTHING_VISIBLE = Number.MAX_SAFE_INTEGER;
/** A playhead before anything: the video's position isn't known yet. */
const NOTHING_VISIBLE = -1;

const NO_OBJECTS: SessionObjects = { drivers: [], startingGrid: [], sessionResult: [], championshipDrivers: [], championshipTeams: [], lapCount: null };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const useSessionData = create<SessionDataView>(() => ({ state: 'idle' }));
/** The open session's circuit, which the main process fetches when the session opens. */
export const useCircuit = create<CircuitView>(() => ({ state: 'idle' }));
export const useSchedule = create<ScheduleView>(() => ({ state: 'loading', reason: null, meetings: [], sessions: [], refreshedAt: null }));

function applySchedule(schedule: Schedule | null, reason: string | null, state: ScheduleView['state']): void {
  useSchedule.setState(deepFreeze({ state, reason, meetings: schedule?.meetings ?? [], sessions: schedule?.sessions ?? [], refreshedAt: schedule?.refreshedAt ?? null }), true);
}

/** The calendar refreshes itself in the main process on every start. This just keeps a copy up to date. */
function startSchedule(): void {
  const api = globalThis.window?.f1a?.data;
  if (!api) return;
  api.onSchedule(({ schedule, reason }) => applySchedule(schedule, reason, 'ready'));
  void api
    .schedule()
    .then((schedule) => {
      if (schedule && useSchedule.getState().state === 'loading') applySchedule(schedule, null, 'loading');
    })
    .catch(() => {});
}
startSchedule();

/** The archive files sprints as type Race and sprint qualifying as Qualifying. */
const ARCHIVE_TYPES: Partial<Record<SessionInfo['type'], string>> = {
  race: 'race',
  sprint: 'race',
  qualifying: 'qualifying',
  'sprint-qualifying': 'qualifying',
  practice: 'practice',
};

/** F1 TV and the archive share F1's meeting and session keys. That's what links a video to its data. */
export function archiveQuery(session: SessionInfo): TimingQuery {
  return {
    year: session.year,
    sessionName: session.title,
    sessionType: ARCHIVE_TYPES[session.type],
    ...(session.meetingKey ? { meetingKey: session.meetingKey } : {}),
    ...(session.sessionKey ? { sessionKey: session.sessionKey } : {}),
  };
}

/** What a running session asks of this. */
export interface SessionDataHandle {
  /** Where the video is: called on every clock tick. */
  update(timeSec: number, wallClockMs: number | null): void;
  /** The video second showing a moment on the database's clock, or null when the frame can't be placed. */
  videoTimeOf(dateMs: number): number | null;
  destroy(): void;
}

let current: { sessionKey: number; playhead(): number } | null = null;

/** What a query sees: what the feed had revealed at the frame on screen, or everything the session holds. */
export type SqlAsOf = 'playhead' | 'session';

/** Runs a query against what's visible at the frame on screen, or across the session. Only reading is possible. */
export async function sessionSql(sql: string, params: unknown[] = [], asOf: SqlAsOf = 'playhead'): Promise<SqlRows> {
  if (!current) throw new Error('No session data is open.');
  const playhead = asOf === 'session' ? EVERYTHING_VISIBLE : current.playhead();
  return deepFreeze(await window.f1a.data.sql(current.sessionKey, playhead, sql, params));
}

export function openSessionData(session: SessionInfo, live: boolean): SessionDataHandle {
  const query = archiveQuery(session);
  let destroyed = false;
  let sessionKey: number | null = null;
  let datasets: Record<Dataset, DatasetState> | null = null;
  let map: TimeMap | null = null;
  let ready = false;
  let playhead = NOTHING_VISIBLE;
  /** The last position the video reported, for placing a moment relative to it. */
  let videoSec = 0;
  let videoWallClockMs: number | null = null;
  /** The frame as consumers see it: null when it's not a real time. */
  let shownPlayhead: number | null = null;
  /** The second of the playhead last read. Row visibility is only asked for this often. */
  let readSecond: number | null = null;
  let reading = false;
  let readAgain = false;
  let revision = 0;
  let lastObjects = '';
  let objects: SessionObjects = NO_OBJECTS;

  const publish = () => {
    if (destroyed || !ready || sessionKey === null || !datasets) return;
    useSessionData.setState(deepFreeze({ state: 'ready', sessionKey, datasets, revision, playheadMs: shownPlayhead, ...objects }), true);
  };

  const read = async () => {
    if (destroyed || !ready || sessionKey === null) return;
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    readSecond = Math.floor(playhead / 1000);
    try {
      const next = await window.f1a.data.objects(sessionKey, playhead);
      const serialized = JSON.stringify(next);
      if (serialized !== lastObjects) {
        lastObjects = serialized;
        objects = next;
      }
      revision += 1;
      publish();
    } catch (e) {
      console.warn('[data] could not read session objects:', (e as Error).message);
    } finally {
      reading = false;
      if (readAgain) {
        readAgain = false;
        void read();
      }
    }
  };

  const onStatus = (status: DataStatus) => {
    if (destroyed) return;
    if (query.sessionKey != null && status.sessionKey !== null && String(query.sessionKey) !== String(status.sessionKey)) return;
    if (status.state === 'unsupported' || status.state === 'failed') {
      useSessionData.setState({ state: status.state, reason: status.reason ?? 'The session data could not be loaded.' }, true);
      return;
    }
    sessionKey = status.sessionKey;
    datasets = status.coverage?.datasets ?? null;
    if (status.clock) map = buildTimeMap(status.clock, status.sessionStartSec);
    if (status.state === 'loading') {
      if (!ready) useSessionData.setState({ state: 'loading', sessionKey, datasets }, true);
      return;
    }
    if (sessionKey === null || !datasets) return;
    ready = true;
    current = { sessionKey, playhead: () => playhead };
    // Results and telemetry arrive after the first `ready`: what can be seen may have changed.
    void read();
  };

  useSessionData.setState({ state: 'loading', sessionKey: null, datasets: null }, true);
  useCircuit.setState({ state: 'loading' }, true);
  const asked = JSON.stringify(query);
  const stopCircuit = window.f1a.data.onCircuit(({ query: sent, circuit }) => {
    if (!destroyed && JSON.stringify(sent) === asked) useCircuit.setState(deepFreeze(circuit), true);
  });
  const unsubscribe = window.f1a.data.onStatus(onStatus);
  void window.f1a.data.open(query, live).catch((e: Error) => {
    if (!destroyed) useSessionData.setState({ state: 'failed', reason: e.message }, true);
  });

  return {
    update(timeSec, wallClockMs) {
      videoSec = timeSec;
      videoWallClockMs = wallClockMs;
      const at = playheadOf(live, map, timeSec, wallClockMs);
      playhead = at === 'everything' ? EVERYTHING_VISIBLE : (at ?? NOTHING_VISIBLE);
      shownPlayhead = typeof at === 'number' ? at : null;
      if (ready && Math.floor(playhead / 1000) !== readSecond) void read();
    },
    videoTimeOf(dateMs) {
      return videoTimeOf(live, map, dateMs, videoSec, videoWallClockMs);
    },
    destroy() {
      destroyed = true;
      current = null;
      unsubscribe();
      stopCircuit();
      void window.f1a.data.close().catch(() => {});
      useSessionData.setState({ state: 'idle' }, true);
      useCircuit.setState({ state: 'idle' }, true);
    },
  };
}
