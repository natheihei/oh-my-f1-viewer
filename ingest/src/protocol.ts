/**
 * F1 SignalR Core wire protocol parsing, `.z` raw-deflate inflation, SessionInfo extraction,
 * and SessionData finish detection.
 */

import zlib from 'node:zlib';
import {
  COMPRESSED_FEEDS,
  type ParsedLiveRecord,
  type SessionInfoExtracted,
  type SessionMetaUpdate,
} from './types.js';

/** SignalR JSON protocol record separator (ASCII 0x1e). */
export const SIGNALR_RS = '\x1e';

/** Safety cap for inflated CarData.z / Position.z JSON payloads (matches livetiming.js). */
export const MAX_INFLATED_BYTES = 16 * 1024 * 1024;

export const DEFAULT_LIVETIMING_URL = 'https://livetiming.formula1.com';

/** Strip a leading UTF-8 BOM if present. */
export function stripBom(text: string): string {
  if (typeof text !== 'string') return '';
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function isCompressedFeed(feed: string): boolean {
  return COMPRESSED_FEEDS.has(feed);
}

/** Inflates a base64 raw-deflate `.z` telemetry payload into parsed JSON. */
export function inflateZ(b64: string): unknown {
  const buf = Buffer.from(String(b64), 'base64');
  const inflated = zlib
    .inflateRawSync(buf, { maxOutputLength: MAX_INFLATED_BYTES })
    .toString('utf8');
  return JSON.parse(stripBom(inflated));
}

/**
 * Decodes a single live feed payload. Compressed feeds (`CarData.z`, `Position.z`) arrive over
 * SignalR as base64 strings and are inflated; malformed blobs return null so they can be dropped.
 */
export function decodeLiveValue(feed: string, value: unknown): unknown | null {
  if (value == null) return null;
  if (!isCompressedFeed(feed)) return value;
  if (typeof value !== 'string' || !value) return null;
  try {
    return inflateZ(value);
  } catch {
    return null;
  }
}

/** Splits a raw SignalR Core WebSocket message by `\x1e` and parses JSON frames safely. */
export function splitCoreFrames(raw: string | Buffer): unknown[] {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const out: unknown[] = [];
  for (const part of text.split(SIGNALR_RS)) {
    if (!part) continue;
    try {
      out.push(JSON.parse(part));
    } catch {
      // Ignore malformed JSON frames.
    }
  }
  return out;
}

/** Validates the first SignalR Core handshake response frame (`{}\x1e`). */
export function parseHandshakeFrame(
  frame: unknown,
): { ok: true } | { ok: false; error: string } {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    return { ok: false, error: 'invalid SignalR handshake response' };
  }
  const err = (frame as { error?: unknown }).error;
  if (err != null && err !== '') {
    return { ok: false, error: String(err) };
  }
  return { ok: true };
}

/**
 * Converts parsed SignalR Core JSON messages into normalized `ParsedLiveRecord` items:
 * - Type 3 (`Subscribe` completion snapshot): emits `SessionInfo` first when present, with
 *   `snapshot: true`, `ts: null`.
 * - Type 1 (`target: 'feed'`): emits incremental update with `snapshot: false`, `ts`.
 */
export function recordsFromCoreMessages(msgs: unknown[]): ParsedLiveRecord[] {
  const out: ParsedLiveRecord[] = [];
  const push = (topic: string, rawData: unknown, ts: string | null, snapshot: boolean) => {
    const data = decodeLiveValue(topic, rawData);
    if (data != null) {
      out.push({ topic, data, ts, snapshot });
    }
  };

  for (const rawMsg of msgs) {
    if (!rawMsg || typeof rawMsg !== 'object' || Array.isArray(rawMsg)) continue;
    const msg = rawMsg as {
      type?: unknown;
      target?: unknown;
      arguments?: unknown;
      result?: unknown;
    };

    const isFeedUpdate =
      msg.type === 1 &&
      msg.target === 'feed' &&
      Array.isArray(msg.arguments) &&
      msg.arguments.length >= 2;

    if (isFeedUpdate) {
      const args = msg.arguments as unknown[];
      const topic = String(args[0]);
      const ts = typeof args[2] === 'string' ? args[2] : null;
      push(topic, args[1], ts, false);
    } else if (
      msg.type === 3 &&
      msg.result &&
      typeof msg.result === 'object' &&
      !Array.isArray(msg.result)
    ) {
      const result = msg.result as Record<string, unknown>;
      const keys = Object.keys(result);
      // Emit SessionInfo first so downstream session discovery happens before sibling snapshot feeds.
      const orderedKeys = keys.includes('SessionInfo')
        ? ['SessionInfo', ...keys.filter((k) => k !== 'SessionInfo')]
        : keys;
      for (const feed of orderedKeys) {
        push(feed, result[feed], null, true);
      }
    }
  }

  return out;
}

export function parseCoreFrame(raw: string | Buffer): ParsedLiveRecord[] {
  return recordsFromCoreMessages(splitCoreFrames(raw));
}

function toPositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Extracts `sessionKey` and `SessionMetaUpdate` from a `SessionInfo` feed payload. */
export function extractSessionInfo(data: unknown): SessionInfoExtracted | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const obj = data as {
    Key?: unknown;
    Name?: unknown;
    Type?: unknown;
    Meeting?: { Key?: unknown; Name?: unknown; OfficialName?: unknown } | null;
  };

  const sessionKey = toPositiveInt(obj.Key);
  if (sessionKey == null) return null;

  const meeting = obj.Meeting && typeof obj.Meeting === 'object' ? obj.Meeting : null;
  const meta: SessionMetaUpdate = {
    meeting_key: meeting ? toPositiveInt(meeting.Key) : null,
    session_name: toNonEmptyString(obj.Name),
    session_type: toNonEmptyString(obj.Type),
    meeting_name: meeting
      ? toNonEmptyString(meeting.Name) ?? toNonEmptyString(meeting.OfficialName)
      : null,
  };

  return { sessionKey, meta };
}

const FINISHED_STATUSES = new Set(['Finalised', 'Ends']);

function iterSeriesItems(series: unknown): unknown[] {
  if (Array.isArray(series)) return series;
  if (series && typeof series === 'object') return Object.values(series as Record<string, unknown>);
  return [];
}

/**
 * Returns true if a `SessionData` payload reports `Finalised` or `Ends` in `StatusSeries`
 * (supports both array and keyed-object incremental forms).
 */
export function isSessionFinishedData(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const obj = data as { StatusSeries?: unknown; SessionStatus?: unknown };

  if (typeof obj.SessionStatus === 'string' && FINISHED_STATUSES.has(obj.SessionStatus)) {
    return true;
  }

  for (const item of iterSeriesItems(obj.StatusSeries)) {
    if (!item || typeof item !== 'object') continue;
    const status = (item as { SessionStatus?: unknown }).SessionStatus;
    if (typeof status === 'string' && FINISHED_STATUSES.has(status)) {
      return true;
    }
  }

  return false;
}
