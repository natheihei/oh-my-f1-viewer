/** There are no processes to start in a browser: everything here fails the way a missing program does. */
const missing = () => Object.assign(new Error('Processes cannot be started in the browser'), { code: 'ENOENT' });

function execFile(_file: string, ...rest: unknown[]): { stdin: { end(): void }; kill(): void; on(): void } {
  const callback = rest.find((arg) => typeof arg === 'function') as ((e: Error) => void) | undefined;
  queueMicrotask(() => callback?.(missing()));
  return { stdin: { end() {} }, kill() {}, on() {} };
}
const fail = (): never => {
  throw missing();
};

module.exports = { execFile, exec: execFile, spawn: fail, spawnSync: () => ({ error: missing(), status: null, stdout: '', stderr: '' }), execSync: fail, execFileSync: fail, fork: fail };
