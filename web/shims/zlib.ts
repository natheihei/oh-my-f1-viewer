/** `zlib` over fflate: what the timing archive and its cache inflate and deflate with. */
/* eslint-disable @typescript-eslint/no-require-imports */
const fflate = require('fflate');

type Callback = (error: Error | null, result?: Buffer) => void;
const sync = (run: (data: Uint8Array) => Uint8Array) => (data: Uint8Array | string) => Buffer.from(run(typeof data === 'string' ? Buffer.from(data) : data));
const later = (run: (data: Uint8Array | string) => Buffer) => (data: Uint8Array | string, options: unknown, callback?: Callback) => {
  const done = (typeof options === 'function' ? options : callback) as Callback;
  queueMicrotask(() => {
    try {
      done(null, run(data));
    } catch (e) {
      done(e as Error);
    }
  });
};
const unsupported = (name: string) => () => {
  throw new Error(`zlib.${name} is not available in the browser`);
};

const inflateRawSync = sync(fflate.inflateSync);
const deflateRawSync = sync(fflate.deflateSync);
const inflateSync = sync(fflate.unzlibSync);
const deflateSync = sync(fflate.zlibSync);
const gunzipSync = sync(fflate.gunzipSync);
const gzipSync = sync(fflate.gzipSync);
const unzipSync = sync(fflate.decompressSync);

module.exports = {
  inflateRawSync,
  deflateRawSync,
  inflateSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  unzipSync,
  inflateRaw: later(inflateRawSync),
  deflateRaw: later(deflateRawSync),
  inflate: later(inflateSync),
  deflate: later(deflateSync),
  gunzip: later(gunzipSync),
  gzip: later(gzipSync),
  unzip: later(unzipSync),
  brotliDecompressSync: unsupported('brotliDecompressSync'),
  brotliCompressSync: unsupported('brotliCompressSync'),
  createGunzip: unsupported('createGunzip'),
  createGzip: unsupported('createGzip'),
  createInflate: unsupported('createInflate'),
  createDeflate: unsupported('createDeflate'),
  createBrotliDecompress: unsupported('createBrotliDecompress'),
  constants: { Z_SYNC_FLUSH: 2, Z_FINISH: 4, BROTLI_OPERATION_FLUSH: 1 },
};
