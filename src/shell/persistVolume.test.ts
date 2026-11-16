import { beforeEach, expect, test, vi } from 'vitest';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

import { host, read } from '../host';
import { parseSavedVolume, restoreVolume, saveVolume } from './persistVolume';
import type { UiStorage } from './uiState';

function memoryStorage(): UiStorage {
  const items = new Map<string, unknown>();
  return { get: (key) => items.get(key), set: (key, value) => void items.set(key, value) };
}

function saved(storage: UiStorage): unknown {
  return storage.get('volume') ?? null;
}

beforeEach(() => host.audio.setVolume({ volume: 1 }));

test('restores the level the app closed at', () => {
  const storage = memoryStorage();
  storage.set('volume', { level: 0.4, lastHeard: 0.4 });
  restoreVolume(storage);
  expect(read().volume).toBe(0.4);
});

test('restores muted, and unmuting goes back to the level last heard', () => {
  const storage = memoryStorage();
  storage.set('volume', { level: 0, lastHeard: 0.6 });
  restoreVolume(storage);
  expect(read().volume).toBe(0);
  host.audio.toggleMute();
  expect(read().volume).toBe(0.6);
});

test('with nothing saved, the volume stays where it was', () => {
  restoreVolume(memoryStorage());
  expect(read().volume).toBe(1);
});

test('saving a mute keeps the level last heard', () => {
  const storage = memoryStorage();
  saveVolume(0.7, storage);
  expect(saved(storage)).toEqual({ level: 0.7, lastHeard: 0.7 });
  saveVolume(0, storage);
  expect(saved(storage)).toEqual({ level: 0, lastHeard: 0.7 });
});

test('a restored mute is saved with the level last heard', () => {
  const storage = memoryStorage();
  storage.set('volume', { level: 0, lastHeard: 0.6 });
  restoreVolume(storage);
  saveVolume(read().volume, storage);
  expect(saved(storage)).toEqual({ level: 0, lastHeard: 0.6 });
});

test('rejects saved values out of range, or with nothing to unmute to', () => {
  expect(parseSavedVolume({ level: 0.5, lastHeard: 0.5 })).toEqual({ level: 0.5, lastHeard: 0.5 });
  expect(parseSavedVolume({ level: 2, lastHeard: 0.5 })).toBeNull();
  expect(parseSavedVolume({ level: 0, lastHeard: 0 })).toBeNull();
  expect(parseSavedVolume({ level: '0.5', lastHeard: 0.5 })).toBeNull();
  expect(parseSavedVolume(null)).toBeNull();
});
