import { describe, expect, it } from 'vitest';
import { hiddenBelow, type Box } from './overflow';

interface TestBox extends Box {
  clips: boolean;
  children: TestBox[];
}

const box = (clientHeight: number, scrollHeight: number, { scrollTop = 0, clips = false, children = [] as TestBox[] } = {}): TestBox => ({
  clientHeight,
  scrollHeight,
  scrollTop,
  clips,
  children,
});
const clips = (b: Box) => (b as TestBox).clips;

describe('hiddenBelow', () => {
  it('is false when everything fits', () => {
    expect(hiddenBelow(box(100, 100, { children: [box(60, 60, { clips: true })] }), clips)).toBe(false);
  });

  it('is true when the view itself is taller than its tile', () => {
    expect(hiddenBelow(box(40, 90), clips)).toBe(true);
  });

  it('is true when a clipping element inside hides content', () => {
    expect(hiddenBelow(box(100, 100, { children: [box(50, 200, { clips: true })] }), clips)).toBe(true);
  });

  it('is true when a scroll area collapsed to nothing still has content', () => {
    expect(hiddenBelow(box(100, 100, { children: [box(0, 16, { clips: true })] }), clips)).toBe(true);
  });

  it('ignores an element that lets its overflow spill', () => {
    expect(hiddenBelow(box(100, 100, { children: [box(20, 60)] }), clips)).toBe(false);
  });

  it('is false once scrolled to the end, and ignores content scrolled off the top', () => {
    expect(hiddenBelow(box(100, 100, { children: [box(50, 200, { clips: true, scrollTop: 150 })] }), clips)).toBe(false);
    expect(hiddenBelow(box(100, 100, { children: [box(50, 200, { clips: true, scrollTop: 100 })] }), clips)).toBe(true);
  });

  it('allows a pixel of subpixel slack', () => {
    expect(hiddenBelow(box(100, 101), clips)).toBe(false);
  });

  it('finds a clipped element deep inside', () => {
    const deep = box(100, 100, { children: [box(100, 100, { children: [box(30, 31), box(30, 80, { clips: true })] })] });
    expect(hiddenBelow(deep, clips)).toBe(true);
  });
});
