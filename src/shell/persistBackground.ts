/** Keeps the background, and every style's settings, across app restarts, like the volume. */
import { useEffect } from 'react';
import { host, NO_BACKGROUND, read, useLive, type BackgroundParams } from '../host';
import { loadUiState, saveUiState, type UiStorage } from './uiState';

const KEY = 'background';

export interface SavedBackground {
  style: string;
  params: Record<string, BackgroundParams>;
}

export function parseSavedBackground(value: unknown): SavedBackground | null {
  if (typeof value !== 'object' || value == null) return null;
  const { style, params } = value as Record<string, unknown>;
  if (typeof style !== 'string' || typeof params !== 'object' || params == null) return null;
  return { style, params: params as Record<string, BackgroundParams> };
}

/**
 * Hands the host what was saved. Call it once, after the backgrounds are registered and before the
 * first render. The host checks every setting, so one saved by an older version that no longer
 * fits is left at its default, and a style that's gone leaves the background off.
 */
export function restoreBackground(storage?: UiStorage | null): void {
  const saved = loadUiState(KEY, parseSavedBackground, null, storage);
  if (saved == null) return;
  const known = new Set(read().backgrounds.map((b) => b.name));
  // Each style's settings first, which also shows it, then the one that was showing.
  for (const [style, params] of Object.entries(saved.params)) {
    if (known.has(style)) host.appearance.setBackground({ style, params });
  }
  host.appearance.setBackground({
    style: known.has(saved.style) ? saved.style : NO_BACKGROUND,
  });
}

export function saveBackground(saved: SavedBackground, storage?: UiStorage | null): void {
  saveUiState(KEY, saved, storage);
}

/** Saves the background whenever it changes, however it was changed. */
export function usePersistBackground(): void {
  const style = useLive((s) => s.background.style);
  const params = useLive((s) => s.background.params);
  useEffect(() => saveBackground({ style, params }), [style, params]);
}
