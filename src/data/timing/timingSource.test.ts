import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../../shared/api';
import { createLiveTiming, createReplayTiming, useTiming } from './timingSource';

const session = { contentId: 1, title: 'x', type: 'race', year: 2026, status: 'replay' } as SessionInfo;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('timing state', () => {
  const timing = {
    resolve: vi.fn(),
    load: vi.fn(),
    syncData: vi.fn(async () => null),
    liveStart: vi.fn(async () => ({ path: null })),
    liveStop: vi.fn(async () => {}),
    onLiveUpdate: vi.fn(() => () => {}),
  };

  beforeEach(() => {
    vi.stubGlobal('window', { f1a: { timing } });
    timing.resolve.mockResolvedValue({ path: 'p', meetingKey: 1, sessionKey: 2, name: 'Race' });
    timing.load.mockResolvedValue({});
    timing.liveStart.mockResolvedValue({ path: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is loading, then ready with no rows yet, for a replay', async () => {
    const source = createReplayTiming(session);
    expect(useTiming.getState().state).toBe('loading');
    await flush();
    expect(useTiming.getState()).toMatchObject({ state: 'ready', drivers: [] });
    source.destroy();
    expect(useTiming.getState()).toEqual({ state: 'idle' });
  });

  it('fails with a reason when the archive refuses, without the IPC wrapper', async () => {
    timing.resolve.mockRejectedValue(new Error("Error invoking remote method 'timing:resolve': Error: refused (HTTP 403)"));
    const source = createReplayTiming(session);
    await flush();
    expect(useTiming.getState()).toEqual({ state: 'failed', reason: 'refused (HTTP 403)' });
    source.destroy();
  });

  it("fails, rather than loading forever, when the session isn't found in the archive", async () => {
    timing.resolve.mockResolvedValue(null);
    const source = createReplayTiming(session);
    await flush();
    expect(useTiming.getState()).toEqual({ state: 'failed', reason: "This session wasn't found in the timing archive." });
    source.destroy();
  });

  it('a session closed while loading cannot write over its replacement', async () => {
    let refuse: (e: Error) => void = () => {};
    timing.resolve.mockReturnValueOnce(new Promise((_, reject) => (refuse = reject)));
    const closed = createReplayTiming(session);
    closed.destroy();
    const next = createReplayTiming(session);
    refuse(new Error('too late'));
    await flush();
    expect(useTiming.getState().state).toBe('ready');
    next.destroy();
  });

  it('is loading until the first live record reaches the video', async () => {
    let push: (record: { feed: string; data: unknown }) => void = () => {};
    timing.onLiveUpdate.mockImplementationOnce(((cb: typeof push) => ((push = cb), () => {})) as never);
    const source = createLiveTiming({ ...session, status: 'live' });
    source.update(0, Date.now());
    expect(useTiming.getState().state).toBe('loading');
    push({ feed: 'WeatherData', data: {} });
    source.update(0, Date.now() + 1000);
    expect(useTiming.getState().state).toBe('ready');
    source.destroy();
  });

  it('fails when live timing cannot start', async () => {
    timing.liveStart.mockRejectedValue(new Error('no socket'));
    const source = createLiveTiming({ ...session, status: 'live' });
    await flush();
    expect(useTiming.getState()).toEqual({ state: 'failed', reason: 'no socket' });
    source.destroy();
  });
});
