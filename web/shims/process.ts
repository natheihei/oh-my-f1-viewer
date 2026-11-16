/** `node:process`, for code that imports it by name: the same object `globals.ts` puts in place of the global. */
module.exports = (globalThis as unknown as { process: unknown }).process;
