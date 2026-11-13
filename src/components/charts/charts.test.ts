import { describe, expect, it, vi } from 'vitest';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { gapModel } = await import('./GapEvolution');
const { tyreModel, tyreExtent } = await import('./TyreStrategy');
const { towerModel, towerExtent } = await import('./TimingTower');
const { paceModel } = await import('./FieldPace');
const { pitWindowModel, pitWindowExtent, CLEAR_AIR, LEAST: PIT_WINDOW_LEAST } = await import('./PitWindow');
const { pitWindowsModel, lossNow } = await import('./PitWindows');
const { sectorTable } = await import('./SectorTable');
const { stopsModel } = await import('./PitStops');
const { messagesModel, signalOf, markOf, lineText } = await import('./RaceControl');
const { sentenceCase, shorten, stageLabel, standing } = await import('./raceControlMessages');
type Line = import('./RaceControl').Line;
const { boardModel, drawBoard, KEEP_DECIDED } = await import('./RaceStatus');
const { trackModel, placeLabels } = await import('./TrackMap');
const { telemetryModel, chaseOf, corners, traceSeconds } = await import('./CarTelemetry');
const { lapsOf, pastParams, pedalModel, pedalOf, throttleShade, lapDelta } = await import('./PedalBarcode');
const { cornerSpeeds, ribbonModel, ribbonWidth, windowSeconds } = await import('./SpeedRibbon');
const { components } = await import('../registry');
const { addTile, allTiles, autoLayout, EMPTY_LAYOUT, measure, minCells } = await import('../../layout/model');
type ComponentSpec = import('../../layout/model').ComponentSpec;
type LayoutState = import('../../layout/model').LayoutState;

const lap = (n: number, date: number): Record<string, unknown> => ({ kind: 'lap', n, date, gap: null });
const gap = (driver: number, date: number, value: unknown) => ({ kind: 'gap', n: driver, date, gap: value });
const end = (driver: number, n: number, value: unknown, stint: number | null = 1) => ({ kind: 'end', n: driver, date: (n + 1) * 100, gap: value, lap: n, stint });

describe('gap_evolution', () => {
  it("sets each driver's tyre and last lap beside the gap", () => {
    const rows = [
      lap(10, 0),
      { ...end(44, 10, null), lap_duration: 90.5, compound: 'MEDIUM', tyre_age: 12 },
      { ...end(44, 11, null), date: null, lap_duration: null, compound: 'MEDIUM', tyre_age: 13 },
      { ...end(1, 10, 1.2), lap_duration: 90.1, compound: 'HARD', tyre_age: 3 },
    ];
    const m = gapModel(rows, [44, 1]);
    // The lap in progress isn't counted in the age, as in the timing tower.
    expect(m.sides).toEqual([
      { driver: 44, compound: 'MEDIUM', age: 12, last: 90.5 },
      { driver: 1, compound: 'HARD', age: 3, last: 90.1 },
    ]);
  });

  it('follows the difference of the two gaps to the leader, sample by sample', () => {
    const rows = [
      lap(10, 0),
      gap(44, 10_000, 5.0),
      gap(1, 12_000, 6.2),
      gap(44, 50_000, 5.1),
      lap(11, 100_000),
      gap(1, 150_000, 5.9),
    ];
    const m = gapModel(rows, [44, 1]);
    expect(m.points).toEqual([
      { x: 10.12, gap: expect.closeTo(1.2) },
      { x: 10.5, gap: expect.closeTo(1.1) },
      { x: 11.5, gap: expect.closeTo(0.8) },
    ]);
    expect(m.from).toBe(10);
    expect(m.to).toBe(11.5);
    expect(m.current).toBeCloseTo(0.8);
  });

  it('takes out spikes several samples long when the leader changes, but keeps a pit stop', () => {
    const rows: Array<Record<string, unknown>> = [lap(1, 0), gap(44, 0, 0)];
    const run = (n: number, g: number) => Array<number>(n).fill(g);
    // A one-sample spike, a five-sample one, then a stop that lasts a lap and ends.
    const b = [...run(12, 2), 25, ...run(10, 2.3), ...run(5, 30), ...run(12, 2.5), ...run(20, 22), ...run(12, 2.6)];
    b.forEach((g, i) => rows.push(gap(1, i * 1000 + 1, g)));
    const gaps = gapModel(rows, [44, 1]).points.map((p) => p?.gap);
    expect(gaps[12]).toBeLessThan(3);
    expect(gaps.slice(23, 28).every((g) => g! < 3)).toBe(true);
    expect(gaps.filter((g) => g === 22)).toHaveLength(20);
    expect(gaps.slice(-12)).toEqual(run(12, 2.6));
  });

  it('keeps the gap at each crossing of the line, the stops and the passes', () => {
    // 1 closes on 44 and passes during lap 3; 44 stops at the end of lap 4.
    const rows: Array<Record<string, unknown>> = [];
    for (let n = 1; n <= 6; n++) rows.push(lap(n, n * 100));
    rows.push(gap(44, 100, 0));
    [0.4, 0.35, 0.3, 0.25, 0.2, 0.1, 0.05, -0.1, -0.2, -0.3].forEach((g, i) => rows.push(gap(1, 100 + i * 25, g)));
    for (let n = 1; n <= 5; n++) rows.push(end(44, n, 0, n >= 5 ? 2 : 1), end(1, n, n === 1 ? 1.3 : -0.5, 1));
    const m = gapModel(rows, [44, 1]);
    expect(m.lapGaps.map((g) => g.lap)).toEqual([1, 2, 3, 4, 5]);
    // Read off the trace where it has a sample at the line.
    expect(m.lapGaps[0].gap).toBeCloseTo(0.2);
    expect(m.lapGaps[4].stints).toEqual([2, 1]);
    expect(m.pits).toEqual([{ driver: 44, lap: 5 }]);
    expect(m.passes).toEqual([{ x: expect.closeTo(2.5, 1), ahead: 1 }]);
  });

  it('counts the leader as no gap', () => {
    const m = gapModel([lap(1, 0), gap(1, 1000, null), gap(44, 2000, 2.5)], [1, 44]);
    expect(m.current).toBeCloseTo(2.5);
  });

  it('breaks the line while a car is lapped, and has no current value then', () => {
    const rows = [lap(1, 0), gap(44, 1000, 80), gap(1, 2000, 79), gap(1, 3000, '+1 LAP'), gap(1, 4000, 81)];
    expect(gapModel(rows, [44, 1]).points).toEqual([{ x: expect.any(Number), gap: -1 }, null, { x: expect.any(Number), gap: 1 }]);
    const now = gapModel(rows.slice(0, 4), [44, 1]);
    expect(now.points.every((p) => p === null || Number.isFinite(p.gap))).toBe(true);
    expect(now.current).toBeNull();
  });

  it('gives the trend over the last three laps, from the gaps as both crossed the line', () => {
    const rows = [lap(1, 0), lap(2, 100), lap(3, 200), lap(4, 300), lap(5, 400)];
    rows.push(gap(44, 0, 0), gap(1, 0, 3), gap(1, 400, 1.5));
    [3, 2.6, 2.2, 1.8].forEach((g, i) => rows.push(end(44, i + 1, 0), end(1, i + 1, g)));
    const m = gapModel(rows, [44, 1]);
    expect(m.trend).toBeCloseTo(-0.4);
  });

  it("isn't swung by a pit-stop spike three laps back", () => {
    // 1 runs 4s behind 44, closing 0.5 a lap. 44 stops at the end of lap 17 and 1 a lap later, so
    // through lap 18 the gap is a pit stop, about 17s the other way. Lap 21 is in progress.
    const rows: Array<Record<string, unknown>> = [];
    for (let n = 14; n <= 21; n++) rows.push(lap(n, n * 100));
    const behind = (t: number) => 4 - 0.005 * (t - 1400);
    for (let t = 1400; t <= 2150; t += 10) rows.push(gap(44, t, 10 + (t >= 1800 ? 21 : 0)), gap(1, t, 10 + behind(t) + (t >= 1900 ? 21 : 0)));
    // At the line: the stop shows in the gap from the end of the out-lap, with the new stint.
    const ends = (n: number) => {
      const [s44, s1] = [n >= 18 ? 2 : 1, n >= 19 ? 2 : 1];
      return [end(44, n, 10 + (s44 - 1) * 21, s44), end(1, n, 10 + behind((n + 1) * 100) + (s1 - 1) * 21, s1)];
    };
    for (let n = 14; n <= 20; n++) rows.push(...ends(n));
    const m = gapModel(rows, [44, 1]);
    // The raw sample three laps back, at 18.5, is on the stop.
    expect(m.points.some((p) => p && p.x > 18 && p.x < 19 && Math.abs(p.gap) > 10)).toBe(true);
    // From the end of lap 17 to the end of lap 20: closing 0.5 a lap.
    expect(m.trend).toBeCloseTo(-0.5);
    // A lap later the line three back is lap 18's, where 44 had stopped and 1 not yet: no trend.
    expect(gapModel([...rows, lap(22, 2200), ...ends(21)], [44, 1]).trend).toBeNull();
  });

  it('is empty before the first lap', () => {
    expect(gapModel([gap(44, 1000, 1), gap(1, 1000, 2)], [44, 1]).points).toEqual([]);
  });
});

const stint = (driver: number, n: number, start: number, end: number | null, compound: string, age = 0, position: number | null = 1) => ({
  driver_number: driver,
  stint_number: n,
  lap_start: start,
  lap_end: end,
  compound,
  tyre_age_at_start: age,
  position,
});

describe('tyre_strategy', () => {
  it('makes one row per driver in the order given, with the last stint open and aged', () => {
    const m = tyreModel([
      stint(1, 1, 1, 16, 'MEDIUM', 0, 1),
      stint(1, 2, 17, 31, 'HARD', 0, 1),
      stint(44, 1, 1, 31, 'HARD', 3, 2),
    ]);
    expect(m.lap).toBe(31);
    expect(m.rows).toEqual([
      {
        driver: 1,
        position: 1,
        out: false,
        stints: [
          { from: 0, to: 16, compound: 'MEDIUM', age: 16, open: false },
          { from: 16, to: 31, compound: 'HARD', age: 15, open: true },
        ],
      },
      { driver: 44, position: 2, out: false, stints: [{ from: 0, to: 31, compound: 'HARD', age: 34, open: true }] },
    ]);
  });

  it('copes with a stint that has no end yet', () => {
    expect(tyreModel([stint(1, 1, 1, null, 'SOFT')]).rows[0].stints[0]).toMatchObject({ from: 0, to: 1, open: true });
  });

  it('marks a car that is out', () => {
    expect(tyreModel([{ ...stint(18, 1, 1, 9, 'SOFT', 0, 21), is_out: 1 }]).rows[0].out).toBe(true);
  });

  describe('extent', () => {
    const tyres = components.find((c) => c.name === 'tyre_strategy')!;
    const grid = (laps: number, total: number | null = 71) => ({
      ...tyreModel(Array.from({ length: 22 }, (_, i) => stint(i + 1, 1, 1, laps, 'SOFT', 0, i + 1))),
      styles: new Map(),
      total,
    });
    const box = (width: number, height: number, compact = false) => ({ width, height, compact });

    it('fits the tile while it has room', () => {
      expect(tyreExtent(grid(30), box(600, 500))).toEqual({ width: 600, height: 500 });
      expect(tyreExtent(grid(30), box(tyres.size!.min.width, tyres.size!.min.height))).toEqual(tyres.size!.min);
    });

    it('stops shrinking rows at 16px and laps at 4px, and runs past the tile from there', () => {
      expect(tyreExtent(grid(30), box(380, 250)).height).toBe(tyres.size!.min.height);
      expect(tyreExtent(grid(30, 78), box(320, 400)).width).toBeGreaterThan(320);
    });

    it('is a thumbnail in the suggestion strip, fitting its box', () => {
      expect(tyreExtent(grid(30), box(182, 137, true))).toEqual({ width: 182, height: 137 });
    });

    it('declares the size it reads at least and the most it draws', () => {
      expect(tyres.size!.min).toEqual({ width: 364, height: 374 });
      expect(tyres.fit).toEqual({ width: 652, height: 506 });
    });
  });
});

describe('timing_tower', () => {
  const row = (driver: number, position: number, gap: unknown, interval: unknown, more: Record<string, unknown> = {}) => ({
    driver_number: driver,
    position,
    gap_to_leader: gap,
    interval,
    gap_date: 1,
    lap: 31,
    last_lap: 92.345,
    compound: 'MEDIUM',
    lap_start: 14,
    lap_end: 30,
    tyre_age_at_start: 2,
    ...more,
  });

  it('writes each row: the leader on its lap, the rest with gaps', () => {
    const rows = towerModel([row(4, 1, null, null), row(1, 2, 1.2, 1.2), row(44, 3, '+1 LAP', 20.5, { last_lap: null, compound: null, lap_start: null })]);
    expect(rows).toEqual([
      { driver: 4, position: 1, gained: null, gap: 'LAP 31', interval: '', intervalSeconds: null, last: '1:32.345', compound: 'MEDIUM', age: 19, out: false },
      { driver: 1, position: 2, gained: null, gap: '+1.200', interval: '+1.200', intervalSeconds: 1.2, last: '1:32.345', compound: 'MEDIUM', age: 19, out: false },
      { driver: 44, position: 3, gained: null, gap: '+1 LAP', interval: '+20.500', intervalSeconds: 20.5, last: '', compound: null, age: null, out: false },
    ]);
  });

  it('marks a retired car OUT, with no interval or last lap, never as the leader', () => {
    const [first, second] = towerModel([row(4, 1, null, null, { is_out: 1 }), row(1, 2, '+2 LAPS', 30, { is_out: 1 })]);
    expect(first).toMatchObject({ gap: 'OUT', interval: '', last: '', out: true, compound: 'MEDIUM' });
    expect(second).toMatchObject({ gap: 'OUT', interval: '', last: '', out: true });
  });

  it('counts places gained from the grid, but not for a retired car or one without a slot', () => {
    const grid = [
      { driver_number: 4, position: 3, lap_duration: null },
      { driver_number: 1, position: 1, lap_duration: null },
      { driver_number: 44, position: 2, lap_duration: null },
      { driver_number: 16, position: null, lap_duration: null },
    ];
    const rows = towerModel([row(4, 1, null, null), row(1, 2, 1.2, 1.2), row(16, 3, 2, 0.8), row(44, 4, 9, 7, { is_out: 1 })], null, grid);
    expect(rows.map((r) => r.gained)).toEqual([2, -1, null, null]);
  });

  it('gives the leader the race distance when it is known', () => {
    expect(towerModel([row(4, 1, null, null)], 56)[0].gap).toBe('LAP 31/56');
  });

  it('gives a lapped interval no seconds, so it is never read as within range', () => {
    const [, second] = towerModel([row(4, 1, null, null), row(1, 2, '+1 LAP', '+1 LAP')]);
    expect(second).toMatchObject({ interval: '+1 LAP', intervalSeconds: null });
  });

  describe('extent', () => {
    const tower = components.find((c) => c.name === 'timing_tower')!;
    const grid = (gains: boolean) => ({ rows: towerModel(Array.from({ length: 22 }, (_, i) => row(i + 1, i + 1, i, 1))), gains, styles: new Map(), watched: new Set<number>(), within: 1 });
    const box = (width: number, height: number) => ({ width, height, compact: false });

    it('fits the tile while it has room', () => {
      expect(towerExtent(grid(true), box(500, 600))).toEqual({ width: 500, height: 600 });
      expect(towerExtent(grid(true), box(tower.size!.min.width, tower.size!.min.height))).toEqual({ width: tower.size!.min.width, height: tower.size!.min.height });
    });

    it('stops shrinking at its least size, and runs past the tile from there, every column kept', () => {
      expect(towerExtent(grid(true), box(200, 290))).toEqual(tower.size!.min);
      // Without a grid there's no places column, so it needs less width.
      expect(towerExtent(grid(false), box(200, 290)).width).toBeLessThan(tower.size!.min.width);
    });

    it('is a thumbnail in the suggestion strip, fitting its box', () => {
      expect(towerExtent(grid(true), box(182, 137))).toEqual({ width: 182, height: 137 });
    });

    it('declares the size it reads at least and the most it draws', () => {
      expect(tower.size!.min).toEqual({ width: 315, height: 376 });
      expect(tower.fit).toEqual({ width: 396, height: 508 });
    });
  });

  it('leaves the gaps blank in a session without them', () => {
    const [leader, second] = towerModel([row(4, 1, null, null, { gap_date: null }), row(1, 2, null, null, { gap_date: null })]);
    expect(leader.gap).toBe('');
    expect(second.gap).toBe('');
  });
});

/** A `lap_summary` row with the columns any of the lap charts read. */
const ls = (driver_number: number, lap_number: number, more: Record<string, unknown> = {}): Record<string, unknown> => ({
  driver_number,
  lap_number,
  date_end: null,
  position: null,
  lap_duration: 92,
  stint_number: 1,
  compound: 'MEDIUM',
  tyre_age: lap_number,
  is_pit_in_lap: 0,
  is_pit_out_lap: 0,
  track_status: 'AllClear',
  ...more,
});

describe('field_pace', () => {
  it('ranks medians of the last five clean laps, with too few clean laps last', () => {
    const laps = (driver: number, times: number[], more: Record<string, unknown> = {}) => times.map((t, i) => ls(driver, i + 2, { lap_duration: t, ...more }));
    const rows = [
      ...laps(44, [99, 91, 91.2, 91.1, 91.3, 91.4]),
      ...laps(1, [90.9, 90.8, 95, 90.7, 90.9, 90.8]),
      ...laps(16, [91, 91, 91, 91, 91, 91], { track_status: 'Yellow' }),
      ls(16, 8, { lap_duration: null, compound: 'HARD', tyre_age: 3 }),
    ];
    const m = paceModel(rows);
    expect(m.map((r) => r.driver)).toEqual([1, 44, 16]);
    expect(m[0].pace).toBeCloseTo(90.8);
    expect(m[1].pace).toBeCloseTo(91.2);
    expect(m[2]).toEqual({ driver: 16, pace: null, compound: 'HARD', age: 2 });
  });

  it('stops ranking a car whose clean laps are long past', () => {
    const rows = [...[2, 3, 4, 5].map((n) => ls(4, n, { lap_duration: 90 })), ...Array.from({ length: 20 }, (_, i) => ls(1, i + 2, { lap_duration: 91 }))];
    expect(paceModel(rows).find((r) => r.driver === 4)?.pace).toBeNull();
  });

  it('gives a car that has retired a dash, even with recent clean laps', () => {
    const rows = [...[2, 3, 4, 5].map((n) => ls(4, n, { lap_duration: 90 })), ls(4, 6, { lap_duration: null, is_out: 1 }), ...Array.from({ length: 7 }, (_, i) => ls(1, i + 2, { lap_duration: 91 }))];
    expect(paceModel(rows).map((r) => [r.driver, r.pace])).toEqual([[1, 91], [4, null]]);
  });

  it('keeps ranking a car that is laps down but still running', () => {
    const rows = [...[2, 3, 4, 5].map((n) => ls(4, n, { lap_duration: 90 })), ...Array.from({ length: 7 }, (_, i) => ls(1, i + 2, { lap_duration: 91 }))];
    expect(paceModel(rows).map((r) => [r.driver, r.pace])).toEqual([[4, 90], [1, 91]]);
  });
});

describe('pit_window', () => {
  // A 90 s lap. The leader has finished laps 1 to 6 and is on lap 7; everyone else shows their lap in progress.
  const T0 = 1_000_000;
  const LAP = 90_000;
  const running = (driver: number, position: number, gap: unknown, more: Record<string, unknown> = {}) =>
    ls(driver, 7, { position, gap_to_leader: gap, date_start: T0 + 6 * LAP + (typeof gap === 'number' ? gap * 1000 : 0), lap_duration: null, ...more });
  const field = () => [
    ...[1, 2, 3, 4, 5, 6].map((n) => ls(1, n, { date_start: T0 + (n - 1) * LAP, date_end: T0 + n * LAP, lap_duration: 90, position: 1 })),
    running(1, 1, null),
    running(44, 2, 5, { compound: 'HARD', tyre_age: 12 }),
    running(16, 3, 18),
    running(4, 4, 22.5),
    running(81, 5, 30),
    running(77, 6, 85),
    // Lapped, 12 s behind 77: 97 s behind the leader, so 7 s behind it on the road. Its lap ends say 96.5 s.
    ls(63, 5, { date_start: T0 + 4 * LAP + 96_500, date_end: T0 + 5 * LAP + 96_500, position: 7 }),
    ls(63, 6, { date_start: T0 + 5 * LAP + 96_500, lap_duration: null, position: 7, gap_to_leader: '+1 LAP', interval: 12 }),
    // Retired on lap 3, with a gap the feed still gives.
    ls(99, 3, { date_start: T0 + 2 * LAP, lap_duration: null, position: 8, gap_to_leader: 40, is_out: 1 }),
  ];

  it("rings the field by the leader's clean laps, with lapped cars where they are on the road and retired ones left off", () => {
    const m = pitWindowModel(field(), 44, 20);
    expect(m.lapTime).toBe(90);
    expect(m.cars.map((c) => c.driver)).toEqual([1, 44, 16, 4, 81, 77, 63]);
    const lapped = m.cars.find((c) => c.driver === 63)!;
    expect(lapped).toMatchObject({ lapped: true, gap: 97 });
    expect(lapped.ring).toBeCloseTo(7);
  });

  it("measures a lapped car from its lap ends when the car ahead can't be built on", () => {
    const rows = field().filter((r) => r.driver_number !== 77);
    expect(pitWindowModel(rows, 44, 20).cars.find((c) => c.driver === 63)?.gap).toBe(96.5);
  });

  it('plays the stop out: where they rejoin, who is either side on the road, and whether that is clear air', () => {
    const m = pitWindowModel(field(), 44, 20);
    expect(m.from).toBe(2);
    expect(m.out).toMatchObject({ gap: 25, position: 4, behind: { driver: 4, by: 2.5, lapped: false }, aheadOf: { driver: 81, by: 5 }, clearAir: true });
    expect(m.compound).toBe('HARD');
    expect(m.age).toBe(11);

    const close = pitWindowModel(field(), 44, 26).out!;
    expect(close).toMatchObject({ position: 5, behind: { driver: 81 }, clearAir: false });
    expect(close.behind!.by).toBeCloseTo(1);
    expect(close.behind!.by).toBeLessThan(CLEAR_AIR);
  });

  it("counts a lapped car as traffic on the road, but not as a place lost", () => {
    const out = pitWindowModel(field(), 1, 8).out!;
    expect(out.position).toBe(2);
    expect(out.behind).toMatchObject({ driver: 63, lapped: true });
    expect(out.behind!.by).toBeCloseTo(1);
    expect(out.clearAir).toBe(false);
  });

  it('draws the ring but plays nothing out without a pit loss, or for a car that has retired', () => {
    const none = pitWindowModel(field(), 44, null);
    expect(none.out).toBeNull();
    expect(none.me?.gap).toBe(5);
    expect(none.cars).toHaveLength(7);
    const stopped = pitWindowModel(field(), 99, 20);
    expect(stopped.me).toBeNull();
    expect(stopped.out).toBeNull();
  });

  it('gives the margin either side: seconds short of the place ahead, and seconds spare before losing one', () => {
    const out = pitWindowModel(field(), 44, 20).out!;
    expect(out.short).toBeCloseTo(2.5);
    expect(out.spare).toBeCloseTo(5);
    expect(pitWindowModel(field(), 1, 8).out!.short).toBeCloseTo(3);
    expect(pitWindowModel(field(), 1, 3).out).toMatchObject({ position: 1, short: null });
  });

  it('says whether each car either side is racing them, laps down, or a lap up', () => {
    expect(pitWindowModel(field(), 44, 20).out).toMatchObject({ behind: { driver: 4, laps: 0 }, aheadOf: { driver: 81, laps: 0 } });
    // The leader's lapped car, 1 s up the road from where the leader would come out.
    expect(pitWindowModel(field(), 1, 8).out!.behind).toMatchObject({ driver: 63, laps: 1 });
    // 77 coming out a lap down: the leader 4 s up the road, and 44 1 s behind, about to lap it.
    const lappedOut = pitWindowModel(field(), 77, 9).out!;
    expect(lappedOut.behind).toMatchObject({ driver: 1, laps: -1 });
    expect(lappedOut.aheadOf).toMatchObject({ driver: 44, laps: -1 });
  });

  it('plays the same stop out under a safety car and a virtual one', () => {
    const m = pitWindowModel(field(), 44, 20, { safetyCar: 12, virtualSafetyCar: 14 });
    expect(m.safetyCar).toMatchObject({ gap: 17, position: 2 });
    expect(m.virtualSafetyCar).toMatchObject({ gap: 19, position: 3 });
    expect(pitWindowModel(field(), 44, 20).safetyCar).toBeNull();
  });

  it('runs past a tile below its least size, except as a thumbnail', () => {
    const m = { ...pitWindowModel(field(), 44, 20), styles: new Map(), pointer: null };
    expect(pitWindowExtent(m, { width: 267, height: 195, compact: true })).toEqual(PIT_WINDOW_LEAST);
    expect(pitWindowExtent(m, { width: 400, height: 846, compact: false })).toEqual({ width: 400, height: 846 });
    expect(pitWindowExtent(m, { width: 280, height: 120, compact: true })).toEqual({ width: 280, height: 120 });
    // Wide enough for the panel beside the ring: it only needs the ring's height.
    expect(pitWindowExtent(m, { width: 600, height: 250, compact: false })).toEqual({ width: 600, height: 280 });
  });

  it('has no ring before there is a clean lap', () => {
    const m = pitWindowModel([running(1, 1, null), running(44, 2, 1.5)], 44, 20);
    expect(m.lapTime).toBeNull();
    expect(m.out).toMatchObject({ position: 2, behind: { driver: 1, by: 21.5 } });
  });
});

describe('pit_windows', () => {
  // The same field as pit_window's: a 90 s lap, the leader on lap 7.
  const T0 = 1_000_000;
  const LAP = 90_000;
  const running = (driver: number, position: number, gap: unknown, more: Record<string, unknown> = {}) =>
    ls(driver, 7, { position, gap_to_leader: gap, date_start: T0 + 6 * LAP + (typeof gap === 'number' ? gap * 1000 : 0), lap_duration: null, ...more });
  const field = (more16: Record<string, unknown> = {}) => [
    ...[1, 2, 3, 4, 5, 6].map((n) => ls(1, n, { date_start: T0 + (n - 1) * LAP, date_end: T0 + n * LAP, lap_duration: 90, position: 1 })),
    running(1, 1, null),
    running(44, 2, 5),
    running(16, 3, 18, more16),
    running(4, 4, 22.5),
    running(81, 5, 30),
    running(77, 6, 85),
    ls(63, 5, { date_start: T0 + 4 * LAP + 96_500, date_end: T0 + 5 * LAP + 96_500, position: 7 }),
    ls(63, 6, { date_start: T0 + 5 * LAP + 96_500, lap_duration: null, position: 7, gap_to_leader: '+1 LAP', interval: 12 }),
    ls(99, 3, { date_start: T0 + 2 * LAP, lap_duration: null, position: 8, gap_to_leader: 40, is_out: 1 }),
  ];

  it("plays out every running car's stop, in running order, with retired cars left off", () => {
    const rows = pitWindowsModel(field(), 20);
    expect(rows.map((r) => r.driver)).toEqual([1, 44, 16, 4, 81, 77, 63]);
    const ham = rows.find((r) => r.driver === 44)!;
    expect(ham).toMatchObject({ from: 2, pit: false, rejoin: 4, lost: 2, ahead: { driver: 4 }, clearAir: true });
    // 2.5 s short of rejoining ahead of 4, 5 s before 81 gets by too.
    expect(ham.short).toBeCloseTo(2.5);
    expect(ham.spare).toBeCloseTo(5);
    expect(ham.ahead!.by).toBeCloseTo(2.5);
  });

  it('has nothing spare for the last car, and loses it no place', () => {
    const last = pitWindowsModel(field(), 20).at(-1)!;
    expect(last).toMatchObject({ driver: 63, from: 7, rejoin: 7, lost: 0, spare: null });
    expect(last.short).toBeCloseTo(32);
  });

  it('reads a car on its in-lap or out-lap as in the pits, with no stop to play out', () => {
    const out = pitWindowsModel(field({ is_pit_out_lap: 1 }), 20).find((r) => r.driver === 16)!;
    expect(out).toMatchObject({ pit: true, rejoin: null, lost: null, short: null, ahead: null });
    expect(pitWindowsModel(field({ is_pit_in_lap: 1 }), 20).find((r) => r.driver === 16)!.pit).toBe(true);
    // A finished out-lap is behind them.
    expect(pitWindowsModel(field({ is_pit_out_lap: 1, date_end: T0 + 7 * LAP }), 20).find((r) => r.driver === 16)!.pit).toBe(false);
  });

  it('plays nothing out without a pit loss', () => {
    expect(pitWindowsModel(field(), null).every((r) => r.rejoin === null && !r.pit)).toBe(true);
  });

  it("uses the safety car's or the VSC's pit loss while one is out", () => {
    const loss = { normal: 21.84, safetyCar: 14.16, virtualSafetyCar: 15.05 };
    expect(lossNow(loss, null)).toBe(21.84);
    expect(lossNow(loss, 'SC')).toBe(14.16);
    expect(lossNow(loss, 'VSC')).toBe(15.05);
    expect(lossNow({ ...loss, safetyCar: null }, 'SC')).toBeNull();
  });
});

const sec = (driver: number, lap: number, s: [number | null, number | null, number | null], more: Record<string, unknown> = {}) => ({
  driver_number: driver,
  lap_number: lap,
  duration_sector_1: s[0],
  duration_sector_2: s[1],
  duration_sector_3: s[2],
  is_pit_in_lap: 0,
  is_pit_out_lap: 0,
  track_status: 'AllClear',
  ...more,
});

describe('sector_table', () => {
  // Car 44 is 0.2s slower in S1 and 0.1s quicker in S2 than car 1 on every lap.
  const rows: Array<Record<string, unknown>> = [];
  for (let lap = 1; lap <= 14; lap++) {
    rows.push(sec(44, lap, [30.2, 39.9, 20], lap === 13 ? { track_status: 'VSCDeployed' } : {}));
    rows.push(sec(1, lap, [30, 40, 20]));
  }
  // The lap in progress: both have the first sector, only one the second.
  rows.push(sec(44, 15, [30.1, 40, null]), sec(1, 15, [30, null, null]));

  it('goes back to ten laps that count, newest first, negative where the first driver was faster', () => {
    const m = sectorTable(rows, [44, 1]);
    expect(m.rows.map((r) => r.lap)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
    expect(m.rows[0]).toMatchObject({ live: true, total: null });
    expect(m.rows[0].deltas[0]).toBeCloseTo(0.1);
    expect(m.rows[0].deltas[1]).toBeNull();
    expect(m.rows[1].deltas[0]).toBeCloseTo(0.2);
    expect(m.rows[1].deltas[1]).toBeCloseTo(-0.1);
    expect(m.rows[1].total).toBeCloseTo(0.1);
    expect(m.rows[2]).toMatchObject({ skip: 'VSC', deltas: [null, null, null] });
    expect(m.counted).toBe(10);
    expect(m.averages[0]).toBeCloseTo(0.2);
    expect(m.averages[2]).toBe(0);
    expect(m.total).toBeCloseTo(0.1);
    expect(m).toMatchObject({ sinceStop: false, averageAt: 12 });
  });

  it('stops at the pit laps of either driver\'s last stop, and averages only the laps since', () => {
    const stopped = rows.map((r) =>
      r.driver_number === 1 && r.lap_number === 10 ? { ...r, is_pit_in_lap: 1 } : r.driver_number === 1 && r.lap_number === 11 ? { ...r, is_pit_out_lap: 1 } : r,
    );
    const m = sectorTable(stopped, [44, 1]);
    expect(m.rows.map((r) => r.lap)).toEqual([15, 14, 13, 12, 11, 10]);
    expect(m.rows[4]).toMatchObject({ skip: 'PIT', pits: [{ who: 1, way: 'out' }] });
    expect(m.rows[5].pits).toEqual([{ who: 1, way: 'in' }]);
    expect(m).toMatchObject({ counted: 2, sinceStop: true, averageAt: 4 });
  });

  it('leaves the standing start out', () => {
    const m = sectorTable(rows.filter((r) => (r.lap_number as number) <= 3), [44, 1]);
    expect(m.rows.map((r) => r.skip)).toEqual([null, null, 'START']);
    expect(m.counted).toBe(2);
  });

  it('has nothing before both have a sector', () => {
    expect(sectorTable([sec(44, 1, [30, null, null])], [44, 1]).rows).toEqual([]);
  });
});

describe('pit_stops', () => {
  const stop = (driver: number, lap: number, lane: number | null, stop: number | null, compound: string | null) => ({
    driver_number: driver,
    lap_number: lap,
    lane,
    stop_duration: stop,
    compound,
  });

  it('keeps the order given, newest first, with the tyre fitted and a shared lane scale', () => {
    const m = stopsModel([stop(1, 20, 23.4, 2.1, 'HARD'), stop(44, 18, 25.76, null, null)]);
    expect(m.stops).toEqual([
      { driver: 1, lap: 20, compound: 'HARD', lane: 23.4, stop: 2.1 },
      { driver: 44, lap: 18, compound: null, lane: 25.76, stop: null },
    ]);
    expect(m.hasStop).toBe(true);
    expect(m.lane).toEqual([21, 26]);
  });

  it('hides the stationary time when no stop has one', () => {
    const m = stopsModel([stop(1, 20, 23.4, null, 'HARD')]);
    expect(m.hasStop).toBe(false);
    expect(m.lane).toEqual([21, 26]);
    expect(stopsModel([stop(1, 20, null, null, null)]).lane).toBeNull();
  });
});

describe('race_control', () => {
  // Real messages from the 2026 São Paulo and Mexico City races.
  const rc = (lap: number, category: string, flag: string | null, message: string, more: Record<string, unknown> = {}) => ({
    lap_number: lap,
    category,
    flag,
    message,
    driver_number: null,
    scope: null,
    sector: null,
    ...more,
  });
  const sector = (lap: number, flag: string, n: number) => rc(lap, 'Flag', flag, `${flag} IN TRACK SECTOR ${n}`, { scope: 'Sector', sector: n });
  const blue = (lap: number, n: number, code: string) => rc(lap, 'Flag', 'BLUE', `WAVED BLUE FLAG FOR CAR ${n} (${code}) TIMED AT 14:26:52`, { scope: 'Driver', driver_number: n });
  const CODES: Record<number, string> = { 51: 'CAM', 3: 'VER', 11: 'PER', 16: 'LEC', 23: 'ALB', 44: 'HAM', 87: 'BEA', 10: 'GAS', 55: 'SAI' };
  const codeOf = (n: number) => CODES[n] ?? String(n);
  const words = { codeOf, isCode: (w: string) => Object.values(CODES).includes(w) };

  it('reads the red flag from its text, and tells a safety car from a VSC and from its end', () => {
    expect(signalOf(rc(45, 'Other', null, 'RED FLAG - RACE SUSPENDED'))).toBe('red');
    expect(signalOf(rc(7, 'SafetyCar', null, 'VSC DEPLOYED'))).toBe('vsc');
    expect(signalOf(rc(8, 'SafetyCar', null, 'VSC ENDING'))).toBe('vscEnd');
    expect(signalOf(rc(44, 'SafetyCar', null, 'SAFETY CAR DEPLOYED'))).toBe('sc');
    expect(signalOf(rc(1, 'Flag', 'DOUBLE YELLOW', ''))).toBe('double');
    expect(signalOf(rc(1, 'Flag', 'CLEAR', ''))).toBe('green');
    expect(signalOf(rc(58, 'Flag', 'BLACK AND WHITE', ''))).toBe('blackwhite');
    expect(signalOf(rc(71, 'Flag', 'CHEQUERED', ''))).toBe('chequered');
    expect(signalOf(rc(38, 'Other', null, 'CAR 23 (ALB) TIME 1:18.737 DELETED - TRACK LIMITS AT TURN 1 LAP 34 14:50:00'))).toBe('note');
  });

  it('says each message in fewer words, and one it does not know as sent, less car numbers and clock times', () => {
    const say = (m: string) => sentenceCase(shorten(m, codeOf), words.isCode);
    expect(say('CAR 23 (ALB) TIME 1:18.737 DELETED - TRACK LIMITS AT TURN 1 LAP 34 14:50:00')).toBe('ALB lap 34 deleted · T1 limits');
    expect(say('CAR 51 (CAM) LAP DELETED - TRACK LIMITS AT TURN 1 LAP 59 15:23:16 (PIT)')).toBe('CAM lap 59 deleted · T1 limits');
    expect(say('FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 23 (ALB) - REJOINING UNSAFELY (14:50:05)')).toBe('ALB 5s penalty · rejoining unsafely');
    expect(say('DOUBLE YELLOW IN TRACK SECTOR 2')).toBe('Double yellow S2');
    expect(say('RED FLAG - RACE SUSPENDED')).toBe('Red flag - race suspended');
    expect(say('PUSH CARS TO FRONT IN ORDER: 30, 55, 11, 23')).toBe('Push cars to front in order: 30 SAI PER ALB');
    expect(say('RISK OF RAIN FOR THE F1 RACE IS 80%')).toBe('Risk of rain for the F1 race is 80%');
  });

  it("folds a stewards' case into one line that moves up as it changes", () => {
    const rows = [
      rc(37, 'Other', null, 'TURN 1 INCIDENT INVOLVING CARS 23 (ALB) AND 10 (GAS) NOTED (14:50:05)'),
      rc(38, 'Other', null, 'CAR 23 (ALB) TIME 1:18.737 DELETED - TRACK LIMITS AT TURN 1 LAP 34 14:50:00'),
      rc(40, 'Other', null, 'FIA STEWARDS: TURN 1 INCIDENT INVOLVING CARS 23 (ALB) AND 10 (GAS) UNDER INVESTIGATION (14:50:05)'),
      rc(42, 'Other', null, 'FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 23 (ALB) - REJOINING UNSAFELY (14:50:05)'),
    ];
    const lines = messagesModel(rows);
    expect(lines.map((l) => l.kind)).toEqual(['case', 'message']);
    const c = lines[0] as Extract<Line, { kind: 'case' }>;
    expect(c.lap).toBe(42);
    expect(c.steps.map((s) => stageLabel(s.stage, s.penalty))).toEqual(['noted', 'investigating', '5s penalty']);
    expect(lineText(c, words)).toBe('T1 ALB & GAS · rejoining unsafely');
  });

  it('puts a run of yellows and their clears on one line, and a clear with no yellow on its own', () => {
    const rows = [
      sector(1, 'CLEAR', 14),
      sector(17, 'DOUBLE YELLOW', 2),
      sector(17, 'YELLOW', 1),
      blue(17, 11, 'PER'),
      sector(18, 'CLEAR', 1),
      sector(18, 'CLEAR', 2),
    ];
    const lines = messagesModel(rows);
    expect(lines.map((l) => l.kind)).toEqual(['flags', 'blue', 'message']);
    expect(markOf(lines[0])).toBe('cleared');
    expect(lineText(lines[0], words)).toBe('Double yellow S2 · yellow S1 · cleared');
    expect(lineText(lines[1], words)).toBe('Blue ×1  PER');
  });

  it('collapses each run of blue flags into one line unless asked for each', () => {
    const rows = [blue(27, 43, 'COL'), rc(28, 'Other', null, 'TRACK SURFACE SLIPPERY IN TRACK SECTOR 12'), blue(29, 11, 'PER'), blue(30, 87, 'BEA'), blue(30, 11, 'PER')];
    expect(messagesModel(rows)).toEqual([
      { kind: 'blue', lap: 30, count: 3, drivers: [11, 87] },
      { kind: 'message', lap: 28, signal: 'note', message: 'TRACK SURFACE SLIPPERY IN TRACK SECTOR 12' },
      { kind: 'blue', lap: 27, count: 1, drivers: [43] },
    ]);
    expect(messagesModel(rows, true)).toHaveLength(5);
  });

  it('knows what is in force: a red flag until the session starts again, yellows until cleared, open cases', () => {
    const rows = [
      rc(1, 'Other', null, 'OVERTAKE DISABLED'),
      rc(3, 'Other', null, 'TURN 4 INCIDENT INVOLVING CARS 44 (HAM) AND 16 (LEC) NOTED (14:03:57)'),
      rc(44, 'SafetyCar', null, 'SAFETY CAR DEPLOYED'),
      sector(44, 'DOUBLE YELLOW', 3),
      rc(45, 'Other', null, 'RED FLAG - RACE SUSPENDED'),
    ];
    let s = standing(rows);
    expect(s.track).toBe('red');
    expect([...s.sectors]).toEqual([[3, 'double']]);
    expect(s.aid).toEqual({ name: 'OVERTAKE', on: false });
    expect(s.grip).toBeNull();
    expect(s.open).toBe(1);
    s = standing([...rows, rc(46, 'Flag', 'CLEAR', 'TRACK CLEAR', { scope: 'Track' }), sector(46, 'CLEAR', 3)]);
    expect(s.track).toBe('red');
    expect(s.sectors.size).toBe(0);
    s = standing([
      ...rows,
      rc(46, 'SessionStatus', null, 'SESSION STARTED'),
      rc(12, 'Other', null, 'FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 16 (LEC) - LEAVING THE TRACK AND GAINING AN ADVANTAGE (14:03:57)'),
    ]);
    expect(s.track).toBe('green');
    expect(s.open).toBe(0);
  });
});

describe('race_status', () => {
  // Real messages from the 2026 São Paulo and Mexico City races.
  const rc = (lap: number, category: string, flag: string | null, message: string, more: Record<string, unknown> = {}) => ({
    lap_number: lap,
    category,
    flag,
    message,
    driver_number: null,
    scope: null,
    sector: null,
    ...more,
  });
  const sector = (lap: number, flag: string, n: number) => rc(lap, 'Flag', flag, `${flag} IN TRACK SECTOR ${n}`, { scope: 'Sector', sector: n });
  const options: { styles: Parameters<typeof boardModel>[1]['styles']; marshalSectors: number | null; aidLabel: string } = { styles: new Map(), marshalSectors: 16, aidLabel: 'Overtake' };
  const board = (rows: Array<Record<string, unknown>>, o: Partial<typeof options> = {}) => boardModel(rows, { ...options, ...o });

  it('holds the red flag from the lap it was shown, with the restart order and time, until the session starts', () => {
    const rows = [
      rc(44, 'SafetyCar', null, 'SAFETY CAR DEPLOYED'),
      rc(45, 'Other', null, 'RED FLAG - RACE SUSPENDED'),
      rc(46, 'Flag', 'CLEAR', 'TRACK CLEAR', { scope: 'Track' }),
      rc(46, 'Other', null, 'RESUMPTION ORDER: 3, 16, 12, 44'),
      rc(46, 'Other', null, 'REVISED RESUMPTION ORDER: 3, 16, 44, 12'),
      rc(46, 'Other', null, 'RACE WILL RESUME AT 15:45'),
    ];
    expect(board(rows.slice(0, 1))).toMatchObject({ track: 'sc', since: 44, restart: null });
    expect(board(rows)).toMatchObject({ track: 'red', since: 45, restart: { order: [3, 16, 44, 12], at: '15:45' } });
    expect(board([...rows, rc(46, 'SessionStatus', null, 'SESSION STARTED')])).toMatchObject({ track: 'green', since: null, restart: null });
  });

  it('keeps a VSC to the lap it began on while it ends', () => {
    const rows = [rc(7, 'SafetyCar', null, 'VSC DEPLOYED'), rc(8, 'SafetyCar', null, 'VSC ENDING')];
    expect(board(rows)).toMatchObject({ track: 'vscEnd', since: 7 });
    expect(board([...rows, rc(8, 'Flag', 'CLEAR', 'TRACK CLEAR', { scope: 'Track' })])).toMatchObject({ track: 'green', since: null });
  });

  it('leaves grip and the aid unsaid until race control says them', () => {
    const quiet = board([rc(1, 'SessionStatus', null, 'SESSION STARTED')]);
    expect(quiet.grip).toBeNull();
    expect(quiet.aid).toBeNull();
    expect(board([rc(1, 'Other', null, 'OVERTAKE DISABLED'), rc(1, 'Other', null, 'LOW GRIP CONDITIONS')])).toMatchObject({
      grip: 'low',
      aid: { label: 'Overtake', on: false },
    });
  });

  it("strips the circuit's marshal sectors, or as many as have been flagged", () => {
    const rows = [sector(63, 'DOUBLE YELLOW', 14), sector(63, 'DOUBLE YELLOW', 15), sector(63, 'CLEAR', 14)];
    expect(board(rows).sectorCount).toBe(16);
    expect([...board(rows).sectors]).toEqual([[15, 'double']]);
    expect(board(rows, { marshalSectors: null }).sectorCount).toBe(15);
  });

  it('keeps owed penalties and open cases, and lets a decision go three laps after it', () => {
    const rows = [
      rc(36, 'Other', null, 'TURN 6 INCIDENT INVOLVING CARS 87 (BEA) AND 55 (SAI) NOTED (14:44:23)'),
      rc(37, 'Other', null, 'TURN 1 INCIDENT INVOLVING CARS 23 (ALB) AND 10 (GAS) NOTED (14:50:05)'),
      rc(38, 'Other', null, 'FIA STEWARDS: TURN 6 INCIDENT INVOLVING CARS 87 (BEA) AND 55 (SAI) REVIEWED NO FURTHER INVESTIGATION (14:44:23)'),
      rc(40, 'Other', null, 'FIA STEWARDS: TURN 1 INCIDENT INVOLVING CARS 23 (ALB) AND 10 (GAS) UNDER INVESTIGATION (14:50:05)'),
      rc(42, 'Other', null, 'FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 23 (ALB) - REJOINING UNSAFELY (14:50:05)'),
    ];
    expect(board(rows.slice(0, 4)).cases.map((c) => [c.cars, c.stage])).toEqual([
      [[23, 10], 'investigating'],
      [[87, 55], 'no action'],
    ]);
    // Decided on lap 38, so gone after lap 38 + KEEP_DECIDED; the penalty stays until served.
    expect(KEEP_DECIDED).toBe(3);
    const at42 = board(rows).cases;
    expect(at42.map((c) => c.stage)).toEqual(['penalty']);
    expect(at42[0]).toMatchObject({ cars: [23, 10], penalised: [23], penalty: '5s', reason: 'REJOINING UNSAFELY' });
    const served = [...rows, rc(46, 'Other', null, 'FIA STEWARDS: PENALTY SERVED - 5 SECOND TIME PENALTY FOR CAR 23 (ALB) (14:50:05)')];
    expect(board(served).cases.map((c) => c.stage)).toEqual(['served']);
    expect(board([...served, rc(50, 'Other', null, 'PIT EXIT CLOSED')]).cases).toEqual([]);
  });

  it('puts the cases left for after the race for one reason on one line', () => {
    const later = (n: number, code: string, time: string) =>
      rc(1, 'Other', null, `FIA STEWARDS: INCIDENT INVOLVING CAR ${n} (${code}) WILL BE INVESTIGATED AFTER THE RACE - FAILING TO FOLLOW RACE DIRECTORS INSTRUCTIONS – PRACTICE START INFRINGEMENT (${time})`);
    const rows = [
      later(27, 'HUL', '13:20:45'),
      later(11, 'PER', '13:21:07'),
      later(6, 'HAD', '13:24:09'),
      rc(71, 'Other', null, 'FIA STEWARDS: TURN 12 INCIDENT INVOLVING CARS 16 (LEC) AND 30 (LAW) WILL BE INVESTIGATED AFTER THE RACE - CAUSING A COLLISION (15:36:34)'),
    ];
    expect(board(rows).cases.map((c) => [c.cars, c.reason])).toEqual([
      [[16, 30], 'CAUSING A COLLISION'],
      [[27, 11, 6], 'PRACTICE START INFRINGEMENT'],
    ]);
  });

  it('counts laps deleted per car, with the black and white flag', () => {
    const del = (lap: number, n: number, code: string) => rc(lap, 'Other', null, `CAR ${n} (${code}) TIME 1:32.243 DELETED - TRACK LIMITS AT TURN 1 LAP ${lap - 1} 14:28:00`);
    const rows = [
      del(16, 51, 'CAM'),
      rc(16, 'Other', null, 'CAR 51 (CAM) LAP DELETED - TRACK LIMITS AT TURN 1 LAP 15 14:24:39 (PIT)'),
      del(21, 12, 'ANT'),
      del(24, 51, 'CAM'),
      rc(58, 'Flag', 'BLACK AND WHITE', 'BLACK AND WHITE FLAG FOR CAR 51 (CAM) - TRACK LIMITS', { scope: 'Driver', driver_number: 51 }),
    ];
    expect(board(rows).deleted).toEqual([
      { car: 51, laps: 3, blackWhite: true },
      { car: 12, laps: 1, blackWhite: false },
    ]);
  });

  it('draws taller than a short tile once its cases need it, and only the top of the board as a thumbnail', () => {
    const calls: string[] = [];
    const ctx = new Proxy(
      { measureText: (s: string) => ({ width: s.length * 6.6 }) },
      {
        get: (t, k) => (k in t ? t[k as keyof typeof t] : () => calls.push(String(k))),
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    const rows = [
      rc(45, 'Other', null, 'RED FLAG - RACE SUSPENDED'),
      rc(46, 'Other', null, 'RESUMPTION ORDER: 3, 16, 12, 44, 1, 63, 41, 81, 43, 27, 87, 5, 10, 6, 30, 55, 50, 23, 11'),
      rc(46, 'Other', null, 'INCIDENT INVOLVING CAR 11 (PER) NOTED - SPEEDING IN THE PIT LANE (15:04:43)'),
    ];
    const tall = drawBoard(ctx, board(rows), { width: 300, height: 180 });
    expect(tall).toBeGreaterThan(180);
    expect(drawBoard(ctx, board(rows), { width: 300, height: 100 })).toBeLessThan(100);
  });
});

describe('track_map', () => {
  it("keeps each car's latest position, and leaves out the feed's (0, 0) placeholder", () => {
    const rows = [
      { driver_number: 44, x: 100, y: 200, date: 1000 },
      { driver_number: 44, x: 110, y: 210, date: 2000 },
      { driver_number: 1, x: 0, y: 0, date: 2000 },
      { driver_number: 4, x: -5, y: 7, date: 2000 },
    ];
    expect(trackModel(rows)).toEqual([
      { driver: 4, x: -5, y: 7 },
      { driver: 44, x: 110, y: 210 },
    ]);
  });

  it('leaves retired cars off, wherever they still report', () => {
    const rows = [
      { driver_number: 44, x: 100, y: 200, date: 1000 },
      { driver_number: 4, x: -5, y: 7, date: 1000 },
    ];
    expect(trackModel(rows, [{ driver_number: 44 }])).toEqual([{ driver: 4, x: -5, y: 7 }]);
  });

  it('pushes labels off the line, and apart when cars are close', () => {
    const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;
    // A horizontal line, its outside up; two cars nearly on top of each other.
    const line = Array.from({ length: 41 }, (_, i) => [i * 5, 100] as const);
    const label = (x: number) => ({ x, y: 100, nx: 0, ny: -1, w: 24, h: 10 });
    const [a, b] = placeLabels([label(100), label(102)], [], line);
    expect(a.y).toBeLessThan(100 - 5);
    expect(overlap(a, b)).toBe(false);
    // Kept inside the tile: with no room above, the label goes below the line.
    expect(placeLabels([{ x: 100, y: 8, nx: 0, ny: -1, w: 24, h: 10 }], [], [], { width: 200, height: 200 })[0].y).toBeGreaterThan(8);
    for (const box of [a, b]) expect(line.some(([x, y]) => Math.abs(x - box.x) * 2 < box.w && Math.abs(y - box.y) * 2 < box.h)).toBe(false);
  });
});

describe('speed_ribbon', () => {
  const at = (date: number, x: number, y: number) => ({ date, x, y, speed: null, n_gear: null, throttle: null, brake: null });
  const car = (date: number, speed: number, brake = 0, throttle = 100, n_gear = 7) => ({ date, x: null, y: null, speed, n_gear, throttle, brake });
  const point = (x: number, speed: number | null, more: Record<string, unknown> = {}) => ({ x, y: x, speed, braking: false, lifting: false, ...more });

  it('gives each position the speed and pedals of the latest sample at or before it', () => {
    const m = ribbonModel([car(0, 300), at(100, 1, 1), car(200, 280, 100, 0), at(300, 2, 2), car(400, 150, 0, 40), at(450, 3, 3), car(500, 250, 100, 0, 5)]);
    expect(m.path).toEqual([point(1, 300), point(2, 280, { braking: true }), point(3, 150, { lifting: true })]);
    expect(m).toMatchObject({ now: { x: 3, y: 3 }, speed: 250, gear: 5, throttle: 0, braking: true });
  });

  it('reads 104 as no reading: neither braking nor lifting, and no pedals in the readout', () => {
    // São Paulo 2026, car 3, lap 38: brake goes to 104 mid-corner.
    const m = ribbonModel([car(0, 93, 104, 46), at(100, 1, 1)]);
    expect(m.path).toEqual([point(1, 93)]);
    expect(m).toMatchObject({ throttle: null, braking: null });
  });

  it('breaks at a gap, and leaves out the placeholder position', () => {
    const m = ribbonModel([at(0, 1, 1), at(250, 0, 0), at(3000, 2, 2), car(3100, 200)]);
    expect(m.path).toEqual([point(1, null), null, point(2, null)]);
    expect(ribbonModel([])).toEqual({ path: [], now: null, speed: null, gear: null, throttle: null, braking: null });
  });

  it("finds each corner's slowest speed once the car is out of it", () => {
    const run = [[300, true], [200, true], [120, false], [95, false], [98, false], [130, false], [250, false], [200, true], [110, false], [100, false]] as const;
    const path = run.map(([speed, braking], i) => point(i, speed, { braking }));
    // The second zone's low isn't settled: the car hasn't picked up 10 km/h since.
    expect(cornerSpeeds(path).map((p) => p.speed)).toEqual([95]);
    // A gap ends a zone with no low.
    expect(cornerSpeeds([point(0, 200, { braking: true }), point(1, 90), null, point(2, 200)])).toEqual([]);
  });

  it('is one lap long, within a minute and two, and wider the faster', () => {
    expect(windowSeconds([])).toBe(60);
    expect(windowSeconds([{ lap_duration: 75.067 }])).toBe(75);
    expect(windowSeconds([{ lap_duration: 181.2 }])).toBe(120);
    expect(ribbonWidth(60)).toBe(1);
    expect(ribbonWidth(340)).toBe(6);
    expect(ribbonWidth(200)).toBeGreaterThan(ribbonWidth(100));
  });
});

describe('car_telemetry', () => {
  const sample = (date: number, more: Record<string, unknown> = {}) => ({ date, speed: 300, rpm: 11420, n_gear: 8, throttle: 100, brake: 0, drs: null, ...more });

  it('shows the latest sample, with the window before it as a trace broken at gaps', () => {
    const m = telemetryModel([sample(0, { speed: 100 }), sample(1000), sample(5000, { speed: 250, n_gear: 5 })]);
    expect(m).toMatchObject({ speed: 250, gear: 5, rpm: 11420, throttle: 100, brake: 0, drs: null, seconds: 60 });
    expect(m.trace).toEqual([{ t: -5, speed: 100, gear: 8 }, { t: -4, speed: 300, gear: 8 }, null, { t: 0, speed: 250, gear: 5 }]);
    expect(telemetryModel([]).speed).toBeNull();
    expect(telemetryModel([sample(0, { speed: 100 }), sample(5000)], 4).trace).toEqual([{ t: 0, speed: 300, gear: 8 }]);
  });

  it('reads 104 as no reading: no throttle, brake or revs', () => {
    // São Paulo 2026, car 3, lap 38: both go to 104 together and the revs freeze.
    const m = telemetryModel([sample(0), sample(250, { speed: 109, rpm: 9424, n_gear: 2, throttle: 104, brake: 104 })]);
    expect(m).toMatchObject({ speed: 109, gear: 2, rpm: null, throttle: null, brake: null });
  });

  it('is one lap long, within a minute and two', () => {
    expect(traceSeconds([])).toBe(60);
    expect(traceSeconds([{ lap_duration: 75.067 }])).toBe(75);
    expect(traceSeconds([{ lap_duration: 41 }])).toBe(60);
    expect(traceSeconds([{ lap_duration: 181.2 }])).toBe(120);
  });

  it('lights the chase aid within its line of the car ahead', () => {
    const aid = { label: 'OT', within: 1 };
    expect(chaseOf([{ interval: 0.858 }], aid)).toEqual({ label: 'OT', interval: 0.858, inRange: true });
    expect(chaseOf([{ interval: 9.337 }], aid)).toMatchObject({ inRange: false });
    // A lapped car's interval is text, and the leader has none.
    expect(chaseOf([{ interval: '+1 LAP' }], aid)).toBeNull();
    expect(chaseOf([], aid)).toBeNull();
  });

  it('finds the corners: low points well under the speed before them', () => {
    const trace = [300, 280, 200, 120, 90, 110, 160, 220, 260, 250, 240, 230, 250, 280, 300, 200, 85, 85, 140, 200, 250, 280, 300, 310].map((speed, i) => ({ t: i * 0.5 - 9, speed, gear: speed < 100 ? 2 : 6 }));
    // A 30 km/h lift isn't a corner; of two equal lows, the first is.
    expect(corners([...trace.slice(0, 9), null, ...trace.slice(9)]).map((p) => [p.t, p.speed])).toEqual([[-7, 90], [-1, 85]]);
    // The car still braking at the newest sample isn't at a corner yet.
    expect(corners(trace.slice(0, 17)).map((p) => p.speed)).toEqual([90]);
    // Nor is a dip it hasn't come out of.
    expect(corners([...trace.slice(0, 17), ...[86, 87, 86, 87, 86, 87].map((speed, i) => ({ t: -0.5 + i * 0.5, speed, gear: 2 }))]).map((p) => p.speed)).toEqual([90]);
  });

  it("reads DRS only when the channel holds DRS's own codes", () => {
    expect(telemetryModel([sample(0, { drs: 8 }), sample(1000, { drs: 12 })]).drs).toBe('open');
    expect(telemetryModel([sample(0, { drs: 0 }), sample(1000, { drs: 8 })]).drs).toBe('available');
    expect(telemetryModel([sample(0, { drs: 1 }), sample(1000, { drs: 1 })]).drs).toBe('off');
    // 2026's cars have no DRS, and the channel carries other codes.
    expect(telemetryModel([sample(0, { drs: 17 }), sample(1000, { drs: 1 })]).drs).toBeNull();
  });
});

describe('pedal_barcode', () => {
  const lapRow = (lap_number: number, date_start: number, lap_duration: number | null) => ({ driver_number: 1, lap_number, date_start, lap_duration });
  const sample = (date: number, throttle: number, brake: number) => ({ date, throttle, brake, x: null, y: null });

  it('reads 104 on either pedal as no reading, and the brake as on or off', () => {
    expect(pedalOf(104, 104)).toBe('none');
    expect(pedalOf(46, 104)).toBe('none');
    expect(pedalOf(0, 100)).toBe('brake');
    expect(pedalOf(37, 0)).toBe(37);
    expect(pedalOf(null, 0)).toBe('none');
  });

  it('shades the throttle colour by the amount pressed, never to black', () => {
    expect(throttleShade(100, '#5fb57c')).toBe('rgb(95,181,124)');
    expect(throttleShade(0, '#5fb57c')).toBe('rgb(14,27,19)');
  });

  it('gives a lap against the one before, signed', () => {
    expect(lapDelta(-0.1584)).toBe('−0.158');
    expect(lapDelta(0.036)).toBe('+0.036');
  });

  it('keeps the latest laps, and queries the completed ones only until the lap in progress', () => {
    const rows = [lapRow(9, 90_000, null), lapRow(8, 80_000, 10), lapRow(7, 70_000, 10)];
    const { driver, laps } = lapsOf(rows);
    expect(driver).toBe(1);
    expect(laps.map((l) => l.lap)).toEqual([7, 8, 9]);
    expect(pastParams(1, laps)).toEqual([1, 70_000, 90_000]);
    // Before a lap is completed, there's nothing to query.
    expect(pastParams(1, laps.slice(-1))).toEqual([1, 0, -1]);
    expect(lapsOf([]).driver).toBeNull();
  });

  it('places each lap by distance from the line, so a corner falls in one place whatever the lap time', () => {
    // A 1,000-unit square. Lap 7 at 100 units a second, lap 8 at 80, lap 9 at 100 and in progress.
    const outline = { x: [0, 250, 250, 0], y: [0, 0, 250, 250] };
    const corners = [{ number: 1, x: 250, y: 0, angle: 0, distance: 250 }];
    const at = (u: number) => {
      const s = ((u % 1000) + 1000) % 1000;
      if (s < 250) return { x: s, y: 0 };
      if (s < 500) return { x: 250, y: s - 250 };
      if (s < 750) return { x: 750 - s, y: 250 };
      return { x: 0, y: 1000 - s };
    };
    const u = (t: number) => (t < 10_000 ? t * 0.1 : t < 22_500 ? 1000 + (t - 10_000) * 0.08 : 2000 + (t - 22_500) * 0.1);
    const rows: Array<Record<string, unknown>> = [];
    for (let t = 0; t <= 25_000; t += 250) {
      rows.push({ date: t, throttle: null, brake: null, ...at(u(t)) });
      // Braking from 200 to 300 units into each lap; one sample with no reading in lap 8.
      const into = u(t) % 1000;
      const brake = into >= 200 && into < 300;
      rows.push({ date: t + 10, throttle: t === 15_000 ? 104 : brake ? 0 : 100, brake: t === 15_000 ? 104 : brake ? 100 : 0, x: null, y: null });
    }
    const laps = lapsOf([lapRow(7, 0, 10), lapRow(8, 10_000, 12.5), lapRow(9, 22_500, null)]).laps;
    const m = pedalModel(laps, rows, 25_000, { outline, corners });
    expect(m.length).toBe(1000);
    expect(m.corners).toEqual([{ number: 1, d: 250 }]);
    expect(m.laps.map((l) => [l.lap, l.done])).toEqual([
      [9, false],
      [8, true],
      [7, true],
    ]);
    const brakeStart = (lap: number) => m.laps.find((l) => l.lap === lap)!.cells.find((c) => c.pedal === 'brake')!.d0;
    expect(brakeStart(7)).toBeCloseTo(201, 0);
    expect(brakeStart(8)).toBeCloseTo(200.8, 0);
    expect(m.laps[1].cells.some((c) => c.pedal === 'none')).toBe(true);
    expect(m.now).toBeCloseTo(250);
    // Without positions, the lap in progress is placed by time, scaled to the last completed lap's.
    const blind = pedalModel(laps, rows.filter((r) => r.x === null || (r.date as number) < 22_500), 25_000, { outline, corners });
    expect(blind.now).toBeCloseTo(200);
  });
});

describe('the registry', () => {
  it('declares the charts the agent can suggest', () => {
    const byName = Object.fromEntries(components.map((c) => [c.name, c]));
    expect(byName.gap_evolution.sessions).toEqual(['race', 'sprint']);
    expect(byName.tyre_strategy.sessions).toEqual(['race', 'sprint']);
    expect(byName.gap_evolution.spec({ drivers: [44, 1] })).toEqual({ key: 'gap_evolution:44-1', label: 'Gap 44 · 1' });
    expect(byName.tyre_strategy.spec({})).toEqual({ key: 'tyre_strategy:all', label: 'Tyres' });
    expect(byName.timing_tower.spec({})).toEqual({ key: 'timing_tower', label: 'Timing' });
    expect(byName.field_pace.sessions).toEqual(['race', 'sprint']);
    expect(byName.pit_window.sessions).toEqual(['race', 'sprint']);
    expect(byName.pit_window.spec({ drivers: [44] })).toEqual({ key: 'pit_window:44', label: 'Pit window 44' });
    expect(byName.pit_windows.spec({})).toEqual({ key: 'pit_windows', label: 'Pit windows' });
    expect(byName.pit_stops.sessions).toEqual(['race', 'sprint']);
    expect(byName.sector_table.spec({ drivers: [44, 1] })).toEqual({ key: 'sector_table:44-1', label: 'Sectors 44 · 1' });
    expect(byName.pit_stops.spec({})).toEqual({ key: 'pit_stops:all', label: 'Pit stops' });
    expect(byName.race_control.spec({})).toEqual({ key: 'race_control', label: 'Race control' });
    expect(byName.race_status.spec({})).toEqual({ key: 'race_status', label: 'Race status' });
    for (const name of ['track_map', 'car_telemetry', 'pedal_barcode', 'speed_ribbon']) {
      expect(byName[name].replayOnly).toBe(true);
      expect(byName[name].needs).toEqual(['telemetry']);
    }
    expect(byName.track_map.spec({})).toEqual({ key: 'track_map:all', label: 'Track' });
    expect(byName.car_telemetry.spec({ drivers: [44] })).toEqual({ key: 'car_telemetry:44', label: 'Telemetry 44' });
    expect(byName.pedal_barcode.spec({ drivers: [44] })).toEqual({ key: 'pedal_barcode:44', label: 'Pedals 44' });
    expect(byName.pedal_barcode.spec({})).toEqual({ key: 'pedal_barcode:lead', label: 'Pedals' });
    expect(byName.speed_ribbon.spec({ drivers: [44] })).toEqual({ key: 'speed_ribbon:44', label: 'Speed ribbon 44' });
    expect(byName.speed_ribbon.spec({})).toEqual({ key: 'speed_ribbon:leader', label: 'Speed ribbon' });
    for (const gone of ['race_trace', 'speed_trace', 'lap_time_compare', 'position_chart', 'tyre_degradation', 'battle_card', 'stint_pace', 'telemetry_live']) expect(byName[gone]).toBeUndefined();
    expect(components).toHaveLength(15);
    // Every chart is for races only, to start with; video is for any session.
    for (const c of components) expect(c.sessions).toEqual(c.name === 'video' ? undefined : ['race', 'sprint']);
  });
});

describe('sizes', () => {
  const charts = components.filter((c) => c.name !== 'video');

  it('gives every chart a least size it draws in full at, and that a window can give it', () => {
    for (const c of charts) {
      const min = c.size?.min;
      expect(min, c.name).toBeDefined();
      // Below these a chart is compact: marks only, as in the suggestion strip.
      expect(min!.width, c.name).toBeGreaterThanOrEqual(300);
      expect(min!.height, c.name).toBeGreaterThanOrEqual(150);
      expect(min!.width, c.name).toBeLessThanOrEqual(480);
      expect(min!.height, c.name).toBeLessThanOrEqual(400);
      if (c.fit?.width) expect(c.fit.width, c.name).toBeGreaterThanOrEqual(min!.width);
      if (c.fit?.height) expect(c.fit.height, c.name).toBeGreaterThanOrEqual(min!.height);
    }
  });

  /** A 1600 by 900 window: the grid is about 1600 by 816 under the timeline. */
  const cell = { w: 1600 / 24, h: 34 };
  const specOf = (name: string, n: number): ComponentSpec => {
    const c = components.find((d) => d.name === name)!;
    return { type: name, key: `${name}:${n}`, label: name, props: {}, ...(c.size ? { size: c.size } : {}), ...(c.fit ? { fit: c.fit } : {}) };
  };
  const arrange = (names: string[]) => autoLayout(names.map(specOf).reduce(addTile, measure(EMPTY_LAYOUT, cell)));
  const short = (state: LayoutState) =>
    allTiles(state)
      .filter((t) => {
        const [w, h] = minCells(t.component.size, cell);
        return t.component.size && (t.w < w || t.h < h);
      })
      .map((t) => `${t.component.type} ${t.w}x${t.h}`);

  it('keeps every chart at its least size beside a video, alone', () => {
    for (const c of charts) expect(short(arrange(['video', c.name])), c.name).toEqual([]);
  });

  it('keeps them there in the arrangements a viewer builds', () => {
    const arrangements = [
      ['video', 'timing_tower', 'gap_evolution'],
      ['video', 'timing_tower', 'gap_evolution', 'tyre_strategy'],
      ['video', 'gap_evolution', 'tyre_strategy', 'timing_tower'],
      ['video', 'video', 'video', 'timing_tower', 'gap_evolution'],
      ['video', 'timing_tower', 'gap_evolution', 'tyre_strategy', 'sector_table', 'field_pace'],
      ['video', 'track_map', 'car_telemetry'],
      ['video', 'car_telemetry', 'pedal_barcode'],
      ['video', 'speed_ribbon', 'car_telemetry'],
      ['video', 'video', 'speed_ribbon', 'timing_tower'],
      ['video', 'race_control', 'pit_stops', 'race_status'],
      ['video', 'pit_window', 'field_pace', 'sector_table'],
      ['video', 'timing_tower', 'pit_windows'],
      ['video', 'pit_windows', 'pit_stops', 'race_control'],
      ['video', 'timing_tower', 'race_status', 'race_control'],
      ['timing_tower', 'gap_evolution', 'sector_table'],
    ];
    for (const names of arrangements) expect(short(arrange(names)), names.join(', ')).toEqual([]);
  });

  it('gives the main place to the video, and the timing tower a place beside it', () => {
    const state = arrange(['timing_tower', 'gap_evolution', 'video']);
    const by = Object.fromEntries(allTiles(state).map((t) => [t.component.type, t]));
    expect(by.video).toMatchObject({ x: 0, y: 0 });
    expect(by.timing_tower.x).toBeGreaterThanOrEqual(by.video.w);
  });
});
