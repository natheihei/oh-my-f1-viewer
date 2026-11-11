/**
 * The contract between the main process and the renderer: everything `window.f1a` exposes.
 * Account tokens never cross this boundary; the renderer only learns whether a login exists.
 */

export type SessionType =
  | 'race'
  | 'qualifying'
  | 'sprint'
  | 'sprint-qualifying'
  | 'practice'
  | 'show'
  | 'other';

export type ChannelKind = 'main' | 'onboard' | 'data' | 'tracker' | 'other';

export interface SeasonInfo {
  year: number;
  pageId: number;
}

export interface EventInfo {
  /** F1 TV page id, used to list the event's sessions. */
  pageId: number;
  name: string;
  /** Short, human name such as "Mexico City Grand Prix" when F1 TV provides one. */
  shortName: string;
  round: number;
  startMs: number;
  endMs: number;
  isTest: boolean;
}

export interface SessionInfo {
  contentId: number;
  title: string;
  type: SessionType;
  year: number;
  startMs: number | null;
  endMs: number | null;
  meetingKey: string | null;
  sessionKey: string | null;
  hasOnboards: boolean;
  series: string;
  /** 'replay' is watchable from the start, 'live' is on air now, 'upcoming' can't be played yet. */
  status: 'replay' | 'live' | 'upcoming';
}

export interface LiveItem {
  contentId: number;
  title: string;
  meetingKey?: string;
  sessionKey?: string;
}

export interface Channel {
  /** Stable within a session: `${contentId}:${channelId ?? 0}`. */
  id: string;
  contentId: number;
  channelId?: number;
  kind: ChannelKind;
  /** Display label: driver code for onboards (HAM), otherwise the channel name. */
  label: string;
  title: string;
  driverName?: string;
  driverCode?: string;
  team?: string;
  number?: number;
}

export interface PlaybackInfo {
  manifestUrl: string;
  licenseUrl: string;
  drmToken?: string;
  streamType?: string;
  fallbackManifestUrl?: string;
  fallbackLicenseUrl?: string;
  fallbackDrmToken?: string;
  fallbackStreamType?: string;
  contentId?: number;
  channelId?: number;
}

export interface TimingQuery {
  year?: number;
  meetingKey?: string | number;
  meetingName?: string;
  sessionName?: string;
  /** The archive's session type: race (also sprints), qualifying, or practice. */
  sessionType?: string;
  sessionKey?: string | number;
}

export interface F1TvStatus {
  signedIn: boolean;
  ready: boolean;
}

export interface AiStatus {
  signedIn: boolean;
  model: string | null;
}

/** What the model is told about one tool. */
export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One agent tool invocation the renderer must carry out, because it owns layout and playback. */
export interface AgentToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentToolResult {
  callId: string;
  ok: boolean;
  /** What the model sees: a short JSON or text result. */
  content: string;
}

export type AgentEvent =
  | { type: 'turn_start'; turnId: string }
  | { type: 'text_delta'; turnId: string; delta: string }
  | { type: 'tool_start'; turnId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; turnId: string; name: string; ok: boolean }
  | { type: 'turn_end'; turnId: string; acted: boolean }
  | { type: 'error'; turnId: string; message: string };

export type {
  Circuit,
  CircuitView,
  DataStatus,
  Schedule,
  ScheduleView,
  SessionDataView,
  SessionObjects,
  SqlRows,
} from './sessionData';

export interface F1aApi {
  f1tv: {
    status(): Promise<F1TvStatus>;
    login(): Promise<F1TvStatus>;
    logout(): Promise<void>;
    onExpired(cb: () => void): () => void;
    seasons(): Promise<SeasonInfo[]>;
    events(seasonPageId: number): Promise<EventInfo[]>;
    sessions(eventPageId: number, year?: number): Promise<SessionInfo[]>;
    channels(contentId: number): Promise<Channel[]>;
    liveNow(): Promise<LiveItem[]>;
    /** Sessions that haven't started, soonest first. */
    upcoming(): Promise<SessionInfo[]>;
    play(contentId: number, channelId?: number): Promise<PlaybackInfo>;
    lastLicenseError(streamKey?: string): Promise<string>;
  };
  /** The session database. It only ever answers as of the playhead it's given. */
  data: {
    schedule(): Promise<import('./sessionData').Schedule | null>;
    onSchedule(cb: (update: { schedule: import('./sessionData').Schedule; reason: string | null }) => void): () => void;
    /** Ingests what isn't there yet. Progress comes through `onStatus`. */
    open(query: TimingQuery, live: boolean): Promise<void>;
    close(): Promise<void>;
    onStatus(cb: (status: import('./sessionData').DataStatus) => void): () => void;
    /**
     * The open session's circuit: the cached copy first if there is one, then a fresh one. `query` is the
     * one the session was opened with, so an update for a session since closed can be told apart.
     */
    onCircuit(cb: (update: { query: TimingQuery; circuit: import('./sessionData').CircuitView }) => void): () => void;
    objects(sessionKey: number, playheadMs: number): Promise<import('./sessionData').SessionObjects>;
    sql(sessionKey: number, playheadMs: number, sql: string, params: unknown[]): Promise<import('./sessionData').SqlRows>;
  };
  ai: {
    status(): Promise<AiStatus>;
    login(): Promise<AiStatus>;
    logout(): Promise<void>;
    /** `reference` is appended to the system prompt: what the agent should know up front, like the event list. */
    send(text: string, context: string, tools: AgentToolDefinition[], reference: string): Promise<void>;
    cancel(): Promise<void>;
    reset(): Promise<void>;
    onEvent(cb: (event: AgentEvent) => void): () => void;
    onToolCall(cb: (call: AgentToolCall) => void): () => void;
    toolResult(result: AgentToolResult): void;
  };
  /** Mods: main watches and compiles them, and the renderer loads them. See docs/MODS.md. */
  mods: {
    list(): Promise<import('./mods').ModStatus[]>;
    onChanged(cb: (list: import('./mods').ModStatus[]) => void): () => void;
    /** Reports whether a build loaded: `error` is null when it did. */
    loaded(name: string, version: number, error: string | null): void;
    log(name: string, line: import('./mods').ModLogLine): void;
  };
}

declare global {
  interface Window {
    f1a: F1aApi;
  }
}
