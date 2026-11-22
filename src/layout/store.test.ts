import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentSpec } from './model';
import { layout, RESIZE_SETTLE_MS, useLayout } from './store';

const video = (key: string): ComponentSpec => ({ type: 'video', key, label: key, props: {}, fit: { aspect: 16 / 9 } });
const rects = () => layout.tiles().map(({ x, y, w, h }) => [x, y, w, h]);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runAllTimers();
  layout.clear();
  vi.useRealTimers();
});

describe('measuring the grid', () => {
  it('lays tiles out at once the first time', () => {
    layout.measure({ w: 66, h: 34 });
    layout.setMain(layout.add(video('main')));
    layout.add(video('A'));
    expect(useLayout.getState().cell).toEqual({ w: 66, h: 34 });
    // Fitted to its picture, which only a measured grid can do.
    expect(rects()[0][3]).toBeLessThan(24);
  });

  it('leaves tiles in their cells while the size keeps changing, and re-tiles once it holds still', () => {
    layout.measure({ w: 66, h: 34 });
    layout.setMain(layout.add(video('main')));
    layout.add(video('A'));
    const before = rects();
    // A window dragged much narrower, a step at a time: the main picture would take other cells.
    for (const w of [60, 50, 40]) {
      layout.measure({ w, h: 34 });
      vi.advanceTimersByTime(RESIZE_SETTLE_MS - 1);
      expect(useLayout.getState().cell.w).toBe(w);
      expect(rects()).toEqual(before);
    }
    vi.advanceTimersByTime(1);
    expect(rects()).not.toEqual(before);
    expect(useLayout.getState().manual).toBe(false);
  });

  it('moves nothing when the new size puts tiles where they are, and leaves a hand-arranged layout alone', () => {
    layout.measure({ w: 66, h: 34 });
    layout.setMain(layout.add(video('main')));
    layout.add(video('A'));
    const tiles = layout.tiles();
    layout.measure({ w: 66, h: 34.02 });
    vi.advanceTimersByTime(RESIZE_SETTLE_MS);
    expect(layout.tiles()).toBe(tiles);
    layout.mouseEdit(tiles[1].id, { x: 20, y: 20, w: 4, h: 4 });
    const arranged = layout.tiles();
    layout.measure({ w: 40, h: 34 });
    vi.advanceTimersByTime(RESIZE_SETTLE_MS);
    expect(layout.tiles()).toBe(arranged);
    expect(useLayout.getState().manual).toBe(true);
  });
});
