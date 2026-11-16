/**
 * Small UI state that should survive an app restart, like the master volume. It lives in the shell, above the host:
 * the host holds the state while the app runs, and the shell saves it and hands it back at the next start. It's
 * kept in the profile's settings file, through `host.savedState`, which reads it once before the first render.
 */
import { host } from '../host';

/** Where it's kept, so tests can pass their own. */
export interface UiStorage {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** The value saved under `key`, or `fallback` if there's none or `parse` rejects it by returning null. */
export function loadUiState<T>(key: string, parse: (value: unknown) => T | null, fallback: T, storage: UiStorage | null = host.savedState): T {
  try {
    const value = storage?.get(key);
    if (value === undefined) return fallback;
    return parse(value) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Saves `value` under `key`. Failing to save only means it won't be restored. */
export function saveUiState(key: string, value: unknown, storage: UiStorage | null = host.savedState): void {
  try {
    storage?.set(key, value);
  } catch {
    // The app works the same, it just starts from defaults next time.
  }
}
