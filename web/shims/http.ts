/**
 * `http` servers with no network: a server made here answers the page's own `fetch` to
 * `http://127.0.0.1:<port>`. The license proxy is such a server, and the player posts each Widevine
 * challenge to it, so in the browser that request never leaves the page.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { EventEmitter } = require('events');

type Handler = (req: any, res: any) => void;
const servers = new Map<number, Handler>();

class ServerResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  private headers = new Headers();
  private chunks: Uint8Array[] = [];
  constructor(private readonly resolve: (response: Response) => void) {
    super();
  }
  setHeader(name: string, value: string | number | string[]): this {
    this.headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
    return this;
  }
  getHeader(name: string): string | null {
    return this.headers.get(name);
  }
  removeHeader(name: string): void {
    this.headers.delete(name);
  }
  writeHead(status: number, headers?: Record<string, string | number | string[]>): this {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    return true;
  }
  end(chunk?: string | Uint8Array): void {
    if (chunk !== undefined) this.write(chunk);
    const body = this.chunks.length ? Buffer.concat(this.chunks) : null;
    // A response with one of these statuses can't have a body.
    const bodiless = [101, 204, 205, 304].includes(this.statusCode);
    // Content the proxy already decoded: these would have the browser decode it again.
    this.headers.delete('content-encoding');
    this.headers.delete('content-length');
    this.headers.delete('transfer-encoding');
    this.resolve(new Response(bodiless ? null : body, { status: this.statusCode, headers: this.headers }));
    this.emit('finish');
  }
}

async function serve(handler: Handler, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array();
  const headers: Record<string, string> = { host: url.host, 'user-agent': navigator.userAgent };
  request.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
  return new Promise<Response>((resolve) => {
    const req = Object.assign(new EventEmitter(), {
      method: request.method,
      url: url.pathname + url.search,
      headers,
      socket: { remoteAddress: '127.0.0.1' },
      destroy() {},
      async *[Symbol.asyncIterator]() {
        if (body.length) yield Buffer.from(body);
      },
    });
    try {
      handler(req, new ServerResponse(resolve));
    } catch (e) {
      console.error('[http] handler failed:', e);
      resolve(new Response(null, { status: 500 }));
    }
  });
}

const networkFetch = globalThis.fetch.bind(globalThis);

/** The page's fetch, with requests to a server made here answered by it. */
function localFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (servers.size) {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (raw.startsWith('http://127.0.0.1:') || raw.startsWith('http://localhost:')) {
      const handler = servers.get(Number(new URL(raw).port));
      if (handler) return serve(handler, input instanceof Request ? input : new Request(raw, init));
    }
  }
  return networkFetch(input, init);
}
globalThis.fetch = localFetch as typeof fetch;

class Server extends EventEmitter {
  private port: number | null = null;
  listening = false;
  constructor(private readonly handler: Handler) {
    super();
  }
  listen(port: number, ...rest: unknown[]): this {
    const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined;
    queueMicrotask(() => {
      if (servers.has(port)) return void this.emit('error', Object.assign(new Error(`Port ${port} is in use`), { code: 'EADDRINUSE' }));
      servers.set(port, this.handler);
      this.port = port;
      this.listening = true;
      this.emit('listening');
      callback?.();
    });
    return this;
  }
  address(): { address: string; family: string; port: number } | null {
    return this.port === null ? null : { address: '127.0.0.1', family: 'IPv4', port: this.port };
  }
  close(callback?: () => void): this {
    if (this.port !== null) servers.delete(this.port);
    this.port = null;
    this.listening = false;
    queueMicrotask(() => {
      this.emit('close');
      callback?.();
    });
    return this;
  }
  /** There are no connections to close: each request is one call. pi-ai calls these when a sign-in ends. */
  closeAllConnections(): void {}
  closeIdleConnections(): void {}
  unref(): this {
    return this;
  }
  ref(): this {
    return this;
  }
}

const unavailable = (): never => {
  throw new Error('http requests go through fetch in the browser');
};

module.exports = {
  createServer: (options: unknown, handler?: Handler) => new Server((typeof options === 'function' ? options : handler) as Handler),
  request: unavailable,
  get: unavailable,
  Agent: class {},
  globalAgent: {},
  STATUS_CODES: {},
  METHODS: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
};
