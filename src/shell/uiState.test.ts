import { expect, test } from 'vitest';
import { loadUiState, saveUiState, type UiStorage } from './uiState';

function memoryStorage(): UiStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
}

const asNumber = (value: unknown) => (typeof value === 'number' ? value : null);

test('a saved value loads back', () => {
  const storage = memoryStorage();
  saveUiState('level', 0.4, storage);
  expect(loadUiState('level', asNumber, 1, storage)).toBe(0.4);
  expect([...storage.items.keys()]).toEqual(['f1a.level']);
});

test('nothing saved gives the fallback', () => {
  expect(loadUiState('level', asNumber, 1, memoryStorage())).toBe(1);
});

test('a corrupt or rejected value gives the fallback', () => {
  const storage = memoryStorage();
  storage.setItem('f1a.level', '{not json');
  expect(loadUiState('level', asNumber, 1, storage)).toBe(1);
  storage.setItem('f1a.level', '"loud"');
  expect(loadUiState('level', asNumber, 1, storage)).toBe(1);
});

test('no storage, or storage that throws, changes nothing and throws nothing', () => {
  expect(loadUiState('level', asNumber, 1, null)).toBe(1);
  saveUiState('level', 0.4, null);
  const broken: UiStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('full');
    },
  };
  expect(loadUiState('level', asNumber, 1, broken)).toBe(1);
  expect(() => saveUiState('level', 0.4, broken)).not.toThrow();
});
