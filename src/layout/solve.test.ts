import { describe, expect, it } from 'vitest';
import { arrange, shareWithin, solve, type Slot } from './solve';

const sum = (list: number[]) => list.reduce((a, v) => a + v, 0);

describe('shareWithin', () => {
  it('shares in proportion to what each part wants', () => {
    expect(shareWithin(24, [2, 1], [99, 99])).toEqual([16, 8]);
    expect(shareWithin(24, [1, 1, 1], [99, 99, 99])).toEqual([8, 8, 8]);
  });

  it('gives what a part cannot use to the others', () => {
    expect(shareWithin(24, [3, 1], [16, 99])).toEqual([16, 8]);
    expect(shareWithin(24, [1, 1, 1], [4, 99, 99])).toEqual([4, 10, 10]);
  });

  it('leaves the rest unused when no part can take it', () => {
    expect(shareWithin(24, [1, 1], [6, 8])).toEqual([6, 8]);
  });

  it('never gives out more than there is, and at least one cell each while there are enough', () => {
    for (const total of [3, 5, 7, 24]) {
      const out = shareWithin(total, [9, 1, 1], [99, 99, 99]);
      expect(sum(out)).toBeLessThanOrEqual(total);
      expect(Math.min(...out)).toBeGreaterThanOrEqual(1);
    }
    expect(sum(shareWithin(2, [1, 1, 1], [9, 9, 9]))).toBe(2);
  });
});

describe('solve', () => {
  const grid = { columns: 24, rows: 24, cell: { w: 60, h: 36 }, titleBar: 22 };
  const slot = (over: Partial<Slot> = {}): Slot => ({ aspect: 16 / 9, min: { w: 0, h: 0 }, fit: (room) => room, capped: false, ...over });

  it('gives the main place to the slot named, top left and largest, and to none when none is named', () => {
    const boxes = solve([slot(), slot(), slot()], grid, 1);
    expect(boxes[1]).toMatchObject({ x: 0, y: 0 });
    for (const other of [boxes[0], boxes[2]]) expect(boxes[1].w * boxes[1].h).toBeGreaterThan(other.w * other.h);
    expect(new Set(solve([slot(), slot(), slot()], grid).map((b) => b.w * b.h)).size).toBe(1);
  });

  it('shares the grid evenly between slots when there is no main tile', () => {
    const boxes = solve([slot(), slot(), slot(), slot()], grid);
    expect(boxes.map((b) => b.w * b.h)).toEqual([144, 144, 144, 144]);
  });

  it('returns a box for every slot in the order given', () => {
    expect(solve([], grid)).toEqual([]);
    expect(solve([slot()], grid)).toEqual([{ x: 0, y: 0, w: 24, h: 24 }]);
    expect(solve([slot(), slot(), slot()], grid)).toHaveLength(3);
  });

  it('never gives a slot more than it can use', () => {
    const capped = slot({ aspect: 0.75, capped: true, fit: (room) => ({ w: Math.min(room.w, 6), h: Math.min(room.h, 16) }) });
    const [, box] = solve([slot(), capped], grid, 0);
    expect(box.w).toBeLessThanOrEqual(6);
    expect(box.h).toBeLessThanOrEqual(16);
  });

  it('prefers a smaller main tile to a slot below its least size', () => {
    const needy = slot({ min: { w: 10, h: 10 } });
    const [main, box] = solve([slot(), needy], grid, 0);
    expect(box.w).toBeGreaterThanOrEqual(10);
    expect(box.h).toBeGreaterThanOrEqual(10);
    expect(main.w * main.h).toBeLessThanOrEqual(24 * 24 - 100);
  });

  /** No two boxes share a cell, none leaves the grid, and each is at least `least` cells either way. */
  const legible = (boxes: { x: number; y: number; w: number; h: number }[], least: number) => {
    const seen = new Set<string>();
    for (const b of boxes) {
      expect(b.w >= least && b.h >= least && b.x >= 0 && b.y >= 0 && b.x + b.w <= 24 && b.y + b.h <= 24, JSON.stringify(b)).toBe(true);
      for (let y = b.y; y < b.y + b.h; y += 1) {
        for (let x = b.x; x < b.x + b.w; x += 1) {
          expect(seen.has(`${x},${y}`), `overlap at ${x},${y}`).toBe(false);
          seen.add(`${x},${y}`);
        }
      }
    }
  };

  it('splits the rail and band into as many lines as they need, so no slot is squeezed to a sliver', () => {
    for (const count of [8, 16, 32, 48]) {
      const slots = Array.from({ length: count }, (_, i) => slot({ min: { w: 5, h: 6 }, aspect: i % 3 === 0 ? 0.8 : 16 / 9 }));
      legible(solve(slots, grid, 0), 3);
      legible(solve(slots, grid), 3);
    }
  });

  it('falls back to a plain grid, with no overlap, when no rail or band gives every slot room', () => {
    const many = Array.from({ length: 80 }, () => slot());
    expect(arrange(many, grid, 0)).toBeNull();
    legible(solve(many, grid, 0), 2);
  });
});
