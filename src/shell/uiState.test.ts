import { expect, test, vi } from 'vitest';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { loadUiState, saveUiState } = await import('./uiState');
type UiStorage = import('./uiState').UiStorage;

function memoryStorage(): UiStorage & { items: Map<string, unknown> } {
  const items = new Map<string, unknown>();
  return { items, get: (key) => items.get(key), set: (key, value) => void items.set(key, value) };
}

const asNumber = (value: unknown) => (typeof value === 'number' ? value : null);

test('a saved value loads back, as itself', () => {
  const storage = memoryStorage();
  saveUiState('level', 0.4, storage);
  expect(loadUiState('level', asNumber, 1, storage)).toBe(0.4);
  expect([...storage.items]).toEqual([['level', 0.4]]);
});

test('nothing saved gives the fallback', () => {
  expect(loadUiState('level', asNumber, 1, memoryStorage())).toBe(1);
});

test('a rejected value gives the fallback', () => {
  const storage = memoryStorage();
  storage.set('level', 'loud');
  expect(loadUiState('level', asNumber, 1, storage)).toBe(1);
});

test('no storage, or storage that throws, changes nothing and throws nothing', () => {
  expect(loadUiState('level', asNumber, 1, null)).toBe(1);
  saveUiState('level', 0.4, null);
  const broken: UiStorage = {
    get: () => {
      throw new Error('blocked');
    },
    set: () => {
      throw new Error('full');
    },
  };
  expect(loadUiState('level', asNumber, 1, broken)).toBe(1);
  expect(() => saveUiState('level', 0.4, broken)).not.toThrow();
});
