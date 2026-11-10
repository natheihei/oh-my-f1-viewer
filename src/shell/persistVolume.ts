/** Keeps the master volume, and the level the mute icon goes back to, across app restarts. */
import { useEffect } from 'react';
import { host, useLive } from '../host';
import { loadUiState, saveUiState, type UiStorage } from './uiState';

const KEY = 'volume';

export interface SavedVolume {
  /** The level when the app closed: 0 if it was muted. */
  level: number;
  /** The last level above 0, which the mute icon restores. */
  lastHeard: number;
}

function isLevel(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

export function parseSavedVolume(value: unknown): SavedVolume | null {
  if (typeof value !== 'object' || value == null) return null;
  const { level, lastHeard } = value as Record<string, unknown>;
  if (!isLevel(level) || !isLevel(lastHeard) || lastHeard === 0) return null;
  return { level, lastHeard };
}

/**
 * The last level above 0 the host has had. The host keeps its own copy for the mute icon but doesn't expose it, so
 * this tracks it by the same rule: every level above 0 is one that was heard.
 */
let lastHeard = 1;

/** Sets the host's volume to what was saved. Call it once, before the first render, so the slider never shows 100% first. */
export function restoreVolume(storage?: UiStorage | null): void {
  const saved = loadUiState(KEY, parseSavedVolume, null, storage);
  if (saved == null) return;
  // The host can only be told a level, but it remembers every level above 0 as the one the mute icon restores. So
  // setting two levels restores both: first the level last heard, which the host remembers for the mute icon...
  host.audio.setVolume({ volume: saved.lastHeard });
  // ...then the level the app closed at. If that's 0 (muted), the host still remembers the first level and unmuting
  // goes back to it. If it's above 0, it replaces the first as the level last heard, as it did before the restart.
  host.audio.setVolume({ volume: saved.level });
  lastHeard = saved.level > 0 ? saved.level : saved.lastHeard;
}

/** Saves a level the host has just changed to, with the level last heard. */
export function saveVolume(level: number, storage?: UiStorage | null): void {
  if (level > 0) lastHeard = level;
  saveUiState(KEY, { level, lastHeard } satisfies SavedVolume, storage);
}

/** Saves the volume whenever it changes, however it was changed: the slider, the keyboard, the mute icon or the agent. */
export function usePersistVolume(): void {
  const volume = useLive((s) => s.volume);
  useEffect(() => saveVolume(volume), [volume]);
}
