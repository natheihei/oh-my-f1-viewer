/**
 * Pluggable static object storage sinks for omfv-live-ingest:
 * - Cloudflare R2 / S3-compatible HTTP API with zero-dependency AWS SigV4 signing (`node:crypto`)
 *   and conditional PUT (`If-Match` / `If-None-Match`) for optimistic manifest locking.
 * - Local filesystem directory (`fs`) with atomic temp-file rename and SHA-256 ETag checks
 *   (for self-hosting with Nginx/Caddy on a VPS or local E2E testing).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface StoredObject {
  body: Buffer;
  etag: string | null;
}

export interface PutObjectOptions {
  contentType: string;
  contentEncoding?: string;
  cacheControl?: string;
  /** Require existing object's ETag to match (HTTP `If-Match`). */
  ifMatch?: string;
  /** Require object to not exist yet (HTTP `If-None-Match: *`). */
  ifNoneMatch?: '*';
}

export interface ObjectStore {
  readonly description: string;
  get(key: string): Promise<StoredObject | null>;
  put(key: string, body: Buffer | Uint8Array | string, options: PutObjectOptions): Promise<string | null>;
}

export class PreconditionFailedError extends Error {
  constructor(message = 'Object precondition failed (HTTP 412)') {
    super(message);
    this.name = 'PreconditionFailedError';
  }
}

export class FatalStorageError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'FatalStorageError';
  }
}

export interface S3ObjectStoreOptions {
  /** S3 endpoint origin, e.g. `https://<accountId>.r2.cloudflarestorage.com`. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Signing region (`auto` for Cloudflare R2). */
  region?: string;
  requestTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Normalizes S3/R2 ETag headers for strong `If-Match` conditional PUTs.
 * Cloudflare R2 may return a weak ETag (`W/"..."`) on GET when edge compression applies,
 * which always fails RFC 9110 strong comparison on `If-Match` with HTTP 412.
 */
export function normalizeStrongEtag(etag: string | null): string | null {
  if (!etag) return null;
  const trimmed = etag.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed;
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function encodeS3PathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeS3Key(key: string): string {
  return key
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeS3PathSegment)
    .join('/');
}

function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * Signs an S3 / Cloudflare R2 HTTP request using AWS Signature Version 4 (`AWS4-HMAC-SHA256`).
 */
export function signS3Request(params: {
  method: 'GET' | 'PUT' | 'HEAD';
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  now?: Date;
}): Record<string, string> {
  const { amzDate, dateStamp } = formatAmzDate(params.now ?? new Date());
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(params.headers)) {
    normalized[k.toLowerCase()] = v.trim();
  }
  normalized.host = params.url.host;
  normalized['x-amz-date'] = amzDate;
  normalized['x-amz-content-sha256'] = params.payloadHash;

  const sortedKeys = Object.keys(normalized).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${normalized[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const queryPairs = [...params.url.searchParams.entries()]
    .map(([k, v]) => [encodeS3PathSegment(k), encodeS3PathSegment(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join('&');

  const canonicalRequest = [
    params.method,
    params.url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    params.payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${params.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${params.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, params.region);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  return {
    ...params.headers,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': params.payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** Creates a zero-dependency Cloudflare R2 / S3-compatible `ObjectStore`. */
export function createS3ObjectStore(options: S3ObjectStoreOptions): ObjectStore {
  const endpoint = options.endpoint.trim().replace(/\/+$/, '');
  const bucket = options.bucket.trim().replace(/^\/+|\/+$/g, '');
  const region = options.region?.trim() || 'auto';
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const objectUrl = (key: string): URL =>
    new URL(`${endpoint}/${encodeS3PathSegment(bucket)}/${encodeS3Key(key)}`);

  return {
    description: `r2/s3 (${endpoint}/${bucket})`,

    async get(key: string): Promise<StoredObject | null> {
      const url = objectUrl(key);
      const headers = signS3Request({
        method: 'GET',
        url,
        headers: { 'accept-encoding': 'identity' },
        payloadHash: sha256Hex(''),
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        region,
      });
      const res = await fetchFn(url.toString(), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) return null;
      if (res.status === 401 || res.status === 403) {
        const text = await res.text().catch(() => '');
        throw new FatalStorageError(
          res.status,
          `R2/S3 GET ${key} denied (HTTP ${res.status}): ${text.trim().slice(0, 200)}`,
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`R2/S3 GET ${key} failed (HTTP ${res.status}): ${text.trim().slice(0, 200)}`);
      }
      const body = Buffer.from(await res.arrayBuffer());
      return { body, etag: normalizeStrongEtag(res.headers.get('etag')) };
    },

    async put(
      key: string,
      rawBody: Buffer | Uint8Array | string,
      putOpts: PutObjectOptions,
    ): Promise<string | null> {
      const url = objectUrl(key);
      const body =
        typeof rawBody === 'string'
          ? Buffer.from(rawBody, 'utf8')
          : Buffer.isBuffer(rawBody)
            ? rawBody
            : Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
      const reqHeaders: Record<string, string> = {
        'content-type': putOpts.contentType,
      };
      if (putOpts.contentEncoding) reqHeaders['content-encoding'] = putOpts.contentEncoding;
      if (putOpts.cacheControl) reqHeaders['cache-control'] = putOpts.cacheControl;
      const strongIfMatch = normalizeStrongEtag(putOpts.ifMatch ?? null);
      if (strongIfMatch) reqHeaders['if-match'] = strongIfMatch;
      if (putOpts.ifNoneMatch) reqHeaders['if-none-match'] = putOpts.ifNoneMatch;

      const signed = signS3Request({
        method: 'PUT',
        url,
        headers: reqHeaders,
        payloadHash: sha256Hex(body),
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        region,
      });

      const res = await fetchFn(url.toString(), {
        method: 'PUT',
        headers: signed,
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 412) {
        throw new PreconditionFailedError(`R2/S3 conditional PUT failed for ${key} (HTTP 412)`);
      }
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        const text = await res.text().catch(() => '');
        throw new FatalStorageError(
          res.status,
          `R2/S3 PUT ${key} failed (HTTP ${res.status}): ${text.trim().slice(0, 200)}`,
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`R2/S3 PUT ${key} failed (HTTP ${res.status}): ${text.trim().slice(0, 200)}`);
      }
      return normalizeStrongEtag(res.headers.get('etag'));
    },
  };
}

/**
 * Creates a local filesystem `ObjectStore` with atomic temp-file writes and SHA-256 ETag checks.
 * Ideal for serving static chunks directly via Nginx/Caddy on a VPS or for local E2E testing.
 */
export function createFsObjectStore(rootDir: string): ObjectStore {
  const resolvedRoot = path.resolve(rootDir);

  const resolveKey = (key: string): string => {
    const clean = key.replace(/^\/+/, '');
    const target = path.resolve(resolvedRoot, clean);
    if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`Invalid storage key outside root: ${key}`);
    }
    return target;
  };

  const etagOf = (buf: Buffer): string => `"${sha256Hex(buf)}"`;

  return {
    description: `local directory (${resolvedRoot})`,

    async get(key: string): Promise<StoredObject | null> {
      const target = resolveKey(key);
      try {
        const body = fs.readFileSync(target);
        return { body, etag: etagOf(body) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },

    async put(
      key: string,
      rawBody: Buffer | Uint8Array | string,
      putOpts: PutObjectOptions,
    ): Promise<string | null> {
      const target = resolveKey(key);
      const body =
        typeof rawBody === 'string'
          ? Buffer.from(rawBody, 'utf8')
          : Buffer.isBuffer(rawBody)
            ? rawBody
            : Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);

      let existingEtag: string | null = null;
      try {
        existingEtag = etagOf(fs.readFileSync(target));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      if (putOpts.ifNoneMatch === '*' && existingEtag !== null) {
        throw new PreconditionFailedError(`Object already exists: ${key}`);
      }
      if (putOpts.ifMatch && existingEtag !== putOpts.ifMatch) {
        throw new PreconditionFailedError(`ETag mismatch for ${key}: expected ${putOpts.ifMatch}, got ${existingEtag}`);
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, target);
      return etagOf(body);
    },
  };
}
