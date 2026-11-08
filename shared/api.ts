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
  /** F1 TV state: 'replay' is watchable from the start, 'live' is on air now. */
  status: 'replay' | 'live';
}

export interface LiveItem {
  contentId: number;
  title: string;
  meetingKey?: string;
  sessionKey?: string;
}

export interface ScheduledSession {
  meetingKey: number;
  sessionKey: number;
  country: string;
  location: string;
  name: string;
  type: string;
  startMs: number;
  endMs: number;
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

export interface TimingSessionRef {
  path: string;
  meetingKey: string | number | null;
  sessionKey: string | number | null;
  name: string | null;
}

export interface SyncData {
  sessionStartSec: number;
  channelDiffs: Record<string, { diff: number; diffV2: number }>;
  contentId: string | null;
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

export type FeedRecord = { offsetMs: number; ts?: string; data: unknown };

export interface F1TvStatus {
  signedIn: boolean;
  ready: boolean;
}

export interface AiStatus {
  signedIn: boolean;
  model: string | null;
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

export type LiveTimingStatus = { status: string; detail?: string };

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
    schedule(year: number): Promise<ScheduledSession[]>;
    play(contentId: number, channelId?: number): Promise<PlaybackInfo>;
    lastLicenseError(streamKey?: string): Promise<string>;
  };
  timing: {
    resolve(year: number, query: TimingQuery): Promise<TimingSessionRef | null>;
    load(path: string): Promise<Record<string, FeedRecord[]>>;
    syncData(meetingKey: string | number, sessionKey: string | number): Promise<SyncData | null>;
    liveStart(query: TimingQuery): Promise<{ path: string | null }>;
    liveStop(): Promise<void>;
    onLiveUpdate(cb: (record: { feed: string; data: unknown }) => void): () => void;
    onLiveStatus(cb: (status: LiveTimingStatus) => void): () => void;
  };
  ai: {
    status(): Promise<AiStatus>;
    login(): Promise<AiStatus>;
    logout(): Promise<void>;
    send(text: string, context: string): Promise<void>;
    cancel(): Promise<void>;
    reset(): Promise<void>;
    onEvent(cb: (event: AgentEvent) => void): () => void;
    onToolCall(cb: (call: AgentToolCall) => void): () => void;
    toolResult(result: AgentToolResult): void;
  };
}

declare global {
  interface Window {
    f1a: F1aApi;
  }
}
