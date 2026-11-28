#!/usr/bin/env node
/**
 * CLI entry point for omfv-live-ingest.
 *
 * Subcommands:
 *   login [--paste]       Sign in to F1 TV (interactive browser or --paste stdin fallback)
 *   status                Show saved F1 TV sign-in status and JWT expiry (never prints token)
 *   logout                Remove saved F1 TV token and persistent browser profile
 *   [run] [options]       Connect to F1 SignalR Core and publish immutable gzipped chunks +
 *                         v1 manifest directly to Cloudflare R2 (S3 API) or a local directory.
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  clearAuthData,
  getBrowserProfileDir,
  getEnvFilePath,
  getTokenFilePath,
  loginWithBrowser,
  loginWithPaste,
  resolveAuthToken,
} from './auth.js';
import { DEFAULT_LIVETIMING_URL } from './protocol.js';
import { ChunkPublisher, PUBLISHER_DEFAULTS } from './publisher.js';
import { createSignalRClient } from './signalr.js';
import { createFsObjectStore, createS3ObjectStore, type ObjectStore } from './storage.js';

export type StorageTarget =
  | {
      kind: 'r2';
      endpoint: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      region: string;
    }
  | {
      kind: 'fs';
      outputDir: string;
    };

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'login'; paste: boolean; timeoutMs?: number; configDir?: string }
  | { kind: 'status'; configDir?: string }
  | { kind: 'logout'; configDir?: string }
  | {
      kind: 'run';
      storage: StorageTarget;
      f1tvToken?: string;
      livetimingUrl: string;
      chunkIntervalMs: number;
      chunkMaxRecords: number;
      chunkMaxBytes: number;
      exitOnFinish: boolean;
      takeover: boolean;
      waitForLive: boolean;
      login: boolean;
      configDir?: string;
      /** True when secret credentials were supplied via CLI argv (visible in ps). */
      secretFromCliFlag?: boolean;
    };

const HELP_TEXT = `omfv-live-ingest — F1 live timing & telemetry SignalR Core ingestor (direct to R2 or local dir)

Usage:
  npm run login [-- --paste]          Sign in to F1 TV (opens browser, or reads token from stdin)
  npm run status                      Show F1 TV sign-in status & expiry (never prints token)
  npm run logout                      Delete saved F1 TV token and browser profile
  npm run ingest [-- options]         Capture F1 SignalR Core feeds and publish v1 chunks + manifest

Storage options (choose R2/S3 OR --output-dir):
  --r2-account-id <id>        Cloudflare account ID (env: OMFV_R2_ACCOUNT_ID)
  --r2-bucket <name>          R2/S3 bucket name (env: OMFV_R2_BUCKET)
  --r2-access-key-id <id>     R2/S3 access key ID (env: OMFV_R2_ACCESS_KEY_ID)
  --r2-secret-access-key <k>  R2/S3 secret access key (env: OMFV_R2_SECRET_ACCESS_KEY)
  --s3-endpoint <url>         Custom S3 endpoint (env: OMFV_S3_ENDPOINT; default: https://<accountId>.r2.cloudflarestorage.com)
  --s3-region <region>        S3 signing region (env: OMFV_S3_REGION; default: auto)
  --output-dir <dir>          Write v1/sessions/... to a local directory (env: OMFV_OUTPUT_DIR, e.g. for Nginx/Caddy)

Chunk & runtime options:
  --chunk-interval-ms <ms>    Chunk flush interval in ms (env: OMFV_CHUNK_INTERVAL_MS, default: ${PUBLISHER_DEFAULTS.chunkIntervalMs})
  --chunk-max-records <n>     Max records per chunk before sealing early (env: OMFV_CHUNK_MAX_RECORDS, default: ${PUBLISHER_DEFAULTS.chunkMaxRecords})
  --chunk-max-bytes <bytes>   Max uncompressed bytes per chunk (env: OMFV_CHUNK_MAX_BYTES, default: ${PUBLISHER_DEFAULTS.chunkMaxBytes})
  --f1tv-token <token>        Explicit F1 TV JWT / login-session cookie (env: OMFV_F1TV_TOKEN)
  --livetiming-url <url>      F1 SignalR base URL (env: OMFV_LIVETIMING_URL, default: ${DEFAULT_LIVETIMING_URL})
  --exit-on-finish            Flush final chunks and exit 0 when SessionData reports Finalised/Ends
  --takeover                  Replace an active ingestor's writer lease (env: OMFV_TAKEOVER=1)
  --wait-for-live             Ignore an already-Finalised initial snapshot until the next live session (default: on)
  --no-wait-for-live          Capture even an already-Finalised initial snapshot (env: OMFV_WAIT_FOR_LIVE=0)
  --login                     Run interactive F1 TV login first if no valid token is saved
  --config-dir <dir>          Override config dir (env: OMFV_INGEST_CONFIG_DIR; default: ~/.config/omfv-live-ingest)
  -h, --help                  Show this help message

Config file:
  Defaults are automatically loaded from ~/.config/omfv-live-ingest/config.env (KEY=VALUE, chmod 600).
  Precedence: CLI flags > process environment > config.env.
`;

/** Parses a simple KEY=VALUE dotenv file (comments, optional `export `, single/double quotes). */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ') || line.startsWith('export\t')) {
      line = line.slice(6).trim();
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[key] = value;
  }
  return out;
}

/** Loads optional `<configDir>/config.env` defaults without modifying `process.env`. */
export function loadConfigEnv(configDir?: string): {
  path: string;
  exists: boolean;
  values: Record<string, string>;
} {
  const filePath = getEnvFilePath(configDir);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { path: filePath, exists: true, values: parseEnvFile(raw) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: filePath, exists: false, values: {} };
    }
    throw err;
  }
}

function extractConfigDirArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--config-dir') {
      return argv[i + 1];
    }
    if (a.startsWith('--config-dir=')) {
      return a.slice('--config-dir='.length);
    }
  }
  return undefined;
}

function parsePositiveIntArg(flag: string, raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error(`Invalid integer value for ${flag}: ${raw ?? '(missing)'}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`Invalid positive integer for ${flag}: ${raw}`);
  }
  return n;
}

export function parseCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliCommand {
  const args = [...argv];
  if (args.includes('-h') || args.includes('--help') || args[0] === 'help') {
    return { kind: 'help' };
  }

  let subcommand = 'run';
  if (args.length > 0 && !args[0]!.startsWith('-')) {
    subcommand = args.shift()!;
  }

  const readValue = (flag: string, i: number): [string, number] => {
    const eq = args[i]!.indexOf('=');
    if (eq >= 0) return [args[i]!.slice(eq + 1), i];
    const next = args[i + 1];
    if (next === undefined) throw new Error(`Missing value for ${flag}`);
    return [next, i + 1];
  };

  if (subcommand === 'login') {
    let paste = false;
    let timeoutMs: number | undefined;
    let configDir: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === '--paste') {
        paste = true;
      } else if (a === '--timeout-ms' || a.startsWith('--timeout-ms=')) {
        const [v, nextI] = readValue('--timeout-ms', i);
        timeoutMs = parsePositiveIntArg('--timeout-ms', v);
        i = nextI;
      } else if (a === '--config-dir' || a.startsWith('--config-dir=')) {
        const [v, nextI] = readValue('--config-dir', i);
        configDir = v;
        i = nextI;
      } else {
        throw new Error(`Unknown option for login: ${a}`);
      }
    }
    return { kind: 'login', paste, timeoutMs, configDir };
  }

  if (subcommand === 'status' || subcommand === 'logout') {
    let configDir: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === '--config-dir' || a.startsWith('--config-dir=')) {
        const [v, nextI] = readValue('--config-dir', i);
        configDir = v;
        i = nextI;
      } else {
        throw new Error(`Unknown option for ${subcommand}: ${a}`);
      }
    }
    return { kind: subcommand, configDir };
  }

  if (subcommand !== 'run') {
    throw new Error(`Unknown subcommand "${subcommand}". Run with --help for usage.`);
  }

  let r2AccountId = env.OMFV_R2_ACCOUNT_ID?.trim() || undefined;
  let r2Bucket = env.OMFV_R2_BUCKET?.trim() || undefined;
  let r2AccessKeyId = env.OMFV_R2_ACCESS_KEY_ID?.trim() || undefined;
  let r2SecretAccessKey = env.OMFV_R2_SECRET_ACCESS_KEY?.trim() || undefined;
  let s3Endpoint = env.OMFV_S3_ENDPOINT?.trim() || undefined;
  let s3Region = env.OMFV_S3_REGION?.trim() || 'auto';
  let outputDir = env.OMFV_OUTPUT_DIR?.trim() || undefined;

  let f1tvToken: string | undefined;
  let livetimingUrl = env.OMFV_LIVETIMING_URL?.trim() || DEFAULT_LIVETIMING_URL;
  let chunkIntervalMs: number = env.OMFV_CHUNK_INTERVAL_MS
    ? parsePositiveIntArg('OMFV_CHUNK_INTERVAL_MS', env.OMFV_CHUNK_INTERVAL_MS.trim())
    : PUBLISHER_DEFAULTS.chunkIntervalMs;
  let chunkMaxRecords: number = env.OMFV_CHUNK_MAX_RECORDS
    ? parsePositiveIntArg('OMFV_CHUNK_MAX_RECORDS', env.OMFV_CHUNK_MAX_RECORDS.trim())
    : PUBLISHER_DEFAULTS.chunkMaxRecords;
  let chunkMaxBytes: number = env.OMFV_CHUNK_MAX_BYTES
    ? parsePositiveIntArg('OMFV_CHUNK_MAX_BYTES', env.OMFV_CHUNK_MAX_BYTES.trim())
    : PUBLISHER_DEFAULTS.chunkMaxBytes;
  let exitOnFinish = false;
  let takeover = env.OMFV_TAKEOVER === '1' || env.OMFV_TAKEOVER === 'true';
  let waitForLive = env.OMFV_WAIT_FOR_LIVE !== '0' && env.OMFV_WAIT_FOR_LIVE !== 'false';
  let login = false;
  let configDir: string | undefined;
  let secretFromCliFlag = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--r2-account-id' || a.startsWith('--r2-account-id=')) {
      const [v, nextI] = readValue('--r2-account-id', i);
      r2AccountId = v;
      i = nextI;
    } else if (a === '--r2-bucket' || a.startsWith('--r2-bucket=')) {
      const [v, nextI] = readValue('--r2-bucket', i);
      r2Bucket = v;
      i = nextI;
    } else if (a === '--r2-access-key-id' || a.startsWith('--r2-access-key-id=')) {
      const [v, nextI] = readValue('--r2-access-key-id', i);
      r2AccessKeyId = v;
      secretFromCliFlag = true;
      i = nextI;
    } else if (a === '--r2-secret-access-key' || a.startsWith('--r2-secret-access-key=')) {
      const [v, nextI] = readValue('--r2-secret-access-key', i);
      r2SecretAccessKey = v;
      secretFromCliFlag = true;
      i = nextI;
    } else if (a === '--s3-endpoint' || a.startsWith('--s3-endpoint=')) {
      const [v, nextI] = readValue('--s3-endpoint', i);
      s3Endpoint = v;
      i = nextI;
    } else if (a === '--s3-region' || a.startsWith('--s3-region=')) {
      const [v, nextI] = readValue('--s3-region', i);
      s3Region = v;
      i = nextI;
    } else if (a === '--output-dir' || a.startsWith('--output-dir=')) {
      const [v, nextI] = readValue('--output-dir', i);
      outputDir = v;
      i = nextI;
    } else if (a === '--chunk-interval-ms' || a.startsWith('--chunk-interval-ms=')) {
      const [v, nextI] = readValue('--chunk-interval-ms', i);
      chunkIntervalMs = parsePositiveIntArg('--chunk-interval-ms', v);
      i = nextI;
    } else if (a === '--chunk-max-records' || a.startsWith('--chunk-max-records=')) {
      const [v, nextI] = readValue('--chunk-max-records', i);
      chunkMaxRecords = parsePositiveIntArg('--chunk-max-records', v);
      i = nextI;
    } else if (a === '--chunk-max-bytes' || a.startsWith('--chunk-max-bytes=')) {
      const [v, nextI] = readValue('--chunk-max-bytes', i);
      chunkMaxBytes = parsePositiveIntArg('--chunk-max-bytes', v);
      i = nextI;
    } else if (a === '--f1tv-token' || a.startsWith('--f1tv-token=')) {
      const [v, nextI] = readValue('--f1tv-token', i);
      f1tvToken = v;
      secretFromCliFlag = true;
      i = nextI;
    } else if (a === '--livetiming-url' || a.startsWith('--livetiming-url=')) {
      const [v, nextI] = readValue('--livetiming-url', i);
      livetimingUrl = v;
      i = nextI;
    } else if (a === '--exit-on-finish') {
      exitOnFinish = true;
    } else if (a === '--takeover') {
      takeover = true;
    } else if (a === '--wait-for-live') {
      waitForLive = true;
    } else if (a === '--no-wait-for-live') {
      waitForLive = false;
    } else if (a === '--login') {
      login = true;
    } else if (a === '--config-dir' || a.startsWith('--config-dir=')) {
      const [v, nextI] = readValue('--config-dir', i);
      configDir = v;
      i = nextI;
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }

  let storage: StorageTarget;
  if (outputDir) {
    storage = { kind: 'fs', outputDir };
  } else {
    const endpoint = s3Endpoint || (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : undefined);
    if (!endpoint || !r2Bucket || !r2AccessKeyId || !r2SecretAccessKey) {
      throw new Error(
        'Missing storage target. Configure R2 in ~/.config/omfv-live-ingest/config.env or env vars ' +
          '(OMFV_R2_ACCOUNT_ID / OMFV_S3_ENDPOINT, OMFV_R2_BUCKET, OMFV_R2_ACCESS_KEY_ID, ' +
          'OMFV_R2_SECRET_ACCESS_KEY), or pass --output-dir <dir>.',
      );
    }
    storage = {
      kind: 'r2',
      endpoint,
      bucket: r2Bucket,
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
      region: s3Region,
    };
  }

  return {
    kind: 'run',
    storage,
    f1tvToken,
    livetimingUrl,
    chunkIntervalMs,
    chunkMaxRecords,
    chunkMaxBytes,
    exitOnFinish,
    takeover,
    waitForLive,
    login,
    configDir,
    ...(secretFromCliFlag ? { secretFromCliFlag: true } : {}),
  };
}

function formatExpiry(expiresAt: number | null): string {
  if (expiresAt == null) return 'unknown';
  const iso = new Date(expiresAt).toISOString();
  const diffMs = expiresAt - Date.now();
  if (diffMs <= 0) return `${iso} (expired)`;
  const hours = Math.floor(diffMs / 3_600_000);
  const mins = Math.floor((diffMs % 3_600_000) / 60_000);
  return `${iso} (in ${hours}h ${mins}m)`;
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const configDirHint = extractConfigDirArg(argv) ?? (env.OMFV_INGEST_CONFIG_DIR?.trim() || undefined);
  const configEnv = loadConfigEnv(configDirHint);
  const mergedEnv: NodeJS.ProcessEnv = { ...configEnv.values };
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) mergedEnv[k] = v;
  }

  const cmd = parseCliArgs(argv, mergedEnv);

  if (cmd.kind === 'help') {
    console.log(HELP_TEXT);
    return 0;
  }

  if (cmd.kind === 'login') {
    const res = cmd.paste
      ? await loginWithPaste({ configDir: cmd.configDir })
      : await loginWithBrowser({ configDir: cmd.configDir, timeoutMs: cmd.timeoutMs });
    console.log(`F1 TV token saved to ${res.tokenPath}`);
    console.log(`Token expires: ${formatExpiry(res.expiresAt)}`);
    return 0;
  }

  if (cmd.kind === 'status') {
    const resolved = resolveAuthToken({
      envToken: mergedEnv.OMFV_F1TV_TOKEN,
      configDir: cmd.configDir,
    });
    const profileDir = getBrowserProfileDir(cmd.configDir);
    const hasProfile = fs.existsSync(profileDir);
    console.log(`Config env file:   ${configEnv.path} (${configEnv.exists ? 'present' : 'not created'})`);
    console.log(`Config token file: ${getTokenFilePath(cmd.configDir)}`);
    console.log(`Browser profile:   ${profileDir} (${hasProfile ? 'present' : 'not created'})`);
    if (!resolved.token) {
      console.log('Status:            not signed in (timing feeds only; run `npm run login` for telemetry)');
      return 0;
    }
    if (resolved.expired) {
      console.log(`Status:            EXPIRED (expires ${formatExpiry(resolved.expiresAt)})`);
      console.log('Action:            run `npm run login` to refresh your F1 TV session.');
      return 0;
    }
    console.log(
      `Status:            signed in via ${resolved.source} (CarData.z + Position.z telemetry enabled)`,
    );
    console.log(`Token expires:     ${formatExpiry(resolved.expiresAt)}`);
    return 0;
  }

  if (cmd.kind === 'logout') {
    const res = clearAuthData(cmd.configDir);
    console.log(
      res.removedToken
        ? `Removed token file: ${res.tokenPath}`
        : `No token file found at: ${res.tokenPath}`,
    );
    console.log(
      res.removedProfile
        ? `Removed browser profile: ${res.profileDir}`
        : `No browser profile found at: ${res.profileDir}`,
    );
    return 0;
  }

  // `run` command
  let resolved = resolveAuthToken({
    cliToken: cmd.f1tvToken,
    envToken: mergedEnv.OMFV_F1TV_TOKEN,
    configDir: cmd.configDir,
  });

  let f1tvToken: string | null = resolved.token;

  if (resolved.source === 'saved' && resolved.expired) {
    if (cmd.login) {
      console.log('[auth] Saved F1 TV token is expired; starting interactive browser login...');
      const fresh = await loginWithBrowser({ configDir: cmd.configDir });
      f1tvToken = fresh.token;
      resolved = {
        token: fresh.token,
        source: 'saved',
        expired: false,
        expiresAt: fresh.expiresAt,
        tokenPath: fresh.tokenPath,
      };
    } else {
      console.warn(
        `[auth] Saved F1 TV token expired (${formatExpiry(resolved.expiresAt)}). ` +
          'Run `npm run login` (or pass `--login`) to enable CarData.z/Position.z telemetry. ' +
          'Continuing anonymously (timing feeds only).',
      );
      f1tvToken = null;
    }
  } else if (!f1tvToken && cmd.login) {
    console.log('[auth] No F1 TV token found; starting interactive browser login...');
    const fresh = await loginWithBrowser({ configDir: cmd.configDir });
    f1tvToken = fresh.token;
    resolved = {
      token: fresh.token,
      source: 'saved',
      expired: false,
      expiresAt: fresh.expiresAt,
      tokenPath: fresh.tokenPath,
    };
  } else if (f1tvToken && resolved.expired) {
    console.warn(
      `[auth] Explicit F1 TV token (${resolved.source}) appears expired (${formatExpiry(resolved.expiresAt)}).`,
    );
  }

  if (cmd.secretFromCliFlag) {
    console.warn(
      '[security] Passing credentials via CLI flags exposes them in process listings (ps). Prefer environment variables or `npm run login`.',
    );
  }
  try {
    const parsedLive = new URL(cmd.livetimingUrl);
    const isLocalLive =
      parsedLive.hostname === 'localhost' ||
      parsedLive.hostname === '127.0.0.1' ||
      parsedLive.hostname === '::1' ||
      parsedLive.hostname === '[::1]';
    if (f1tvToken && !isLocalLive && !/(^|\.)formula1\.com$/i.test(parsedLive.hostname)) {
      console.warn(
        `[security] Warning: sending F1 TV token to non-formula1.com host (${parsedLive.host}).`,
      );
    }
  } catch {
    // Ignore
  }

  const store: ObjectStore =
    cmd.storage.kind === 'fs'
      ? createFsObjectStore(cmd.storage.outputDir)
      : createS3ObjectStore({
          endpoint: cmd.storage.endpoint,
          bucket: cmd.storage.bucket,
          accessKeyId: cmd.storage.accessKeyId,
          secretAccessKey: cmd.storage.secretAccessKey,
          region: cmd.storage.region,
        });

  if (configEnv.exists) {
    console.log(`[ingest] Config env file: ${configEnv.path}`);
  }
  console.log(`[ingest] Target storage:  ${store.description}`);
  console.log(`[ingest] Live timing URL: ${cmd.livetimingUrl}`);
  console.log(
    `[ingest] F1 TV auth:      ${
      f1tvToken
        ? `authenticated via ${resolved.source} (expires ${formatExpiry(resolved.expiresAt)})`
        : 'anonymous (15 timing feeds only; run `npm run login` for CarData.z/Position.z)'
    }`,
  );
  console.log(
    `[ingest] Chunk policy:    flush every ${cmd.chunkIntervalMs}ms (max ${cmd.chunkMaxRecords} records / ${Math.round(cmd.chunkMaxBytes / 1024)} KiB)${
      cmd.exitOnFinish ? ', exit-on-finish' : ''
    }${cmd.takeover ? ', takeover' : ''}${cmd.waitForLive ? ', wait-for-live' : ', no-wait-for-live'}`,
  );

  return await new Promise<number>((resolveExit) => {
    let shuttingDown = false;

    const publisher = new ChunkPublisher({
      store,
      chunkIntervalMs: cmd.chunkIntervalMs,
      chunkMaxRecords: cmd.chunkMaxRecords,
      chunkMaxBytes: cmd.chunkMaxBytes,
      takeover: cmd.takeover,
      waitForLive: cmd.waitForLive,
      onSessionStart(sessionKey, meta) {
        const label = [meta.meeting_name, meta.session_name].filter(Boolean).join(' — ');
        console.log(
          `[ingest] Session discovered: key=${sessionKey}${label ? ` (${label})` : ''} (writer=${publisher.writerId.slice(0, 8)})`,
        );
      },
      onSessionIgnored(sessionKey, meta) {
        const label = [meta.meeting_name, meta.session_name].filter(Boolean).join(' — ');
        console.log(
          `[ingest] Ignoring already-finished session key=${sessionKey}${label ? ` (${label})` : ''}; waiting for next live session...`,
        );
      },
      onChunkPublished(sessionKey, chunks, manifest) {
        const summary = chunks.map((c) => `${c.stream}#${c.id}(${c.record_count}rec,${Math.round(c.byte_len / 1024)}KB)`).join(', ');
        console.log(
          `[ingest] Session ${sessionKey}: published ${summary} (total=${manifest.record_count}, chunks=${manifest.chunks.length})`,
        );
      },
      onSessionFinished(sessionKey) {
        console.log(`[ingest] Session ${sessionKey} marked finished in manifest.json.`);
        if (cmd.exitOnFinish) {
          void shutdown('session finished', 0);
        }
      },
      onLeaseConflict(sessionKey, detail) {
        console.error(
          `[ingest] Conflict on session ${sessionKey}: ${detail.error}. ` +
            'Another ingestor is already active — stopping to avoid duplicate chunks. Pass --takeover to replace it.',
        );
        void shutdown('lease conflict', 2);
      },
      onFatalError(sessionKey, message) {
        console.error(`[ingest] Fatal storage error on session ${sessionKey}: ${message}`);
        void shutdown('fatal error', 1);
      },
    });

    const client = createSignalRClient({
      livetimingUrl: cmd.livetimingUrl,
      f1tvToken,
      onRecord(record, receivedAt) {
        publisher.pushRecord(record, receivedAt);
      },
      onGapEvent(event) {
        console.log(`[signalr] Gap ${event.kind} at ${new Date(event.at).toISOString()}`);
        publisher.pushGapEvent(event);
      },
      onStatus(status, detail) {
        if (status === 'error' || status === 'disconnected' || status === 'reconnecting') {
          console.warn(`[signalr] ${status}${detail ? `: ${detail}` : ''}`);
        } else {
          console.log(`[signalr] ${status}${detail ? `: ${detail}` : ''}`);
        }
      },
    });

    const onSigInt = () => {
      void shutdown('SIGINT', 0);
    };
    const onSigTerm = () => {
      void shutdown('SIGTERM', 0);
    };

    async function shutdown(reason: string, exitCode = 0): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
      console.log(`[ingest] Shutting down (${reason}); flushing buffered chunks...`);
      client.stop();
      const drained = exitCode === 0 ? await publisher.flushAndStop(10_000) : false;
      const stats = publisher.getStats();
      console.log(
        `[ingest] Shutdown complete (drained=${drained}, chunks=${stats.totalPublishedChunks}, records=${stats.totalPublishedRecords}).`,
      );
      resolveExit(exitCode);
    }

    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);

    publisher.start();
    client.start();
  });
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(fs.realpathSync(entry)).href === import.meta.url;
  } catch {
    return pathToFileURL(entry).href === import.meta.url;
  }
}

if (isDirectEntry()) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[ingest] Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
