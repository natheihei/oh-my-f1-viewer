import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalog, useEventIndex } from './catalog';

const seasons = [
  { year: 2022, pageId: 22 },
  { year: 2024, pageId: 24 },
  { year: 2023, pageId: 23 },
];

function stub(events: (pageId: number) => Promise<unknown[]>) {
  const f1tv = { seasons: vi.fn(async () => seasons), events: vi.fn(events) };
  vi.stubGlobal('window', { f1a: { f1tv } });
  return f1tv;
}

afterEach(() => {
  vi.unstubAllGlobals();
  useEventIndex.setState({ state: 'idle', seasons: [], error: null });
});

describe('the event index', () => {
  it('loads only supported seasons, oldest first', async () => {
    const f1tv = stub(async (pageId) => [{ pageId: pageId * 100 }]);
    const index = await catalog.loadIndex();
    expect(index.state).toBe('ready');
    expect(index.seasons.map((s) => s.year)).toEqual([2023, 2024]);
    expect(f1tv.events).not.toHaveBeenCalledWith(22);
  });

  it('reports a failure, without the IPC wrapping, and loads on retry', async () => {
    let fail = true;
    stub(async () => {
      if (fail) throw new Error("Error invoking remote method 'f1tv:events': Error: timed out");
      return [];
    });
    expect(await catalog.loadIndex()).toMatchObject({ state: 'error', error: 'timed out' });
    fail = false;
    expect(await catalog.loadIndex()).toMatchObject({ state: 'ready', error: null });
  });

  it('shares one load between callers', async () => {
    const f1tv = stub(async () => []);
    await Promise.all([catalog.loadIndex(), catalog.loadIndex()]);
    expect(f1tv.seasons).toHaveBeenCalledTimes(1);
  });
});
