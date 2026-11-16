import nodeZlib from 'node:zlib';
import { describe, expect, it } from 'vitest';


import shim from './zlib';

describe('the zlib shim', () => {
  const text = JSON.stringify({ Position: Array.from({ length: 200 }, (_, i) => ({ Timestamp: i, X: i * 3, Y: -i })) });

  it('inflates what the timing archive deflates', () => {
    expect(shim.inflateRawSync(nodeZlib.deflateRawSync(text)).toString('utf8')).toBe(text);
    expect(shim.inflateRawSync(nodeZlib.deflateRawSync(text), { maxOutputLength: 1 << 20 }).toString('utf8')).toBe(text);
  });

  it('round-trips gzip with Node', () => {
    expect(nodeZlib.gunzipSync(shim.gzipSync(text)).toString('utf8')).toBe(text);
    expect(shim.gunzipSync(nodeZlib.gzipSync(text)).toString('utf8')).toBe(text);
    expect(shim.inflateSync(nodeZlib.deflateSync(text)).toString('utf8')).toBe(text);
  });

  it('answers the callback forms', async () => {
    const out = await new Promise<Buffer>((resolve, reject) => shim.gunzip(nodeZlib.gzipSync(text), (e: Error | null, result: Buffer) => (e ? reject(e) : resolve(result))));
    expect(out.toString('utf8')).toBe(text);
  });
});
