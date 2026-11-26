import { beforeEach, expect, test, vi } from 'vitest';

// The host, which keeps the saved state, pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));
import {
  clampDragHeight,
  clampHistoryHeight,
  minHistoryHeight,
  parseSavedHeight,
  restorePaletteHeight,
  setPaletteHeight,
  usePaletteHeight,
} from './persistPaletteHeight';
import type { UiStorage } from './uiState';

function memoryStorage(): UiStorage {
  const items = new Map<string, unknown>();
  return { get: (key) => items.get(key), set: (key, value) => void items.set(key, value) };
}

beforeEach(() => usePaletteHeight.setState({ height: null }));

test('the minimum is the built-in 7 rows', () => {
  expect(minHistoryHeight(22)).toBe(162);
});

test('a height stays between the minimum and 60% of the window', () => {
  expect(clampHistoryHeight(100, 162, 1000)).toBe(162);
  expect(clampHistoryHeight(300, 162, 1000)).toBe(300);
  expect(clampHistoryHeight(900, 162, 1000)).toBe(600);
});

test('in a tiny window the minimum wins', () => {
  expect(clampHistoryHeight(400, 162, 200)).toBe(162);
});

test('a drag stays within the built-in cap and window share when starting at or above the minimum', () => {
  expect(clampDragHeight(100, 415, 162, 1000)).toBe(162);
  expect(clampDragHeight(315, 415, 162, 1000)).toBe(315);
  expect(clampDragHeight(515, 415, 162, 1000)).toBe(515);
  expect(clampDragHeight(900, 415, 162, 1000)).toBe(600);
});

test('a drag from a short history below the minimum never jumps up to the minimum', () => {
  expect(clampDragHeight(20, 52, 162, 1000)).toBe(52);
  expect(clampDragHeight(52, 52, 162, 1000)).toBe(52);
  expect(clampDragHeight(100, 52, 162, 1000)).toBe(100);
  expect(clampDragHeight(300, 52, 162, 1000)).toBe(300);
});

test('a drag in a tiny window never jumps above the rendered height', () => {
  expect(clampDragHeight(100, 120, 162, 200)).toBe(120);
  expect(clampDragHeight(300, 120, 162, 200)).toBe(120);
});

test('only a positive number is a saved height', () => {
  expect(parseSavedHeight(320)).toBe(320);
  for (const bad of [null, 0, -5, '320', Number.NaN, Infinity, {}]) expect(parseSavedHeight(bad)).toBeNull();
});

test('a chosen height survives a restart', () => {
  const storage = memoryStorage();
  setPaletteHeight(320, storage);
  usePaletteHeight.setState({ height: null });
  restorePaletteHeight(storage);
  expect(usePaletteHeight.getState().height).toBe(320);
});

test('resetting goes back to the built-in cap after a restart too', () => {
  const storage = memoryStorage();
  setPaletteHeight(320, storage);
  setPaletteHeight(null, storage);
  restorePaletteHeight(storage);
  expect(usePaletteHeight.getState().height).toBeNull();
});

test('with nothing saved, or junk saved, the built-in cap stays', () => {
  const storage = memoryStorage();
  restorePaletteHeight(storage);
  expect(usePaletteHeight.getState().height).toBeNull();
  storage.set('paletteHeight', 'tall');
  restorePaletteHeight(storage);
  expect(usePaletteHeight.getState().height).toBeNull();
});
