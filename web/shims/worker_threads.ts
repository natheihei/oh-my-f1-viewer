/**
 * `worker_threads` over Web Workers. On the page's side, `new Worker(file, { workerData })` starts the
 * bundle built for that file (`WORKER_BUNDLES`), with `workerData` in the worker's name, where the
 * worker's side reads it before any message arrives.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { EventEmitter } = require('events');

/** Worker files as the main-process code names them, and the bundle each one is built into. */
const WORKER_BUNDLES: Record<string, string> = { 'worker.js': 'timing-worker.js' };

const inWorker = typeof (globalThis as any).WorkerGlobalScope !== 'undefined' && globalThis instanceof (globalThis as any).WorkerGlobalScope;

class WorkerShim extends EventEmitter {
  private worker: Worker;
  constructor(file: string | URL, options: { workerData?: unknown } = {}) {
    super();
    const name = String(file).split('/').pop() ?? '';
    const bundle = WORKER_BUNDLES[name];
    if (!bundle) throw new Error(`No worker bundle for ${name}`);
    this.worker = new Worker(new URL(bundle, location.href), { type: 'module', name: JSON.stringify(options.workerData ?? null) });
    this.worker.onmessage = (e) => this.emit('message', e.data);
    this.worker.onerror = (e) => this.emit('error', new Error(e.message || 'The worker failed'));
    this.worker.onmessageerror = () => this.emit('error', new Error('A worker message could not be read'));
  }
  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.worker.postMessage(message, transfer ?? []);
  }
  terminate(): Promise<number> {
    this.worker.terminate();
    queueMicrotask(() => this.emit('exit', 0));
    return Promise.resolve(0);
  }
  ref(): void {}
  unref(): void {}
}

/** The worker's side. Messages that arrive before anything listens are kept for the first listener. */
function createParentPort(): any {
  const port = new EventEmitter();
  const waiting: unknown[] = [];
  self.onmessage = (e: MessageEvent) => {
    if (port.listenerCount('message')) port.emit('message', e.data);
    else waiting.push(e.data);
  };
  const on = port.on.bind(port);
  port.on = (event: string, listener: (...args: any[]) => void) => {
    on(event, listener);
    if (event === 'message') for (const message of waiting.splice(0)) listener(message);
    return port;
  };
  port.postMessage = (message: unknown, transfer?: Transferable[]) => (self as unknown as Worker).postMessage(message, transfer ?? []);
  return port;
}

function readWorkerData(): unknown {
  try {
    return JSON.parse(self.name || 'null');
  } catch {
    return null;
  }
}

module.exports = {
  Worker: WorkerShim,
  isMainThread: !inWorker,
  parentPort: inWorker ? createParentPort() : null,
  workerData: inWorker ? readWorkerData() : null,
  threadId: inWorker ? 1 : 0,
};
