/**
 * F1 TV authentication for omfv-live-ingest:
 * - Parses `login-session` cookies and raw subscription JWTs.
 * - Persists token at `~/.config/omfv-live-ingest/f1tv-token.json` with 0600 permissions.
 * - Launches interactive Playwright Chromium login against account.formula1.com or accepts --paste.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export const F1_LOGIN_URL = 'https://account.formula1.com/';
export const FORMULA1_COOKIE_URLS = [
  'https://account.formula1.com',
  'https://formula1.com',
  'https://f1tv.formula1.com',
];

export const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;
export const DEFAULT_POLL_INTERVAL_MS = 500;
export const DEFAULT_EXPIRY_SKEW_MS = 60_000;

export interface StoredTokenRecord {
  token: string;
  saved_at: number;
  expires_at: number | null;
}

export interface LoginResult {
  token: string;
  expiresAt: number | null;
  tokenPath: string;
}

export type AuthTokenSource = 'flag' | 'env' | 'saved' | 'none';

export interface ResolvedAuthToken {
  token: string | null;
  source: AuthTokenSource;
  expired: boolean;
  expiresAt: number | null;
  tokenPath: string;
}

export function getConfigDir(overrideDir?: string): string {
  if (overrideDir && overrideDir.trim()) return path.resolve(overrideDir.trim());
  const fromEnv = process.env.OMFV_INGEST_CONFIG_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.config', 'omfv-live-ingest');
}

export function getTokenFilePath(configDir?: string): string {
  return path.join(getConfigDir(configDir), 'f1tv-token.json');
}

export function getEnvFilePath(configDir?: string): string {
  return path.join(getConfigDir(configDir), 'config.env');
}

export function getBrowserProfileDir(configDir?: string): string {
  return path.join(getConfigDir(configDir), 'browser-profile');
}

/** Builds a clean desktop Chrome UA (mirrors electron/vendor/f1ov/loginUtils.js). */
export function buildLoginUserAgent(chromeVersion?: string): string {
  const version =
    typeof chromeVersion === 'string' && /^\d+(?:\.\d+){1,3}$/.test(chromeVersion)
      ? chromeVersion
      : '144.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

export function isFormula1CookieDomain(domain?: string | null): boolean {
  return /(^|\.)formula1\.com$/i.test(domain ?? '');
}

/** Decodes a JWT payload without signature verification. Returns null if malformed. */
export function parseJwtPayload(token: string): Record<string, unknown> | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Returns the JWT `exp` claim converted to epoch milliseconds, or null if absent/unreadable. */
export function parseJwtExpiry(token: string): number | null {
  const payload = parseJwtPayload(token);
  if (!payload) return null;
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return exp * 1000;
}

/** True when the token has a readable `exp` claim that is expired (within `skewMs`). */
export function isTokenExpired(
  token: string,
  skewMs = DEFAULT_EXPIRY_SKEW_MS,
  nowMs = Date.now(),
): boolean {
  const expMs = parseJwtExpiry(token);
  if (expMs == null) return false;
  return expMs - nowMs <= skewMs;
}

function isPlausibleJwt(value: string): boolean {
  if (value.length <= 50) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  if (!parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p))) return false;
  return parseJwtPayload(value) !== null;
}

function extractTokenFromObject(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as { data?: { subscriptionToken?: unknown }; subscriptionToken?: unknown };
  const candidate = obj.data?.subscriptionToken ?? obj.subscriptionToken;
  if (typeof candidate === 'string' && candidate.trim().length > 50) {
    return candidate.trim();
  }
  return null;
}

/**
 * Extracts the F1 TV subscription JWT from either:
 * - F1's URL-encoded JSON `login-session` cookie value (or `login-session=<value>`),
 * - decoded JSON containing `data.subscriptionToken` or `subscriptionToken`, or
 * - a raw JWT pasted directly.
 */
export function tokenFromLoginSessionCookie(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;

  // Strip optional "login-session=" prefix and trailing cookie attributes if pasted from DevTools.
  if (/^login-session=/i.test(value)) {
    value = value.slice('login-session='.length);
    const semi = value.indexOf(';');
    if (semi >= 0) value = value.slice(0, semi);
    value = value.trim();
  }

  // Strip surrounding quotes if pasted as a quoted string.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }

  // 1. Try URL-decoded JSON (standard F1 `login-session` cookie format).
  try {
    const decoded = decodeURIComponent(value);
    const parsed: unknown = JSON.parse(decoded);
    const tok = extractTokenFromObject(parsed);
    if (tok) return tok;
  } catch {
    // Fall through to raw JSON / raw JWT checks.
  }

  // 2. Try raw JSON (in case the cookie value was already URL-decoded).
  try {
    const parsed: unknown = JSON.parse(value);
    const tok = extractTokenFromObject(parsed);
    if (tok) return tok;
  } catch {
    // Fall through to raw JWT check.
  }

  // 3. Accept a raw JWT pasted directly.
  if (isPlausibleJwt(value)) {
    return value;
  }

  return null;
}

/** Saves the F1 TV token JSON to disk with strict 0600 permissions. */
export function saveToken(token: string, configDir?: string, nowMs = Date.now()): StoredTokenRecord {
  const dir = getConfigDir(configDir);
  const filePath = getTokenFilePath(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort on filesystems that don't support POSIX chmod.
  }

  const record: StoredTokenRecord = {
    token,
    saved_at: nowMs,
    expires_at: parseJwtExpiry(token),
  };

  const tmpPath = `${filePath}.${process.pid}.${nowMs}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // Best-effort.
  }
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort.
  }

  return record;
}

/** Loads the saved F1 TV token from disk, or returns null if missing or malformed. */
export function loadSavedToken(configDir?: string): StoredTokenRecord | null {
  const filePath = getTokenFilePath(configDir);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredTokenRecord> | null;
    if (!parsed || typeof parsed.token !== 'string' || parsed.token.trim().length <= 50) {
      return null;
    }
    const token = parsed.token.trim();
    const savedAt =
      typeof parsed.saved_at === 'number' && Number.isFinite(parsed.saved_at)
        ? parsed.saved_at
        : 0;
    const expiresAt =
      typeof parsed.expires_at === 'number' && Number.isFinite(parsed.expires_at)
        ? parsed.expires_at
        : parseJwtExpiry(token);
    return { token, saved_at: savedAt, expires_at: expiresAt };
  } catch {
    return null;
  }
}

/** Removes the saved token file and Playwright browser profile directory. */
export function clearAuthData(configDir?: string): {
  removedToken: boolean;
  removedProfile: boolean;
  tokenPath: string;
  profileDir: string;
} {
  const dir = getConfigDir(configDir);
  const tokenPath = getTokenFilePath(dir);
  const profileDir = getBrowserProfileDir(dir);

  let removedToken = false;
  let removedProfile = false;

  if (fs.existsSync(tokenPath)) {
    fs.rmSync(tokenPath, { force: true });
    removedToken = true;
  }
  if (fs.existsSync(profileDir)) {
    fs.rmSync(profileDir, { recursive: true, force: true });
    removedProfile = true;
  }

  return { removedToken, removedProfile, tokenPath, profileDir };
}

/**
 * Resolves the F1 TV token following strict precedence:
 * `--f1tv-token` > `OMFV_F1TV_TOKEN` > saved `f1tv-token.json` > anonymous (null).
 */
export function resolveAuthToken(opts: {
  cliToken?: string;
  envToken?: string;
  configDir?: string;
  nowMs?: number;
  skewMs?: number;
} = {}): ResolvedAuthToken {
  const nowMs = opts.nowMs ?? Date.now();
  const skewMs = opts.skewMs ?? DEFAULT_EXPIRY_SKEW_MS;
  const tokenPath = getTokenFilePath(opts.configDir);

  const normalizeInput = (raw: string | undefined): string | null => {
    if (!raw || !raw.trim()) return null;
    return tokenFromLoginSessionCookie(raw) ?? raw.trim();
  };

  const fromFlag = normalizeInput(opts.cliToken);
  if (fromFlag) {
    return {
      token: fromFlag,
      source: 'flag',
      expired: isTokenExpired(fromFlag, skewMs, nowMs),
      expiresAt: parseJwtExpiry(fromFlag),
      tokenPath,
    };
  }

  const fromEnv = normalizeInput(opts.envToken);
  if (fromEnv) {
    return {
      token: fromEnv,
      source: 'env',
      expired: isTokenExpired(fromEnv, skewMs, nowMs),
      expiresAt: parseJwtExpiry(fromEnv),
      tokenPath,
    };
  }

  const saved = loadSavedToken(opts.configDir);
  if (saved) {
    return {
      token: saved.token,
      source: 'saved',
      expired: isTokenExpired(saved.token, skewMs, nowMs),
      expiresAt: saved.expires_at ?? parseJwtExpiry(saved.token),
      tokenPath,
    };
  }

  return {
    token: null,
    source: 'none',
    expired: false,
    expiresAt: null,
    tokenPath,
  };
}

/** Finds an installed system Chrome/Chromium binary if available. */
export function findSystemBrowserExecutable(): string | null {
  const envExec = process.env.OMFV_BROWSER_EXECUTABLE?.trim();
  if (envExec && fs.existsSync(envExec)) return envExec;

  const candidates: string[] =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ]
      : process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
          ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export interface BrowserLoginOptions {
  configDir?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  executablePath?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * Opens an interactive Playwright Chromium window at https://account.formula1.com/ using a
 * persistent profile, polls for a valid non-expired `login-session` cookie on `*.formula1.com`,
 * saves the extracted subscription JWT with 0600 permissions, and closes the browser.
 */
export async function loginWithBrowser(options: BrowserLoginOptions = {}): Promise<LoginResult> {
  const { chromium } = await import('playwright');

  const configDir = getConfigDir(options.configDir);
  const profileDir = getBrowserProfileDir(configDir);
  const tokenPath = getTokenFilePath(configDir);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const log = options.logger ?? console;

  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  const userAgent = buildLoginUserAgent();
  const baseLaunchOpts = {
    headless: false,
    userAgent,
    viewport: { width: 1024, height: 760 },
    args: ['--disable-blink-features=AutomationControlled'],
  };

  let context;
  const preferredExec = options.executablePath ?? findSystemBrowserExecutable();
  if (preferredExec) {
    log.log(`[auth] Launching browser (${preferredExec}) for F1 TV sign-in...`);
    context = await chromium.launchPersistentContext(profileDir, {
      ...baseLaunchOpts,
      executablePath: preferredExec,
    });
  } else {
    // Try system Chrome channel first, then fall back to Playwright's bundled Chromium.
    try {
      log.log('[auth] Launching Chrome channel for F1 TV sign-in...');
      context = await chromium.launchPersistentContext(profileDir, {
        ...baseLaunchOpts,
        channel: 'chrome',
      });
    } catch {
      try {
        log.log('[auth] Launching Playwright Chromium for F1 TV sign-in...');
        context = await chromium.launchPersistentContext(profileDir, baseLaunchOpts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Could not launch Chromium for browser login (${msg}). ` +
            'Install Chromium (`npx playwright install chromium`) or use headless paste mode (`npm run login -- --paste`).',
        );
      }
    }
  }

  let closed = false;
  context.on('close', () => {
    closed = true;
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    log.log(`[auth] Opening ${F1_LOGIN_URL} — sign in to your F1 TV account in the browser window.`);
    await page.goto(F1_LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch((err) => {
      log.warn('[auth] Initial navigation warning:', err instanceof Error ? err.message : String(err));
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (closed) {
        throw new Error('Browser window closed before F1 TV sign-in completed.');
      }
      const cookies = await context.cookies(FORMULA1_COOKIE_URLS).catch(() => []);
      for (const cookie of cookies) {
        if (cookie.name !== 'login-session' || !isFormula1CookieDomain(cookie.domain)) continue;
        const token = tokenFromLoginSessionCookie(cookie.value);
        if (!token || isTokenExpired(token)) continue;
        // Brief settle period so any sibling cookies flush to the persistent profile.
        await new Promise((r) => setTimeout(r, 500));
        const saved = saveToken(token, configDir);
        const expiryStr = saved.expires_at ? new Date(saved.expires_at).toISOString() : 'unknown';
        log.log(`[auth] Signed in to F1 TV. Token saved to ${tokenPath} (expires ${expiryStr}).`);
        return { token, expiresAt: saved.expires_at, tokenPath };
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for F1 TV login-session cookie.`,
    );
  } finally {
    if (!closed) {
      await context.close().catch(() => {});
    }
  }
}

export interface PasteLoginOptions {
  configDir?: string;
  input?: Readable;
  output?: Writable;
  isTTY?: boolean;
  nowMs?: number;
}

/**
 * Headless fallback: reads a raw subscription JWT or `login-session` cookie value from stdin/TTY,
 * validates that it parses and is not expired, and saves it with 0600 permissions.
 */
export async function loginWithPaste(options: PasteLoginOptions = {}): Promise<LoginResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const isTTY = options.isTTY ?? Boolean((input as NodeJS.ReadStream).isTTY);
  const nowMs = options.nowMs ?? Date.now();

  let raw = '';
  if (isTTY) {
    output.write(
      'Paste your F1 TV `login-session` cookie value or subscription JWT and press Enter (input hidden):\n> ',
    );
    const ttyInput = input as NodeJS.ReadStream;
    if (typeof ttyInput.setRawMode === 'function') {
      raw = await new Promise<string>((resolve, reject) => {
        const wasRaw = ttyInput.isRaw;
        ttyInput.setRawMode(true);
        ttyInput.resume();
        let buf = '';
        const cleanup = () => {
          ttyInput.off('data', onData);
          ttyInput.setRawMode(Boolean(wasRaw));
          ttyInput.pause();
          output.write('\n');
        };
        const onData = (chunk: Buffer | string) => {
          const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
          for (const ch of str) {
            if (ch === '\u0003') {
              cleanup();
              reject(new Error('Login cancelled.'));
              return;
            }
            if (ch === '\r' || ch === '\n' || ch === '\u0004') {
              cleanup();
              resolve(buf);
              return;
            }
            if (ch === '\u007f' || ch === '\b') {
              buf = buf.slice(0, -1);
            } else {
              buf += ch;
            }
          }
        };
        ttyInput.on('data', onData);
      });
    } else {
      const rl = readline.createInterface({ input, output, terminal: false });
      raw = await new Promise<string>((resolve) => {
        rl.once('line', (answer) => {
          rl.close();
          resolve(answer);
        });
      });
    }
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }

  const token = tokenFromLoginSessionCookie(raw);
  if (!token) {
    throw new Error(
      'Could not extract an F1 TV subscription token. Paste either the URL-encoded `login-session` cookie value or a valid subscription JWT.',
    );
  }
  if (isTokenExpired(token, DEFAULT_EXPIRY_SKEW_MS, nowMs)) {
    const exp = parseJwtExpiry(token);
    throw new Error(
      `The provided F1 TV token is already expired (${exp ? new Date(exp).toISOString() : 'unknown expiry'}). Sign in again to obtain a fresh token.`,
    );
  }

  const saved = saveToken(token, options.configDir, nowMs);
  return {
    token,
    expiresAt: saved.expires_at,
    tokenPath: getTokenFilePath(options.configDir),
  };
}
