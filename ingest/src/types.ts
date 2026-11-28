/**
 * Shared v1 static chunk storage contract and SignalR feed types for omfv-live-ingest.
 *
 * Object key layout (identical on Cloudflare R2, S3-compatible buckets, and local disk):
 *   v1/sessions/index.json
 *   v1/sessions/{sessionKey}/manifest.json
 *   v1/sessions/{sessionKey}/chunks/{timing|telemetry}-{id:06d}.ndjson.gz
 */

export const PROTOCOL_VERSION = 1 as const;
export const SESSIONS_INDEX_KEY = 'v1/sessions/index.json';
export const CHUNK_ENCODING = 'ndjson+gzip' as const;

export const TIMING_FEEDS = [
  'SessionInfo',
  'DriverList',
  'TimingData',
  'TimingAppData',
  'RaceControlMessages',
  'SessionData',
  'DriverRaceInfo',
  'PitStop',
  'PitStopSeries',
  'PitLaneTimeCollection',
  'WeatherData',
  'ChampionshipPrediction',
  'TrackStatus',
  'LapCount',
  'ExtrapolatedClock',
] as const;

export const TELEMETRY_FEEDS = ['CarData.z', 'Position.z'] as const;

/** All 17 F1 SignalR Core feeds (15 timing + 2 compressed telemetry). */
export const LIVE_FEEDS = [...TIMING_FEEDS, ...TELEMETRY_FEEDS] as const;

export type LiveFeed = (typeof LIVE_FEEDS)[number];
export type StreamKind = 'timing' | 'telemetry';
export type SessionStatus = 'live' | 'finished';

export const COMPRESSED_FEEDS: ReadonlySet<string> = new Set(TELEMETRY_FEEDS);

export function streamForTopic(topic: string): StreamKind {
  return COMPRESSED_FEEDS.has(topic) ? 'telemetry' : 'timing';
}

export function formatChunkFilename(stream: StreamKind, id: number): string {
  return `${stream}-${String(id).padStart(6, '0')}.ndjson.gz`;
}

export function chunkObjectKey(sessionKey: number, filename: string): string {
  return `v1/sessions/${sessionKey}/chunks/${filename}`;
}

export function chunkPublicPath(sessionKey: number, filename: string): string {
  return `/v1/sessions/${sessionKey}/chunks/${filename}`;
}

export function manifestObjectKey(sessionKey: number): string {
  return `v1/sessions/${sessionKey}/manifest.json`;
}

export interface ParsedLiveRecord {
  topic: string;
  data: unknown;
  ts: string | null;
  snapshot: boolean;
}

export interface LiveRecord extends ParsedLiveRecord {
  seq: number;
  received_at: number;
}

export interface SessionMetaUpdate {
  meeting_key: number | null;
  session_name: string | null;
  session_type: string | null;
  meeting_name: string | null;
}

export interface SessionInfoExtracted {
  sessionKey: number;
  meta: SessionMetaUpdate;
}

export interface Gap {
  from: number;
  to: number | null;
}

export interface GapEvent {
  kind: 'open' | 'close';
  at: number;
}

export interface ChunkMeta {
  id: number;
  stream: StreamKind;
  encoding: typeof CHUNK_ENCODING;
  path: string;
  seq_start: number;
  seq_end: number;
  from_ms: number;
  to_ms: number;
  record_count: number;
  byte_len: number;
}

export interface TailSummary {
  timing_count: number;
  telemetry_count: number;
  from_ms: number | null;
  to_ms: number | null;
}

export interface SessionManifest {
  protocol_version: typeof PROTOCOL_VERSION;
  session_key: number;
  meeting_key: number | null;
  session_name: string | null;
  session_type: string | null;
  meeting_name: string | null;
  status: SessionStatus;
  captured_from: number;
  last_received_at: number;
  last_seq: number;
  record_count: number;
  has_telemetry: boolean;
  gaps: Gap[];
  chunks: ChunkMeta[];
  /** Always empty (0/0) for direct R2 static chunks; kept for v1 manifest compatibility. */
  tail: TailSummary;
  writer_id: string | null;
  lease_expires_at: number | null;
  updated_at: number;
}

export interface SessionSummary {
  protocol_version: typeof PROTOCOL_VERSION;
  session_key: number;
  meeting_key: number | null;
  session_name: string | null;
  session_type: string | null;
  meeting_name: string | null;
  status: SessionStatus;
  captured_from: number;
  last_received_at: number;
  last_seq: number;
  record_count: number;
  has_telemetry: boolean;
  chunk_count: number;
  updated_at: number;
}

export interface SessionsIndex {
  protocol_version: typeof PROTOCOL_VERSION;
  sessions: SessionSummary[];
  updated_at: number;
}

export interface LeaseConflictDetail {
  error: string;
  active_writer_id: string | null;
  lease_expires_at: number | null;
}

export function toSessionSummary(manifest: SessionManifest): SessionSummary {
  return {
    protocol_version: PROTOCOL_VERSION,
    session_key: manifest.session_key,
    meeting_key: manifest.meeting_key,
    session_name: manifest.session_name,
    session_type: manifest.session_type,
    meeting_name: manifest.meeting_name,
    status: manifest.status,
    captured_from: manifest.captured_from,
    last_received_at: manifest.last_received_at,
    last_seq: manifest.last_seq,
    record_count: manifest.record_count,
    has_telemetry: manifest.has_telemetry,
    chunk_count: manifest.chunks.length,
    updated_at: manifest.updated_at,
  };
}
