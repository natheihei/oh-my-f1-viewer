import { describe, expect, it } from 'vitest';
import { clampPreviewSize, MIN_PREVIEW, previewAspect, STRIP_SHAPES } from './stripShape';

describe('previewAspect', () => {
  it('follows the hint when it fits', () => {
    expect(previewAspect(1.6, 'suggestion')).toBe(1.6);
    expect(previewAspect(2, 'draft')).toBe(2);
  });

  it('falls back to the card\'s own shape without a hint', () => {
    expect(previewAspect(undefined, 'suggestion')).toBe(16 / 9);
    expect(previewAspect(undefined, 'draft')).toBe(8 / 3);
    expect(previewAspect(0, 'draft')).toBe(8 / 3);
  });

  it('stops at the tallest and shortest a card may be', () => {
    const { width, minHeight, maxHeight } = STRIP_SHAPES.draft;
    expect(previewAspect(0.6, 'draft')).toBe(width / maxHeight);
    expect(previewAspect(10, 'draft')).toBe(width / minHeight);
  });
});

describe('clampPreviewSize', () => {
  it('keeps a size that fits', () => {
    expect(clampPreviewSize({ width: 300, height: 200 }, 800, 400)).toEqual({ width: 300, height: 200 });
  });

  it('stops at the strip\'s width and the window\'s share of height', () => {
    expect(clampPreviewSize({ width: 2000, height: 900 }, 800, 400)).toEqual({ width: 800, height: 400 });
  });

  it('never goes below the least size, even without room', () => {
    expect(clampPreviewSize({ width: 10, height: 5 }, 800, 400)).toEqual(MIN_PREVIEW);
    expect(clampPreviewSize({ width: 300, height: 200 }, 50, 30)).toEqual(MIN_PREVIEW);
  });
});
