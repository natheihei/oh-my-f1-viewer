import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, LiveItem, SessionInfo } from '../../shared/api';
import { AGENT_TOOLS } from '../../shared/tools';

// The executor imports the video component, which pulls in the browser-only player.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { resolveChannel, runTool } = await import('./executor');
const { closeViewingSession, startCountdown, useCountdown } = await import('../shell/viewing');
const { useSession } = await import('../data/session');

const onboard = (label: string, driverName: string, number: number): Channel => ({
  id: `1:${number}`,
  contentId: 1,
  channelId: number,
  kind: 'onboard',
  label,
  title: label,
  driverName,
  driverCode: label,
  number,
});

const channels: Channel[] = [
  { id: '1:101', contentId: 1, channelId: 101, kind: 'main', label: 'F1 LIVE', title: 'F1 LIVE' },
  { id: '1:100', contentId: 1, channelId: 100, kind: 'other', label: 'INTERNATIONAL', title: 'INTERNATIONAL' },
  { id: '1:102', contentId: 1, channelId: 102, kind: 'data', label: 'DATA', title: 'DATA' },
  { id: '1:103', contentId: 1, channelId: 103, kind: 'tracker', label: 'TRACKER', title: 'TRACKER' },
  onboard('HAM', 'Lewis Hamilton', 44),
  onboard('LEC', 'Charles Leclerc', 16),
  onboard('NOR', 'Lando Norris', 4),
  onboard('VER', 'Max Verstappen', 1),
  onboard('HUL', 'Nico Hulkenberg', 27),
  onboard('PER', 'Sergio Pérez', 11),
];

describe('resolveChannel', () => {
  it.each([
    ['HAM', 'HAM'],
    ['ham', 'HAM'],
    ['Hamilton', 'HAM'],
    ['Lewis Hamilton', 'HAM'],
    ['44', 'HAM'],
    ['Lando', 'NOR'],
    ['Noris', 'NOR'],
    ['Lec', 'LEC'],
    ['Leclerk', 'LEC'],
    ['Verstapen', 'VER'],
    ['Hamiltn', 'HAM'],
    ['verstappen', 'VER'],
    ['Perez', 'PER'],
    ['Hülkenberg', 'HUL'],
    ['world feed', 'INTERNATIONAL'],
    ['main', 'F1 LIVE'],
    ['broadcast', 'F1 LIVE'],
    ['international', 'INTERNATIONAL'],
    ['F1 Live', 'F1 LIVE'],
    ['data channel', 'DATA'],
    ['tracker', 'TRACKER'],
  ])('%s resolves to %s', (ref, label) => {
    expect(resolveChannel(channels, ref)?.label).toBe(label);
  });

  it.each(['nobody', '', 'x', '99'])('%s resolves to nothing', (ref) => {
    expect(resolveChannel(channels, ref)).toBeNull();
  });
});

describe('agent tools', () => {
  it('cannot move playback forward or read race state until spoiler approval exists', () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(names).toContain('seek_back');
    for (const banned of ['seek', 'seek_forward', 'seek_to_lap', 'go_live', 'get_race_state', 'get_standings']) {
      expect(names).not.toContain(banned);
    }
  });

  it('are separate from user commands', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile('src/shell/commands.ts', 'utf8'));
    expect(source).not.toMatch(/from .*shared\/tools/);
    expect(source).not.toContain('reset_layout');
    expect(AGENT_TOOLS.map((t) => t.name)).toContain('reset_layout');
  });

  it('all have a handler', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile('src/agent/executor.ts', 'utf8'));
    for (const { name } of AGENT_TOOLS) expect(source).toContain(`case '${name}'`);
  });
});

describe('upcoming sessions', () => {
  const session = (contentId: number, title: string, status: SessionInfo['status'], series = 'FORMULA 1'): SessionInfo => ({
    contentId,
    title,
    status,
    series,
    type: 'race',
    year: 2026,
    startMs: Date.now() + 10 ** 7,
    endMs: null,
    meetingKey: '1300',
    sessionKey: String(contentId),
    hasOnboards: true,
  });
  const f1tv = { sessions: vi.fn(), upcoming: vi.fn(), liveNow: vi.fn(async () => [] as LiveItem[]), channels: vi.fn(async () => []) };
  const live = (contentId: number): LiveItem => ({ contentId, title: 'x', meetingKey: '1300', sessionKey: '' });

  beforeEach(() => {
    vi.stubGlobal('window', { f1a: { f1tv, timing: { resolve: vi.fn(async () => null), onLiveUpdate: () => () => {}, liveStart: vi.fn(async () => ({ path: null })), liveStop: vi.fn(async () => {}) } } });
    f1tv.liveNow.mockResolvedValue([]);
  });
  afterEach(() => {
    closeViewingSession();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('list_upcoming leaves out other series', async () => {
    f1tv.upcoming.mockResolvedValue([session(1, 'Race', 'upcoming'), session(2, 'F1A Race', 'upcoming', 'F1 ACADEMY')]);
    expect(JSON.parse(await runTool('list_upcoming', {})).map((s: { contentId: number }) => s.contentId)).toEqual([1]);
  });

  it('refuses to load a session that has not started', async () => {
    f1tv.upcoming.mockResolvedValue([session(1, 'Race', 'upcoming')]);
    await runTool('list_upcoming', {});
    await expect(runTool('load_session', { contentId: 1, title: 'Race' })).rejects.toThrow(/hasn't started/);
    expect(useSession.getState().session).toBeNull();
  });

  it('loads a listed upcoming session once it has gone live', async () => {
    f1tv.upcoming.mockResolvedValue([session(1, 'Race', 'upcoming')]);
    await runTool('list_upcoming', {});
    f1tv.liveNow.mockResolvedValue([live(1)]);
    await runTool('load_session', { contentId: 1, title: 'Race' });
    expect(useSession.getState().session).toMatchObject({ contentId: 1, status: 'live' });
  });

  it('wait_for_session needs a session it has seen, and only an upcoming one', async () => {
    f1tv.upcoming.mockResolvedValue([session(1, 'Race', 'upcoming')]);
    f1tv.sessions.mockResolvedValue([session(3, 'Old', 'replay')]);
    await expect(runTool('wait_for_session', { contentId: 99 })).rejects.toThrow(/Unknown contentId/);
    await runTool('list_sessions', { pageId: 1, year: 2026 });
    await expect(runTool('wait_for_session', { contentId: 3 })).rejects.toThrow(/isn't upcoming/);
    await runTool('list_upcoming', {});
    await runTool('wait_for_session', { contentId: 1 });
    expect(useCountdown.getState().countdown).toMatchObject({ title: 'Race' });
  });

  it('a countdown fires for its own session, not another going live in the same event', async () => {
    vi.useFakeTimers();
    const race = { ...session(1, 'Race', 'upcoming'), startMs: Date.now() + 60_000 };
    const onLive = vi.fn();
    startCountdown(race, onLive);

    f1tv.liveNow.mockResolvedValue([{ ...live(2), title: 'Pre-Race Show' }]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onLive).not.toHaveBeenCalled();
    expect(useCountdown.getState().countdown).not.toBeNull();

    f1tv.liveNow.mockResolvedValue([live(2), live(1)]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onLive).toHaveBeenCalledTimes(1);
    expect(onLive.mock.calls[0][0]).toMatchObject({ contentId: 1, status: 'live' });
    expect(useCountdown.getState().countdown).toBeNull();
  });

  it('a countdown does not poll until close to the start', async () => {
    vi.useFakeTimers();
    startCountdown({ ...session(1, 'Race', 'upcoming'), startMs: Date.now() + 10 ** 8 }, vi.fn());
    f1tv.liveNow.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f1tv.liveNow).not.toHaveBeenCalled();
  });
});
