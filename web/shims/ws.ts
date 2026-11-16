/** The `ws` package over the browser's WebSocket: the events and methods the live timing connection uses. */
/* eslint-disable @typescript-eslint/no-require-imports */
const { EventEmitter } = require('events');

class WebSocketShim extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;
  private socket: WebSocket;

  /** Headers can't be set on a browser socket: the browser sends its own cookies for the host. */
  constructor(url: string, protocols?: string | string[] | Record<string, unknown>) {
    super();
    this.socket = typeof protocols === 'string' || Array.isArray(protocols) ? new WebSocket(url, protocols) : new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.onopen = () => this.emit('open');
    this.socket.onmessage = (e) => {
      const binary = typeof e.data !== 'string';
      this.emit('message', binary ? Buffer.from(e.data as ArrayBuffer) : Buffer.from(e.data as string, 'utf8'), binary);
    };
    this.socket.onclose = (e) => this.emit('close', e.code, Buffer.from(e.reason ?? ''));
    this.socket.onerror = () => this.emit('error', new Error('WebSocket error'));
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView, options?: unknown, callback?: (e?: Error) => void): void {
    const done = (typeof options === 'function' ? options : callback) as ((e?: Error) => void) | undefined;
    try {
      this.socket.send(data as string);
      done?.();
    } catch (e) {
      if (done) done(e as Error);
      else throw e;
    }
  }

  ping(): void {}
  pong(): void {}

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  terminate(): void {
    this.socket.close();
  }
}

module.exports = WebSocketShim;
module.exports.WebSocket = WebSocketShim;
module.exports.default = WebSocketShim;
