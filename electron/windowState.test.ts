import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultBounds, isFilling, loadWindowState, MIN_SIZE, openingState, parseWindowState, saveWindowState } from './windowState';

const area = (width: number, height: number, x = 0, y = 0) => ({ x, y, width, height });

describe('defaultBounds', () => {
  it('fills most of a 16:9 display, at 16:10', () => {
    expect(defaultBounds(area(1920, 1040))).toEqual({ x: 253, y: 78, width: 1414, height: 884 });
  });

  it('keeps an ultrawide from getting a very wide window', () => {
    const b = defaultBounds(area(3440, 1414, 0, 26));
    expect(b.width / b.height).toBeCloseTo(1.6, 2);
    expect(b.height).toBe(1202);
    expect(b.y).toBe(26 + 106);
  });

  it('is limited by the width on a tall display', () => {
    const b = defaultBounds(area(1080, 1880));
    expect(b.width).toBe(918);
    expect(b.height).toBe(1598);
  });

  it('never goes below the minimum', () => {
    expect(defaultBounds(area(600, 400))).toMatchObject({ width: MIN_SIZE.width, height: MIN_SIZE.height });
  });
});

describe('isFilling', () => {
  const work = area(2560, 1415, 0, 25);

  it('takes a maximized window that fills its display', () => {
    expect(isFilling(true, { width: 2560, height: 1415 }, work)).toBe(true);
    expect(isFilling(true, { width: 2536, height: 1391 }, work)).toBe(true);
  });

  it('ignores a compositor calling a smaller window maximized', () => {
    expect(isFilling(true, { width: 1111, height: 777 }, work)).toBe(false);
  });

  it('never counts a window the platform says is not maximized', () => {
    expect(isFilling(false, { width: 2560, height: 1415 }, work)).toBe(false);
  });
});

describe('parseWindowState', () => {
  it('takes a saved state and rounds it', () => {
    expect(parseWindowState({ x: 10.4, y: -20, width: 1200, height: 800, maximized: true })).toEqual({ x: 10, y: -20, width: 1200, height: 800, maximized: true });
  });

  it.each([null, 'x', {}, { x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 0, height: 100, maximized: false }, { x: '0', y: 0, width: 1, height: 1, maximized: false }])(
    'rejects %j',
    (value) => expect(parseWindowState(value)).toBeNull(),
  );
});

describe('openingState', () => {
  const laptop = area(1440, 875, 0, 25);
  const monitor = area(2560, 1415, 1440, 0);

  it('uses the default on the display the mouse is on when nothing is saved', () => {
    expect(openingState(null, [laptop, monitor], monitor)).toEqual({ ...defaultBounds(monitor), maximized: false });
  });

  it('puts the window back where it was', () => {
    const saved = { x: 1600, y: 100, width: 1500, height: 900, maximized: true };
    expect(openingState(saved, [laptop, monitor], laptop)).toEqual(saved);
  });

  it('falls back when the display it was on is gone', () => {
    const saved = { x: 1600, y: 100, width: 1500, height: 900, maximized: false };
    expect(openingState(saved, [laptop], laptop)).toEqual({ ...defaultBounds(laptop), maximized: false });
  });

  it('falls back when only a sliver would be on screen', () => {
    const saved = { x: 1400, y: 100, width: 1200, height: 800, maximized: false };
    expect(openingState(saved, [laptop], laptop)).toEqual({ ...defaultBounds(laptop), maximized: false });
  });

  it('shrinks a window bigger than the display it is on', () => {
    const saved = { x: 0, y: 25, width: 2400, height: 1300, maximized: false };
    expect(openingState(saved, [laptop], laptop)).toMatchObject({ x: 0, y: 25, width: 1440, height: 875 });
  });
});

describe('loadWindowState and saveWindowState', () => {
  it('round-trips through the file, and treats a missing or broken file as nothing saved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1a-window-'));
    const file = path.join(dir, 'window-state.json');
    expect(loadWindowState(file)).toBeNull();
    const state = { x: 5, y: 6, width: 1000, height: 700, maximized: false };
    saveWindowState(file, state);
    expect(loadWindowState(file)).toEqual(state);
    fs.writeFileSync(file, '{not json');
    expect(loadWindowState(file)).toBeNull();
    fs.rmSync(dir, { recursive: true });
  });
});
