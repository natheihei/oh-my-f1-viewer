/**
 * What the session database hands out. Names follow OpenF1 so its docs and API serve as a reference
 * (https://openf1.org/docs), except that every time is UTC milliseconds rather than an ISO string.
 */

/** The first season with the feeds this data needs, and the first OpenF1 covers. */
export const FIRST_SUPPORTED_YEAR = 2023;

/** Tables reachable through SQL. Each one only shows what the feed had revealed by the playhead. */
export const SQL_TABLES = [
  'car_data',
  'intervals',
  'lap_summary',
  'laps',
  'location',
  'overtakes',
  'pit',
  'position',
  'race_control',
  'stints',
  'track_status',
  'weather',
] as const;

export type SqlTable = (typeof SQL_TABLES)[number];

export interface Meeting {
  meeting_key: number;
  meeting_name: string;
  meeting_official_name: string | null;
  year: number;
  round: number | null;
  location: string | null;
  country_key: number | null;
  country_code: string | null;
  country_name: string | null;
  circuit_key: number | null;
  circuit_short_name: string | null;
  gmt_offset: string | null;
  date_start: number | null;
  date_end: number | null;
}

export interface ScheduleSession {
  session_key: number;
  meeting_key: number;
  session_name: string;
  session_type: string;
  year: number;
  date_start: number | null;
  date_end: number | null;
  gmt_offset: string | null;
  /** Where its files are in F1's archive. Null until the session has happened. */
  path: string | null;
}

export interface Schedule {
  meetings: Meeting[];
  sessions: ScheduleSession[];
  refreshedAt: number | null;
}

/** Known meetings and sessions are kept when a refresh fails: `reason` then says what went wrong. */
export type ScheduleView = { state: 'loading' | 'ready'; reason: string | null } & Schedule;

/** A numbered corner, at its apex on the outline's coordinates. */
export interface CircuitCorner {
  number: number;
  x: number;
  y: number;
  /** Degrees, for placing its number beside the track. */
  angle: number;
  /** How far along the lap it is, on the outline's scale. */
  distance: number;
}

/**
 * A circuit, from MultiViewer's public API. It doesn't depend on the playhead: a circuit can't spoil a
 * race. Its data is dated 2021 whatever year is asked for.
 */
export interface Circuit {
  /** F1's own circuit key, as the schedule's `circuit_key`. */
  circuitKey: number;
  name: string;
  /** When it was last fetched, in UTC milliseconds. */
  refreshedAt: number;
  /** The track as one closed line, in the same units as `location`'s x and y. */
  outline: { x: number[]; y: number[] };
  corners: CircuitCorner[];
  /** Degrees to turn the outline by so it reads the usual way up. */
  rotation: number;
  /** Seconds lost to a stop, under green, a safety car and a virtual one. Null where missing or unreadable. */
  pitLoss: { normal: number | null; safetyCar: number | null; virtualSafetyCar: number | null };
}

/**
 * The open session's circuit. A stale copy stays `ready` when a refresh fails, with `reason` saying why.
 * `loading` until the circuit's key is known and it has been fetched or found in the cache.
 */
export type CircuitView =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'failed'; reason: string }
  | ({ state: 'ready'; reason: string | null } & Circuit);

export interface DriverEntry {
  driver_number: number;
  broadcast_name: string | null;
  full_name: string | null;
  name_acronym: string | null;
  team_name: string | null;
  team_colour: string | null;
  first_name: string | null;
  last_name: string | null;
  headshot_url: string | null;
  country_code: string | null;
}

export interface StartingGridEntry {
  driver_number: number;
  position: number | null;
  lap_duration: number | null;
}

export interface SessionResultEntry {
  driver_number: number;
  position: number | null;
  number_of_laps: number | null;
  points: number | null;
  dnf: boolean;
  dns: boolean;
  dsq: boolean;
  /** Seconds, or one per qualifying part. */
  duration: number | Array<number | null> | null;
  /** Seconds or text such as "+1 LAP", or one per qualifying part. */
  gap_to_leader: number | string | Array<number | null> | null;
}

export interface ChampionshipDriverEntry {
  driver_number: number;
  position_start: number | null;
  position_current: number | null;
  points_start: number | null;
  points_current: number | null;
}

export interface ChampionshipTeamEntry {
  team_name: string | null;
  position_start: number | null;
  position_current: number | null;
  points_start: number | null;
  points_current: number | null;
}

/** The roster and results as they stood at the playhead. */
export interface SessionObjects {
  drivers: DriverEntry[];
  /** Races and sprints only. Hidden until the session reaches the grid. */
  startingGrid: StartingGridEntry[];
  /** Hidden until the session has finished at the playhead. */
  sessionResult: SessionResultEntry[];
  championshipDrivers: ChampionshipDriverEntry[];
  championshipTeams: ChampionshipTeamEntry[];
  /** The leader's lap and the scheduled distance. Null in a session without them, such as practice. */
  lapCount: LapCount | null;
}

export interface LapCount {
  current: number;
  /** The scheduled distance, known from the start. */
  total: number;
}

export type Dataset = 'timing' | 'telemetry' | 'results';

/** How much of a dataset the database holds, and whether that's final. */
export interface DatasetState {
  state: 'absent' | 'loading' | 'partial' | 'complete' | 'failed';
  /** Why it's partial or failed. Never says anything about how the session went. */
  reason: string | null;
}

/** What the main process knows about a session's data. Only `datasets` reaches `sessionData`. */
export interface SessionCoverage {
  source: 'archive' | 'live' | null;
  datasets: Record<Dataset, DatasetState>;
  /** Feeds the archive doesn't have for this session. */
  missingFeeds: string[];
  /** Spans a live capture missed. `from` is null when the capture began after the session did. */
  gaps: Array<{ from: number; to: number | null }>;
  /** When a live capture began. */
  capturedFrom: number | null;
}

/** Whether there's session data and, if not, why. The data only exists once it's ready. */
export type SessionDataView =
  | { state: 'idle' }
  | { state: 'unsupported'; reason: string }
  | { state: 'loading'; sessionKey: number | null; datasets: Record<Dataset, DatasetState> | null }
  | { state: 'failed'; reason: string }
  | ({
      state: 'ready';
      sessionKey: number;
      datasets: Record<Dataset, DatasetState>;
      /** Goes up each time what can be seen may have changed. */
      revision: number;
      /** The frame on screen, on the feed's clock in UTC milliseconds. Null when it isn't known. */
      playheadMs: number | null;
    } & SessionObjects);

import type { FeedClock } from './feedTime';

export interface SqlRows {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

/** Sent to the renderer whenever a session's ingestion moves on. */
export interface DataStatus {
  sessionKey: number | null;
  state: 'unsupported' | 'loading' | 'ready' | 'failed';
  reason: string | null;
  coverage: SessionCoverage | null;
  /** Where the feed's timeline sits, for placing a replay's video frames on it. */
  clock: FeedClock | null;
  /** The video second of lights out, from F1 TV's own sync data. Null when it has none. */
  sessionStartSec: number | null;
}
