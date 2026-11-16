/**
 * The parts of Node's `crypto` that main-process code uses, synchronous as Node's are: hashes from
 * @noble/hashes, random values from the browser, and RS256 verification with BigInt, which the F1 client
 * checks the subscription token with.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const { sha1, md5 } = require('@noble/hashes/legacy.js');
const { sha256, sha384, sha512 } = require('@noble/hashes/sha2.js');
const { hmac } = require('@noble/hashes/hmac.js');

type Bytes = Uint8Array;
const HASHES: Record<string, { create(): { update(d: Bytes): unknown; digest(): Bytes } }> = { sha1, md5, sha256, sha384, sha512 };
const algorithmOf = (name: string) => {
  const hash = HASHES[name.toLowerCase().replace(/^rsa-/, '').replace('-', '')];
  if (!hash) throw new Error(`Digest method not supported: ${name}`);
  return hash;
};
const toBytes = (data: unknown, encoding?: string): Bytes => {
  if (typeof data === 'string') return Buffer.from(data, (encoding as BufferEncoding) ?? 'utf8');
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('The data must be a string or a buffer');
};
const encode = (bytes: Bytes, encoding?: string) => (encoding ? Buffer.from(bytes).toString(encoding as BufferEncoding) : Buffer.from(bytes));

function hasher(state: { update(d: Bytes): unknown; digest(): Bytes }) {
  const self = {
    update(data: unknown, encoding?: string) {
      state.update(toBytes(data, encoding));
      return self;
    },
    digest: (encoding?: string) => encode(state.digest(), encoding),
    copy: () => {
      throw new Error('Hash.copy is not available in the browser');
    },
  };
  return self;
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const toBig = (bytes: Bytes) => BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}
/** The DER prefix of a DigestInfo, by hash, as RSASSA-PKCS1-v1_5 pads it. */
const DIGEST_INFO: Record<string, string> = {
  sha256: '3031300d060960864801650304020105000420',
  sha384: '3041300d060960864801650304020205000430',
  sha512: '3051300d060960864801650304020305000440',
  sha1: '3021300906052b0e03021a05000414',
};

interface PublicKey {
  type: 'public';
  jwk: { n: string; e: string; kty?: string };
}

function verify(algorithm: string, data: unknown, key: PublicKey | { key: PublicKey }, signature: Bytes): boolean {
  const { jwk } = 'jwk' in key ? key : key.key;
  const name = algorithm.toLowerCase().replace(/^rsa-/, '');
  const prefix = DIGEST_INFO[name];
  if (!prefix || !jwk?.n || !jwk?.e) throw new Error(`Unsupported signature algorithm: ${algorithm}`);
  const n = b64url(jwk.n);
  const size = n[0] === 0 ? n.length - 1 : n.length;
  if (signature.length !== size) return false;
  const hash = algorithmOf(name).create();
  hash.update(toBytes(data));
  const expected = Buffer.concat([Buffer.from(prefix, 'hex'), Buffer.from(hash.digest())]);
  const padding = size - expected.length - 3;
  if (padding < 8) return false;
  const encoded = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(padding, 0xff), Buffer.from([0]), expected]);
  const decrypted = modPow(toBig(signature), toBig(b64url(jwk.e)), toBig(n));
  return decrypted === toBig(encoded);
}

const randomBytes = (size: number, callback?: (e: null, bytes: Buffer) => void) => {
  const bytes = Buffer.alloc(size);
  // The browser fills at most 65536 bytes a call.
  for (let at = 0; at < size; at += 65536) globalThis.crypto.getRandomValues(bytes.subarray(at, Math.min(size, at + 65536)));
  if (callback) queueMicrotask(() => callback(null, bytes));
  return bytes;
};

module.exports = {
  webcrypto: globalThis.crypto,
  subtle: globalThis.crypto.subtle,
  getRandomValues: <T extends ArrayBufferView>(array: T) => globalThis.crypto.getRandomValues(array as never),
  randomUUID: () => globalThis.crypto.randomUUID(),
  randomBytes,
  randomFillSync: <T extends ArrayBufferView>(array: T) => globalThis.crypto.getRandomValues(array as never),
  randomInt: (min: number, max?: number) => {
    const [low, high] = max === undefined ? [0, min] : [min, max];
    return low + (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % (high - low));
  },
  createHash: (name: string) => hasher(algorithmOf(name).create()),
  createHmac: (name: string, key: unknown) => hasher(hmac.create(algorithmOf(name), toBytes(key))),
  hash: (name: string, data: unknown, encoding = 'hex') => hasher(algorithmOf(name).create()).update(data).digest(encoding),
  getHashes: () => Object.keys(HASHES),
  timingSafeEqual: (a: Bytes, b: Bytes) => {
    if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  },
  createPublicKey: (input: { key: PublicKey['jwk']; format: string }): PublicKey => {
    if (input?.format !== 'jwk') throw new Error('Only JWK public keys are supported in the browser');
    return { type: 'public', jwk: input.key };
  },
  verify,
  constants: {},
};
