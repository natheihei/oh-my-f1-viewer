import { describe, expect, it } from 'vitest';
import {
  addTile,
  addTileAt,
  dropTarget,
  allTiles,
  applyMouseEdit,
  autoLayout,
  EMPTY_LAYOUT,
  freeRectAt,
  groupOf,
  GRID_COLUMNS,
  GRID_ROWS,
  largestFreeRect,
  measure,
  minCells,
  NoRoomError,
  removeTile,
  replaceComponent,
  setMain,
  swap,
  tileWithKey,
  type ComponentSpec,
  type LayoutState,
  type Rect,
} from './model';

/** A video: the picture keeps its shape, which is what makes the first one the main tile. */
const spec = (key: string): ComponentSpec => ({ type: 'video', key, label: key, props: {}, fit: { aspect: 16 / 9 } });
/** The tile showing the component with this key. */
const byKey = (s: LayoutState, key: string) => tileWithKey(s, key)!;
const idOf = (s: LayoutState, key: string) => byKey(s, key).id;
/** Gives the main place to the tile showing `key`. */
const mainTo = (s: LayoutState, key: string) => setMain(s, idOf(s, key));
/** Videos added in order, the first one given the main place, as opening a session does. */
const build = (...keys: string[]) => keys.slice(1).reduce<LayoutState>((s, k) => addTile(s, spec(k)), mainTo(addTile(EMPTY_LAYOUT, spec(keys[0])), keys[0]));

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
const add = (state: LayoutState, ...specs: ComponentSpec[]) => specs.reduce((s, c) => addTile(s, c), state);
/** A measured grid with the main feed on it, in the main place. */
const opened = mainTo(addTile(sized, video('main')), 'main');

describe('auto-layout', () => {
  for (let tiles = 1; tiles <= 12; tiles += 1) {
    it(`places ${tiles} tile(s) without overlap, the first one largest`, () => {
      const s = build(...Array.from({ length: tiles }, (_, i) => `t${i}`));
      expect(s.tiles).toHaveLength(tiles);
      assertNoOverlap(s.tiles);
      for (const n of s.tiles.slice(1)) expect(area(s.tiles[0])).toBeGreaterThanOrEqual(area(n));
    });
  }

  it('fills the grid with one tile, and with the main tile and a rail', () => {
    expect(build('main').tiles[0]).toMatchObject({ x: 0, y: 0, w: GRID_COLUMNS, h: GRID_ROWS });
    const two = build('main', 'side');
    expect(area(two.tiles[0]) + area(two.tiles[1])).toBe(GRID_COLUMNS * GRID_ROWS);
    expect(two.tiles[1].x).toBe(two.tiles[0].w);
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
    const assigned = rects(mainTo(three, 'feed'));
    expect(assigned.feed).toMatchObject({ x: 0, y: 0 });
    for (const other of [assigned.gap, assigned.tower]) expect(assigned.feed.w * assigned.feed.h).toBeGreaterThan(other.w * other.h);
    // A video that wasn't assigned it is laid out by its own size, like any other tile.
    const plain = autoLayout(three);
    expect(plain.main).toBeNull();
    expect(rects(plain).feed).not.toEqual(assigned.feed);
  });

  it('keeps the main place with its tile, and promotes no other when that tile goes', () => {
    const s = add(opened, video('onboard'), tower);
    expect(s.main).toBe(idOf(s, 'main'));
    expect(setMain(s, 'nothing')).toBe(s);
    const gone = removeTile(s, idOf(s, 'main'));
    expect(gone.main).toBeNull();
    expect(rects(gone)).toEqual(rects(autoLayout({ ...gone, main: null })));
    expect(removeTile(s, idOf(s, 'onboard')).main).toBe(idOf(s, 'main'));
  });

  it('takes the main place away with null, and leaves a hand-arranged layout where it is', () => {
    const s = add(opened, chart('gap', 16 / 9, 330, 180));
    const none = setMain(s, null);
    expect(none.main).toBeNull();
    expect(rects(none)).not.toEqual(rects(s));
    const manual = applyMouseEdit(s, s.tiles[1].id, { x: 20, y: 0, w: 4, h: 6 });
    const reassigned = mainTo(manual, 'gap');
    expect(reassigned.main).toBe(idOf(s, 'gap'));
    expect(reassigned.tiles).toBe(manual.tiles);
  });

  it('shares the grid when no tile has the main place, tall ones at the right', () => {
    const four = ['gap', 'tyres', 'laps', 'trace'].map((key) => chart(key, 16 / 9, 400, 220));
    const even = autoLayout(add(sized, ...four));
    assertTilesGrid(even.tiles);
    expect(new Set(even.tiles.map(area)).size).toBe(1);
    const r = rects(autoLayout(add(sized, tower, ...four.slice(0, 2))));
    expect(r.tower).toEqual({ x: 18, y: 0, w: 6, h: 16 });
    expect(r.gap.w * r.gap.h).toBe(r.tyres.w * r.tyres.h);
  });

  it('gives one chart the whole grid, and a video the main place once it is assigned', () => {
    const alone = autoLayout(add(sized, chart('gap', 16 / 9, 330, 180)));
    expect(rects(alone).gap).toEqual({ x: 0, y: 0, w: GRID_COLUMNS, h: GRID_ROWS });
    const r = rects(mainTo(add(alone, video('feed')), 'feed'));
    expect(r.feed).toMatchObject({ x: 0, y: 0 });
    expect(r.feed.w * r.feed.h).toBeGreaterThan(r.gap.w * r.gap.h);
  });

  it('keeps every tile at its least size while there is room, by making the main tile smaller', () => {
    const charts = [tower, chart('gap', 16 / 9, 330, 180), chart('tyres', 16 / 9, 380, 250), chart('laps', 16 / 9, 440, 220)];
    const few = autoLayout(add(opened, ...charts.slice(0, 2)));
    const more = autoLayout(add(opened, ...charts));
    for (const s of [few, more]) {
      assertNoOverlap(s.tiles);
      for (const t of allTiles(s)) {
        const [w, h] = minCells(t.component.size, CELL);
        if (t.component.size) expect(t.w >= w && t.h >= h, `${t.component.key} is ${t.w}x${t.h}, needs ${w}x${h}`).toBe(true);
      }
    }
    expect(area(more.tiles[0])).toBeLessThan(area(few.tiles[0]));
  });

  it('shares the shortfall when nothing fits, with no overlap', () => {
    const many = add(opened, ...Array.from({ length: 10 }, (_, i) => chart(`c${i}`, 16 / 9, 440, 220)));
    assertNoOverlap(many.tiles);
    expect(many.tiles).toHaveLength(11);
  });

  it('spreads a wall of 31 tiles round the main one over more lines, with no overlap and none a sliver', () => {
    // Twenty-two onboards clicked in one by one, then nine charts, as on a replay with the world feed open.
    const onboard = (key: string): ComponentSpec => ({ ...video(key), size: { aspect: 16 / 9, min: { width: 320, height: 180 } } });
    const charts = [
      { ...chart('tower', 0.78, 330, 376), fit: { width: 396, height: 500 } },
      chart('strategy', 1.3, 380, 380),
      chart('deg', 1.3, 380, 400),
      chart('windows', 1.1, 330, 380),
      chart('window', 0.9, 330, 400),
      chart('track', 1.4, 360, 250),
      chart('telemetry', 2, 300, 150),
      chart('pedals', 2.4, 300, 150),
      chart('ribbon', 1.2, 300, 240),
    ];
    const onboards = add(opened, ...Array.from({ length: 22 }, (_, i) => onboard(`onboard${i}`)));
    const wall = add(onboards, ...charts);
    expect(wall.tiles).toHaveLength(32);
    for (const s of [onboards, wall]) {
      assertNoOverlap(s.tiles);
      for (const t of allTiles(s)) expect(t.w >= 3 && t.h >= 3, `${t.component.key} is ${t.w}x${t.h}`).toBe(true);
    }
    // The main tile keeps its place, at the size the others leave it.
    expect(byKey(wall, 'main')).toMatchObject({ x: 0, y: 0 });
    expect(area(byKey(wall, 'main'))).toBeGreaterThanOrEqual(64);
  });
});

describe('a full grid', () => {
  const onboard = (key: string): ComponentSpec => ({ ...video(key), size: { aspect: 16 / 9, min: { width: 320, height: 180 } } });
  /** Adds onboards till one is refused. Returns the last layout that took one, and the error. */
  const fill = (start: LayoutState) => {
    let s = start;
    for (let i = 0; i < 200; i += 1) {
      try {
        s = addTile(s, onboard(`onboard${i}`));
      } catch (error) {
        return { full: s, error };
      }
    }
    throw new Error('Never refused a tile');
  };

  it('refuses a tile that would leave some too small, and keeps every tile at least 3 cells either way', () => {
    const { full, error } = fill(opened);
    expect(error).toBeInstanceOf(NoRoomError);
    expect((error as Error).message).toMatch(/^No room for onboard\d+/);
    expect(full.tiles.length).toBeGreaterThan(32);
    assertNoOverlap(full.tiles);
    for (const t of allTiles(full)) expect(t.w >= 3 && t.h >= 3, `${t.component.key} is ${t.w}x${t.h}`).toBe(true);
    // The main tile keeps its place to the end.
    expect(byKey(full, 'main')).toMatchObject({ x: 0, y: 0 });
  });

  it('refuses one in a hand-arranged layout too, and leaves it as arranged', () => {
    const { full } = fill(opened);
    const arranged = swap(full, idOf(full, 'onboard0'), idOf(full, 'onboard1'));
    expect(() => addTile(arranged, onboard('one more'))).toThrow(NoRoomError);
    // A component already on screen is still no error: it adds nothing.
    expect(addTile(arranged, onboard('onboard0'))).toBe(arranged);
  });

  it('never splits a tile on a drop into halves under 3 cells', () => {
    // A 5 by 5 tile would split into halves 2 and 3 wide; a 6 by 5 one into two 3 wide.
    const small = applyMouseEdit(opened, idOf(opened, 'main'), { x: 0, y: 0, w: 5, h: 5 });
    expect(dropTarget(small, { x: 1, y: 1 }, 1)).toBeNull();
    const six = applyMouseEdit(opened, idOf(opened, 'main'), { x: 0, y: 0, w: 6, h: 5 });
    expect(dropTarget(six, { x: 4, y: 1 }, 1)?.room).toEqual({ x: 3, y: 0, w: 3, h: 5 });
    // Nor does it fill a gap under 3 cells.
    const strip = applyMouseEdit(opened, idOf(opened, 'main'), { x: 0, y: 0, w: 24, h: 22 });
    expect(dropTarget(strip, { x: 1, y: 23 }, 1)).toBeNull();
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

  it('re-tiles an auto layout when a tile is added, even when a gap would fit it', () => {
    const card = addTile(withTower, chart('card', 1.6, 300, 150));
    expect(rects(card)).toEqual(rects(autoLayout(card)));
    expect(card.manual).toBe(false);
    assertNoOverlap(card.tiles);
  });

  it('gives a new tile at least its least size', () => {
    const next = addTile(withTower, chart('big', 16 / 9, 600, 300));
    const [w, h] = minCells(next.tiles[2].component.size, CELL);
    const r = rects(next);
    expect(r.big.w >= w && r.big.h >= h).toBe(true);
    assertNoOverlap(next.tiles);
  });

  it('leaves tiles alone on a resize that changes nothing re-tiling would do', () => {
    const next = measure(withTower, { w: CELL.w, h: CELL.h - 0.05 });
    expect(next.tiles).toBe(withTower.tiles);
    expect(next.cell).toEqual({ w: CELL.w, h: CELL.h - 0.05 });
  });

  it('re-tiles on a resize that does', () => {
    const narrow = measure(withTower, { w: 40, h: 40 });
    expect(rects(narrow)).not.toEqual(rects(withTower));
    assertNoOverlap(narrow.tiles);
  });

  it('leaves a hand-arranged layout alone on a resize', () => {
    const manual = applyMouseEdit(withTower, withTower.tiles[1].id, { x: 14, y: 0, w: 10, h: 24 });
    expect(measure(manual, { w: 50, h: 40 }).tiles).toBe(manual.tiles);
  });
});

describe('the session journey', () => {
  it('starts with the main broadcast filling the screen', () => {
    const s = build('main');
    expect(s.tiles[0]).toMatchObject({ x: 0, y: 0, w: GRID_COLUMNS, h: GRID_ROWS });
  });
});

describe('tile identity', () => {
  it('survives re-tiling', () => {
    const s = build('main', 'A', 'B');
    expect(autoLayout(s).tiles.map((n) => n.id).sort()).toEqual(s.tiles.map((n) => n.id).sort());
  });

  it('survives new props, which change its key, and keeps the main place', () => {
    const s = build('main', 'A');
    const id = idOf(s, 'main');
    const next = replaceComponent(s, id, spec('other'))!;
    expect(byKey(next, 'other').id).toBe(id);
    expect(tileWithKey(next, 'main')).toBeNull();
    expect(next.main).toBe(id);
    expect(replaceComponent(s, 'nothing', spec('other'))).toBeNull();
  });

  it('survives a move, a resize and a swap', () => {
    const s = build('main', 'A');
    const [main, a] = [idOf(s, 'main'), idOf(s, 'A')];
    const moved = swap(applyMouseEdit(s, a, { x: 0, y: 0, w: 4, h: 4 }), main, a);
    expect([idOf(moved, 'main'), idOf(moved, 'A')]).toEqual([main, a]);
  });

  it('is new for a component added again after its tile was closed', () => {
    const s = build('main', 'A');
    const before = idOf(s, 'A');
    const again = addTile(removeTile(s, before), spec('A'));
    expect(idOf(again, 'A')).not.toBe(before);
    expect(new Set(again.tiles.map((t) => t.id)).size).toBe(again.tiles.length);
  });
});

describe('groups', () => {
  it('keeps the tiles of a group together in an auto layout, and a tile its group through new props', () => {
    // Two onboards and a chart for each, clicked in turn about, round the main feed and a tower.
    const wide = (key: string) => chart(key, 2.4, 300, 150);
    const adds: [ComponentSpec, string?][] = [[tower], [video('a1'), 'a'], [video('b1'), 'b'], [wide('a2'), 'a'], [wide('b2'), 'b']];
    const s = adds.reduce((state, [component, group]) => addTile(state, component, group), opened);
    assertNoOverlap(allTiles(s));
    const touch = (a: Rect, b: Rect) => {
      const across = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const down = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      return (across === 0 && down > 0) || (down === 0 && across > 0);
    };
    expect(touch(byKey(s, 'a1'), byKey(s, 'a2')), JSON.stringify(rects(s))).toBe(true);
    expect(touch(byKey(s, 'b1'), byKey(s, 'b2')), JSON.stringify(rects(s))).toBe(true);
    const renamed = replaceComponent(s, idOf(s, 'a1'), video('a3'))!;
    expect(byKey(renamed, 'a3').group).toBe('a');
    expect(byKey(s, 'tower').group).toBeUndefined();
  });
});

describe('what a tile belongs with', () => {
  const about = (key: string, driver: number): ComponentSpec => ({ ...video(key), title: { name: '', drivers: [driver] } });
  const pair: ComponentSpec = { ...chart('gap', 2, 300, 150), title: { name: 'Gap', drivers: [4, 1] } };

  it('is the tiles about its driver when there are others, and failing that its batch', () => {
    // A battle suggested as one batch: two onboards and the gap between them.
    let s = [about('NOR', 4), about('VER', 1), pair].reduce((state, c) => addTile(state, c, 'batch-1'), opened);
    expect(groupOf(s.tiles)).toEqual([undefined, 'batch-1', 'batch-1', 'batch-1']);
    // Then a chart about one of them, however it got on screen: it and that onboard go together.
    s = addTile(s, { ...chart('telemetry', 1.6, 300, 150), title: { name: 'Telemetry', drivers: [4] } });
    expect(groupOf(s.tiles)).toEqual([undefined, 'driver-4', 'batch-1', 'batch-1', 'driver-4']);
  });

  it('is the tiles following its place, apart from the car that holds it now', () => {
    const following = (key: string, place: `P${number}`): ComponentSpec => ({ ...video(key), title: { name: '', drivers: [place] } });
    // P1's onboard and P1's telemetry go together; VER's onboard isn't with them, even while VER leads.
    const s = [following('P1', 'P1'), about('VER', 1), { ...chart('telemetry', 1.6, 300, 150), title: { name: 'Telemetry', drivers: ['P1' as const] } }].reduce(
      (state, c) => addTile(state, c),
      opened,
    );
    expect(groupOf(s.tiles)).toEqual([undefined, 'driver-P1', undefined, 'driver-P1']);
  });

  it('puts a tile about a driver beside that driver\'s other tile, in a hand-arranged layout too', () => {
    let s = addTile(addTile(sized, about('NOR', 4)), video('B'));
    s = applyMouseEdit(s, idOf(s, 'NOR'), { x: 0, y: 0, w: 6, h: 6 });
    s = applyMouseEdit(s, idOf(s, 'B'), { x: 6, y: 0, w: 6, h: 24 });
    expect(byKey(addTile(s, about('VER', 1)), 'VER')).toMatchObject({ x: 12, y: 0 });
    expect(byKey(addTile(s, about('NOR again', 4)), 'NOR again')).toMatchObject({ x: 0, y: 6 });
  });

  it('names the group that has gone longest without a new tile when there is no room', () => {
    let s = addTile(addTile(opened, about('NOR', 4)), about('NOR pedals', 4));
    s = addTile(addTile(s, about('VER', 1)), about('VER pedals', 1));
    // A wall of tiles, put there directly: the grid has no room for one more.
    const wall = Array.from({ length: 70 }, (_, n) => ({ id: `wall-${n}`, component: video(`onboard${n}`), x: 0, y: 0, w: 1, h: 1 }));
    const full = { ...s, tiles: [...s.tiles, ...wall] };
    expect(() => addTile(full, video('one more'))).toThrow(/Close a tile to make room\. NOR, NOR pedals have been up longest\.$/);
    expect(() => addTile(full, video('one more'))).toThrow(NoRoomError);
  });
});

describe('editing', () => {
  it('ignores adding the same component twice', () => {
    const s = build('main', 'A');
    expect(addTile(s, spec('A'))).toBe(s);
  });

  it('removes a tile by its id, and nothing for one that is not on screen', () => {
    const s = build('main', 'A');
    expect(removeTile(s, 'A')).toBe(s);
    expect(allTiles(removeTile(s, idOf(s, 'A'))).map((t) => t.component.key)).toEqual(['main']);
  });
});

describe('mouse edits', () => {
  it('stay put when a tile is added, using free space', () => {
    let s = build('main');
    s = applyMouseEdit(s, s.tiles[0].id, { x: 0, y: 0, w: 12, h: 24 });
    expect(s.manual).toBe(true);
    s = addTile(s, spec('A'));
    expect(s.tiles[0]).toMatchObject({ w: 12, h: 24 });
    expect(byKey(s, 'A')).toMatchObject({ x: 12, y: 0, w: 12, h: 24 });
  });

  it('give way to a re-tile when there is no room left', () => {
    let s = build('main');
    s = applyMouseEdit(s, s.tiles[0].id, { x: 0, y: 0, w: 24, h: 23 });
    s = addTile(s, spec('A'));
    expect(s.manual).toBe(false);
    expect(area(byKey(s, 'A'))).toBeGreaterThan(36);
  });

  it('are discarded by an auto layout, which puts tiles back in the order they were added', () => {
    let s = build('main', 'A');
    s = applyMouseEdit(s, s.tiles[0].id, { x: 0, y: 0, w: 5, h: 5 });
    s = swap(s, s.tiles[0].id, s.tiles[1].id);
    s = autoLayout(s);
    expect(s.manual).toBe(false);
    expect(s.tiles[0].w).toBeGreaterThan(5);
    expect(area(byKey(s, 'main'))).toBeGreaterThan(area(byKey(s, 'A')));
  });

  it('put a new tile in the gap beside a tile of its group, when one is big enough', () => {
    let s = addTile(addTile(sized, video('A'), 'batch'), video('B'));
    s = applyMouseEdit(s, idOf(s, 'A'), { x: 0, y: 0, w: 6, h: 6 });
    s = applyMouseEdit(s, idOf(s, 'B'), { x: 6, y: 0, w: 6, h: 24 });
    // The biggest gap is right of B. The one under A is smaller, and beside A.
    expect(byKey(addTile(s, video('C')), 'C')).toMatchObject({ x: 12, y: 0 });
    expect(byKey(addTile(s, video('C'), 'other'), 'C')).toMatchObject({ x: 12, y: 0 });
    const next = addTile(s, video('C'), 'batch');
    expect(byKey(next, 'C')).toMatchObject({ x: 0, y: 6, group: 'batch' });
    expect(next.manual).toBe(true);
    assertNoOverlap(allTiles(next));
  });

  it('do not count as an edit when nothing moved', () => {
    const s = build('main');
    const { x, y, w, h } = s.tiles[0];
    expect(applyMouseEdit(s, s.tiles[0].id, { x, y, w, h })).toBe(s);
  });
});

describe('swap', () => {
  it('exchanges two tiles and marks the layout as manual', () => {
    const s = build('main', 'A');
    const [main, a] = s.tiles;
    const swapped = swap(s, main.id, a.id);
    expect(byKey(swapped, 'main')).toMatchObject({ x: a.x, w: a.w });
    expect(byKey(swapped, 'A')).toMatchObject({ x: main.x, w: main.w });
    expect(swapped.manual).toBe(true);
    expect(byKey(swapped, 'main').id).toBe(main.id);
  });

  it('does nothing for an id that is not on screen', () => {
    const s = build('main', 'A');
    expect(swap(s, s.tiles[0].id, 'nothing')).toBe(s);
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
    const withMain = { ...state, tiles: [{ id: 't', component: spec('main'), x: 0, y: 0, w: 12, h: 24 }] };
    expect(freeRectAt(withMain.tiles, { x: 18, y: 3 })).toEqual({ x: 12, y: 0, w: 12, h: 24 });
    const next = addTileAt(withMain, spec('ham'), { x: 18, y: 3 });
    expect(allTiles(next).find((t) => t.component.key === 'ham')).toMatchObject({ x: 12, y: 0, w: 12, h: 24 });
  });

  it("takes only what its content uses of the room, keeping the corner, and the split tile keeps its half", () => {
    const cell = { w: 100, h: 50 };
    const state: LayoutState = { ...EMPTY_LAYOUT, cell, manual: true, tiles: [{ id: 't', component: spec('main'), x: 0, y: 0, w: 24, h: 24 }] };
    const chart: ComponentSpec = { type: 'chart', key: 'gap', label: 'Gap', props: {}, fit: { width: 640, height: 340 } };
    const target = dropTarget(state, { x: 18, y: 3 }, cell.w / cell.h, chart)!;
    expect(target.room).toEqual({ x: 12, y: 0, w: 12, h: 24 });
    expect(target.rect).toEqual({ x: 12, y: 0, w: 7, h: 8 });
    const next = addTileAt(state, chart, { x: 18, y: 3 }, cell.w / cell.h);
    expect(byKey(next, 'gap')).toMatchObject(target.rect);
    expect(byKey(next, 'main')).toMatchObject({ x: 0, y: 0, w: 12, h: 24 });
  });

  it('ignores a component already on screen', () => {
    const state = build('main');
    expect(addTileAt(state, spec('main'), { x: 1, y: 1 })).toBe(state);
  });
});
