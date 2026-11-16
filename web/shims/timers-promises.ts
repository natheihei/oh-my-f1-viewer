/** `node:timers/promises`. */
export const setImmediate = <T>(value?: T): Promise<T | undefined> => new Promise((resolve) => globalThis.setImmediate(() => resolve(value)));
export const setTimeout = <T>(ms?: number, value?: T): Promise<T | undefined> => new Promise((resolve) => globalThis.setTimeout(() => resolve(value), ms));
export const scheduler = { wait: (ms: number) => setTimeout(ms), yield: () => setImmediate() };
export default { setImmediate, setTimeout, scheduler };
