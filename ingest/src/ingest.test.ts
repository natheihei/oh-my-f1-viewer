import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  buildLoginUserAgent,
  clearAuthData,
  getBrowserProfileDir,
  getEnvFilePath,
  getTokenFilePath,
  isFormula1CookieDomain,
  isTokenExpired,
  loadSavedToken,
  loginWithPaste,
  parseJwtExpiry,
  resolveAuthToken,
  saveToken,
  tokenFromLoginSessionCookie,
} from './auth.js';
import { loadConfigEnv, parseCliArgs, parseEnvFile, runCli } from './cli.js';
import {
  MAX_INFLATED_BYTES,
  SIGNALR_RS,
  decodeLiveValue,
  extractSessionInfo,
  inflateZ,
  isSessionFinishedData,
  parseCoreFrame,
  parseHandshakeFrame,
  splitCoreFrames,
} from './protocol.js';
import { ChunkPublisher } from './publisher.js';
import { backoffDelay, createSignalRClient } from './signalr.js';
import {
  FatalStorageError,
  PreconditionFailedError,
  createFsObjectStore,
  createS3ObjectStore,
  normalizeStrongEtag,
  signS3Request,
  type ObjectStore,
} from './storage.js';
import {
  LIVE_FEEDS,
  SESSIONS_INDEX_KEY,
  manifestObjectKey,
  type LiveRecord,
  type SessionManifest,
  type SessionsIndex,
} from './types.js';

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url(payload);
  const sig = Buffer.from('signature-padding-bytes-for-realistic-jwt-length').toString('base64url');
  return `${header}.${body}.${sig}`;
}

function deflateToBase64(obj: unknown, withBom = false): string {
  const json = (withBom ? '\uFEFF' : '') + JSON.stringify(obj);
  return zlib.deflateRawSync(Buffer.from(json, 'utf8')).toString('base64');
}

const tempDirs: string[] = [];

function makeTempDir(prefix = 'omfv-ingest-test-'): string {
  const base =
    process.env.TMPDIR && !process.env.TMPDIR.startsWith('/tmp')
      ? process.env.TMPDIR
      : path.join(os.homedir(), '.cache', 'omfv-test-tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('auth: cookie/JWT parsing & persistence', () => {
  const futureExpSec = Math.floor(Date.now() / 1000) + 7200;
  const pastExpSec = Math.floor(Date.now() / 1000) - 300;
  const validJwt = makeJwt({ sub: 'user-123', exp: futureExpSec });
  const expiredJwt = makeJwt({ sub: 'user-123', exp: pastExpSec });

  it('extracts subscriptionToken from URL-encoded login-session cookie', () => {
    const cookieVal = encodeURIComponent(
      JSON.stringify({ data: { subscriptionToken: validJwt, other: true } }),
    );
    expect(tokenFromLoginSessionCookie(cookieVal)).toBe(validJwt);

    const flatCookie = `login-session=${encodeURIComponent(
      JSON.stringify({ subscriptionToken: validJwt }),
    )}; Path=/; Domain=.formula1.com`;
    expect(tokenFromLoginSessionCookie(flatCookie)).toBe(validJwt);
    expect(tokenFromLoginSessionCookie(JSON.stringify({ data: { subscriptionToken: validJwt } }))).toBe(
      validJwt,
    );
    expect(tokenFromLoginSessionCookie(`  ${validJwt}\n`)).toBe(validJwt);
    expect(tokenFromLoginSessionCookie('')).toBeNull();
    expect(tokenFromLoginSessionCookie('not-a-jwt')).toBeNull();
  });

  it('parses JWT expiry and respects skew window', () => {
    const nowMs = Date.now();
    expect(parseJwtExpiry(validJwt)).toBe(futureExpSec * 1000);
    expect(isTokenExpired(validJwt, 60_000, nowMs)).toBe(false);
    expect(isTokenExpired(expiredJwt, 60_000, nowMs)).toBe(true);

    const soonJwt = makeJwt({ exp: Math.floor((nowMs + 30_000) / 1000) });
    expect(isTokenExpired(soonJwt, 60_000, nowMs)).toBe(true);
    expect(isTokenExpired(soonJwt, 10_000, nowMs)).toBe(false);

    const noExpJwt = makeJwt({ sub: 'no-exp' });
    expect(parseJwtExpiry(noExpJwt)).toBeNull();
    expect(isTokenExpired(noExpJwt, 60_000, nowMs)).toBe(false);
  });

  it('saves token with strict 0600 permissions and clears auth data on logout', () => {
    const dir = makeTempDir();
    const saved = saveToken(validJwt, dir);
    const tokenPath = getTokenFilePath(dir);

    expect(saved.token).toBe(validJwt);
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(loadSavedToken(dir)?.token).toBe(validJwt);

    const profileDir = getBrowserProfileDir(dir);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'Cookies'), 'dummy');

    const cleared = clearAuthData(dir);
    expect(cleared.removedToken).toBe(true);
    expect(cleared.removedProfile).toBe(true);
    expect(fs.existsSync(tokenPath)).toBe(false);
    expect(fs.existsSync(profileDir)).toBe(false);
  });

  it('supports headless --paste login and rejects expired/invalid tokens', async () => {
    const dir = makeTempDir();
    const cookieVal = encodeURIComponent(JSON.stringify({ data: { subscriptionToken: validJwt } }));
    const res = await loginWithPaste({
      configDir: dir,
      input: Readable.from([`${cookieVal}\n`]),
      isTTY: false,
    });

    expect(res.token).toBe(validJwt);
    expect(fs.statSync(res.tokenPath).mode & 0o777).toBe(0o600);

    await expect(
      loginWithPaste({ configDir: dir, input: Readable.from([expiredJwt]), isTTY: false }),
    ).rejects.toThrow(/already expired/i);
    await expect(
      loginWithPaste({ configDir: dir, input: Readable.from(['garbage-input']), isTTY: false }),
    ).rejects.toThrow(/Could not extract/i);
  });

  it('enforces token precedence and CLI status never leaks token', async () => {
    const dir = makeTempDir();
    const flagJwt = makeJwt({ sub: 'flag', exp: futureExpSec });
    const envJwt = makeJwt({ sub: 'env', exp: futureExpSec });
    const savedJwt = makeJwt({ sub: 'saved', exp: futureExpSec });
    saveToken(savedJwt, dir);

    expect(resolveAuthToken({ cliToken: flagJwt, envToken: envJwt, configDir: dir }).source).toBe('flag');
    expect(resolveAuthToken({ envToken: envJwt, configDir: dir }).source).toBe('env');
    expect(resolveAuthToken({ configDir: dir }).source).toBe('saved');
    expect(isFormula1CookieDomain('.formula1.com')).toBe(true);
    expect(isFormula1CookieDomain('evilformula1.com')).toBe(false);
    expect(buildLoginUserAgent('145.0.0.0')).toContain('Chrome/145.0.0.0');

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    try {
      expect(await runCli(['status', '--config-dir', dir])).toBe(0);
      expect(logs.join('\n')).toContain('signed in');
      expect(logs.join('\n')).not.toContain(savedJwt);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('protocol & CLI args', () => {
  it('inflates raw-deflate .z payloads with BOM stripping and safely drops bad blobs', () => {
    const sample = { Entries: [{ Utc: '2026-11-28T14:00:00Z', Cars: { '1': { Channels: { '2': 312 } } } }] };
    const b64 = deflateToBase64(sample, true);
    expect(inflateZ(b64)).toEqual(sample);
    expect(decodeLiveValue('CarData.z', b64)).toEqual(sample);
    expect(decodeLiveValue('CarData.z', 'not-valid-deflate!!!')).toBeNull();
    const hugeB64 = zlib.deflateRawSync(Buffer.alloc(MAX_INFLATED_BYTES + 1024, 'a')).toString('base64');
    expect(decodeLiveValue('CarData.z', hugeB64)).toBeNull();
  });

  it('parses Type 3 snapshots (SessionInfo first), Type 1 updates, and finish detection', () => {
    const carData = { Entries: [{ Utc: '2026-11-28T14:00:01Z' }] };
    const raw =
      JSON.stringify({
        type: 3,
        invocationId: '1',
        result: {
          TimingData: { Lines: { '1': { Position: '1' } } },
          'CarData.z': deflateToBase64(carData),
          SessionInfo: { Key: 13011, Name: 'Practice 2', Type: 'Practice', Meeting: { Key: 1301, Name: 'Qatar Grand Prix' } },
        },
      }) +
      SIGNALR_RS +
      JSON.stringify({ type: 1, target: 'feed', arguments: ['TrackStatus', { Status: '1' }, '2026-11-28T14:00:02Z'] }) +
      SIGNALR_RS;

    expect(splitCoreFrames(raw)).toHaveLength(2);
    const records = parseCoreFrame(raw);
    expect(records[0]).toMatchObject({ topic: 'SessionInfo', snapshot: true });
    expect(records[2]).toEqual({ topic: 'CarData.z', data: carData, snapshot: true, ts: null });
    expect(parseHandshakeFrame({})).toEqual({ ok: true });
    expect(extractSessionInfo({ Key: 13011, Name: 'FP2', Type: 'Practice', Meeting: { Key: 1301, Name: 'Qatar' } })?.sessionKey).toBe(13011);
    expect(isSessionFinishedData({ StatusSeries: [{ SessionStatus: 'Finalised' }] })).toBe(true);
    expect(isSessionFinishedData({ StatusSeries: { '0': { SessionStatus: 'Ends' } } })).toBe(true);
    expect(isSessionFinishedData({ StatusSeries: [{ SessionStatus: 'Started' }] })).toBe(false);
  });

  it('parses R2/S3, --output-dir, and configurable --chunk-interval-ms CLI args', () => {
    expect(backoffDelay(0, { backoffBaseMs: 1000, backoffMaxMs: 30000 }, () => 0.5)).toBe(1000);

    const r2Cmd = parseCliArgs(
      ['--chunk-interval-ms', '15000', '--chunk-max-records=500', '--exit-on-finish', '--takeover'],
      {
        OMFV_R2_ACCOUNT_ID: 'acct123',
        OMFV_R2_BUCKET: 'omfv-chunks',
        OMFV_R2_ACCESS_KEY_ID: 'key123',
        OMFV_R2_SECRET_ACCESS_KEY: 'sec456',
      },
    );
    expect(r2Cmd).toMatchObject({
      kind: 'run',
      storage: {
        kind: 'r2',
        endpoint: 'https://acct123.r2.cloudflarestorage.com',
        bucket: 'omfv-chunks',
        region: 'auto',
      },
      chunkIntervalMs: 15_000,
      chunkMaxRecords: 500,
      exitOnFinish: true,
      takeover: true,
      waitForLive: true,
    });

    const fsCmd = parseCliArgs(['--output-dir', '/var/www/omfv', '--no-wait-for-live'], {
      OMFV_CHUNK_INTERVAL_MS: '10000',
    });
    expect(fsCmd).toMatchObject({
      kind: 'run',
      storage: { kind: 'fs', outputDir: '/var/www/omfv' },
      chunkIntervalMs: 10_000,
      waitForLive: false,
    });

    expect(() => parseCliArgs([], {})).toThrow(/Missing storage target/i);
  });

  it('loads optional ~/.config/omfv-live-ingest/config.env with env & flag precedence and never leaks secrets', async () => {
    const dir = makeTempDir();
    expect(loadConfigEnv(dir)).toEqual({
      path: getEnvFilePath(dir),
      exists: false,
      values: {},
    });

    const parsed = parseEnvFile(`
      # R2 credentials
      OMFV_R2_ACCOUNT_ID=acct_from_file # inline comment
      export OMFV_R2_BUCKET="my-bucket"
      OMFV_R2_ACCESS_KEY_ID='key_with_#hash'
      OMFV_R2_SECRET_ACCESS_KEY="sec_\\"quoted\\""
      OMFV_CHUNK_INTERVAL_MS=15000
    `);
    expect(parsed).toEqual({
      OMFV_R2_ACCOUNT_ID: 'acct_from_file',
      OMFV_R2_BUCKET: 'my-bucket',
      OMFV_R2_ACCESS_KEY_ID: 'key_with_#hash',
      OMFV_R2_SECRET_ACCESS_KEY: 'sec_"quoted"',
      OMFV_CHUNK_INTERVAL_MS: '15000',
    });

    const envJwt = makeJwt({ sub: 'from-config-env', exp: Math.floor(Date.now() / 1000) + 3600 });
    fs.writeFileSync(
      getEnvFilePath(dir),
      [
        'OMFV_R2_ACCOUNT_ID=acct_cfg',
        'OMFV_R2_BUCKET=cfg-bucket',
        'OMFV_R2_ACCESS_KEY_ID=cfg_access_key_secret',
        'OMFV_R2_SECRET_ACCESS_KEY=cfg_secret_key_value',
        'OMFV_CHUNK_INTERVAL_MS=15000',
        `OMFV_F1TV_TOKEN=${envJwt}`,
      ].join('\n'),
      { mode: 0o600 },
    );

    const loaded = loadConfigEnv(dir);
    expect(loaded.exists).toBe(true);
    // Process env overrides config.env; CLI flags override both.
    const merged = { ...loaded.values, OMFV_R2_BUCKET: 'env-bucket' };
    const cmd = parseCliArgs(['--chunk-interval-ms', '5000'], merged);
    expect(cmd).toMatchObject({
      kind: 'run',
      storage: {
        kind: 'r2',
        endpoint: 'https://acct_cfg.r2.cloudflarestorage.com',
        bucket: 'env-bucket',
        accessKeyId: 'cfg_access_key_secret',
        secretAccessKey: 'cfg_secret_key_value',
      },
      chunkIntervalMs: 5_000,
    });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    try {
      expect(await runCli(['status', '--config-dir', dir], {})).toBe(0);
      const out = logs.join('\n');
      expect(out).toContain('Config env file:');
      expect(out).toContain('(present)');
      expect(out).toContain('signed in via env');
      expect(out).not.toContain('cfg_access_key_secret');
      expect(out).not.toContain('cfg_secret_key_value');
      expect(out).not.toContain(envJwt);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('storage: S3/R2 SigV4 & local filesystem ObjectStore', () => {
  it('signs SigV4 requests, sends Cache-Control/Content-Encoding/If-Match, and maps 404/412/403', async () => {
    const seen: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    let status = 200;
    const store = createS3ObjectStore({
      endpoint: 'https://acct123.r2.cloudflarestorage.com',
      bucket: 'omfv-replay',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'SECRET_TEST',
      region: 'auto',
      fetchFn: async (input, init) => {
        seen.push({
          method: String(init?.method ?? 'GET'),
          url: String(input),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        if (status === 404) return new Response('not found', { status: 404 });
        if (status === 412) return new Response('precondition', { status: 412 });
        if (status === 403) return new Response('denied', { status: 403 });
        return new Response('ok', { status: 200, headers: { etag: '"e1"' } });
      },
    });

    const etag = await store.put('v1/sessions/1/manifest.json', '{"a":1}', {
      contentType: 'application/json',
      cacheControl: 'no-store',
      ifNoneMatch: '*',
    });
    expect(etag).toBe('"e1"');
    expect(seen[0]!.url).toBe('https://acct123.r2.cloudflarestorage.com/omfv-replay/v1/sessions/1/manifest.json');
    expect(seen[0]!.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA_TEST\/\d{8}\/auto\/s3\/aws4_request/);
    expect(seen[0]!.headers['if-none-match']).toBe('*');
    expect(seen[0]!.headers['cache-control']).toBe('no-store');

    status = 404;
    expect(await store.get('v1/sessions/1/missing.json')).toBeNull();
    status = 200;
    const weakStore = createS3ObjectStore({
      endpoint: 'https://acct123.r2.cloudflarestorage.com',
      bucket: 'omfv-replay',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'SECRET_TEST',
      region: 'auto',
      fetchFn: async (_input, init) => {
        seen.push({
          method: String(init?.method ?? 'GET'),
          url: String(_input),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return new Response('{"ok":true}', { status: 200, headers: { etag: 'W/"abc123"' } });
      },
    });
    const gotWeak = await weakStore.get('v1/sessions/1/manifest.json');
    expect(gotWeak?.etag).toBe('"abc123"');
    expect(seen.at(-1)!.headers['accept-encoding']).toBe('identity');
    await weakStore.put('v1/sessions/1/manifest.json', '{}', {
      contentType: 'application/json',
      ifMatch: 'W/"abc123"',
    });
    expect(seen.at(-1)!.headers['if-match']).toBe('"abc123"');
    expect(normalizeStrongEtag('W/"xyz"')).toBe('"xyz"');
    expect(normalizeStrongEtag('"xyz"')).toBe('"xyz"');

    status = 412;
    await expect(
      store.put('v1/sessions/1/manifest.json', '{}', { contentType: 'application/json', ifMatch: '"old"' }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    status = 403;
    await expect(
      store.put('v1/sessions/1/manifest.json', '{}', { contentType: 'application/json' }),
    ).rejects.toBeInstanceOf(FatalStorageError);

    // Deterministic SigV4 smoke check
    const signed = signS3Request({
      method: 'PUT',
      url: new URL('https://acct.r2.cloudflarestorage.com/bucket/v1/test.gz'),
      headers: { 'content-type': 'application/x-ndjson' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'K',
      secretAccessKey: 'S',
      region: 'auto',
      now: new Date('2026-11-28T00:00:00.000Z'),
    });
    expect(signed['x-amz-date']).toBe('20261128T000000Z');
    expect(signed.Authorization).toContain('Signature=');
  });

  it('enforces atomic writes and ETag CAS preconditions in createFsObjectStore', async () => {
    const dir = makeTempDir();
    const store = createFsObjectStore(dir);
    expect(await store.get('v1/sessions/1/manifest.json')).toBeNull();

    const e1 = await store.put('v1/sessions/1/manifest.json', '{"v":1}', {
      contentType: 'application/json',
      ifNoneMatch: '*',
    });
    expect(e1).toBeTruthy();

    await expect(
      store.put('v1/sessions/1/manifest.json', '{"v":2}', {
        contentType: 'application/json',
        ifNoneMatch: '*',
      }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);

    await expect(
      store.put('v1/sessions/1/manifest.json', '{"v":2}', {
        contentType: 'application/json',
        ifMatch: '"wrong"',
      }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);

    const e2 = await store.put('v1/sessions/1/manifest.json', '{"v":2}', {
      contentType: 'application/json',
      ifMatch: e1!,
    });
    expect(e2).not.toBe(e1);
    const loaded = await store.get('v1/sessions/1/manifest.json');
    expect(loaded?.body.toString('utf8')).toBe('{"v":2}');
  });
});

describe('publisher: direct chunk publishing, lease CAS, wait-for-live & memory caps', () => {
  it('publishes immutable gzipped timing + telemetry chunks and manifest, enforces lease conflict/takeover/release, and drops post-finish frames', async () => {
    const dir = makeTempDir();
    const store = createFsObjectStore(dir);

    const pub1 = new ChunkPublisher({
      store,
      writerId: 'writer-1',
      chunkIntervalMs: 5_000,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    pub1.pushRecord(
      { topic: 'SessionInfo', data: { Key: 9001, Name: 'Race', Type: 'Race', Meeting: { Key: 900, Name: 'Qatar GP' } }, ts: null, snapshot: true },
      10_000,
    );
    pub1.pushRecord({ topic: 'TimingData', data: { Lines: { '1': { Line: 1 } } }, ts: 't1', snapshot: false }, 11_000);
    pub1.pushRecord({ topic: 'CarData.z', data: { Entries: [{ Cars: { '1': { Channels: { '2': 310 } } } }] }, ts: 't1', snapshot: false }, 11_500);

    expect(await pub1.flush(true)).toBe(true);

    const m1 = JSON.parse((await store.get(manifestObjectKey(9001)))!.body.toString('utf8')) as SessionManifest;
    expect(m1.protocol_version).toBe(1);
    expect(m1.status).toBe('live');
    expect(m1.record_count).toBe(3);
    expect(m1.last_seq).toBe(2);
    expect(m1.has_telemetry).toBe(true);
    expect(m1.writer_id).toBe('writer-1');
    expect(m1.chunks.map((c) => `${c.stream}#${c.id}`)).toEqual(['timing#1', 'telemetry#2']);

    // Verify gzipped chunk content directly on disk.
    const timingGz = (await store.get(m1.chunks[0]!.path.slice(1)))!.body;
    const timingLines = zlib.gunzipSync(timingGz).toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as LiveRecord);
    expect(timingLines.map((r) => [r.seq, r.topic])).toEqual([[0, 'SessionInfo'], [1, 'TimingData']]);

    // Second writer without --takeover hits lease conflict!
    let conflictWriter: string | null = null;
    const pub2 = new ChunkPublisher({
      store,
      writerId: 'writer-2',
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      onLeaseConflict: (_k, detail) => {
        conflictWriter = detail.active_writer_id;
      },
    });
    pub2.pushRecord({ topic: 'SessionInfo', data: { Key: 9001 }, ts: null, snapshot: true }, 12_000);
    expect(await pub2.flush(true)).toBe(false);
    expect(conflictWriter).toBe('writer-1');
    expect(pub2.getStats().leaseConflict).toBe(true);

    // Second writer WITH --takeover after > 5s resumes seq 3, chunk 3, and auto-records gap!
    const pub3 = new ChunkPublisher({
      store,
      writerId: 'writer-3',
      takeover: true,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    pub3.pushRecord({ topic: 'SessionInfo', data: { Key: 9001 }, ts: null, snapshot: true }, 20_000);
    pub3.pushRecord({ topic: 'SessionData', data: { StatusSeries: [{ SessionStatus: 'Finalised' }] }, ts: null, snapshot: false }, 21_000);
    // Trailing frame after Finalised must be dropped (H4)!
    pub3.pushRecord({ topic: 'WeatherData', data: { AirTemp: '24' }, ts: null, snapshot: false }, 22_000);
    expect(await pub3.flush(true)).toBe(true);

    const m2 = JSON.parse((await store.get(manifestObjectKey(9001)))!.body.toString('utf8')) as SessionManifest;
    expect(m2.status).toBe('finished');
    expect(m2.writer_id).toBeNull();
    expect(m2.record_count).toBe(5);
    expect(m2.last_seq).toBe(4);
    expect(m2.gaps).toEqual([{ from: 11_500, to: 20_000 }]);
    expect(m2.chunks.map((c) => `${c.stream}#${c.id}`)).toEqual(['timing#1', 'telemetry#2', 'timing#3']);

    // Verify v1/sessions/index.json was written.
    await new Promise((r) => setTimeout(r, 30));
    const idx = JSON.parse((await store.get(SESSIONS_INDEX_KEY))!.body.toString('utf8')) as SessionsIndex;
    expect(idx.sessions[0]).toMatchObject({ session_key: 9001, status: 'finished', record_count: 5 });
  });

  it('supports --wait-for-live and bounds memory during storage outage (M6)', async () => {
    const dir = makeTempDir();
    const store = createFsObjectStore(dir);
    const ignored: number[] = [];

    const pub = new ChunkPublisher({
      store,
      waitForLive: true,
      liveCheckGraceMs: 20,
      onSessionIgnored: (k) => ignored.push(k),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    pub.pushRecord({ topic: 'SessionInfo', data: { Key: 5001 }, ts: null, snapshot: true }, 1000);
    pub.pushRecord({ topic: 'SessionData', data: { StatusSeries: [{ SessionStatus: 'Finalised' }] }, ts: null, snapshot: true }, 1001);
    expect(await pub.flush(true)).toBe(true);
    expect(ignored).toEqual([5001]);
    expect(await store.get(manifestObjectKey(5001))).toBeNull();

    // Bounded outage queue sheds telemetry first.
    const failingStore: ObjectStore = {
      description: 'failing',
      get: async () => {
        throw new Error('offline');
      },
      put: async () => {
        throw new Error('offline');
      },
    };
    const capPub = new ChunkPublisher({
      store: failingStore,
      maxPendingRecords: 10,
      maxPendingBytes: 16_384,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    capPub.pushRecord({ topic: 'SessionInfo', data: { Key: 6003 }, ts: null, snapshot: true }, 1000);
    for (let i = 0; i < 15; i++) {
      capPub.pushRecord({ topic: i % 2 === 0 ? 'CarData.z' : 'TimingData', data: { i }, ts: null, snapshot: false }, 1001 + i);
    }
    const stats = capPub.getStats();
    expect(stats.pendingTimingRecords + stats.pendingTelemetryRecords).toBeLessThanOrEqual(10);
    expect(stats.droppedRecords).toBeGreaterThanOrEqual(6);

    // Bounded CAS retry loop: persistent 412 must not spin forever.
    let putCalls = 0;
    const always412Store: ObjectStore = {
      description: 'always-412',
      get: async () => null,
      put: async (key) => {
        if (key.endsWith('manifest.json')) {
          putCalls += 1;
          throw new PreconditionFailedError('forced 412');
        }
        return '"chunk-etag"';
      },
    };
    const casPub = new ChunkPublisher({
      store: always412Store,
      retryBaseMs: 60_000,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    casPub.pushRecord({ topic: 'SessionInfo', data: { Key: 6004 }, ts: null, snapshot: false }, 1000);
    expect(await casPub.flush(true)).toBe(false);
    expect(putCalls).toBe(4);
    expect(casPub.getStats().consecutiveFailures).toBe(1);
    await casPub.flushAndStop(10);
  });
});

describe('E2E: mock SignalR Core WebSocket -> ChunkPublisher -> local directory store', () => {
  it('captures all 17 feeds, inflates .z, records reconnect gaps, and publishes finished v1 manifest + gzipped chunks', async () => {
    const f1tvToken = makeJwt({ sub: 'f1-subscriber', exp: Math.floor(Date.now() / 1000) + 3600 });
    const carSample = { Entries: [{ Utc: '2026-11-28T14:00:00Z', Cars: { '1': { Channels: { '2': 320 } } } }] };
    const posSample = { Position: [{ Timestamp: '2026-11-28T14:00:01Z', Entries: { '1': { X: 100, Y: 200 } } }] };

    let subscribedFeeds: string[] = [];
    let wsConnectionCount = 0;

    const signalrHttp = http.createServer((req, res) => {
      if (req.method === 'OPTIONS' && req.url === '/signalrcore/negotiate') {
        res.setHeader('Set-Cookie', 'AWSALBCORS=alb-sticky-token; Path=/; Secure');
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'POST' && req.url === '/signalrcore/negotiate?negotiateVersion=1') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connectionToken: `conn-${wsConnectionCount + 1}` }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const wss = new WebSocketServer({ noServer: true });
    signalrHttp.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    wss.on('connection', (ws) => {
      wsConnectionCount += 1;
      const connNum = wsConnectionCount;
      let handshaken = false;

      ws.on('message', (raw) => {
        for (const frame of splitCoreFrames(String(raw))) {
          const obj = frame as Record<string, unknown>;
          if (!handshaken && obj.protocol === 'json' && obj.version === 1) {
            handshaken = true;
            ws.send(`{}${SIGNALR_RS}`);
            continue;
          }
          if (obj.type === 1 && obj.target === 'Subscribe' && Array.isArray(obj.arguments)) {
            subscribedFeeds = obj.arguments[0] as string[];
            if (connNum === 1) {
              const snapshot = {
                type: 3,
                invocationId: obj.invocationId,
                result: {
                  TimingData: { Lines: { '1': { Position: '1' } } },
                  'CarData.z': deflateToBase64(carSample),
                  SessionInfo: {
                    Key: 13011,
                    Name: 'Practice 2',
                    Type: 'Practice',
                    Meeting: { Key: 1301, Name: 'Qatar Grand Prix' },
                  },
                },
              };
              const posUpdate = {
                type: 1,
                target: 'feed',
                arguments: ['Position.z', deflateToBase64(posSample), '2026-11-28T14:00:01.000Z'],
              };
              ws.send(JSON.stringify(snapshot) + SIGNALR_RS + JSON.stringify(posUpdate) + SIGNALR_RS);
              setTimeout(() => ws.terminate(), 80);
            } else {
              const finishedUpdate = {
                type: 1,
                target: 'feed',
                arguments: [
                  'SessionData',
                  { StatusSeries: { '0': { Utc: '2026-11-28T15:00:00Z', SessionStatus: 'Finalised' } } },
                  '2026-11-28T15:00:00.000Z',
                ],
              };
              ws.send(JSON.stringify(finishedUpdate) + SIGNALR_RS);
            }
          }
        }
      });
    });

    await new Promise<void>((resolve) => signalrHttp.listen(0, '127.0.0.1', resolve));
    const signalrPort = (signalrHttp.address() as { port: number }).port;
    const outDir = makeTempDir('omfv-e2e-out-');
    const store = createFsObjectStore(outDir);

    try {
      let resolveFinished!: (sessionKey: number) => void;
      const finishedPromise = new Promise<number>((resolve) => {
        resolveFinished = resolve;
      });

      const publisher = new ChunkPublisher({
        store,
        chunkIntervalMs: 1_000,
        logger: { log: () => {}, warn: () => {}, error: () => {} },
        onSessionFinished: (k) => resolveFinished(k),
      });

      const client = createSignalRClient({
        livetimingUrl: `http://127.0.0.1:${signalrPort}`,
        f1tvToken,
        timing: { backoffBaseMs: 50, backoffMaxMs: 200, keepaliveMs: 10_000, watchdogMs: 30_000, handshakeTimeoutMs: 5_000 },
        onRecord: (rec, receivedAt) => publisher.pushRecord(rec, receivedAt),
        onGapEvent: (ev) => publisher.pushGapEvent(ev),
      });

      publisher.start();
      client.start();

      const finishedKey = await Promise.race([
        finishedPromise,
        new Promise<number>((_, reject) => setTimeout(() => reject(new Error('E2E ingest timed out')), 10_000)),
      ]);

      client.stop();
      expect(await publisher.flushAndStop(3_000)).toBe(true);
      expect(finishedKey).toBe(13011);
      expect(subscribedFeeds).toEqual([...LIVE_FEEDS]);

      const manifest = JSON.parse((await store.get(manifestObjectKey(13011)))!.body.toString('utf8')) as SessionManifest;
      expect(manifest.status).toBe('finished');
      expect(manifest.record_count).toBe(5);
      expect(manifest.has_telemetry).toBe(true);
      expect(manifest.gaps).toHaveLength(1);
      expect(manifest.gaps[0]!.to).not.toBeNull();

      // Verify all 5 records exist across the immutable gzipped chunks.
      const allRecs: LiveRecord[] = [];
      for (const c of manifest.chunks) {
        const gz = (await store.get(c.path.slice(1)))!.body;
        const lines = zlib.gunzipSync(gz).toString('utf8').trim().split('\n');
        for (const l of lines) allRecs.push(JSON.parse(l) as LiveRecord);
      }
      allRecs.sort((a, b) => a.seq - b.seq);
      expect(allRecs.map((r) => r.topic)).toEqual(['SessionInfo', 'TimingData', 'CarData.z', 'Position.z', 'SessionData']);
    } finally {
      wss.close();
      await new Promise<void>((resolve) => signalrHttp.close(() => resolve()));
    }
  });
});
