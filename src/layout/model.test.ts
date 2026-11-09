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
  focus,
  freeRectAt,
  GRID_COLUMNS,
  GRID_ROWS,
  largestFreeRect,
  removeTile,
  resetLayout,
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

  it('focus makes a node the largest, and reset restores the main feed', () => {
    const s = build('main', 'A', 'B');
    const focused = focus(s, 'B')!;
    const b = findTile(focused, 'B')!.tile;
    expect(area(b)).toBeGreaterThan(area(findTile(focused, 'main')!.tile));
    const reset = resetLayout(focused);
    expect(area(findTile(reset, 'main')!.tile)).toBeGreaterThan(area(findTile(reset, 'B')!.tile));
  });

  it('focus by a member promotes its group', () => {
    const { state } = createGroup(build('main', 'X'), [spec('A'), spec('B')]);
    const focused = focus(state, 'A')!;
    expect(focused.primaryId).toBe(findTile(focused, 'A')!.group!.id);
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

  it('are discarded by a reset', () => {
    let s = build('main', 'A');
    s = applyMouseEdit(s, s.nodes[0].id, { x: 0, y: 0, w: 5, h: 5 });
    s = resetLayout(s);
    expect(s.manual).toBe(false);
    expect(s.nodes[0].w).toBeGreaterThan(5);
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
