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
  SqlTableInfo,
} from '../../shared/sessionData';
import { buildTimeMap, playheadOf, videoTimeOf, type TimeMap, type Unplaced } from './timeMap';

/** A playhead past anything a session could hold. */
const EVERYTHING_VISIBLE = Number.MAX_SAFE_INTEGER;
/** A playhead before anything: the video's position isn't known yet. */
const NOTHING_VISIBLE = -1;

const NO_OBJECTS: SessionObjects = { drivers: [], lapCount: null };

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
  const api = globalThis.window?.omfv?.data;
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

let current: { sessionKey: number; playhead(): number; waiting(): Waiting | null } | null = null;

/** Why nothing is visible though there's data: the frame can't be placed, or the live video is behind the data. */
export type WaitingFor = Unplaced | 'video-behind';

export interface Waiting {
  kind: WaitingFor;
  reason: string;
  detail: string;
}

const seconds = (ms: number): string => {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** What to tell the viewer, and the agent, while nothing is visible. `aheadMs` is how far the data's start is ahead of the frame. */
export function waitingFor(kind: WaitingFor, aheadMs = 0): Waiting {
  switch (kind) {
    case 'no-anchor':
      return {
        kind,
        reason: 'Not lined up with the video yet',
        detail:
          "MultiViewer hasn't published where this session starts on the video. It usually does within a few hours of the session " +
          'ending, and the data appears by itself once it has. Until then it could be a minute out, so it stays hidden rather than show anything early.',
      };
    case 'no-feed-clock':
      return {
        kind,
        reason: "Can't line the data up with the video",
        detail: "This session's timing feed carries no time to match against the video, so its data stays hidden.",
      };
    case 'no-wall-clock':
      return {
        kind,
        reason: 'Not lined up with the video yet',
        detail: "The live video hasn't said what time it's showing yet. The data appears as soon as it does.",
      };
    case 'video-behind':
      return {
        kind,
        reason: 'Waiting for the video to reach the live data',
        detail:
          'Live data shows when the video reaches the moment it arrived, so nothing appears early. ' +
          `The data starts when it was first received, about ${seconds(aheadMs)} ahead of the frame on screen.`,
      };
  }
}

/** What a query sees: what the feed had revealed at the frame on screen, or everything the session holds. */
export type SqlAsOf = 'playhead' | 'session';

/** Runs a query against what's visible at the frame on screen, or across the session. Only reading is possible. */
export async function sessionSql(sql: string, params: unknown[] = [], asOf: SqlAsOf = 'playhead'): Promise<SqlRows> {
  if (!current) throw new Error('No session data is open.');
  const waiting = asOf === 'session' ? null : current.waiting();
  if (waiting) throw new Error(`${waiting.reason}. ${waiting.detail}`);
  const playhead = asOf === 'session' ? EVERYTHING_VISIBLE : current.playhead();
  return deepFreeze(await window.omfv.data.sql(current.sessionKey, playhead, sql, params));
}

export function openSessionData(session: SessionInfo, live: boolean): SessionDataHandle {
  const query = archiveQuery(session);
  let destroyed = false;
  let sessionKey: number | null = null;
  let datasets: Record<Dataset, DatasetState> | null = null;
  let map: TimeMap | null = null;
  /** Live: MultiViewer's lead of the stream's frame time over the feed, once it's published. */
  let liveLeadMs: number | null = null;
  /** Live: when the capture began. Nothing before it can be shown. */
  let capturedFrom: number | null = null;
  let waiting: Waiting | null = null;
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
  /** The roster while waiting: as the data last has it, since nothing is visible at the playhead. */
  let lastRoster = '';
  let roster: SessionObjects['drivers'] = NO_OBJECTS.drivers;
  let lastTables = '';
  /** Kept as one object while it's unchanged, so it never makes anything render again. */
  let tables: SqlTableInfo[] = [];

  const publish = () => {
    if (destroyed || !ready || sessionKey === null || !datasets) return;
    if (waiting) {
      const { reason, detail, kind } = waiting;
      const brief = kind === 'no-wall-clock';
      const ahead = kind === 'video-behind';
      useSessionData.setState(deepFreeze({ state: 'waiting', sessionKey, datasets, reason, detail, brief, ahead, tables, drivers: roster }), true);
      return;
    }
    useSessionData.setState(deepFreeze({ state: 'ready', sessionKey, datasets, revision, playheadMs: shownPlayhead, tables, ...objects }), true);
  };

  /** Places the frame the video last reported. Returns whether what's published changed. */
  const place = (): boolean => {
    const at = playheadOf(live, map, videoSec, videoWallClockMs, liveLeadMs);
    const next =
      typeof at === 'string' ? waitingFor(at) : live && capturedFrom !== null && at < capturedFrom ? waitingFor('video-behind', capturedFrom - at) : null;
    playhead = typeof at === 'number' ? at : NOTHING_VISIBLE;
    const shown = typeof at === 'number' && !next ? at : null;
    const changed = shown !== shownPlayhead || next?.reason !== waiting?.reason || next?.detail !== waiting?.detail;
    shownPlayhead = shown;
    waiting = next;
    return changed;
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
      // Waiting, nothing is visible at the playhead, the roster included: it's read as the data last has it.
      if (waiting) {
        const { drivers } = await window.omfv.data.objects(sessionKey, EVERYTHING_VISIBLE);
        const serialized = JSON.stringify(drivers);
        if (serialized !== lastRoster) {
          lastRoster = serialized;
          roster = drivers;
          publish();
        }
        return;
      }
      const next = await window.omfv.data.objects(sessionKey, playhead);
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
    liveLeadMs = status.liveLeadMs ?? null;
    if (live) capturedFrom = status.coverage?.capturedFrom ?? null;
    const sentTables = JSON.stringify(status.tables);
    if (status.tables && sentTables !== lastTables) {
      lastTables = sentTables;
      tables = deepFreeze(status.tables);
    }
    if (status.state === 'loading') {
      if (!ready) useSessionData.setState({ state: 'loading', sessionKey, datasets }, true);
      return;
    }
    if (sessionKey === null || !datasets) return;
    ready = true;
    place();
    current = { sessionKey, playhead: () => playhead, waiting: () => waiting };
    // Results and telemetry arrive after the first `ready`: what can be seen may have changed.
    void read();
  };

  useSessionData.setState({ state: 'loading', sessionKey: null, datasets: null }, true);
  useCircuit.setState({ state: 'loading' }, true);
  const asked = JSON.stringify(query);
  const stopCircuit = window.omfv.data.onCircuit(({ query: sent, circuit }) => {
    if (!destroyed && JSON.stringify(sent) === asked) useCircuit.setState(deepFreeze(circuit), true);
  });
  const unsubscribe = window.omfv.data.onStatus(onStatus);
  void window.omfv.data.open(query, live).catch((e: Error) => {
    if (!destroyed) useSessionData.setState({ state: 'failed', reason: e.message }, true);
  });

  return {
    update(timeSec, wallClockMs) {
      videoSec = timeSec;
      videoWallClockMs = wallClockMs;
      const moved = place();
      // A new second reads the objects again and publishes a revision. In between, only the playhead is
      // published, ten times a second: telemetry shows each sample at its own date, about four a second, and
      // charts that pass the playhead to their query read again as it moves. Others still read once a second.
      // Waiting is published at once: the read behind it only fetches the roster, and publishes only if that changed,
      // so a rewind to before the capture would otherwise leave what the live edge showed on screen.
      if (ready && Math.floor(playhead / 1000) !== readSecond) {
        if (moved && waiting) publish();
        void read();
      } else if (moved) publish();
    },
    videoTimeOf(dateMs) {
      return videoTimeOf(live, map, dateMs, videoSec, videoWallClockMs, liveLeadMs);
    },
    destroy() {
      destroyed = true;
      current = null;
      unsubscribe();
      stopCircuit();
      void window.omfv.data.close().catch(() => {});
      useSessionData.setState({ state: 'idle' }, true);
      useCircuit.setState({ state: 'idle' }, true);
    },
  };
}
