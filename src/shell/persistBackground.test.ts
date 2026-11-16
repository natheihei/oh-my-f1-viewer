import { beforeAll, beforeEach, expect, test, vi } from 'vitest';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({
  default: {},
}));
vi.mock('gridstack', () => ({ GridStack: {} }));

import Type from 'typebox';
import { defineBackground, host, read } from '../host';
import { formatSetting, nudge } from './BackgroundPanel';
import { changedParams, parseSavedBackground, restoreBackground, saveBackground } from './persistBackground';
import type { UiStorage } from './uiState';

function memoryStorage(): UiStorage {
  const items = new Map<string, unknown>();
  return {
    get: (key) => items.get(key),
    set: (key, value) => void items.set(key, value),
  };
}

const stars = defineBackground<{
  [key: string]: number | boolean;
  density: number;
  twinkle: boolean;
  size: number;
}>({
  name: 'stars',
  title: 'Starfield',
  params: Type.Object({
    density: Type.Number({
      title: 'Density',
      minimum: 1,
      maximum: 10,
      step: 0.5,
      default: 4,
    }),
    twinkle: Type.Boolean({ title: 'Twinkle', default: true }),
    size: Type.Union([Type.Literal(24), Type.Literal(48)], {
      title: 'Size',
      default: 24,
    }),
  }),
  animated: () => false,
  draw: () => {},
});
const grid = defineBackground<{ [key: string]: number }>({
  name: 'grid',
  title: 'Layout grid',
  params: Type.Object({
    brightness: Type.Number({
      title: 'Brightness',
      minimum: 0,
      maximum: 1,
      step: 0.01,
      default: 0.1,
      unit: '%',
    }),
  }),
  animated: () => false,
  draw: () => {},
});

beforeAll(() => host.backgrounds.register({ backgrounds: [stars, grid] }));
beforeEach(() => {
  host.appearance.setBackground({
    style: 'stars',
    params: { density: 4, twinkle: true, size: 24 },
  });
  host.appearance.setBackground({ style: 'grid', params: { brightness: 0.1 } });
  host.appearance.setBackground({ style: 'off' });
});

test('registering lists each background with its settings, and fills in their defaults', () => {
  expect(read().backgrounds.map((b) => b.name)).toEqual(['stars', 'grid']);
  expect(read().background.params.stars).toEqual({
    density: 4,
    twinkle: true,
    size: 24,
  });
});

test('a setting is kept in range, snapped to its step, and one that does not fit is ignored', () => {
  host.appearance.setBackground({
    style: 'stars',
    params: { density: 99, twinkle: 3, size: 30, bogus: 1 },
  });
  expect(read().background).toMatchObject({
    style: 'stars',
    params: { stars: { density: 10, twinkle: true, size: 24 } },
  });
  host.appearance.setBackground({
    style: 'stars',
    params: { density: 2.3, size: 48 },
  });
  expect(read().background.params.stars).toEqual({
    density: 2.5,
    twinkle: true,
    size: 48,
  });
});

test('each style keeps its settings while another shows', () => {
  host.appearance.setBackground({ style: 'stars', params: { density: 6 } });
  host.appearance.setBackground({ style: 'grid' });
  host.appearance.setBackground({ style: 'stars' });
  expect(read().background.params.stars.density).toBe(6);
});

test('an unknown style is refused', () => {
  expect(() => host.appearance.setBackground({ style: 'lava' })).toThrow(/Unknown background/);
  expect(read().background.style).toBe('off');
});

test('saves and restores the style showing and every style’s settings', () => {
  const storage = memoryStorage();
  saveBackground(
    {
      style: 'grid',
      params: {
        stars: { density: 7, twinkle: false, size: 48 },
        grid: { brightness: 0.3 },
      },
    },
    storage,
  );
  restoreBackground(storage);
  expect(read().background).toMatchObject({
    style: 'grid',
    params: {
      stars: { density: 7, twinkle: false, size: 48 },
      grid: { brightness: 0.3 },
    },
  });
});

test('saves only the settings changed from their defaults', () => {
  expect(
    changedParams(read().backgrounds, {
      stars: { density: 7, twinkle: true, size: 24 },
      grid: { brightness: 0.1 },
      lava: { heat: 1 },
    }),
  ).toEqual({ stars: { density: 7 }, lava: { heat: 1 } });
});

test('restoring only the changed settings leaves the rest at their defaults', () => {
  const storage = memoryStorage();
  saveBackground({ style: 'stars', params: { stars: { density: 7 } } }, storage);
  restoreBackground(storage);
  expect(read().background.params.stars).toEqual({ density: 7, twinkle: true, size: 24 });
});

test('restores a style that is gone as off, and keeps a setting that no longer fits at what it was', () => {
  const storage = memoryStorage();
  saveBackground(
    {
      style: 'lava',
      params: {
        lava: { heat: 1 },
        stars: { density: 'lots' as unknown as number },
      },
    },
    storage,
  );
  restoreBackground(storage);
  expect(read().background.style).toBe('off');
  expect(read().background.params.stars.density).toBe(4);
});

test('with nothing saved, or something unreadable, the background stays as it was', () => {
  restoreBackground(memoryStorage());
  expect(read().background.style).toBe('off');
  expect(parseSavedBackground({ style: 3 })).toBeNull();
  expect(parseSavedBackground(null)).toBeNull();
});

test('formats a setting by its unit and step', () => {
  expect(formatSetting({ unit: '%' }, 0.135)).toBe('14%');
  expect(formatSetting({ unit: 'px', step: 0.1 }, 1.2)).toBe('1.2px');
  expect(formatSetting({ unit: 'px/s', step: 1 }, 34)).toBe('34px/s');
  expect(formatSetting({ step: 0.005, unit: '%' }, 0.075)).toBe('8%');
  expect(formatSetting({}, true)).toBe('on');
});

test('arrow keys move a setting a step, ten with shift, within its range', () => {
  const density = { minimum: 0.5, maximum: 12, step: 0.1 };
  expect(nudge(density, 3.8, 1)).toBeCloseTo(3.9);
  expect(nudge(density, 3.8, -1, true)).toBeCloseTo(2.8);
  expect(nudge(density, 11.5, 1, true)).toBe(12);
  expect(nudge({ type: 'boolean' }, false, 1)).toBe(true);
  expect(nudge({ type: 'boolean' }, true, -1)).toBe(false);
  const choices = { anyOf: [{ const: 24 }, { const: 48 }] };
  expect(nudge(choices, 24, 1)).toBe(48);
  expect(nudge(choices, 48, 1)).toBe(48);
  expect(nudge(choices, 48, -1)).toBe(24);
});

test('a unit reads on one line', () => {
  expect(formatSetting({ step: 0.1, unit: '/10k px²' }, 5.8)).toBe('5.8/10k px²');
});
