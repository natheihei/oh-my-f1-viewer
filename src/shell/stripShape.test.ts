import { describe, expect, it } from 'vitest';
import { previewAspect, STRIP_SHAPES } from './stripShape';

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
