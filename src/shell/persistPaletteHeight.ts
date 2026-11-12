/**
 * How tall the palette's history box may grow before it scrolls, chosen by dragging the palette's top edge, kept
 * across app restarts. It is a cap, not a height: a short history still shows short.
 */
import { create } from 'zustand';
import { loadUiState, saveUiState, type UiStorage } from './uiState';

const KEY = 'paletteHeight';

/** The history box never grows past this share of the window, so the palette can't cover it all. */
export const MAX_HISTORY_OF_WINDOW = 0.6;

/** The history's built-in cap, in rows: the least it can be set to. */
export const MIN_HISTORY_ROWS = 7;

/** The built-in cap in pixels, for a given row height. Matches `.palette-history` in styles.css. */
export function minHistoryHeight(row: number): number {
  return row * MIN_HISTORY_ROWS + 8;
}

/** A height kept within the built-in cap and the share of the window it may take. The minimum wins in a tiny window. */
export function clampHistoryHeight(height: number, min: number, windowHeight: number): number {
  return Math.round(Math.max(min, Math.min(height, windowHeight * MAX_HISTORY_OF_WINDOW)));
}

export function parseSavedHeight(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The chosen cap in pixels, or null for the built-in one. Kept as chosen: the stylesheet clamps it to the window
 * it's shown in, so a smaller window doesn't lose it.
 */
export const usePaletteHeight = create<{ height: number | null }>(() => ({ height: null }));

/** Takes the saved cap. Call it once, before the first render. */
export function restorePaletteHeight(storage?: UiStorage | null): void {
  usePaletteHeight.setState({ height: loadUiState(KEY, parseSavedHeight, null, storage) });
}

/** Sets the cap and saves it; null goes back to the built-in one. */
export function setPaletteHeight(height: number | null, storage?: UiStorage | null): void {
  usePaletteHeight.setState({ height });
  saveUiState(KEY, height, storage);
}
