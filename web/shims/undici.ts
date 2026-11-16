/**
 * `undici` as the browser's own fetch. Headers a page may not set (Cookie, Origin, Referer, User-Agent)
 * are dropped by the browser, and `dispatcher` means nothing here. Downloads from the timing archive are
 * paced for a browser's single connection: see `download`.
 */
class Dispatcher {
  close(): Promise<void> {
    return Promise.resolve();
  }
  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

/** The timing archive's telemetry files: far larger than the rest. */
const LARGE = /^https:\/\/livetiming\.formula1\.com\/static\/.+\.z\.jsonStream(\?|$)/;
const ARCHIVE = 'https://livetiming.formula1.com/static/';
/** An archive download is given up when nothing has arrived for this long, or it has taken this long in all. */
const STALLED_MS = 30_000;
const LONGEST_MS = 10 * 60_000;
/** Small archive requests in flight, and large ones waiting for them. */
let small = 0;
const waiting: (() => void)[] = [];

function settled(): void {
  small -= 1;
  if (small > 0) return;
  for (const start of waiting.splice(0)) start();
}

/**
 * One file of the archive, whole. Node gives every request a connection of its own, and the caller allows each
 * 30 seconds. A browser sends everything for one host down a single HTTP/2 connection, so a session's fifteen
 * files share what one connection gets, and on a slow one the last of them ran out of time while still
 * arriving. Here a download is given up when it stalls, not when it's slow.
 */
async function download(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const abort = new AbortController();
  const giveUp = (why: string) => abort.abort(new DOMException(why, 'TimeoutError'));
  const longest = setTimeout(() => giveUp('The download took too long.'), LONGEST_MS);
  let stalled = setTimeout(() => giveUp('The download stalled.'), STALLED_MS);
  try {
    const response = await globalThis.fetch(input, { ...init, signal: abort.signal });
    const chunks: Uint8Array[] = [];
    const reader = response.body?.getReader();
    for (;;) {
      const next = await reader?.read();
      if (!next || next.done) break;
      chunks.push(next.value);
      clearTimeout(stalled);
      stalled = setTimeout(() => giveUp('The download stalled.'), STALLED_MS);
    }
    return new Response(new Blob(chunks as BlobPart[]), { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally {
    clearTimeout(longest);
    clearTimeout(stalled);
  }
}

function fetchShim(input: RequestInfo | URL, init?: RequestInit & { dispatcher?: unknown; duplex?: string }): Promise<Response> {
  const { dispatcher: _dispatcher, ...rest } = init ?? {};
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(ARCHIVE)) return globalThis.fetch(input, init ? rest : undefined);
  // The caller's time limit is the one this replaces.
  const { signal: _signal, ...request } = rest;
  // The telemetry files wait for the small ones, which are what a session needs first.
  if (LARGE.test(url)) return small > 0 ? new Promise<void>((start) => waiting.push(start)).then(() => download(input, request)) : download(input, request);
  small += 1;
  return download(input, request).finally(settled);
}

module.exports = {
  fetch: fetchShim,
  request: () => {
    throw new Error('undici.request is not available in the browser');
  },
  Agent: Dispatcher,
  ProxyAgent: Dispatcher,
  EnvHttpProxyAgent: Dispatcher,
  Pool: Dispatcher,
  Client: Dispatcher,
  Dispatcher,
  setGlobalDispatcher: () => {},
  getGlobalDispatcher: () => new Dispatcher(),
  Headers: globalThis.Headers,
  Request: globalThis.Request,
  Response: globalThis.Response,
  FormData: globalThis.FormData,
  WebSocket: globalThis.WebSocket,
  EventSource: (globalThis as { EventSource?: unknown }).EventSource,
  errors: {},
};
