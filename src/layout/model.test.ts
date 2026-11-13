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
  minCells,
  removeTile,
  setMain,
  swap,
  ungroup,
  type ComponentSpec,
  type LayoutState,
  type Rect,
} from './model';

/** A video: the picture keeps its shape, which is what makes the first one the main tile. */
const spec = (key: string): ComponentSpec => ({ type: 'video', key, label: key, props: {}, fit: { aspect: 16 / 9 } });
/** Videos added in order, the first one given the main place, as opening a session does. */
const build = (...keys: string[]) => keys.slice(1).reduce<LayoutState>((s, k) => addTile(s, spec(k)), setMain(addTile(EMPTY_LAYOUT, spec(keys[0])), keys[0]));

function area(r: Rect): number {
  return r.w * r.h;
}

/** Every grid cell is covered exactly once. */
function assertTilesGrid(rects: Rect[]): void {
  assertNoOverlap(rects);
  expect(rects.reduce((sum, r) => sum + area(r), 0)).toBe(GRID_COLUMNS * GRID_ROWS);
}

/** No two rectangles share a cell, and none leaves the grid. */
function assertNoOverlap(rects: Rect[]): void {
  const seen = new Set<string>();
  for (const r of rects) {
    expect(r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 && r.x + r.w <= GRID_COLUMNS && r.y + r.h <= GRID_ROWS, `outside the grid: ${JSON.stringify(r)}`).toBe(true);
    for (let y = r.y; y < r.y + r.h; y += 1) {
      for (let x = r.x; x < r.x + r.w; x += 1) {
        const cell = `${x},${y}`;
        expect(seen.has(cell), `overlap at ${cell}`).toBe(false);
        seen.add(cell);
      }
    }
  }
}

/** 1600 by 816, so a cell is about 66.7 by 34. */
const CELL = { w: 1600 / 24, h: 34 };
const sized = measure(EMPTY_LAYOUT, CELL);
const video = spec;
const chart = (key: string, aspect: number, width: number, height: number): ComponentSpec => ({ type: 'chart', key, label: key, props: {}, size: { aspect, min: { width, height } } });
/** At most 396 by 500 pixels: 6 columns and 16 rows with the title bar. */
const tower: ComponentSpec = { ...chart('tower', 0.75, 330, 376), fit: { width: 396, height: 500 } };
const rects = (s: LayoutState) => Object.fromEntries(allTiles(s).map((t) => [t.component.key, { x: t.x, y: t.y, w: t.w, h: t.h }]));
const add = (state: LayoutState, ...specs: ComponentSpec[]) => specs.reduce(addTile, state);
/** A measured grid with the main feed on it, in the main place. */
const opened = setMain(addTile(sized, video('main')), 'main');

describe('auto-layout', () => {
  for (let tiles = 1; tiles <= 12; tiles += 1) {
    it(`places ${tiles} tile(s) without overlap, the first one largest`, () => {
      const s = build(...Array.from({ length: tiles }, (_, i) => `t${i}`));
      expect(s.nodes).toHaveLength(tiles);
      assertNoOverlap(s.nodes);
      for (const n of s.nodes.slice(1)) expect(area(s.nodes[0])).toBeGreaterThanOrEqual(area(n));
    });
  }

  it('fills the grid with one tile, and with the main tile and a rail', () => {
    expect(build('main').nodes[0]).toMatchObject({ x: 0, y: 0, w: GRID_COLUMNS, h: GRID_ROWS });
    const two = build('main', 'side');
    expect(area(two.nodes[0]) + area(two.nodes[1])).toBe(GRID_COLUMNS * GRID_ROWS);
    expect(two.nodes[1].x).toBe(two.nodes[0].w);
  });

  it('puts a tall tile beside the main one and a wide one below it, whatever order they were added in', () => {
    // Too wide for the rail the tower sits in.
    const wide = chart('wide', 4, 700, 150);
    for (const order of [[tower, wide], [wide, tower]]) {
      const r = rects(autoLayout(add(opened, ...order)));
      expect(r.tower.x).toBeGreaterThanOrEqual(r.main.w);
      expect(r.tower.y).toBe(0);
      expect(r.wide.y).toBeGreaterThanOrEqual(r.main.h);
      expect(r.wide.x).toBe(0);
    }
  });

  it('gives the main place only to the tile it is assigned to, whatever was added first', () => {
    const three = add(sized, tower, chart('gap', 16 / 9, 330, 180), video('feed'));
    const assigned = rects(setMain(three, 'feed'));
    expect(assigned.feed).toMatchObject({ x: 0, y: 0 });
    for (const other of [assigned.gap, assigned.tower]) expect(assigned.feed.w * assigned.feed.h).toBeGreaterThan(other.w * other.h);
    // A video that wasn't assigned it is laid out by its own size, like any other tile.
    const plain = autoLayout(three);
    expect(plain.main).toBeNull();
    expect(rects(plain).feed).not.toEqual(assigned.feed);
  });

  it('keeps the main place with its tile, and promotes no other when that tile goes', () => {
    const s = add(opened, video('onboard'), tower);
    expect(s.main).toBe('main');
    expect(setMain(s, 'nothing')).toBe(s);
    const gone = removeTile(s, 'main');
    expect(gone.main).toBeNull();
    expect(rects(gone)).toEqual(rects(autoLayout({ ...gone, main: null })));
    expect(removeTile(s, 'onboard').main).toBe('main');
  });

  it('takes the main place away with null, and leaves a hand-arranged layout where it is', () => {
    const s = add(opened, chart('gap', 16 / 9, 330, 180));
    const none = setMain(s, null);
    expect(none.main).toBeNull();
    expect(rects(none)).not.toEqual(rects(s));
    const manual = applyMouseEdit(s, s.nodes[1].id, { x: 20, y: 0, w: 4, h: 6 });
    const reassigned = setMain(manual, 'gap');
    expect(reassigned.main).toBe('gap');
    expect(reassigned.nodes).toBe(manual.nodes);
  });

  it('shares the grid when no tile has the main place, tall ones at the right', () => {
    const four = ['gap', 'tyres', 'laps', 'trace'].map((key) => chart(key, 16 / 9, 400, 220));
    const even = autoLayout(add(sized, ...four));
    assertTilesGrid(even.nodes);
    expect(new Set(even.nodes.map(area)).size).toBe(1);
    const r = rects(autoLayout(add(sized, tower, ...four.slice(0, 2))));
    expect(r.tower).toEqual({ x: 18, y: 0, w: 6, h: 16 });
    expect(r.gap.w * r.gap.h).toBe(r.tyres.w * r.tyres.h);
  });

  it('gives one chart the whole grid, and a video the main place once it is assigned', () => {
    const alone = autoLayout(add(sized, chart('gap', 16 / 9, 330, 180)));
    expect(rects(alone).gap).toEqual({ x: 0, y: 0, w: GRID_COLUMNS, h: GRID_ROWS });
    const r = rects(setMain(add(alone, video('feed')), 'feed'));
    expect(r.feed).toMatchObject({ x: 0, y: 0 });
    expect(r.feed.w * r.feed.h).toBeGreaterThan(r.gap.w * r.gap.h);
  });

  it('keeps every tile at its least size while there is room, by making the main tile smaller', () => {
    const charts = [tower, chart('gap', 16 / 9, 330, 180), chart('tyres', 16 / 9, 380, 250), chart('laps', 16 / 9, 440, 220)];
    const few = autoLayout(add(opened, ...charts.slice(0, 2)));
    const more = autoLayout(add(opened, ...charts));
    for (const s of [few, more]) {
      assertNoOverlap(s.nodes);
      for (const t of allTiles(s)) {
        const [w, h] = minCells(t.component.size, CELL);
        if (t.component.size) expect(t.w >= w && t.h >= h, `${t.component.key} is ${t.w}x${t.h}, needs ${w}x${h}`).toBe(true);
      }
    }
    expect(area(more.nodes[0])).toBeLessThan(area(few.nodes[0]));
  });

  it('shares the shortfall when nothing fits, with no overlap', () => {
    const many = add(opened, ...Array.from({ length: 10 }, (_, i) => chart(`c${i}`, 16 / 9, 440, 220)));
    assertNoOverlap(many.nodes);
    expect(many.nodes).toHaveLength(11);
  });

  it('gives a group room for its members side by side', () => {
    const { state } = createGroup(opened, [video('a'), video('b')]);
    const group = state.nodes[1];
    expect(group.w * CELL.w).toBeGreaterThanOrEqual(640);
  });
});

describe('least sizes', () => {
  it('are whole cells that hold the content and the title bar', () => {
    expect(minCells({ aspect: 1, min: { width: 330, height: 376 } }, CELL)).toEqual([5, 12]);
    expect(minCells({ aspect: 1, min: { width: 0, height: 0 } }, CELL)).toEqual([1, 1]);
    expect(minCells(undefined, CELL)).toEqual([1, 1]);
  });

  it('use a 16:9 window before the grid is measured', () => {
    expect(minCells({ aspect: 1, min: { width: 330, height: 376 } }, { w: 0, h: 0 })).toEqual([5, 11]);
  });
});

describe('fitting content', () => {
  const withTower = add(opened, tower);

  it('shrinks the video to its picture and the tower to its content', () => {
    const r = rects(withTower);
    expect(r.tower).toEqual({ x: 18, y: 0, w: 6, h: 16 });
    expect(r.main).toMatchObject({ x: 0, y: 0, w: 18 });
    // 18 columns are 1200 pixels, so the picture is 675 high, and with the title bar that is 21 rows.
    expect(r.main.h).toBe(21);
  });

  it('narrows a video that is limited by height instead', () => {
    expect(rects(addTile(measure(EMPTY_LAYOUT, { w: 100, h: 40 }), video('main'))).main).toEqual({ x: 0, y: 0, w: 17, h: 24 });
  });

  it('fits nothing before the grid is measured', () => {
    const r = rects(add(EMPTY_LAYOUT, video('main'), tower));
    expect(r.main.h).toBe(GRID_ROWS);
    expect(r.tower.h).toBe(GRID_ROWS);
    expect(r.main.w + r.tower.w).toBe(GRID_COLUMNS);
  });

  it('puts a new tile into the gap closest to its shape, and moves nothing else', () => {
    const card = addTile(withTower, chart('card', 1.6, 300, 150));
    expect(rects(card)).toEqual({ ...rects(withTower), card: { x: 18, y: 16, w: 6, h: 8 } });
    expect(card.manual).toBe(false);
  });

  it('re-tiles when no gap is big enough', () => {
    const next = addTile(withTower, chart('big', 16 / 9, 600, 300));
    const r = rects(next);
    expect(r.main).not.toEqual(rects(withTower).main);
    const [w, h] = minCells(next.nodes[2].kind === 'tile' ? next.nodes[2].component.size : undefined, CELL);
    expect(r.big.w >= w && r.big.h >= h).toBe(true);
    assertNoOverlap(next.nodes);
  });

  it('never puts a video into a gap', () => {
    const next = addTile(withTower, video('onboard'));
    expect(rects(next)).toEqual(rects(autoLayout(next)));
    assertNoOverlap(next.nodes);
  });

  it('leaves tiles alone on a resize that changes nothing re-tiling would do', () => {
    const next = measure(withTower, { w: CELL.w, h: CELL.h - 0.05 });
    expect(next.nodes).toBe(withTower.nodes);
    expect(next.cell).toEqual({ w: CELL.w, h: CELL.h - 0.05 });
  });

  it('re-tiles on a resize that does', () => {
    const narrow = measure(withTower, { w: 40, h: 40 });
    expect(rects(narrow)).not.toEqual(rects(withTower));
    assertNoOverlap(narrow.nodes);
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
    let s = build('main', 'HAM');
    const { state } = createGroup(s, [video('NOR'), video('LEC')]);
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
