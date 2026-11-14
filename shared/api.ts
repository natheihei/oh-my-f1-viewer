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

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** How a provider gets connected: signing in through the browser, or an API key typed into its own window. */
export type ConnectWay = 'oauth' | 'api_key';

/** What the agent is set up to use. `ready` means a supported provider is connected, so the agent can run. */
export interface AiStatus {
  ready: boolean;
  provider: string | null;
  model: string | null;
  modelName: string | null;
  thinking: ThinkingLevel | null;
}

/** One provider `/settings-agent` offers, from electron/agent/supported.ts and pi's catalog. */
export interface AgentProviderOption {
  id: string;
  label: string;
  ways: { way: ConnectWay; label: string; note: string }[];
  /** How it's connected, or null. At most one provider is connected at a time. */
  connected: { way: ConnectWay; label: string } | null;
  models: { id: string; name: string; thinking: ThinkingLevel[] }[];
  recommended: { model: string; thinking: ThinkingLevel };
}

/** What the browser side of a sign-in asks of the user, shown in the panel while it runs. */
export type AgentConnectEvent =
  | { type: 'browser'; message: string }
  | { type: 'device_code'; code: string; url: string }
  | { type: 'key_window'; message: string }
  | { type: 'progress'; message: string };

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
  /** It read past the playhead, so the agent forgets it after this turn. See docs/SPOILER_PREVENTION.md. */
  pastPlayhead?: boolean;
}

/** Which of the app's two agents a message goes to: the one that drives viewing, or the one that builds mods. */
export type AgentMode = 'view' | 'build';

export type AgentEvent =
  | { type: 'turn_start'; turnId: string }
  | { type: 'text_delta'; turnId: string; delta: string }
  | { type: 'tool_start'; turnId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; turnId: string; name: string; ok: boolean; /** A line for the palette, such as a file the build agent wrote. */ note?: string }
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
    /** The providers `/settings-agent` offers, each with its ways to connect and its models. */
    providers(): Promise<AgentProviderOption[]>;
    /**
     * Connects a provider. Any other connected provider is removed only once this one succeeds, so a
     * cancelled or failed connection changes nothing. API keys are asked for in their own window.
     */
    connect(provider: string, way: ConnectWay): Promise<AiStatus>;
    cancelConnect(): Promise<void>;
    onConnect(cb: (event: AgentConnectEvent) => void): () => void;
    /** Removes the connected provider's credential. The agent then needs setting up again. */
    disconnect(): Promise<void>;
    /** Saves the model and thinking level. They apply from the next message, in the same conversation. */
    choose(model: string, thinking: ThinkingLevel): Promise<AiStatus>;
    /** `reference` is appended to the system prompt: what the agent should know up front, like the event list. */
    send(text: string, context: string, tools: AgentToolDefinition[], reference: string, mode?: AgentMode): Promise<void>;
    /** Ends build mode's conversation. The viewing one is untouched. */
    endBuild(): Promise<void>;
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
    /** The main process asks how what's on screen is drawing, for the build agent. */
    onHealthAsked(cb: (id: string) => void): () => void;
    /** The answer to that: null if it couldn't be read. */
    health(id: string, places: import('./health').PlaceHealth[] | null): void;
  };
  /** Build mode's snapshot of the mods folder. See docs/BUILD_MODE.md. */
  build: {
    state(): Promise<import('./mods').BuildState>;
    onChanged(cb: (state: import('./mods').BuildState) => void): () => void;
    /** Takes the snapshot Undo all goes back to. */
    begin(): Promise<import('./mods').BuildState>;
    /** Keeps the changes. Resolves to what changed, in the app's words, or null for nothing. */
    save(): Promise<string | null>;
    /** Puts the mods folder back. Resolves to how many mods that undid. */
    undo(): Promise<number>;
  };
}

declare global {
  interface Window {
    f1a: F1aApi;
  }
}
