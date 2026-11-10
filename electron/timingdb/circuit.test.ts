import { describe, expect, it, vi } from 'vitest';
import type { Circuit, CircuitView } from '../../shared/sessionData';
import { circuitUrl, parseCircuit, refreshCircuit, type CircuitRefresh } from './circuit';

// The shape MultiViewer answered with for circuit 9, cut down to a few points.
const AUSTIN = {
  pitLoss: { normal: '20.81', sc: '13.50', vsc: '14.34' },
  corners: [
    { angle: -44.65, length: 6420.3, number: 1, trackPosition: { x: 3743.5, y: -4013.4 } },
    { angle: 120, length: 900, number: 2, trackPosition: { x: 100, y: 200 } },
    { angle: 10, number: 3 },
  ],
  marshalSectors: [],
  candidateLap: {},
  circuitKey: 9,
  circuitName: 'Austin',
  miniSectorsIndexes: [],
  rotation: 0,
  x: [1, 2, 3, 4],
  y: [5, 6, 7, 8],
  year: 2021,
};

describe('parseCircuit', () => {
  it('reads the outline, corners and pit loss, in seconds', () => {
    expect(parseCircuit(AUSTIN, 9, 77)).toEqual({
      circuitKey: 9,
      name: 'Austin',
      refreshedAt: 77,
      outline: { x: [1, 2, 3, 4], y: [5, 6, 7, 8] },
      corners: [
        { number: 1, x: 3743.5, y: -4013.4, angle: -44.65, distance: 6420.3 },
        { number: 2, x: 100, y: 200, angle: 120, distance: 900 },
      ],
      rotation: 0,
      pitLoss: { normal: 20.81, safetyCar: 13.5, virtualSafetyCar: 14.34 },
    });
  });

  it('makes do without the parts it can', () => {
    const c = parseCircuit({ x: [1, 2], y: [3, 4], pitLoss: { normal: 'n/a', sc: -1, vsc: 12 }, rotation: 'x', corners: 'none' }, 9, 1);
    expect(c).toMatchObject({ name: 'Circuit 9', corners: [], rotation: 0, pitLoss: { normal: null, safetyCar: null, virtualSafetyCar: 12 } });
    expect(parseCircuit({ x: [1, 2], y: [3, 4] }, 9, 1)?.pitLoss).toEqual({ normal: null, safetyCar: null, virtualSafetyCar: null });
  });

  it('refuses an answer without a usable outline, or for another circuit', () => {
    for (const bad of [null, 'oops', [], {}, { x: [1, 2], y: [1] }, { x: [1, 'a'], y: [1, 2] }, { x: [1], y: [1] }, { x: [1, NaN], y: [1, 2] }, { error: 'Not found' }]) {
      expect(parseCircuit(bad, 9, 1)).toBeNull();
    }
    expect(parseCircuit({ ...AUSTIN, circuitKey: 10 }, 9, 1)).toBeNull();
  });

  it('asks for nothing but the key and the year', () => {
    expect(circuitUrl(9, 2026)).toBe('https://api.multiviewer.app/api/v1/circuits/9/2026');
  });
});

describe('refreshCircuit', () => {
  const cached: Circuit = { ...parseCircuit(AUSTIN, 9, 5)!, name: 'Austin (cached)' };

  function deps(over: Partial<CircuitRefresh> = {}) {
    const published: CircuitView[] = [];
    const d = {
      load: vi.fn(async () => null as Circuit | null),
      save: vi.fn(async () => {}),
      fetch: vi.fn(async () => AUSTIN as unknown),
      publish: (view: CircuitView) => void published.push(view),
      stale: () => false,
      now: () => 100,
      ...over,
    };
    return { d, published };
  }

  it('publishes the cached copy at once, then the fresh one, and keeps it', async () => {
    const { d, published } = deps({ load: vi.fn(async () => cached) });
    await refreshCircuit(9, 2026, d);
    expect(d.fetch).toHaveBeenCalledWith(9, 2026);
    expect(published.map((v) => v.state === 'ready' && [v.name, v.refreshedAt, v.reason])).toEqual([
      ['Austin (cached)', 5, null],
      ['Austin', 100, null],
    ]);
    expect(d.save).toHaveBeenCalledWith(expect.objectContaining({ circuitKey: 9, name: 'Austin', refreshedAt: 100 }));
  });

  it('keeps the cached copy with a reason when the fetch fails', async () => {
    const { d, published } = deps({ load: vi.fn(async () => cached), fetch: vi.fn(async () => Promise.reject(new Error('MultiViewer answered HTTP 503'))) });
    await refreshCircuit(9, 2026, d);
    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({ state: 'ready', name: 'Austin (cached)', reason: expect.stringContaining('HTTP 503') });
    expect(d.save).not.toHaveBeenCalled();
  });

  it('fails with the reason when there is no cached copy', async () => {
    const { d, published } = deps({ fetch: vi.fn(async () => Promise.reject(new Error('timeout'))) });
    await refreshCircuit(9, 2026, d);
    expect(published).toEqual([{ state: 'failed', reason: expect.stringContaining('timeout') }]);
  });

  it('treats a malformed answer as a failure, and keeps what it had', async () => {
    const { d, published } = deps({ load: vi.fn(async () => cached), fetch: vi.fn(async () => ({ x: 'nope' })) });
    await refreshCircuit(9, 2026, d);
    expect(published[1]).toMatchObject({ state: 'ready', name: 'Austin (cached)', reason: expect.stringContaining('expected shape') });
    expect(d.save).not.toHaveBeenCalled();
    const bare = deps({ fetch: vi.fn(async () => ({ x: 'nope' })) });
    await refreshCircuit(9, 2026, bare.d);
    expect(bare.published).toEqual([{ state: 'failed', reason: expect.stringContaining('expected shape') }]);
  });

  it('publishes nothing once the session has closed', async () => {
    let open = true;
    const { d, published } = deps({
      load: vi.fn(async () => cached),
      fetch: vi.fn(async () => {
        open = false;
        return AUSTIN;
      }),
      stale: () => !open,
    });
    await refreshCircuit(9, 2026, d);
    expect(published).toHaveLength(1);
    // A fresh copy is still worth keeping for next time.
    expect(d.save).toHaveBeenCalled();
  });
});
