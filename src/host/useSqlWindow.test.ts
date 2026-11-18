import { describe, expect, it, vi } from 'vitest';
import type { Held, WindowAsk } from './useSqlWindow';

// The live state pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));
const { mergeRows, nextRead } = await import('./useSqlWindow');

const ask = (from: number, to: number, change: Partial<WindowAsk> = {}): WindowAsk => ({ sql: 'Q', key: '[44]', revision: '1:7', from, to, ...change });
const held = (from: number, to: number, change: Partial<WindowAsk> = {}): Held => ({ ...ask(from, to, change), columns: ['date'], rows: [] });
const dated = (...dates: number[]) => dates.map((date) => ({ date }));

describe('useSqlWindow reads', () => {
  it('reads the whole window the first time', () => {
    expect(nextRead(null, ask(1000, 5000))).toEqual({ kind: 'all', lo: 1000, hi: 5000 });
  });

  it('reads only after the last read as the window moves on', () => {
    expect(nextRead(held(1000, 5000), ask(1100, 5100))).toEqual({ kind: 'new', lo: 5000, hi: 5100 });
    // Never past the playhead it's asked for.
    expect(nextRead(held(1000, 5000), ask(1000, 5000))).toEqual({ kind: 'new', lo: 5000, hi: 5000 });
  });

  it('reads it all again on a new revision, query, parameters or session', () => {
    for (const change of [{ revision: '1:8' }, { revision: '2:7' }, { sql: 'R' }, { key: '[16]' }]) {
      expect(nextRead(held(1000, 5000), ask(1100, 5100, change))).toEqual({ kind: 'all', lo: 1100, hi: 5100 });
    }
  });

  it('reads it all again when the playhead goes back, the window starts earlier, or it jumps past the window', () => {
    expect(nextRead(held(1000, 5000), ask(900, 4900)).kind).toBe('all');
    expect(nextRead(held(1000, 5000), ask(500, 5100)).kind).toBe('all');
    expect(nextRead(held(1000, 5000), ask(5000, 9000))).toEqual({ kind: 'all', lo: 5000, hi: 9000 });
  });
});

describe('useSqlWindow rows', () => {
  it('drops the rows that fell out of the window and adds the new ones', () => {
    expect(mergeRows(dated(1, 2, 3), dated(4, 5), 2)).toEqual(dated(3, 4, 5));
    // Dated exactly `from` is out: the window is after it.
    expect(mergeRows(dated(1, 2, 2, 3), [], 2)).toEqual(dated(3));
  });

  it('keeps the same rows when nothing changed', () => {
    const rows = dated(1, 2, 3);
    expect(mergeRows(rows, [], 0)).toBe(rows);
    expect(mergeRows(rows, [], 1)).not.toBe(rows);
  });

  it('gives what reading the whole window would', () => {
    const all = dated(...Array.from({ length: 60 }, (_, i) => 1000 + i * 260));
    const window = (from: number, to: number) => all.filter((r) => r.date > from && r.date <= to);
    let rows: Array<Record<string, unknown>> = window(0, 5000);
    let last = 5000;
    for (let to = 5100; to <= 12_000; to += 100) {
      rows = mergeRows(rows, window(last, to), to - 5000);
      last = to;
      expect(rows).toEqual(window(to - 5000, to));
    }
  });
});
