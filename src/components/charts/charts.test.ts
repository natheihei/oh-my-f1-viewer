import { describe, expect, it, vi } from 'vitest';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { gapModel } = await import('./GapEvolution');
const { tyreModel } = await import('./TyreStrategy');
const { towerModel } = await import('./TimingTower');
const { traceModel } = await import('./RaceTrace');
const { compareModel, fitLine, formatSlope } = await import('./LapTimeCompare');
const { paceModel } = await import('./FieldPace');
const { pitWindowModel, CLEAR_AIR } = await import('./PitWindow');
const { sectorModel, spanOf } = await import('./SectorDelta');
const { stopsModel } = await import('./PitStops');
const { messagesModel, signalOf, wrap } = await import('./RaceControl');
const { weatherModel } = await import('./Weather');
const { trackModel, placeLabels } = await import('./TrackMap');
const { pickLaps, speedParams, speedModel } = await import('./SpeedTrace');
const { telemetryModel } = await import('./CarTelemetry');
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

  it('takes out a brief spike when the leader changes, but keeps a pit stop', () => {
    const rows: Array<Record<string, unknown>> = [lap(1, 0), gap(44, 0, 0)];
    const b = [2, 2.1, 2.2, 25, 2.3, 2.4, 2.5, 22, 22, 22, 22, 22, 2.6];
    b.forEach((g, i) => rows.push(gap(1, i * 1000 + 1, g)));
    const gaps = gapModel(rows, [44, 1]).points.map((p) => p?.gap);
    expect(gaps[3]).toBeCloseTo(2.3);
    expect(gaps.filter((g) => g === 22)).toHaveLength(5);
    expect(gaps.at(-1)).toBeCloseTo(2.6);
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
        stints: [
          { from: 0, to: 16, compound: 'MEDIUM', age: 16, open: false },
          { from: 16, to: 31, compound: 'HARD', age: 15, open: true },
        ],
      },
      { driver: 44, stints: [{ from: 0, to: 31, compound: 'HARD', age: 34, open: true }] },
    ]);
  });

  it('copes with a stint that has no end yet', () => {
    expect(tyreModel([stint(1, 1, 1, null, 'SOFT')]).rows[0].stints[0]).toMatchObject({ from: 0, to: 1, open: true });
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
      { driver: 4, position: 1, gained: null, gap: 'LAP 31', interval: '', last: '1:32.345', compound: 'MEDIUM', age: 19, out: false },
      { driver: 1, position: 2, gained: null, gap: '+1.200', interval: '+1.200', last: '1:32.345', compound: 'MEDIUM', age: 19, out: false },
      { driver: 44, position: 3, gained: null, gap: '+1 LAP', interval: '+20.500', last: '', compound: null, age: null, out: false },
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

describe('race_trace', () => {
  it("measures each car's gap from when it ended the same lap as whoever ended it first", () => {
    const rows = [
      ls(44, 1, { date_end: 100_000 }),
      ls(1, 1, { date_end: 101_500 }),
      ls(44, 2, { date_end: 192_000 }),
      ls(1, 2, { date_end: 191_000 }),
      // A lapped car ends lap 2 after the leader's lap 3: still a time, never "+1 LAP".
      ls(18, 1, { date_end: 130_000 }),
      ls(18, 2, { date_end: 300_000 }),
      ls(1, 3, { date_end: 283_000 }),
    ];
    const m = traceModel(rows);
    expect(m.lap).toBe(3);
    expect(m.lines.map((l) => l.driver)).toEqual([1, 44, 18]);
    expect(m.lines[0].points).toEqual([
      { lap: 1, gap: 1.5 },
      { lap: 2, gap: 0 },
      { lap: 3, gap: 0 },
    ]);
    expect(m.lines[2].points).toEqual([
      { lap: 1, gap: 30 },
      { lap: 2, gap: 109 },
    ]);
  });

  it('fits most of the field and lets the back of it run off, unless asked for', () => {
    // Ten cars 3 seconds apart on laps of 100 seconds, and one a lap and more behind.
    const rows = [1, 2].flatMap((lap) => Array.from({ length: 10 }, (_, i) => ls(i + 1, lap, { date_end: lap * 100_000 + i * 3000 })));
    rows.push(ls(99, 1, { date_end: 100_000 + 120_000 }));
    expect(traceModel(rows).yMax).toBe(20);
    expect(traceModel(rows, [99]).yMax).toBe(120);
  });

  it("leaves a retired car's line where it stopped, out of the range", () => {
    // Ten cars 3 seconds apart; the last six retired, and their unfinished lap isn't a point.
    const rows = Array.from({ length: 10 }, (_, i) => ls(i + 1, 1, { date_end: 100_000 + i * 3000 }));
    rows.push(...[5, 6, 7, 8, 9, 10].map((d) => ls(d, 2, { date_end: null, is_out: 1 })));
    const m = traceModel(rows);
    expect(m.lines.find((l) => l.driver === 10)!.points).toEqual([{ lap: 1, gap: 27 }]);
    expect(m.yMax).toBe(10);
  });

  it('shades the neutralised laps', () => {
    const rows = [ls(1, 1, { date_end: 1 }), ls(1, 2, { date_end: 2, track_status: 'SCDeployed' })];
    expect(traceModel(rows).bands).toEqual([{ first: 2, last: 2, kind: 'SC' }]);
  });
});

describe('lap_time_compare', () => {
  it('draws racing laps and breaks the line at a stop and a safety car', () => {
    const rows = [
      ls(44, 1, { lap_duration: 99 }),
      ls(44, 2, { lap_duration: 93 }),
      ls(44, 3, { lap_duration: 92.8, is_pit_in_lap: 1 }),
      ls(44, 4, { lap_duration: 112, is_pit_out_lap: 1, compound: 'HARD', tyre_age: 1 }),
      ls(44, 5, { lap_duration: 92.5, compound: 'HARD', tyre_age: 2 }),
      ls(44, 6, { lap_duration: 118, track_status: 'SCDeployed', compound: 'HARD', tyre_age: 3 }),
      ls(44, 7, { lap_duration: 92.4, compound: 'HARD', tyre_age: 4 }),
      ls(44, 8, { lap_duration: null, compound: 'HARD', tyre_age: 5 }),
      ls(1, 2, { lap_duration: 92.9 }),
    ];
    const m = compareModel(rows, [44, 1]);
    expect(m.lap).toBe(7);
    expect(m.range).toEqual([92.4, 93]);
    expect(m.series[0]).toEqual({
      driver: 44,
      laps: [
        { lap: 2, time: 93 },
        { lap: 5, time: 92.5 },
        { lap: 7, time: 92.4 },
      ],
      pits: [3],
      trends: [],
      compound: 'HARD',
      // The lap in progress isn't counted, as in the timing tower.
      age: 4,
    });
    expect(m.series[1].laps).toEqual([{ lap: 2, time: 92.9 }]);
    expect(m.bands).toEqual([{ first: 6, last: 6, kind: 'SC' }]);
  });

  it('has no range before a clean lap', () => {
    expect(compareModel([ls(44, 1, { lap_duration: 99 })], [44]).range).toBeNull();
  });
});

describe('lap_time_compare trends', () => {
  it('fits a line through the clean laps of each stint, by tyre age', () => {
    const rows = [
      ls(44, 1, { tyre_age: 1, lap_duration: 99 }),
      ...[2, 3, 4, 5, 6].map((n) => ls(44, n, { tyre_age: n, lap_duration: 90 + 0.05 * n })),
      ls(44, 7, { tyre_age: 7, lap_duration: 90.35, is_pit_in_lap: 1 }),
      ls(44, 8, { stint_number: 2, compound: 'HARD', tyre_age: 1, lap_duration: 110, is_pit_out_lap: 1 }),
      // Four clean laps: too few for a line.
      ...[9, 10, 11, 12].map((n) => ls(44, n, { stint_number: 2, compound: 'HARD', tyre_age: n - 7, lap_duration: 90 })),
    ];
    const { trends } = compareModel(rows, [44]).series[0];
    expect(trends).toHaveLength(1);
    expect(trends[0].slope).toBeCloseTo(0.05);
    expect(trends[0].from).toEqual({ lap: 2, time: expect.closeTo(90.1) });
    expect(trends[0].to).toEqual({ lap: 6, time: expect.closeTo(90.3) });
  });

  it('orders the drivers it picked by their rank', () => {
    const rows = [ls(16, 2, { rank: 2 }), ls(4, 2, { rank: 1 }), ls(81, 2, { rank: 3 })];
    expect(compareModel(rows).series.map((s) => s.driver)).toEqual([4, 16, 81]);
  });

  it('fits and writes slopes', () => {
    expect(fitLine([{ age: 1, time: 1 }, { age: 2, time: 2 }])).toBeNull();
    expect(fitLine([{ age: 1, time: 1 }, { age: 1, time: 2 }, { age: 1, time: 3 }])).toBeNull();
    expect(fitLine([{ age: 0, time: 1 }, { age: 1, time: 3 }, { age: 2, time: 5 }])).toEqual({ slope: 2, intercept: 1 });
    expect(formatSlope(0.0351)).toBe('+0.035');
    expect(formatSlope(-0.012)).toBe('−0.012');
  });
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

  it('has no ring before there is a clean lap', () => {
    const m = pitWindowModel([running(1, 1, null), running(44, 2, 1.5)], 44, 20);
    expect(m.lapTime).toBeNull();
    expect(m.out).toMatchObject({ position: 2, behind: { driver: 1, by: 21.5 } });
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

describe('sector_delta', () => {
  const rows: Array<Record<string, unknown>> = [];
  for (let lap = 1; lap <= 12; lap++) {
    rows.push(sec(44, lap, [30, 40, 20]));
    rows.push(sec(1, lap, [30.2, 39.9, 20], lap === 7 ? { is_pit_in_lap: 1 } : lap === 9 ? { track_status: 'VSCDeployed' } : {}));
  }
  // The lap in progress: both have the first sector, only one the second.
  rows.push(sec(44, 13, [30, 40, null]), sec(1, 13, [30.1, null, null]));

  it('shows the last ten laps both have started, positive where the first driver was faster', () => {
    const m = sectorModel(rows, [44, 1]);
    expect(m.laps).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(m.deltas[0][0]).toBeCloseTo(0.2);
    expect(m.deltas[1][0]).toBeCloseTo(-0.1);
    expect(m.deltas[2][0]).toBe(0);
    expect(m.deltas[0][9]).toBeCloseTo(0.1);
    expect(m.deltas[1][9]).toBeNull();
  });

  it('leaves pit laps and neutralised laps empty, and averages the rest', () => {
    const m = sectorModel(rows, [44, 1]);
    expect(m.skipped).toEqual([null, null, null, 'PIT', null, 'VSC', null, null, null, null]);
    expect(m.deltas.map((row) => row[3])).toEqual([null, null, null]);
    expect(m.averages[0]).toBeCloseTo((0.2 * 7 + 0.1) / 8);
    expect(m.averages[1]).toBeCloseTo(-0.1);
  });

  it('counts an out-lap of either driver as a pit lap', () => {
    const out = rows.map((r) => (r.driver_number === 44 && r.lap_number === 12 ? { ...r, is_pit_out_lap: 1 } : r));
    expect(sectorModel(out, [44, 1]).skipped[8]).toBe('PIT');
  });

  it('has nothing before both have a sector, and scales between 0.2 and 1 second', () => {
    expect(sectorModel([sec(44, 1, [30, null, null])], [44, 1]).laps).toEqual([]);
    expect(spanOf([[0.04, null], [-0.1]])).toBe(0.2);
    expect(spanOf([[0.34]])).toBe(0.4);
    expect(spanOf([[-8]])).toBe(1);
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
  const rc = (lap: number, category: string, flag: string | null, message: string, driver: number | null = null) => ({
    lap_number: lap,
    category,
    flag,
    message,
    driver_number: driver,
  });

  it('gives each message the colour of its flag, and a safety car the yellow', () => {
    expect(signalOf(rc(1, 'Flag', 'DOUBLE YELLOW', ''))).toBe('yellow');
    expect(signalOf(rc(1, 'Flag', 'CLEAR', ''))).toBe('green');
    expect(signalOf(rc(1, 'SafetyCar', null, 'VSC DEPLOYED'))).toBe('yellow');
    expect(signalOf(rc(1, 'Flag', 'BLACK AND WHITE', ''))).toBe('blackwhite');
    expect(signalOf(rc(1, 'Flag', 'CHEQUERED', ''))).toBe('chequered');
    expect(signalOf(rc(1, 'Other', null, 'CAR 1 (NOR) TIME 1:41.931 DELETED'))).toBe('note');
  });

  it('collapses each run of blue flags into one line, keeping the messages as issued', () => {
    const rows = [
      rc(30, 'Flag', 'BLUE', 'WAVED BLUE FLAG FOR CAR 11 (PER)', 11),
      rc(30, 'Flag', 'BLUE', 'WAVED BLUE FLAG FOR CAR 87 (BEA)', 87),
      rc(29, 'Flag', 'BLUE', 'WAVED BLUE FLAG FOR CAR 11 (PER)', 11),
      rc(28, 'Other', null, 'TRACK SURFACE SLIPPERY IN TRACK SECTOR 12'),
      rc(27, 'Flag', 'BLUE', 'WAVED BLUE FLAG FOR CAR 43 (COL)', 43),
    ];
    expect(messagesModel(rows)).toEqual([
      { kind: 'blue', lap: 30, count: 3, drivers: [11, 87] },
      { kind: 'message', lap: 28, signal: 'note', text: 'TRACK SURFACE SLIPPERY IN TRACK SECTOR 12' },
      { kind: 'blue', lap: 27, count: 1, drivers: [43] },
    ]);
    expect(messagesModel(rows, true)).toHaveLength(5);
  });

  it('wraps a message to the lines it may take, the last taking the rest', () => {
    const measure = (s: string) => s.length;
    expect(wrap(measure, 'FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 63', 14, 2)).toEqual(['FIA STEWARDS:', '5 SECOND TIME PENALTY FOR CAR 63']);
    expect(wrap(measure, 'TRACK CLEAR', 20, 2)).toEqual(['TRACK CLEAR']);
    expect(wrap(measure, 'DOUBLE YELLOW IN TRACK SECTOR 2', 10, 1)).toEqual(['DOUBLE YELLOW IN TRACK SECTOR 2']);
  });
});

describe('weather', () => {
  const w = (date: number, track: number, rainfall = 0) => ({
    date,
    track_temperature: track,
    air_temperature: 26.9,
    wind_speed: 3.1,
    humidity: 42.3,
    rainfall,
  });

  it('draws each measure on its own scale, at least its span wide, with the latest value', () => {
    const m = weatherModel([w(0, 38.3), w(60, 37), w(120, 34.1)]);
    expect(m.from).toBe(0);
    expect(m.to).toBe(120);
    const [track, air] = m.series;
    expect(track.current).toBe(34.1);
    expect(track.range[0]).toBeCloseTo(34.1);
    expect(track.range[1]).toBeCloseTo(38.3);
    expect(air.range).toEqual([25.9, 27.9]);
    expect(m.raining).toBe(false);
    expect(m.rain).toEqual([]);
  });

  it('leaves out a temperature of exactly 0, which the feed sends between real readings', () => {
    const [track] = weatherModel([w(0, 36), w(60, 0), w(120, 37)]).series;
    expect(track.points.map((p) => p.v)).toEqual([36, 37]);
    expect(track.range).toEqual([34.5, 38.5]);
  });

  it('fills the rain strip while rainfall is reported, until the next reading', () => {
    const m = weatherModel([w(0, 30), w(60, 30, 1), w(120, 30, 1), w(180, 30), w(240, 30, 1)]);
    expect(m.rain).toEqual([
      [60, 180],
      [240, 240],
    ]);
    expect(m.raining).toBe(true);
    expect(weatherModel([]).raining).toBeNull();
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

describe('speed_trace', () => {
  const lap = (driver_number: number, lap_number: number, date_start: number, more: Record<string, unknown> = {}) => ({
    driver_number,
    lap_number,
    date_start,
    lap_duration: 10,
    is_pit_in_lap: 0,
    is_pit_out_lap: 0,
    track_status: 'AllClear',
    ...more,
  });

  it("takes each driver's last completed lap, or the latest clean one when that isn't", () => {
    const rows = [lap(1, 4, 30_000), lap(1, 5, 40_000), lap(44, 4, 31_000), lap(44, 5, 41_000, { is_pit_in_lap: 1 }), lap(16, 1, 0)];
    expect(pickLaps(rows, [1, 44])).toEqual([
      { driver: 1, lap: 5, start: 40_000, end: 50_000, latest: true },
      { driver: 44, lap: 4, start: 31_000, end: 41_000, latest: false },
    ]);
    expect(pickLaps(rows, [16, 1])[0]).toBeNull();
    expect(speedParams(pickLaps(rows, [16, 1]), [16, 1])).toEqual([16, 0, -1, 1, 37_000, 53_000]);
  });

  it('runs each lap between its own crossings of the line, scaled to the outline, and compares them at the same distance', () => {
    // A 1,000-unit square, 100 m round. Car 1 does 10 m/s, car 44 8 m/s; both cross the line 0.3 s before the timing says.
    const outline = { x: [0, 250, 250, 0], y: [0, 0, 250, 250] };
    const corners = [{ number: 1, x: 250, y: 0, angle: 0, distance: 250 }];
    const at = (u: number) => {
      const s = ((u % 1000) + 1000) % 1000;
      if (s < 250) return { x: s, y: 0 };
      if (s < 500) return { x: 250, y: s - 250 };
      if (s < 750) return { x: 750 - s, y: 250 };
      return { x: 0, y: 1000 - s };
    };
    const rows: Array<Record<string, unknown>> = [];
    for (const [driver, v, start] of [
      [1, 100, 10_000],
      [44, 80, 10_000],
    ]) {
      for (let date = start - 2000; date <= start + 1000 * (1000 / v) + 2000; date += 250) {
        const u = ((date - start) / 1000) * v;
        rows.push({ driver_number: driver, date, ...at(u), speed: null });
        rows.push({ driver_number: driver, date: date + 100, x: null, y: null, speed: v * 0.36 });
      }
    }
    const picks = pickLaps([lap(1, 5, 10_300), lap(44, 5, 10_300, { lap_duration: 12.5 })], [1, 44]);
    const m = speedModel(picks, rows, { outline, corners });
    expect(m.length).toBe(100);
    expect(m.corners).toEqual([{ number: 1, d: 25 }]);
    const [a, b] = m.laps;
    expect(a!.lapTime).toBeCloseTo(10);
    expect(b!.lapTime).toBeCloseTo(12.5);
    expect(a!.speed[0].d).toBe(0);
    expect(a!.speed.at(-1)!.d).toBeCloseTo(100);
    expect(a!.speed.every((p) => p.speed === 36)).toBe(true);
    expect(m.delta.at(-1)!.delta).toBeCloseTo(2.5);
    expect(m.delta[200].delta).toBeCloseTo(1.25);
    // Without positions round a whole lap, nothing to draw for that driver.
    expect(speedModel(picks, rows.filter((r) => r.driver_number === 1), { outline, corners }).laps[1]).toBeNull();
  });
});

describe('car_telemetry', () => {
  const sample = (date: number, more: Record<string, unknown> = {}) => ({ date, speed: 300, rpm: 11420, n_gear: 8, throttle: 100, brake: 0, drs: null, ...more });

  it('shows the latest sample, with the minute before it as a trace broken at gaps', () => {
    const m = telemetryModel([sample(0, { speed: 100 }), sample(1000), sample(5000, { speed: 250, brake: 104, throttle: 104 })]);
    expect(m).toMatchObject({ speed: 250, gear: 8, rpm: 11420, throttle: 100, brake: 100, drs: null });
    expect(m.trace).toEqual([{ t: -5, speed: 100 }, { t: -4, speed: 300 }, null, { t: 0, speed: 250 }]);
    expect(telemetryModel([]).speed).toBeNull();
  });

  it("reads DRS only when the channel holds DRS's own codes", () => {
    expect(telemetryModel([sample(0, { drs: 8 }), sample(1000, { drs: 12 })]).drs).toBe('open');
    expect(telemetryModel([sample(0, { drs: 0 }), sample(1000, { drs: 8 })]).drs).toBe('available');
    expect(telemetryModel([sample(0, { drs: 1 }), sample(1000, { drs: 1 })]).drs).toBe('off');
    // 2026's cars have no DRS, and the channel carries other codes.
    expect(telemetryModel([sample(0, { drs: 17 }), sample(1000, { drs: 1 })]).drs).toBeNull();
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
    for (const name of ['race_trace', 'field_pace']) expect(byName[name].sessions).toEqual(['race', 'sprint']);
    expect(byName.race_trace.spec({})).toEqual({ key: 'race_trace:all', label: 'Race trace' });
    expect(byName.lap_time_compare.spec({ drivers: [44, 1] })).toEqual({ key: 'lap_time_compare:44-1', label: 'Lap times 44 · 1' });
    expect(byName.lap_time_compare.spec({})).toEqual({ key: 'lap_time_compare:top', label: 'Lap times' });
    expect(byName.pit_window.sessions).toEqual(['race', 'sprint']);
    expect(byName.pit_window.spec({ drivers: [44] })).toEqual({ key: 'pit_window:44', label: 'Pit window 44' });
    expect(byName.pit_stops.sessions).toEqual(['race', 'sprint']);
    expect(byName.sector_delta.spec({ drivers: [44, 1] })).toEqual({ key: 'sector_delta:44-1', label: 'Sectors 44 · 1' });
    expect(byName.pit_stops.spec({})).toEqual({ key: 'pit_stops:all', label: 'Pit stops' });
    expect(byName.race_control.spec({})).toEqual({ key: 'race_control', label: 'Race control' });
    expect(byName.weather.spec({})).toEqual({ key: 'weather', label: 'Weather' });
    for (const name of ['track_map', 'speed_trace', 'car_telemetry']) {
      expect(byName[name].replayOnly).toBe(true);
      expect(byName[name].needs).toEqual(['telemetry']);
    }
    expect(byName.track_map.spec({})).toEqual({ key: 'track_map:all', label: 'Track' });
    expect(byName.speed_trace.spec({ drivers: [44, 1] })).toEqual({ key: 'speed_trace:44-1', label: 'Speed 44 · 1' });
    expect(byName.car_telemetry.spec({ drivers: [44] })).toEqual({ key: 'car_telemetry:44', label: 'Telemetry 44' });
    for (const gone of ['position_chart', 'tyre_degradation', 'battle_card', 'stint_pace', 'telemetry_live']) expect(byName[gone]).toBeUndefined();
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
      ['video', 'timing_tower', 'gap_evolution', 'tyre_strategy', 'lap_time_compare', 'race_trace'],
      ['video', 'track_map', 'car_telemetry', 'speed_trace'],
      ['video', 'race_control', 'pit_stops', 'weather'],
      ['video', 'pit_window', 'field_pace', 'sector_delta'],
      ['timing_tower', 'gap_evolution', 'lap_time_compare'],
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
