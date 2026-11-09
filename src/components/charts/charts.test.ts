import { describe, expect, it, vi } from 'vitest';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { gapModel } = await import('./GapEvolution');
const { tyreModel } = await import('./TyreStrategy');
const { towerModel } = await import('./TimingTower');
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

  it('leaves the gaps blank in a session without them', () => {
    const [leader, second] = towerModel([row(4, 1, null, null, { gap_date: null }), row(1, 2, null, null, { gap_date: null })]);
    expect(leader.gap).toBe('');
    expect(second.gap).toBe('');
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
  });
});
