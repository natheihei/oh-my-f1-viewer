import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
import http from './http';

describe('the http shim', () => {
  it("answers the page's fetch to a server made with it, without a socket", async () => {
    const seen: any[] = [];
    const server = http.createServer(async (req: any, res: any) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.push({ method: req.method, url: req.url, stream: req.headers['x-stream'], body: Buffer.concat(chunks).toString() });
      res.writeHead(201, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from([1, 2, 3]));
    });
    await new Promise<void>((resolve) => server.listen(18999, '127.0.0.1', resolve));
    expect(server.address().port).toBe(18999);

    const response = await fetch('http://127.0.0.1:18999/la?stream=1%3A2', { method: 'POST', body: 'challenge', headers: { 'X-Stream': 'a' } });
    expect(response.status).toBe(201);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(seen).toEqual([{ method: 'POST', url: '/la?stream=1%3A2', stream: 'a', body: 'challenge' }]);

    await new Promise<void>((resolve) => server.close(resolve));
    await expect(fetch('http://127.0.0.1:18999/la')).rejects.toThrow();
  });

  it('says a port is taken, so the license proxy tries the next', async () => {
    const first = http.createServer(() => {});
    await new Promise<void>((resolve) => first.listen(18998, resolve));
    const second = http.createServer(() => {});
    const error = await new Promise<any>((resolve) => second.once('error', resolve).listen(18998));
    expect(error.code).toBe('EADDRINUSE');
    first.close();
  });
});
