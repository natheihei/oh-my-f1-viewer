/**
 * Node's globals, for main-process code running in a page or a worker. esbuild injects this file, so a
 * bare `Buffer`, `process`, `global` or `setImmediate` in any bundled module resolves to these.
 */
import { Buffer as BufferPolyfill } from 'buffer';

type Listener = (...args: unknown[]) => void;
const noop = (): void => {};
const stream = { write: () => true, end: noop, on: noop, once: noop, off: noop, removeListener: noop, isTTY: false, columns: 80, rows: 24, fd: 1 };
const chrome = /Chrome\/([\d.]+)/.exec(globalThis.navigator?.userAgent ?? '')?.[1] ?? '140.0.0.0';
const started = performance.now();

const processShim = {
  env: {} as Record<string, string | undefined>,
  argv: ['f1a'],
  execArgv: [] as string[],
  execPath: '/f1a/f1a',
  platform: 'linux',
  arch: 'x64',
  pid: 1,
  ppid: 0,
  title: 'f1a',
  version: 'v24.0.0',
  // `electron` is set because the vendored F1 client takes its Chromium path when it sees one.
  versions: { node: '24.0.0', electron: '45.0.0', chrome, v8: '0' },
  release: { name: 'node' },
  features: {},
  exitCode: 0,
  stdout: stream,
  stderr: { ...stream, fd: 2 },
  stdin: { ...stream, fd: 0, setRawMode: noop, resume: noop, pause: noop },
  cwd: () => '/f1a',
  chdir: noop,
  umask: () => 0o22,
  uptime: () => (performance.now() - started) / 1000,
  hrtime: Object.assign(
    (previous?: [number, number]): [number, number] => {
      const now = performance.now();
      const seconds = Math.floor(now / 1000);
      const nanos = Math.floor((now % 1000) * 1e6);
      if (!previous) return [seconds, nanos];
      const ds = seconds - previous[0];
      const dn = nanos - previous[1];
      return dn < 0 ? [ds - 1, dn + 1e9] : [ds, dn];
    },
    { bigint: () => BigInt(Math.round(performance.now() * 1e6)) },
  ),
  memoryUsage: Object.assign(() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), { rss: () => 0 }),
  cpuUsage: () => ({ user: 0, system: 0 }),
  nextTick: (fn: Listener, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
  emitWarning: (warning: unknown) => console.warn('[process]', warning),
  getuid: () => 1000,
  getgid: () => 1000,
  geteuid: () => 1000,
  exit: noop,
  abort: noop,
  kill: (): never => {
    throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
  },
  binding: (): never => {
    throw new Error('process.binding is not available in the browser');
  },
  on: () => processShim,
  once: () => processShim,
  off: () => processShim,
  addListener: () => processShim,
  removeListener: () => processShim,
  removeAllListeners: () => processShim,
  prependListener: () => processShim,
  setMaxListeners: () => processShim,
  getMaxListeners: () => 10,
  listeners: () => [] as Listener[],
  listenerCount: () => 0,
  emit: () => false,
};

const root = globalThis as unknown as Record<string, unknown>;
root.Buffer ??= BufferPolyfill;
root.process ??= processShim;
root.global ??= globalThis;

const channel = typeof MessageChannel === 'undefined' ? null : new MessageChannel();
const immediates = new Map<number, () => void>();
let nextImmediate = 1;
if (channel) {
  channel.port1.onmessage = (e: MessageEvent<number>) => {
    const run = immediates.get(e.data);
    immediates.delete(e.data);
    run?.();
  };
}
/** Unlike a zero timeout, this isn't clamped to 4ms once nested. */
const setImmediateShim = (fn: Listener, ...args: unknown[]): number => {
  const id = nextImmediate++;
  immediates.set(id, () => fn(...args));
  if (channel) channel.port2.postMessage(id);
  else setTimeout(() => immediates.get(id)?.(), 0);
  return id;
};
const clearImmediateShim = (id: number): void => void immediates.delete(id);
root.setImmediate ??= setImmediateShim;
root.clearImmediate ??= clearImmediateShim;

export { BufferPolyfill as Buffer, processShim as process, setImmediateShim as setImmediate, clearImmediateShim as clearImmediate };
export const global = globalThis;
