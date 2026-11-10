/**
 * Small UI state that should survive an app restart, like the master volume. It lives in the shell, above the host:
 * the host holds the state while the app runs, and the shell saves it and hands it back at the next start.
 */

/** The part of `localStorage` this needs, so tests can pass their own. */
export interface UiStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFIX = 'f1a.';

/** The browser's storage, or null where there is none (tests) or it refuses access. */
function browserStorage(): UiStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The value saved under `key`, or `fallback` if there's none or `parse` rejects it by returning null. */
export function loadUiState<T>(
  key: string,
  parse: (value: unknown) => T | null,
  fallback: T,
  storage: UiStorage | null = browserStorage(),
): T {
  try {
    const raw = storage?.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return parse(JSON.parse(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Saves `value` under `key`. Failing to save only means it won't be restored. */
export function saveUiState(key: string, value: unknown, storage: UiStorage | null = browserStorage()): void {
  try {
    storage?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Full or blocked storage: the app works the same, it just starts from defaults next time.
  }
}
