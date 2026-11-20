import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalog, useEventIndex } from './catalog';

const seasons = [
  { year: 2022, pageId: 22 },
  { year: 2024, pageId: 24 },
  { year: 2023, pageId: 23 },
];

function stub(events: (pageId: number) => Promise<unknown[]>) {
  const f1tv = { seasons: vi.fn(async () => seasons), events: vi.fn(events) };
  vi.stubGlobal('window', { omfv: { f1tv } });
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

describe('a live session', () => {
  const race = { contentId: 501, title: '2026 Las Vegas GP - Race', type: 'race' as const, meetingKey: '1300', sessionKey: '' };

  it("keeps the live item's type, so a live race is a race", async () => {
    vi.stubGlobal('window', { omfv: { f1tv: { liveNow: vi.fn(async () => [race]) } } });
    await catalog.live();
    expect(catalog.known(501)).toMatchObject({ type: 'race', status: 'live', meetingKey: '1300', sessionKey: null });
  });

  it('opened by a contentId never listed is live when F1 TV has it live, not a replay', async () => {
    const item = { ...race, contentId: 502, type: 'practice' as const };
    vi.stubGlobal('window', { omfv: { f1tv: { liveNow: vi.fn(async () => [item]) } } });
    expect(await catalog.resolve(502, item.title)).toMatchObject({ status: 'live', type: 'practice', meetingKey: '1300' });
  });

  it('opened by a contentId never listed and not live is a replay', async () => {
    vi.stubGlobal('window', { omfv: { f1tv: { liveNow: vi.fn(async () => []) } } });
    expect(await catalog.resolve(503, '2025 Mexico City GP - Race')).toMatchObject({ status: 'replay', year: 2025 });
  });
});
