import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../shared/api';
import type { TimingQuery } from '../../shared/api';
import type { CircuitView, DataStatus, SessionCoverage } from '../../shared/sessionData';
import { LIVE_FRAME_LEAD_MS } from './timeMap';
import { rosterOf } from '../../shared/sessionData';
import { archiveQuery, openSessionData, sessionSql, useCircuit, useSessionData } from './sessionData';

const session = { contentId: 1, title: '2026 Race', type: 'race', year: 2026, meetingKey: '10', sessionKey: '20', status: 'replay' } as SessionInfo;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const coverage = { source: 'archive', datasets: {}, missingFeeds: [], gaps: [], capturedFrom: null } as unknown as SessionCoverage;
const BASE = Date.UTC(2026, 0, 1);
const clock = { feedBaseUtc: BASE, clockStartOffsetMs: 2_000_000, scheduledStartOffsetMs: 1_900_000, durationMs: 9_000_000 };
const tables = [{ name: 'laps', columns: ['session_key', 'meeting_key', 'lap_number', 'visible_from'] }];
const ready: DataStatus = { sessionKey: 20, state: 'ready', reason: null, coverage, clock, sessionStartSec: 500, liveLeadMs: null, tables };
const noObjects = { drivers: [] };

describe('session data', () => {
  let emit: (status: DataStatus) => void;
  let emitCircuit: (update: { query: TimingQuery; circuit: CircuitView }) => void;
  const data = {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onStatus: vi.fn((cb: (status: DataStatus) => void) => {
      emit = cb;
      return () => {};
    }),
    onCircuit: vi.fn((cb: (update: { query: TimingQuery; circuit: CircuitView }) => void) => {
      emitCircuit = cb;
      return () => {};
    }),
    objects: vi.fn(async (_key: number, _playhead: number) => noObjects),
    sql: vi.fn(async () => ({ columns: [], rows: [] })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', { omfv: { data } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('links a video to its data by F1 keys', () => {
    expect(archiveQuery(session)).toMatchObject({ year: 2026, meetingKey: '10', sessionKey: '20', sessionType: 'race' });
    expect(archiveQuery({ ...session, type: 'sprint' }).sessionType).toBe('race');
    expect(archiveQuery({ ...session, sessionKey: null })).not.toHaveProperty('sessionKey');
  });

  it('asks for the session to be ingested when opened, and closes it after', () => {
    const handle = openSessionData(session, false);
    expect(data.open).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: '20' }), false);
    expect(useSessionData.getState().state).toBe('loading');
    handle.destroy();
    expect(data.close).toHaveBeenCalled();
    expect(useSessionData.getState().state).toBe('idle');
  });

  it('says why when there is no data', () => {
    const handle = openSessionData(session, false);
    emit({ sessionKey: null, state: 'unsupported', reason: 'Session data covers 2023 onwards.', coverage: null, clock: null, sessionStartSec: null, liveLeadMs: null, tables: null });
    expect(useSessionData.getState()).toEqual({ state: 'unsupported', reason: 'Session data covers 2023 onwards.' });
    handle.destroy();
  });

  it('reads as of the video frame, with lights out mapped to lights out', async () => {
    const handle = openSessionData(session, false);
    emit(ready);
    handle.update(500, null);
    await flush();
    expect(data.objects).toHaveBeenLastCalledWith(20, BASE + 2_000_000);
    expect(useSessionData.getState()).toMatchObject({ state: 'ready', datasets: coverage.datasets, playheadMs: BASE + 2_000_000 });
    expect(useSessionData.getState()).not.toHaveProperty('coverage');
    handle.destroy();
  });

  it('follows the video backward too', async () => {
    const handle = openSessionData(session, false);
    emit(ready);
    handle.update(1000, null);
    await flush();
    handle.update(100, null);
    await flush();
    expect(data.objects).toHaveBeenLastCalledWith(20, BASE + 2_000_000 - 400_000);
    handle.destroy();
  });

  it('only reads again when the frame has moved a second', async () => {
    const handle = openSessionData(session, false);
    emit(ready);
    await flush();
    handle.update(500, null);
    await flush();
    const calls = data.objects.mock.calls.length;
    handle.update(500.1, null);
    handle.update(500.2, null);
    await flush();
    expect(data.objects.mock.calls.length).toBe(calls);
    handle.update(501.5, null);
    await flush();
    expect(data.objects.mock.calls.length).toBe(calls + 1);
    handle.destroy();
  });

  it('moves the playhead within a second without a new revision, for telemetry', async () => {
    const handle = openSessionData(session, false);
    emit(ready);
    handle.update(500, null);
    await flush();
    const before = useSessionData.getState();
    const revision = before.state === 'ready' ? before.revision : -1;
    handle.update(500.25, null);
    expect(useSessionData.getState()).toMatchObject({ revision, playheadMs: BASE + 2_000_250 });
    // A paused video reports the same frame: nothing is published.
    const paused = useSessionData.getState();
    handle.update(500.25, null);
    expect(useSessionData.getState()).toBe(paused);
    handle.destroy();
  });

  it('waits, and says why, until a replay frame can be placed', async () => {
    const handle = openSessionData(session, false);
    emit({ ...ready, clock: null });
    handle.update(500, null);
    await flush();
    expect(useSessionData.getState()).toMatchObject({ state: 'waiting', sessionKey: 20, reason: "Can't line the data up with the video" });
    expect(useSessionData.getState()).not.toHaveProperty('lapCount');
    handle.destroy();
  });

  it("waits for MultiViewer's anchor on a replay, then shows the frame once it's published", async () => {
    const handle = openSessionData(session, false);
    emit({ ...ready, sessionStartSec: null });
    handle.update(500, null);
    await flush();
    const waiting = useSessionData.getState();
    expect(waiting).toMatchObject({ state: 'waiting', reason: 'Not lined up with the video yet' });
    expect(waiting.state === 'waiting' && waiting.detail).toMatch(/MultiViewer/);
    await expect(sessionSql('SELECT 1')).rejects.toThrow('Not lined up with the video yet');
    // The whole session doesn't depend on the frame.
    await expect(sessionSql('SELECT 1', [], 'session')).resolves.toBeTruthy();
    emit(ready);
    await flush();
    expect(useSessionData.getState()).toMatchObject({ state: 'ready', playheadMs: BASE + 2_000_000 });
    handle.destroy();
  });

  it("holds a live session back to the picture: the stream's wall clock, less its lead", async () => {
    const handle = openSessionData({ ...session, status: 'live' }, true);
    emit({ ...ready, clock: null, sessionStartSec: null });
    handle.update(100, BASE + 123_000);
    await flush();
    expect(data.objects).toHaveBeenLastCalledWith(20, BASE + 123_000 - LIVE_FRAME_LEAD_MS);
    emit({ ...ready, clock: null, sessionStartSec: null, liveLeadMs: 7_552 });
    await flush();
    expect(data.objects).toHaveBeenLastCalledWith(20, BASE + 123_000 - 7_552);
    handle.destroy();
  });

  it("waits, rather than show everything, when a live stream has no clock", async () => {
    const handle = openSessionData({ ...session, status: 'live' }, true);
    emit({ ...ready, clock: null, sessionStartSec: null });
    handle.update(100, null);
    await flush();
    expect(useSessionData.getState()).toMatchObject({ state: 'waiting', reason: 'Not lined up with the video yet' });
    expect(useSessionData.getState()).not.toHaveProperty('lapCount');
    handle.destroy();
  });

  it('keeps the roster while waiting, and nothing else', async () => {
    const driver = { driver_number: 44, name_acronym: 'HAM' };
    data.objects.mockResolvedValueOnce({ drivers: [driver], lapCount: { current: 30, total: 50 } } as never);
    const handle = openSessionData({ ...session, status: 'live' }, true);
    emit({ ...ready, clock: null, sessionStartSec: null });
    await flush();
    const view = useSessionData.getState();
    expect(view).toMatchObject({ state: 'waiting', drivers: [driver] });
    expect(view).not.toHaveProperty('lapCount');
    expect(rosterOf(view)).toEqual([driver]);
    handle.destroy();
  });

  it('waits for the live video to reach when the capture began, counting down', async () => {
    const handle = openSessionData({ ...session, status: 'live' }, true);
    const capturedFrom = BASE + 200_000;
    emit({ ...ready, clock: null, sessionStartSec: null, coverage: { ...coverage, source: 'live', capturedFrom } });
    handle.update(100, capturedFrom - 30_000 + LIVE_FRAME_LEAD_MS);
    await flush();
    const state = useSessionData.getState();
    expect(state).toMatchObject({ state: 'waiting', reason: 'Waiting for the video to reach the live data' });
    expect(state.state === 'waiting' && state.detail).toMatch(/about 30s ahead/);
    handle.update(130, capturedFrom + LIVE_FRAME_LEAD_MS);
    await flush();
    expect(useSessionData.getState()).toMatchObject({ state: 'ready', playheadMs: capturedFrom });
    // Rewinding to before the capture waits again at once, though the roster it reads hasn't changed.
    handle.update(100, capturedFrom - 30_000 + LIVE_FRAME_LEAD_MS);
    expect(useSessionData.getState()).toMatchObject({ state: 'waiting', reason: 'Waiting for the video to reach the live data' });
    await flush();
    expect(useSessionData.getState()).toMatchObject({ state: 'waiting' });
    handle.destroy();
  });

  it('gives SQL the current frame, or the whole session only when asked by name', async () => {
    const handle = openSessionData(session, false);
    emit(ready);
    handle.update(500, null);
    await sessionSql('SELECT 1');
    expect(data.sql).toHaveBeenLastCalledWith(20, BASE + 2_000_000, 'SELECT 1', []);
    await sessionSql('SELECT 1', [], 'session');
    expect(data.sql).toHaveBeenLastCalledWith(20, Number.MAX_SAFE_INTEGER, 'SELECT 1', []);
    handle.destroy();
    await expect(sessionSql('SELECT 1')).rejects.toThrow('No session data is open');
  });

  it('places a moment back on the video', async () => {
    const handle = openSessionData(session, false);
    expect(handle.videoTimeOf(BASE + 2_000_000)).toBeNull();
    emit(ready);
    handle.update(1_000, null);
    // Lights out is video second 500, wherever the video is now.
    expect(handle.videoTimeOf(BASE + 2_000_000)).toBeCloseTo(500);
    handle.destroy();
  });

  it('places a moment on a live session relative to the frame on screen', () => {
    const handle = openSessionData({ ...session, status: 'live' }, true);
    emit({ ...ready, clock: null, sessionStartSec: null });
    handle.update(100, BASE + 123_000);
    expect(handle.videoTimeOf(BASE + 63_000 - LIVE_FRAME_LEAD_MS)).toBe(40);
    handle.update(100, null);
    expect(handle.videoTimeOf(BASE + 63_000)).toBeNull();
    handle.destroy();
  });

  it("keeps the open session's circuit, and ignores one for another session", () => {
    const handle = openSessionData(session, false);
    expect(useCircuit.getState()).toEqual({ state: 'loading' });
    const circuit: CircuitView & { state: 'ready' } = {
      state: 'ready',
      reason: null,
      circuitKey: 9,
      name: 'Austin',
      refreshedAt: 1,
      outline: { x: [0, 1], y: [0, 1] },
      corners: [],
      rotation: 0,
      pitLoss: { normal: 20.81, safetyCar: 13.5, virtualSafetyCar: null },
    };
    emitCircuit({ query: archiveQuery({ ...session, sessionKey: '19' }), circuit: { ...circuit, name: 'Elsewhere' } });
    expect(useCircuit.getState().state).toBe('loading');
    emitCircuit({ query: archiveQuery(session), circuit });
    const view = useCircuit.getState();
    expect(view).toMatchObject({ state: 'ready', name: 'Austin' });
    expect(view.state === 'ready' && Object.isFrozen(view.outline.x)).toBe(true);
    handle.destroy();
    expect(useCircuit.getState()).toEqual({ state: 'idle' });
  });

  it('gives the tables SQL can read once ready, as one object across revisions and statuses', async () => {
    const handle = openSessionData(session, false);
    emit(ready);
    await flush();
    const first = useSessionData.getState();
    expect(first.state === 'ready' && first.tables).toEqual(tables);
    expect(first.state === 'ready' && Object.isFrozen(first.tables[0].columns)).toBe(true);
    handle.update(500, null);
    await flush();
    // Every status carries the list again, as a fresh copy over IPC.
    emit({ ...ready, tables: structuredClone(tables) });
    await flush();
    const later = useSessionData.getState();
    expect(later.state === 'ready' && later.revision).toBeGreaterThan(first.state === 'ready' ? first.revision : 0);
    expect(later.state === 'ready' && later.tables).toBe(first.state === 'ready' && first.tables);
    handle.destroy();
  });

  it('hands out read-only objects', async () => {
    data.objects.mockResolvedValueOnce({ ...noObjects, drivers: [{ driver_number: 1 }] } as never);
    const handle = openSessionData(session, false);
    emit(ready);
    await flush();
    const view = useSessionData.getState();
    expect(view.state === 'ready' && Object.isFrozen(view.drivers)).toBe(true);
    handle.destroy();
  });
});
