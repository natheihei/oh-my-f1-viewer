import { describe, expect, it, vi } from 'vitest';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { gapModel } = await import('./GapEvolution');
const { tyreModel } = await import('./TyreStrategy');
const { towerModel } = await import('./TimingTower');
const { traceModel } = await import('./RaceTrace');
const { positionModel } = await import('./PositionChart');
const { compareModel } = await import('./LapTimeCompare');
const { degModel, fitLine, formatSlope } = await import('./TyreDegradation');
const { paceModel } = await import('./StintPace');
const { pitWindowModel, CLEAR_AIR } = await import('./PitWindow');
const { components } = await import('../registry');

const lap = (n: number, date: number): Record<string, unknown> => ({ kind: 'lap', n, date, gap: null });
const gap = (driver: number, date: number, value: unknown) => ({ kind: 'gap', n: driver, date, gap: value });

describe('gap_evolution', () => {
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

  it('gives the trend over the last three laps, as the gap grows or shrinks', () => {
    const rows = [lap(1, 0), lap(2, 100), lap(3, 200), lap(4, 300), lap(5, 400)];
    rows.push(gap(44, 0, 0), gap(1, 0, 3), gap(1, 400, 1.5));
    const m = gapModel(rows, [44, 1]);
    expect(m.trend).toBeCloseTo(-0.375);
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
      { driver: 4, position: 1, gap: 'LAP 31', interval: '', last: '1:32.345', compound: 'MEDIUM', age: 19 },
      { driver: 1, position: 2, gap: '+1.200', interval: '+1.200', last: '1:32.345', compound: 'MEDIUM', age: 19 },
      { driver: 44, position: 3, gap: '+1 LAP', interval: '+20.500', last: '', compound: null, age: null },
    ]);
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

  it('shades the neutralised laps', () => {
    const rows = [ls(1, 1, { date_end: 1 }), ls(1, 2, { date_end: 2, track_status: 'SCDeployed' })];
    expect(traceModel(rows).bands).toEqual([{ first: 2, last: 2, kind: 'SC' }]);
  });
});

describe('position_chart', () => {
  const grid = (driver_number: number, position: number | null) => ({ driver_number, position, lap_duration: null });

  it('starts from the grid and orders the lines by latest position', () => {
    const rows = [ls(1, 1, { position: 1 }), ls(44, 1, { position: 2 }), ls(1, 2, { position: 2 }), ls(44, 2, { position: 1 })];
    const m = positionModel(rows, [grid(44, 1), grid(1, 2), grid(16, null)]);
    expect(m.lap).toBe(2);
    expect(m.cars).toBe(3);
    expect(m.lines).toEqual([
      { driver: 44, points: [{ lap: 0, position: 1 }, { lap: 1, position: 2 }, { lap: 2, position: 1 }] },
      { driver: 1, points: [{ lap: 0, position: 2 }, { lap: 1, position: 1 }, { lap: 2, position: 2 }] },
    ]);
  });

  it('puts a car that stopped below those still running, and works without a grid', () => {
    const rows = [ls(1, 1, { position: 1 }), ls(4, 1, { position: 2 }), ls(1, 2, { position: 1 })];
    expect(positionModel(rows, []).lines.map((l) => l.driver)).toEqual([1, 4]);
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

describe('tyre_degradation', () => {
  it('fits a line through clean laps only, per stint', () => {
    const rows = [
      ls(44, 1, { tyre_age: 1, lap_duration: 99 }),
      ...[2, 3, 4, 5, 6].map((n) => ls(44, n, { tyre_age: n, lap_duration: 90 + 0.05 * n })),
      ls(44, 7, { tyre_age: 7, lap_duration: 90.35, is_pit_in_lap: 1 }),
      ls(44, 8, { stint_number: 2, compound: 'HARD', tyre_age: 1, lap_duration: 110, is_pit_out_lap: 1 }),
      // Four clean laps: too few for a line.
      ...[9, 10, 11, 12].map((n) => ls(44, n, { stint_number: 2, compound: 'HARD', tyre_age: n - 7, lap_duration: 90 })),
    ];
    const m = degModel(rows, [44]);
    expect(m.stints).toHaveLength(2);
    expect(m.stints[0].laps.map((l) => l.age)).toEqual([2, 3, 4, 5, 6]);
    expect(m.stints[0].fit?.slope).toBeCloseTo(0.05);
    expect(m.stints[1]).toMatchObject({ compound: 'HARD', fit: null });
    expect(m.maxAge).toBe(6);
  });

  it('orders the picked drivers by their rank', () => {
    const rows = [ls(16, 2, { rank: 2 }), ls(4, 2, { rank: 1 }), ls(81, 2, { rank: 3 })];
    expect(degModel(rows).stints.map((s) => s.driver)).toEqual([4, 16, 81]);
  });

  it('fits and writes slopes', () => {
    expect(fitLine([{ age: 1, time: 1 }, { age: 2, time: 2 }])).toBeNull();
    expect(fitLine([{ age: 1, time: 1 }, { age: 1, time: 2 }, { age: 1, time: 3 }])).toBeNull();
    expect(fitLine([{ age: 0, time: 1 }, { age: 1, time: 3 }, { age: 2, time: 5 }])).toEqual({ slope: 2, intercept: 1 });
    expect(formatSlope(0.0351)).toBe('+0.035');
    expect(formatSlope(-0.012)).toBe('−0.012');
  });
});

describe('stint_pace', () => {
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

  it('gives a car that has stopped a dash, even with recent clean laps', () => {
    const rows = [...[2, 3, 4, 5].map((n) => ls(4, n, { lap_duration: 90 })), ...Array.from({ length: 7 }, (_, i) => ls(1, i + 2, { lap_duration: 91 }))];
    expect(paceModel(rows).map((r) => [r.driver, r.pace])).toEqual([[1, 91], [4, null]]);
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
    // Retired: its last lap started four laps before the field's latest.
    ls(99, 3, { date_start: T0 + 2 * LAP, lap_duration: null, position: 8, gap_to_leader: 40 }),
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

  it('draws the ring but plays nothing out without a pit loss, or for a car that has stopped', () => {
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

describe('the registry', () => {
  it('declares the charts the agent can suggest', () => {
    const byName = Object.fromEntries(components.map((c) => [c.name, c]));
    expect(byName.gap_evolution.sessions).toEqual(['race', 'sprint']);
    expect(byName.tyre_strategy.sessions).toEqual(['race', 'sprint']);
    expect(byName.timing_tower.sessions).toBeUndefined();
    expect(byName.gap_evolution.spec({ drivers: [44, 1] })).toEqual({ key: 'gap_evolution:44-1', label: 'Gap 44 · 1' });
    expect(byName.tyre_strategy.spec({})).toEqual({ key: 'tyre_strategy:all', label: 'Tyres' });
    expect(byName.timing_tower.spec({})).toEqual({ key: 'timing_tower', label: 'Timing' });
    for (const name of ['race_trace', 'position_chart', 'tyre_degradation', 'stint_pace']) expect(byName[name].sessions).toEqual(['race', 'sprint']);
    expect(byName.lap_time_compare.sessions).toBeUndefined();
    expect(byName.race_trace.spec({})).toEqual({ key: 'race_trace:all', label: 'Race trace' });
    expect(byName.lap_time_compare.spec({ drivers: [44, 1] })).toEqual({ key: 'lap_time_compare:44-1', label: 'Lap times 44 · 1' });
    expect(byName.tyre_degradation.spec({})).toEqual({ key: 'tyre_degradation:top', label: 'Deg' });
    expect(byName.pit_window.sessions).toEqual(['race', 'sprint']);
    expect(byName.pit_window.spec({ drivers: [44] })).toEqual({ key: 'pit_window:44', label: 'Pit window 44' });
  });
});
