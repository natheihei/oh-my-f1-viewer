import { describe, expect, it, vi } from 'vitest';
import type { SqlView } from './useSql';

// The live state pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));
const { nextView, sameRows } = await import('./useSql');

const ready = (rows: Array<Record<string, unknown>>, columns = ['a', 'b']): SqlView => ({ state: 'ready', columns, rows });

describe('useSql results', () => {
  it('keeps the previous view when the rows are the same', () => {
    const before = ready([{ a: 1, b: 'x' }, { a: 2, b: null }]);
    const after = ready([{ a: 1, b: 'x' }, { a: 2, b: null }]);
    expect(nextView(before, after)).toBe(before);
  });

  it('takes the new view when anything differs', () => {
    const before = ready([{ a: 1, b: 'x' }]);
    for (const after of [ready([{ a: 1, b: 'y' }]), ready([{ a: 1, b: 'x' }, { a: 2, b: 'x' }]), ready([{ a: 1, b: 'x' }], ['a', 'c']), ready([])]) {
      expect(nextView(before, after)).toBe(after);
    }
  });

  it('compares lists by value', () => {
    expect(sameRows({ columns: ['s'], rows: [{ s: [2048, 2049] }] }, { columns: ['s'], rows: [{ s: [2048, 2049] }] })).toBe(true);
    expect(sameRows({ columns: ['s'], rows: [{ s: [2048] }] }, { columns: ['s'], rows: [{ s: [2049] }] })).toBe(false);
  });

  it('tells 0 from null and a number from its text', () => {
    expect(sameRows({ columns: ['a'], rows: [{ a: 0 }] }, { columns: ['a'], rows: [{ a: null }] })).toBe(false);
    expect(sameRows({ columns: ['a'], rows: [{ a: 1 }] }, { columns: ['a'], rows: [{ a: '1' }] })).toBe(false);
  });

  it('keeps a loading or failed view that has not changed', () => {
    const loading: SqlView = { state: 'loading' };
    expect(nextView(loading, { state: 'loading' })).toBe(loading);
    const failed: SqlView = { state: 'failed', reason: 'no such table' };
    expect(nextView(failed, { state: 'failed', reason: 'no such table' })).toBe(failed);
    const other: SqlView = { state: 'failed', reason: 'syntax error' };
    expect(nextView(failed, other)).toBe(other);
    const rows = ready([]);
    expect(nextView(failed, rows)).toBe(rows);
  });
});
