/**
 * `fs` in the browser: an in-memory volume (memfs), which `fsPersist.ts` loads from IndexedDB before
 * anything reads it and saves back as files change. CommonJS, so named imports of any fs function work.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const { Volume, createFsFromVolume } = require('memfs');

const volume = new Volume();
const fs = createFsFromVolume(volume);
fs.__volume = volume;
// memfs has no `cp`: the mods folder's type declarations are copied with it.
const pathOf = require('path');
function cpSync(from: string, to: string, options: { recursive?: boolean } = {}): void {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    if (!options.recursive) throw Object.assign(new Error(`${from} is a directory`), { code: 'ERR_FS_EISDIR' });
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) cpSync(pathOf.join(from, name), pathOf.join(to, name), options);
  } else {
    fs.mkdirSync(pathOf.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}
fs.cpSync ??= cpSync;
fs.promises.cp ??= async (from: string, to: string, options?: { recursive?: boolean }) => cpSync(from, to, options);
fs.cp ??= (from: string, to: string, options: unknown, done?: (e: Error | null) => void) => {
  const callback = typeof options === 'function' ? (options as (e: Error | null) => void) : done;
  try {
    cpSync(from, to, typeof options === 'object' && options ? (options as { recursive?: boolean }) : {});
    callback?.(null);
  } catch (e) {
    callback?.(e as Error);
  }
};
module.exports = fs;
