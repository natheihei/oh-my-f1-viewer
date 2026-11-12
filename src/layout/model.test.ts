import { describe, expect, it } from 'vitest';
import {
  addTile,
  addTileAt,
  allTiles,
  applyMouseEdit,
  autoLayout,
  closeGroup,
  createGroup,
  EMPTY_LAYOUT,
  findTile,
  freeRectAt,
  GRID_COLUMNS,
  GRID_ROWS,
  largestFreeRect,
  measure,
  removeTile,
  solveRects,
  swap,
  ungroup,
  type ComponentSpec,
  type LayoutState,
  type Rect,
} from './model';

const spec = (key: string): ComponentSpec => ({ type: 'video', key, label: key, props: {} });
const build = (...keys: string[]) => keys.reduce<LayoutState>((s, k) => addTile(s, spec(k)), EMPTY_LAYOUT);

function area(r: Rect): number {
  return r.w * r.h;
}

/** Every grid cell is covered exactly once. */
function assertTilesGrid(rects: Rect[]): void {
  const seen = new Set<string>();
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y += 1) {
      for (let x = r.x; x < r.x + r.w; x += 1) {
        const cell = `${x},${y}`;
        expect(seen.has(cell), `overlap at ${cell}`).toBe(false);
        seen.add(cell);
      }
    }
  }
  expect(seen.size).toBe(GRID_COLUMNS * GRID_ROWS);
}

describe('solveRects', () => {
  for (let slots = 1; slots <= 24; slots += 1) {
    it(`fills the grid exactly with ${slots} slot(s), primary largest`, () => {
      const rects = solveRects(slots, false);
      expect(rects).toHaveLength(slots);
      assertTilesGrid(rects);
      for (const r of rects.slice(1)) expect(area(rects[0])).toBeGreaterThanOrEqual(area(r));
    });
  }

  it('widens the rail when a group needs room', () => {
    expect(solveRects(2, true)[1].w).toBeGreaterThan(solveRects(2, false)[1].w);
  });

  it('shares the column beside the primary by least height when every tile there has a hint', () => {
    // A timing tower (12 rows), a pace chart (9) and a small card (5) beside the main feed.
    const rail = solveRects(4, false, [null, 12, 9, 5]);
    assertTilesGrid(rail);
    expect(rail.slice(1).map((r) => r.h)).toEqual([11, 8, 5]);
    expect(rail[0]).toEqual(solveRects(4, false)[0]);
    // Further down the layout, the two beside the primary share its height the same way; the band below doesn't change.
    const band = solveRects(5, false, [null, 12, 5, 6, 6]);
    assertTilesGrid(band);
    expect(band.slice(1, 3).map((r) => r.h)).toEqual([11, 5]);
    expect(band.slice(3)).toEqual(solveRects(5, false).slice(3));
  });

  it('splits evenly as before when any tile in the column has no hint, such as a video', () => {
    for (const slots of [2, 3, 4, 5, 7, 9]) {
      const heights = Array.from({ length: slots }, (_, i) => (i === 2 ? null : 6 + i));
      expect(solveRects(slots, false, heights)).toEqual(solveRects(slots, false));
    }
    expect(solveRects(3, false, [null, 5, 5])).toEqual(solveRects(3, false));
  });
});

describe('size hints', () => {
  const chart = (key: string, h: number): ComponentSpec => ({ type: 'chart', key, label: key, props: {}, size: { aspect: 1, min: [6, h] } });

  it('gives a tall chart more of the rail than a small one, and leaves the main feed where it was', () => {
    const s = [chart('tower', 12), chart('card', 5)].reduce(addTile, build('main'));
    const [main, tower, card] = s.nodes;
    expect(main).toMatchObject({ x: 0, y: 0, w: 16, h: GRID_ROWS });
    expect(tower).toMatchObject({ x: 16, y: 0, w: 8, h: 17 });
    expect(card).toMatchObject({ x: 16, y: 17, w: 8, h: 7 });
  });

  it('places a video beside charts exactly as without hints', () => {
    const hinted = [chart('tower', 12), spec('onboard')].reduce(addTile, build('main'));
    const plain = [spec('tower'), spec('onboard')].reduce(addTile, build('main'));
    expect(hinted.nodes.map(({ x, y, w, h }) => ({ x, y, w, h }))).toEqual(plain.nodes.map(({ x, y, w, h }) => ({ x, y, w, h })));
  });
});

describe('fitting content', () => {
  /** 1680 by 960, so a cell is 70 by 40. */
  const cell = { w: 70, h: 40 };
  const sized = measure(EMPTY_LAYOUT, cell);
  const video = (key: string): ComponentSpec => ({ ...spec(key), fit: { aspect: 16 / 9 } });
  /** 352 by 496 pixels at most: 6 columns and 13 rows with the title bar. */
  const tower: ComponentSpec = { type: 'chart', key: 'tower', label: 'tower', props: {}, size: { aspect: 0.6, min: [6, 12] }, fit: { width: 352, height: 496 } };
  const chart = (key: string, min: [number, number], aspect = 1.6): ComponentSpec => ({ type: 'chart', key, label: key, props: {}, size: { aspect, min } });
  const rects = (s: LayoutState) => Object.fromEntries(allTiles(s).map((t) => [t.component.key, { x: t.x, y: t.y, w: t.w, h: t.h }]));
  const withTower = addTile(addTile(sized, video('main')), tower);

  it('shrinks the video to its picture and the tower to its content, leaving gaps right and below', () => {
    expect(rects(withTower)).toEqual({ main: { x: 0, y: 0, w: 16, h: 17 }, tower: { x: 16, y: 0, w: 6, h: 13 } });
  });

  it('narrows a video that is limited by height instead', () => {
    expect(rects(addTile(measure(EMPTY_LAYOUT, { w: 100, h: 40 }), video('main'))).main).toEqual({ x: 0, y: 0, w: 17, h: 24 });
  });

  it('fits nothing before the grid is measured', () => {
    expect(rects(addTile(addTile(EMPTY_LAYOUT, video('main')), tower))).toEqual({
      main: { x: 0, y: 0, w: 16, h: 24 },
      tower: { x: 16, y: 0, w: 8, h: 24 },
    });
  });

  it('puts a new tile into the gap closest to its shape, and moves nothing else', () => {
    const card = addTile(withTower, chart('card', [6, 5]));
    expect(rects(card)).toEqual({ ...rects(withTower), card: { x: 16, y: 13, w: 8, h: 11 } });
    expect(card.manual).toBe(false);
    expect(rects(addTile(withTower, chart('trace', [12, 7], 16 / 9))).trace).toEqual({ x: 0, y: 17, w: 24, h: 7 });
    expect(rects(addTile(withTower, chart('flags', [2, 6], 0.2))).flags).toEqual({ x: 22, y: 0, w: 2, h: 24 });
  });

  it('re-tiles when no gap is big enough', () => {
    const next = addTile(withTower, chart('big', [8, 12]));
    expect(rects(next)).toEqual({
      main: { x: 0, y: 0, w: 16, h: 17 },
      tower: { x: 16, y: 0, w: 6, h: 12 },
      big: { x: 16, y: 12, w: 8, h: 12 },
    });
  });

  it('never puts a video into a gap', () => {
    expect(rects(addTile(withTower, spec('onboard'))).onboard.w).toBe(8);
  });

  it('leaves tiles alone on a resize that changes nothing re-tiling would do', () => {
    const next = measure(withTower, { w: 70, h: 39.9 });
    expect(next.nodes).toBe(withTower.nodes);
    expect(next.cell).toEqual({ w: 70, h: 39.9 });
  });

  it('re-fits on a resize that does, lifting tiles into the rows others leave', () => {
    const filled = addTile(withTower, chart('flags', [2, 6], 0.2));
    const narrow = measure(filled, { w: 50, h: 40 });
    expect(rects(narrow)).toEqual({
      main: { x: 0, y: 0, w: 16, h: 12 },
      tower: { x: 16, y: 0, w: 8, h: 13 },
      flags: { x: 16, y: 13, w: 8, h: 8 },
    });
  });

  it('leaves a hand-arranged layout alone on a resize', () => {
    const manual = applyMouseEdit(withTower, withTower.nodes[1].id, { x: 14, y: 0, w: 10, h: 24 });
    expect(measure(manual, { w: 50, h: 40 }).nodes).toBe(manual.nodes);
  });
});

describe('the session journey', () => {
  it('starts with the main broadcast filling the screen', () => {
    const s = build('main');
    expect(s.nodes[0]).toMatchObject({ x: 0, y: 0, w: GRID_COLUMNS, h: GRID_ROWS });
  });

  it('"Hamilton. Also battle between Norris and Leclerc", then closing that battle', () => {
    let s = addTile(build('main'), spec('HAM'));
    const { state } = createGroup(s, [spec('NOR'), spec('LEC')]);
    s = state;

    expect(s.nodes.map((n) => n.kind)).toEqual(['tile', 'tile', 'group']);
    const main = s.nodes[0];
    for (const n of s.nodes.slice(1)) expect(area(main)).toBeGreaterThan(area(n));
    const group = s.nodes[2];
    if (group.kind !== 'group') throw new Error('expected a group');
    expect(group.title).toBe('NOR / LEC');
    expect(group.children.map((c) => c.component.key)).toEqual(['NOR', 'LEC']);
    expect(group.children[0].y).toBe(group.children[1].y); // side by side

    const closed = closeGroup(s, 'NOR');
    expect(closed?.removed.map((c) => c.key)).toEqual(['NOR', 'LEC']);
    expect(allTiles(closed!.state).map((t) => t.component.key)).toEqual(['main', 'HAM']);
  });
});

describe('tile identity', () => {
  it('survives moving into a group, so the component is never remounted', () => {
    const s = build('main', 'HAM');
    const before = findTile(s, 'HAM')!.tile.id;
    const { state } = createGroup(s, [spec('HAM'), spec('VER')]);
    expect(findTile(state, 'HAM')!.tile.id).toBe(before);
    expect(findTile(state, 'HAM')!.group).not.toBeNull();
  });

  it('survives dissolving a group', () => {
    const { state } = createGroup(build('main'), [spec('A'), spec('B')]);
    const id = findTile(state, 'A')!.tile.id;
    expect(findTile(ungroup(state, 'A')!, 'A')!.tile.id).toBe(id);
  });

  it('survives re-tiling', () => {
    const s = build('main', 'A', 'B');
    expect(autoLayout(s).nodes.map((n) => n.id).sort()).toEqual(s.nodes.map((n) => n.id).sort());
  });
});

describe('editing', () => {
  it('ignores adding the same component twice', () => {
    const s = build('main', 'A');
    expect(addTile(s, spec('A'))).toBe(s);
  });

  it('dissolves a group left with one member into a plain tile in its place', () => {
    const { state } = createGroup(build('main'), [spec('A'), spec('B')]);
    const s = removeTile(state, 'A');
    expect(s.nodes.every((n) => n.kind === 'tile')).toBe(true);
    expect(findTile(s, 'B')?.group).toBeNull();
  });

  it('pulls a group member into a new group, dissolving the old one', () => {
    const first = createGroup(build('main'), [spec('A'), spec('B')]).state;
    const second = createGroup(first, [spec('A'), spec('C')]).state;
    expect(allTiles(second).map((t) => t.component.key).sort()).toEqual(['A', 'B', 'C', 'main']);
    expect(findTile(second, 'B')?.group).toBeNull();
    expect(findTile(second, 'A')?.group?.children).toHaveLength(2);
  });

});

describe('mouse edits', () => {
  it('stay put when a tile is added, using free space', () => {
    let s = build('main');
    s = applyMouseEdit(s, s.nodes[0].id, { x: 0, y: 0, w: 12, h: 24 });
    expect(s.manual).toBe(true);
    s = addTile(s, spec('A'));
    expect(s.nodes[0]).toMatchObject({ w: 12, h: 24 });
    expect(findTile(s, 'A')!.tile).toMatchObject({ x: 12, y: 0, w: 12, h: 24 });
  });

  it('give way to a re-tile when there is no room left', () => {
    let s = build('main');
    s = applyMouseEdit(s, s.nodes[0].id, { x: 0, y: 0, w: 24, h: 23 });
    s = addTile(s, spec('A'));
    expect(s.manual).toBe(false);
    expect(area(findTile(s, 'A')!.tile)).toBeGreaterThan(36);
  });

  it('are discarded by an auto layout, which puts tiles back in the order they were added', () => {
    let s = build('main', 'A');
    s = applyMouseEdit(s, s.nodes[0].id, { x: 0, y: 0, w: 5, h: 5 });
    s = swap(s, s.nodes[0].id, s.nodes[1].id);
    s = autoLayout(s);
    expect(s.manual).toBe(false);
    expect(s.nodes[0].w).toBeGreaterThan(5);
    expect(area(findTile(s, 'main')!.tile)).toBeGreaterThan(area(findTile(s, 'A')!.tile));
  });

  it('do not count as an edit when nothing moved', () => {
    const s = build('main');
    const { x, y, w, h } = s.nodes[0];
    expect(applyMouseEdit(s, s.nodes[0].id, { x, y, w, h })).toBe(s);
  });

  it('can move a tile inside a group', () => {
    const { state } = createGroup(build('main'), [spec('A'), spec('B')]);
    const tile = findTile(state, 'A')!.tile;
    const s = applyMouseEdit(state, tile.id, { ...tile, w: 3 });
    expect(findTile(s, 'A')!.tile.w).toBe(3);
  });
});

describe('swap', () => {
  it('exchanges two tiles and marks the layout as manual', () => {
    const s = build('main', 'A');
    const [main, a] = s.nodes;
    const swapped = swap(s, main.id, a.id);
    expect(findTile(swapped, 'main')!.tile).toMatchObject({ x: a.x, w: a.w });
    expect(findTile(swapped, 'A')!.tile).toMatchObject({ x: main.x, w: main.w });
    expect(swapped.manual).toBe(true);
    expect(findTile(swapped, 'main')!.tile.id).toBe(main.id);
  });

  it('exchanges two members of a group', () => {
    const { state } = createGroup(build('main'), [spec('A'), spec('B')]);
    const [a, b] = [findTile(state, 'A')!.tile, findTile(state, 'B')!.tile];
    const swapped = swap(state, a.id, b.id);
    expect(findTile(swapped, 'A')!.tile.x).toBe(b.x);
    expect(findTile(swapped, 'B')!.tile.x).toBe(a.x);
  });

  it('does nothing across levels', () => {
    const { state } = createGroup(build('main'), [spec('A'), spec('B')]);
    expect(swap(state, findTile(state, 'main')!.tile.id, findTile(state, 'A')!.tile.id)).toBe(state);
  });
});

describe('largestFreeRect', () => {
  it('finds the whole grid when empty, and nothing when full', () => {
    expect(largestFreeRect([])).toMatchObject({ w: GRID_COLUMNS, h: GRID_ROWS });
    expect(area(largestFreeRect([{ x: 0, y: 0, w: GRID_COLUMNS, h: GRID_ROWS }]))).toBe(0);
  });

  it('finds the biggest hole', () => {
    expect(largestFreeRect([{ x: 0, y: 0, w: 16, h: 24 }, { x: 16, y: 0, w: 8, h: 8 }])).toMatchObject({
      x: 16,
      y: 8,
      w: 8,
      h: 16,
    });
  });
});

describe('dropping a tile', () => {
  it('splits the tile under the pointer across its longer side', () => {
    const one = build('main');
    const next = addTileAt(one, spec('ham'), { x: 20, y: 5 });
    expect(next.manual).toBe(true);
    const rects = Object.fromEntries(allTiles(next).map((t) => [t.component.key, { x: t.x, y: t.y, w: t.w, h: t.h }]));
    expect(rects.main).toEqual({ x: 0, y: 0, w: 12, h: GRID_ROWS });
    expect(rects.ham).toEqual({ x: 12, y: 0, w: 12, h: GRID_ROWS });
    assertTilesGrid(Object.values(rects));
  });

  it('takes the half the pointer is over', () => {
    const next = addTileAt(build('main'), spec('ham'), { x: 2, y: 5 });
    const ham = allTiles(next).find((t) => t.component.key === 'ham');
    expect(ham).toMatchObject({ x: 0, w: 12 });
  });

  it('splits a tall tile top and bottom', () => {
    const state = build('main', 'a');
    const a = allTiles(state).find((t) => t.component.key === 'a')!;
    const next = addTileAt(state, spec('b'), { x: a.x, y: a.y + a.h - 1 });
    const b = allTiles(next).find((t) => t.component.key === 'b')!;
    expect(b.w).toBe(a.w);
    expect(b.y).toBeGreaterThan(a.y);
    assertTilesGrid(allTiles(next));
  });

  it('splits across the side that looks longer on screen', () => {
    // 16 by 24 cells, but cells twice as wide as tall: wider than tall on screen.
    const state = build('main', 'a');
    const main = allTiles(state).find((t) => t.component.key === 'main')!;
    const next = addTileAt(state, spec('b'), { x: 1, y: 1 }, 2);
    expect(allTiles(next).find((t) => t.component.key === 'b')).toMatchObject({ x: 0, y: 0, w: main.w / 2, h: main.h });
  });

  it('fills the gap on empty space', () => {
    const state: LayoutState = { ...EMPTY_LAYOUT, manual: true };
    const withMain = { ...state, nodes: [{ kind: 'tile' as const, id: 't', component: spec('main'), x: 0, y: 0, w: 12, h: 24 }] };
    expect(freeRectAt(withMain.nodes, { x: 18, y: 3 })).toEqual({ x: 12, y: 0, w: 12, h: 24 });
    const next = addTileAt(withMain, spec('ham'), { x: 18, y: 3 });
    expect(allTiles(next).find((t) => t.component.key === 'ham')).toMatchObject({ x: 12, y: 0, w: 12, h: 24 });
  });

  it('ignores a component already on screen', () => {
    const state = build('main');
    expect(addTileAt(state, spec('main'), { x: 1, y: 1 })).toBe(state);
  });
});
