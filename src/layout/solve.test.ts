import { describe, expect, it } from 'vitest';
import { apart, arrange, groupsOf, shareWithin, solve, type Slot } from './solve';

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

  /** How far apart the groups' boxes are: see `apart`. */
  const spread = (slots: Slot[], main: number | null = null) => {
    const by = new Map<string, number[]>();
    slots.forEach((s, i) => s.group !== undefined && by.set(s.group, [...(by.get(s.group) ?? []), i]));
    return apart(new Map(solve(slots, grid, main).map((box, i) => [i, box])), [...by.values()], grid);
  };

  it('keeps slots that share a group together, though they were added between others', () => {
    // Two batches clicked in turn about: a tall chart and a wide one, and two videos. Then a chart alone.
    const mixed = (grouped: boolean) => {
      const of = (group: string) => (grouped ? { group } : {});
      return [slot({ aspect: 0.75, ...of('a') }), slot(of('b')), slot({ aspect: 2, ...of('a') }), slot(of('b')), slot({ aspect: 2.5 })];
    };
    expect(spread(mixed(true))).toBe(0);
    legible(solve(mixed(true), grid), 3);
    // By shape alone the tall chart goes to the rail, away from the one it came with.
    const boxes = solve(mixed(false), grid);
    expect(apart(new Map(boxes.map((box, i) => [i, box])), [[0, 2], [1, 3]], grid)).toBeGreaterThan(0);
  });

  it('keeps a group together round a main tile too, in the rail, the band, or across their corner', () => {
    const slots = [slot(), slot({ group: 'a' }), slot({ group: 'b' }), slot({ aspect: 0.8, group: 'a' }), slot({ aspect: 0.8, group: 'b' }), slot({ aspect: 3, group: 'a' }), slot({ aspect: 3, group: 'b' })];
    legible(solve(slots, grid, 0), 3);
    expect(spread(slots, 0)).toBeLessThan(0.05);
  });

  it('arranges slots as before when none share a group', () => {
    const plain = [slot(), slot({ aspect: 0.75 }), slot({ aspect: 2 }), slot(), slot({ aspect: 2.5 })];
    const alone = plain.map((s, i) => ({ ...s, group: `only-${i}` }));
    expect(solve(alone, grid, 0)).toEqual(solve(plain, grid, 0));
    expect(solve(alone, grid)).toEqual(solve(plain, grid));
  });

  it('puts a slot at its least size before keeping a group together', () => {
    const slots = [slot(), slot({ min: { w: 8, h: 8 }, group: 'a' }), slot({ aspect: 0.6, min: { w: 6, h: 12 }, group: 'a' }), slot({ min: { w: 8, h: 6 } })];
    solve(slots, grid, 0).forEach((box, i) => {
      expect(box.w, `slot ${i}`).toBeGreaterThanOrEqual(slots[i].min.w);
      expect(box.h, `slot ${i}`).toBeGreaterThanOrEqual(slots[i].min.h);
    });
  });

  it('lays out groups made of the same kinds of tile the same way round, at one size and in line, the newest first', () => {
    // An onboard, its telemetry and its pedals for each of two drivers, clicked in turn about, round a main tile.
    const kinds: Partial<Slot>[] = [{ kind: 'video' }, { kind: 'telemetry', aspect: 1.6, min: { w: 5, h: 5 } }, { kind: 'pedals', aspect: 2.4, min: { w: 5, h: 5 } }];
    const slots = [slot(), ...kinds.flatMap((kind) => [slot({ ...kind, group: 'a' }), slot({ ...kind, group: 'b' })])];
    const boxes = solve(slots, grid, 0);
    legible(boxes, 3);
    const a = [1, 3, 5].map((i) => boxes[i]);
    const b = [2, 4, 6].map((i) => boxes[i]);
    // Each of b's tiles is one step from a's of the same kind, the same way for all three: beside it or below it.
    const steps = a.map((box, k) => `${Math.sign(b[k].x - box.x)},${Math.sign(b[k].y - box.y)}`);
    expect(new Set(steps).size, JSON.stringify(boxes)).toBe(1);
    expect(['1,0', '-1,0', '0,1', '0,-1'], JSON.stringify(boxes)).toContain(steps[0]);
    a.forEach((box, k) => {
      expect(Math.abs(box.w - b[k].w), JSON.stringify(boxes)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.h - b[k].h), JSON.stringify(boxes)).toBeLessThanOrEqual(1);
    });
    // b had the last tile added, so it is the newer group and comes first: left of a, or above it.
    expect(['1,0', '0,1']).not.toContain(steps[0]);
  });

  it('lists groups newest first, by the last slot added to each, and leaves out the main slot and a group of one', () => {
    const slots = [slot({ group: 'a' }), slot({ group: 'b' }), slot({ group: 'a' }), slot({ group: 'c' }), slot({ group: 'b' }), slot()];
    expect(groupsOf(slots)).toEqual([[1, 4], [0, 2]]);
    expect(groupsOf(slots, 4)).toEqual([[0, 2]]);
  });

  it('places the slots on their own when a block would leave one under its least size', () => {
    // Five tiles of one group, each needing a third of the grid one way: no row, column or pair of rows holds them.
    const slots = [slot(), ...Array.from({ length: 5 }, () => slot({ min: { w: 8, h: 6 }, group: 'a' }))];
    const boxes = solve(slots, grid, 0);
    legible(boxes, 3);
    boxes.slice(1).forEach((box) => expect(box.w >= 8 && box.h >= 6, JSON.stringify(boxes)).toBe(true));
  });

  it('falls back to a plain grid, with no overlap, when no rail or band gives every slot room', () => {
    const many = Array.from({ length: 80 }, () => slot());
    expect(arrange(many, grid, 0)).toBeNull();
    legible(solve(many, grid, 0), 2);
  });
});
