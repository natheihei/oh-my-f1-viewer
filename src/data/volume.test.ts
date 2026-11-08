import { expect, test } from 'vitest';
import { normalizeVolume, toggledVolume } from './volume';

test('normalizeVolume keeps a level in range', () => {
  expect(normalizeVolume(-0.5)).toBe(0);
  expect(normalizeVolume(0.4)).toBe(0.4);
  expect(normalizeVolume(1.5)).toBe(1);
});

test('normalizeVolume does not drift over repeated steps', () => {
  let volume = 0;
  for (let i = 0; i < 6; i += 1) volume = normalizeVolume(volume + 0.05);
  expect(volume).toBe(0.3);
});

test('toggledVolume mutes from any audible level', () => {
  expect(toggledVolume(0.6, 0.6)).toBe(0);
});

test('toggledVolume restores the level last heard', () => {
  expect(toggledVolume(0, 0.6)).toBe(0.6);
});

test('toggledVolume does not restore a level too quiet to hear', () => {
  expect(toggledVolume(0, 0.02)).toBe(0.25);
});
