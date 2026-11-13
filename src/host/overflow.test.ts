import { describe, expect, it } from 'vitest';
import { hiddenPast } from './overflow';

/** A frame `[shown, drawn]` tall and wide. */
const frame = ([clientHeight, scrollHeight]: [number, number], [clientWidth, scrollWidth]: [number, number] = [100, 100]) => ({
  clientHeight,
  scrollHeight,
  clientWidth,
  scrollWidth,
});

describe('hiddenPast', () => {
  it('is nothing when the content fits', () => {
    expect(hiddenPast(frame([100, 100]))).toEqual({ below: false, right: false });
  });

  it('is below when the content is taller than the tile', () => {
    expect(hiddenPast(frame([40, 90]))).toEqual({ below: true, right: false });
  });

  it('is right when the content is wider than the tile', () => {
    expect(hiddenPast(frame([100, 100], [200, 340]))).toEqual({ below: false, right: true });
  });

  it('is both when the content runs past both edges', () => {
    expect(hiddenPast(frame([40, 90], [200, 340]))).toEqual({ below: true, right: true });
  });

  it('allows a pixel of subpixel slack each way', () => {
    expect(hiddenPast(frame([100, 101], [200, 201]))).toEqual({ below: false, right: false });
  });
});
