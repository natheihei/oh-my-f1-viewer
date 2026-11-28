/**
 * Resilient F1 SignalR Core live timing client.
 * Mirrors electron/vendor/f1ov/livetiming.js + liveConnection.js:
 *  1. OPTIONS {base}/signalrcore/negotiate -> optional AWSALBCORS cookie
 *  2. POST {base}/signalrcore/negotiate?negotiateVersion=1 -> connectionToken
 *  3. WebSocket wss://.../signalrcore?id=<token> with Cookie + optional Bearer F1 TV token
 *  4. Handshake {"protocol":"json","version":1}\x1e -> validate {}\x1e (20s timeout)
 *  5. Subscribe to all 17 LIVE_FEEDS
 *  6. Keepalive {"type":6}\x1e every 15s, watchdog 45s, exponential backoff reconnect (1s..30s ±20%)
 *     emitting GapEvent open/close across drops and reconnects.
 */

import WebSocket from 'ws';
import {
  DEFAULT_LIVETIMING_URL,
  SIGNALR_RS,
  parseHandshakeFrame,
  recordsFromCoreMessages,
  splitCoreFrames,
  stripBom,
} from './protocol.js';
import { LIVE_FEEDS, type GapEvent, type ParsedLiveRecord } from './types.js';

export const SIGNALR_DEFAULTS = {
  keepaliveMs: 15_000,
  watchdogMs: 45_000,
  watchdogCheckMs: 5_000,
  handshakeTimeoutMs: 20_000,
  negotiateTimeoutMs: 15_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  userAgent: 'BestHTTP',
} as const;

export type SignalRStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'error'
  | 'stopped';

export interface SignalRTimingOptions {
  keepaliveMs?: number;
  watchdogMs?: number;
  watchdogCheckMs?: number;
  handshakeTimeoutMs?: number;
  negotiateTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface NegotiateResult {
  connectionToken: string;
  cookie: string | null;
}

export interface SignalRClientOptions {
  /** Base HTTP(S) URL of F1 live timing (defaults to https://livetiming.formula1.com). */
  livetimingUrl?: string;
  /** Optional F1 TV subscription JWT (required for CarData.z and Position.z). */
  f1tvToken?: string | null;
  /** Feeds to subscribe to (defaults to all 17 LIVE_FEEDS). */
  feeds?: readonly string[];
  /** Custom User-Agent header (defaults to BestHTTP). */
  userAgent?: string;
  /** Called for each decoded live record. */
  onRecord: (record: ParsedLiveRecord, receivedAt: number) => void;
  /** Called when an established connection drops (open) or recovers (close). */
  onGapEvent?: (event: GapEvent) => void;
  /** Called on connection lifecycle transitions. */
  onStatus?: (status: SignalRStatus, detail?: string) => void;
  /** Timing overrides (useful for tests). */
  timing?: SignalRTimingOptions;
  /** Injectable fetch implementation (defaults to globalThis.fetch). */
  fetchFn?: typeof fetch;
  /** Injectable clock (defaults to Date.now). */
  now?: () => number;
  /** Injectable RNG for backoff jitter (defaults to Math.random). */
  random?: () => number;
}

export interface SignalRClient {
  start(): void;
  stop(): void;
  resubscribe(): boolean;
  isRunning(): boolean;
}

/** Exponential backoff delay in ms: base * 2^attempt capped at max, with +/-20% jitter. */
export function backoffDelay(
  attempt: number,
  opts: { backoffBaseMs?: number; backoffMaxMs?: number } = {},
  random: () => number = Math.random,
): number {
  const base = opts.backoffBaseMs ?? SIGNALR_DEFAULTS.backoffBaseMs;
  const max = opts.backoffMaxMs ?? SIGNALR_DEFAULTS.backoffMaxMs;
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt));
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.max(1, Math.round(raw * jitter));
}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Builds headers for F1 SignalR negotiate & WebSocket requests. */
export function buildSignalRHeaders(opts: {
  f1tvToken?: string | null;
  cookie?: string | null;
  userAgent?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': opts.userAgent || SIGNALR_DEFAULTS.userAgent,
  };
  if (opts.cookie) {
    headers.Cookie = opts.cookie;
  }
  if (typeof opts.f1tvToken === 'string' && opts.f1tvToken.trim().length > 20) {
    headers.Authorization = `Bearer ${opts.f1tvToken.trim()}`;
  }
  return headers;
}

/** Extracts `AWSALBCORS=...` cookie pair from Fetch Headers. */
export function extractAwsAlbCookie(headers: Headers): string | null {
  const list: string[] =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter((v): v is string => Boolean(v));

  for (const entry of list) {
    const match = entry.match(/(?:^|,\s*)(AWSALBCORS=[^;,\s]+)/i);
    if (match) return match[1];
  }
  return null;
}

/** Step 1: Optional OPTIONS request to obtain AWS ALB affinity cookie. */
export async function fetchAwsAlbCookie(
  baseUrl: string,
  opts: {
    f1tvToken?: string | null;
    userAgent?: string;
    timeoutMs?: number;
    fetchFn?: typeof fetch;
  } = {},
): Promise<string | null> {
  const fetchImpl = opts.fetchFn ?? globalThis.fetch;
  const url = `${normalizeBaseUrl(baseUrl)}/signalrcore/negotiate`;
  try {
    const res = await fetchImpl(url, {
      method: 'OPTIONS',
      headers: buildSignalRHeaders({ f1tvToken: opts.f1tvToken, userAgent: opts.userAgent }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? SIGNALR_DEFAULTS.negotiateTimeoutMs),
    });
    return extractAwsAlbCookie(res.headers);
  } catch {
    return null;
  }
}

/** Step 2: POST negotiateVersion=1 to obtain SignalR Core `connectionToken`. */
export async function negotiateCore(
  baseUrl: string,
  cookie: string | null,
  opts: {
    f1tvToken?: string | null;
    userAgent?: string;
    timeoutMs?: number;
    fetchFn?: typeof fetch;
  } = {},
): Promise<string> {
  const fetchImpl = opts.fetchFn ?? globalThis.fetch;
  const url = `${normalizeBaseUrl(baseUrl)}/signalrcore/negotiate?negotiateVersion=1`;
  const headers = buildSignalRHeaders({
    f1tvToken: opts.f1tvToken,
    cookie,
    userAgent: opts.userAgent,
  });

  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? SIGNALR_DEFAULTS.negotiateTimeoutMs),
  });

  if (!res.ok) {
    if ((res.status === 401 || res.status === 403) && headers.Authorization) {
      throw new Error(
        `SignalR Core negotiate refused F1 TV token (HTTP ${res.status}). Re-run \`npm run login\`.`,
      );
    }
    throw new Error(`POST ${url} returned HTTP ${res.status}`);
  }

  const txt = await res.text();
  const parsed = JSON.parse(stripBom(txt)) as {
    connectionToken?: unknown;
    connectionId?: unknown;
  };
  const token =
    (typeof parsed.connectionToken === 'string' && parsed.connectionToken) ||
    (typeof parsed.connectionId === 'string' && parsed.connectionId) ||
    null;

  if (!token) {
    throw new Error('SignalR Core negotiate: no connectionToken in response');
  }
  return token;
}

/** Converts an HTTP(S) base URL + connectionToken into the SignalR Core WebSocket URL. */
export function toSignalRWsUrl(baseUrl: string, connectionToken: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  const wsBase = normalized.startsWith('https://')
    ? `wss://${normalized.slice('https://'.length)}`
    : normalized.startsWith('http://')
      ? `ws://${normalized.slice('http://'.length)}`
      : normalized;
  return `${wsBase}/signalrcore?id=${encodeURIComponent(connectionToken)}`;
}

/** Creates a resilient SignalR Core client for F1 live timing & telemetry. */
export function createSignalRClient(options: SignalRClientOptions): SignalRClient {
  const baseUrl = normalizeBaseUrl(options.livetimingUrl || DEFAULT_LIVETIMING_URL);
  const feeds = [...(options.feeds ?? LIVE_FEEDS)];
  const userAgent = options.userAgent ?? SIGNALR_DEFAULTS.userAgent;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const timing = {
    keepaliveMs: options.timing?.keepaliveMs ?? SIGNALR_DEFAULTS.keepaliveMs,
    watchdogMs: options.timing?.watchdogMs ?? SIGNALR_DEFAULTS.watchdogMs,
    watchdogCheckMs: options.timing?.watchdogCheckMs ?? SIGNALR_DEFAULTS.watchdogCheckMs,
    handshakeTimeoutMs: options.timing?.handshakeTimeoutMs ?? SIGNALR_DEFAULTS.handshakeTimeoutMs,
    negotiateTimeoutMs: options.timing?.negotiateTimeoutMs ?? SIGNALR_DEFAULTS.negotiateTimeoutMs,
    backoffBaseMs: options.timing?.backoffBaseMs ?? SIGNALR_DEFAULTS.backoffBaseMs,
    backoffMaxMs: options.timing?.backoffMaxMs ?? SIGNALR_DEFAULTS.backoffMaxMs,
  };

  const emitStatus = (s: SignalRStatus, detail?: string) => {
    try {
      options.onStatus?.(s, detail);
    } catch {
      // Never let status listener throw into socket callbacks.
    }
  };

  const emitGap = (kind: 'open' | 'close') => {
    try {
      options.onGapEvent?.({ kind, at: now() });
    } catch {
      // Never let gap listener throw into socket callbacks.
    }
  };

  let running = false;
  let generation = 0;
  let ws: WebSocket | null = null;
  let readySocket: WebSocket | null = null;
  let connecting = false;
  let attempt = 0;
  let invocationSeq = 0;
  let lastActivity = 0;
  let hasConnectedOnce = false;
  let gapOpen = false;

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSocketTimers() {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
  }

  function sendSubscribe(socket: WebSocket) {
    invocationSeq += 1;
    const payload = JSON.stringify({
      type: 1,
      invocationId: String(invocationSeq),
      target: 'Subscribe',
      arguments: [feeds],
    });
    socket.send(payload + SIGNALR_RS);
  }

  function openGapIfNeeded() {
    if (hasConnectedOnce && !gapOpen) {
      gapOpen = true;
      emitGap('open');
    }
  }

  function closeGapIfNeeded() {
    if (gapOpen) {
      gapOpen = false;
      emitGap('close');
    }
  }

  function scheduleReconnect(gen: number) {
    if (!running || gen !== generation || reconnectTimer) return;
    const delay = backoffDelay(attempt, timing, random);
    attempt += 1;
    emitStatus('reconnecting', `retry in ${Math.max(1, Math.round(delay / 1000))}s (${delay}ms)`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect(gen);
    }, delay);
  }

  async function negotiate(): Promise<NegotiateResult> {
    const cookie = await fetchAwsAlbCookie(baseUrl, {
      f1tvToken: options.f1tvToken,
      userAgent,
      timeoutMs: timing.negotiateTimeoutMs,
      fetchFn,
    });
    const connectionToken = await negotiateCore(baseUrl, cookie, {
      f1tvToken: options.f1tvToken,
      userAgent,
      timeoutMs: timing.negotiateTimeoutMs,
      fetchFn,
    });
    return { connectionToken, cookie };
  }

  async function connect(gen: number): Promise<void> {
    if (!running || gen !== generation || connecting || ws) return;
    connecting = true;
    emitStatus('connecting');

    let socket: WebSocket;
    try {
      const { connectionToken, cookie } = await negotiate();
      if (!running || gen !== generation) return;
      const wsUrl = toSignalRWsUrl(baseUrl, connectionToken);
      const headers = buildSignalRHeaders({
        f1tvToken: options.f1tvToken,
        cookie,
        userAgent,
      });
      socket = new WebSocket(wsUrl, { headers });
    } catch (err) {
      if (running && gen === generation) {
        openGapIfNeeded();
        emitStatus('error', err instanceof Error ? err.message : 'negotiate failed');
        scheduleReconnect(gen);
      }
      return;
    } finally {
      if (gen === generation) connecting = false;
    }

    ws = socket;
    let handshaken = false;
    lastActivity = now();

    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      if (ws !== socket || handshaken) return;
      emitStatus('error', 'SignalR handshake timed out');
      try {
        socket.terminate();
      } catch {
        // Ignore close errors.
      }
    }, timing.handshakeTimeoutMs);

    socket.on('open', () => {
      if (ws !== socket) return;
      try {
        socket.send(JSON.stringify({ protocol: 'json', version: 1 }) + SIGNALR_RS);
      } catch (err) {
        emitStatus('error', err instanceof Error ? err.message : 'handshake send failed');
      }
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      if (ws !== socket) return;
      const receivedAt = now();
      lastActivity = receivedAt;

      const text =
        typeof raw === 'string'
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : Array.isArray(raw)
              ? Buffer.concat(raw).toString('utf8')
              : Buffer.from(raw).toString('utf8');

      const frames = splitCoreFrames(text);
      if (!handshaken) {
        if (!frames.length) return;
        const handshake = parseHandshakeFrame(frames.shift());
        if (!handshake.ok) {
          emitStatus('error', handshake.error);
          try {
            socket.close();
          } catch {
            // Ignore close errors.
          }
          return;
        }
        handshaken = true;
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        attempt = 0;
        readySocket = socket;
        hasConnectedOnce = true;
        closeGapIfNeeded();
        sendSubscribe(socket);
        emitStatus('connected');

        keepaliveTimer = setInterval(() => {
          try {
            socket.send(JSON.stringify({ type: 6 }) + SIGNALR_RS);
          } catch {
            // Close handler will trigger reconnect.
          }
        }, timing.keepaliveMs);

        watchdogTimer = setInterval(() => {
          if (now() - lastActivity > timing.watchdogMs) {
            emitStatus('error', 'connection stalled (watchdog timeout)');
            try {
              socket.terminate();
            } catch {
              // Ignore terminate errors.
            }
          }
        }, timing.watchdogCheckMs);
      }

      if (frames.length > 0) {
        const records = recordsFromCoreMessages(frames);
        for (const rec of records) {
          try {
            options.onRecord(rec, receivedAt);
          } catch (err) {
            emitStatus(
              'error',
              `record handler error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    });

    socket.on('close', () => {
      if (readySocket === socket) readySocket = null;
      if (ws !== socket) return;
      ws = null;
      clearSocketTimers();
      if (!running || gen !== generation) return;
      openGapIfNeeded();
      emitStatus('disconnected');
      scheduleReconnect(gen);
    });

    socket.on('error', (err: Error) => {
      if (ws !== socket) return;
      emitStatus('error', err.message || 'websocket error');
    });
  }

  return {
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      void connect(generation);
    },
    stop() {
      running = false;
      generation += 1;
      connecting = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearSocketTimers();
      const s = ws;
      ws = null;
      readySocket = null;
      if (s) {
        try {
          s.close();
        } catch {
          // Ignore close errors.
        }
      }
      emitStatus('stopped');
    },
    resubscribe() {
      if (!running || !readySocket || readySocket !== ws) return false;
      try {
        sendSubscribe(readySocket);
        return true;
      } catch {
        return false;
      }
    },
    isRunning() {
      return running;
    },
  };
}
