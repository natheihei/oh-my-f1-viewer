/**
 * The app was called f1a, and its profile was `<appData>/f1a`. On the first start with the default profile, what's
 * worth keeping is copied from there: mods, settings, conversations, the timing database and the caches. The old
 * profile is left as it was.
 *
 * The sign-ins aren't copied. They're encrypted with a key the OS keyring keeps under the app's name, which the
 * new name can't read, so the viewer signs in to F1 TV and the agent again.
 */
import { copyFileSync, cpSync, existsSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const OLD_NAME = 'f1a';
/** Written once the copy is done, so it happens once. */
const MARKER = 'omfv-copied-from-f1a';
const DIRS = ['conversations', 'session-data', 'livetiming-cache', 'WidevineCdm'];
const FILES: [from: string, to: string][] = [
  ['f1a-settings.json', 'omfv-settings.json'],
  ['f1a-install-id', 'omfv-install-id'],
  ['window-state.json', 'window-state.json'],
];
/** The database and its write-ahead log, copied together or not at all. */
const TIMING = ['timing.sqlite', 'timing.sqlite-wal', 'timing.sqlite-shm'];
/** Written into the mods folder by older versions or on every start: not the viewer's. */
const NOT_MODS = new Set(['.types', 'AGENTS.md', 'tsconfig.json']);
const SOURCE = /\.(tsx?|jsx?|mjs)$/;

/** Whether an app is running on a user data dir: its single-instance lock names a live process. */
function inUse(dir: string): boolean {
  try {
    const pid = Number(readlinkSync(path.join(dir, 'SingletonLock')).split('-').at(-1));
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A mod's imports of the host and kit under the old name, `'f1a'` and `'f1a/kit'`, now `'omfv'` and `'omfv/kit'`. */
export function renameImports(source: string): string {
  return source.replace(/(['"])f1a(\/kit)?\1/g, (_m, quote: string, kit: string | undefined) => `${quote}omfv${kit ?? ''}${quote}`);
}

function copyMods(from: string, to: string): void {
  for (const name of readdirSync(from)) {
    if (NOT_MODS.has(name) || existsSync(path.join(to, name))) continue;
    cpSync(path.join(from, name), path.join(to, name), { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
  }
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (SOURCE.test(name)) {
        const text = readFileSync(file, 'utf8');
        const renamed = renameImports(text);
        if (renamed !== text) writeFileSync(file, renamed);
      }
    }
  };
  walk(to);
}

/**
 * Copies what's kept from `<appData>/f1a` into `userData`, never over something already there. Returns what it
 * copied, empty when there's no old profile or the copy was done before.
 */
export function copyOldProfile(appData: string, userData: string): string[] {
  const old = path.join(appData, OLD_NAME);
  if (!existsSync(old) || existsSync(path.join(userData, MARKER))) return [];
  const copied: string[] = [];
  const free = (name: string) => existsSync(path.join(old, name)) && !existsSync(path.join(userData, name));

  if (existsSync(path.join(old, 'mods'))) {
    copyMods(path.join(old, 'mods'), path.join(userData, 'mods'));
    copied.push('mods');
  }
  for (const dir of DIRS.filter(free)) {
    cpSync(path.join(old, dir), path.join(userData, dir), { recursive: true });
    copied.push(dir);
  }
  for (const [from, to] of FILES) {
    if (!existsSync(path.join(old, from)) || existsSync(path.join(userData, to))) continue;
    copyFileSync(path.join(old, from), path.join(userData, to));
    copied.push(to);
  }
  // A database another app is writing could be copied half-written. It's a cache, so it fills again.
  if (free(TIMING[0]) && !inUse(old)) {
    for (const file of TIMING.filter(free)) copyFileSync(path.join(old, file), path.join(userData, file));
    copied.push(TIMING[0]);
  }
  writeFileSync(path.join(userData, MARKER), `${new Date().toISOString()}\n${copied.join('\n')}\n`);
  return copied;
}
