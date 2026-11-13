import { describe, expect, it } from 'vitest';
import { hiddenPast, type Axis, type Box } from './overflow';

interface TestBox extends Box {
  clipsX: boolean;
  clipsY: boolean;
  children: TestBox[];
}

interface Opts {
  scrollTop?: number;
  scrollLeft?: number;
  /** Clips on both axes. */
  clips?: boolean;
  clipsX?: boolean;
  clipsY?: boolean;
  /** Width shown and drawn; content fits sideways unless set. */
  width?: [client: number, scroll: number];
  children?: TestBox[];
}

/** A box `clientHeight` tall showing `scrollHeight` of content, and as wide as it draws unless `width` says otherwise. */
const box = (clientHeight: number, scrollHeight: number, o: Opts = {}): TestBox => ({
  clientHeight,
  scrollHeight,
  scrollTop: o.scrollTop ?? 0,
  clientWidth: o.width?.[0] ?? 100,
  scrollWidth: o.width?.[1] ?? 100,
  scrollLeft: o.scrollLeft ?? 0,
  clipsX: o.clipsX ?? o.clips ?? false,
  clipsY: o.clipsY ?? o.clips ?? false,
  children: o.children ?? [],
});
const clips = (b: Box, axis: Axis) => (axis === 'x' ? (b as TestBox).clipsX : (b as TestBox).clipsY);
const below = (b: Box) => hiddenPast(b, clips).below;
const right = (b: Box) => hiddenPast(b, clips).right;

describe('hiddenPast, below', () => {
  it('is false when everything fits', () => {
    expect(hiddenPast(box(100, 100, { children: [box(60, 60, { clips: true })] }), clips)).toEqual({ below: false, right: false });
  });

  it('is true when the view itself is taller than its tile', () => {
    expect(below(box(40, 90))).toBe(true);
  });

  it('is true when a clipping element inside hides content', () => {
    expect(below(box(100, 100, { children: [box(50, 200, { clips: true })] }))).toBe(true);
  });

  it('is true when a scroll area collapsed to nothing still has content', () => {
    expect(below(box(100, 100, { children: [box(0, 16, { clips: true })] }))).toBe(true);
  });

  it('ignores an element that lets its overflow spill', () => {
    expect(below(box(100, 100, { children: [box(20, 60)] }))).toBe(false);
  });

  it('is false once scrolled to the end, and ignores content scrolled off the top', () => {
    expect(below(box(100, 100, { children: [box(50, 200, { clips: true, scrollTop: 150 })] }))).toBe(false);
    expect(below(box(100, 100, { children: [box(50, 200, { clips: true, scrollTop: 100 })] }))).toBe(true);
  });

  it('allows a pixel of subpixel slack', () => {
    expect(below(box(100, 101))).toBe(false);
  });

  it('finds a clipped element deep inside', () => {
    const deep = box(100, 100, { children: [box(100, 100, { children: [box(30, 31), box(30, 80, { clips: true })] })] });
    expect(below(deep)).toBe(true);
  });
});

describe('hiddenPast, to the right', () => {
  it('is true when the view itself is wider than its tile, and not below', () => {
    expect(hiddenPast(box(100, 100, { width: [200, 340] }), clips)).toEqual({ below: false, right: true });
  });

  it('is true when a clipping element inside hides content at its right', () => {
    expect(right(box(100, 100, { children: [box(50, 50, { clipsX: true, width: [80, 260] })] }))).toBe(true);
  });

  it('ignores an element that only clips vertically', () => {
    expect(right(box(100, 100, { children: [box(50, 50, { clipsY: true, width: [80, 260] })] }))).toBe(false);
  });

  it('is false once scrolled to the right end, and ignores content scrolled off the left', () => {
    expect(right(box(100, 100, { children: [box(50, 50, { clipsX: true, width: [80, 260], scrollLeft: 180 })] }))).toBe(false);
    expect(right(box(100, 100, { children: [box(50, 50, { clipsX: true, width: [80, 260], scrollLeft: 60 })] }))).toBe(true);
  });

  it('allows a pixel of subpixel slack', () => {
    expect(right(box(100, 100, { width: [200, 201] }))).toBe(false);
  });

  it('says both when content runs past both edges', () => {
    expect(hiddenPast(box(40, 90, { width: [200, 340] }), clips)).toEqual({ below: true, right: true });
  });

  it('finds each way in different elements', () => {
    const tall = box(30, 80, { clipsY: true });
    const wide = box(30, 30, { clipsX: true, width: [60, 140] });
    expect(hiddenPast(box(100, 100, { children: [tall, wide] }), clips)).toEqual({ below: true, right: true });
  });
});
