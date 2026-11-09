import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, LiveItem, SessionInfo } from '../../shared/api';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { AGENT_TOOLS, runTool, toolDefinitions } = await import('./tools');
const { resolveChannel } = await import('./matching');
const { closeViewingSession, startCountdown, useCountdown } = await import('../host/viewing');
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
    expect(names).toContain('seek_to_start');
    for (const banned of ['seek', 'seek_forward', 'seek_to_lap', 'go_live', 'get_race_state', 'get_standings']) {
      expect(names).not.toContain(banned);
    }
  });

  it('are separate from user commands', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile('src/shell/commands.ts', 'utf8'));
    expect(source).not.toMatch(/from .*shared\/tools/);
    expect(source).not.toContain('list_live');
    expect(AGENT_TOOLS.map((t) => t.name)).toContain('list_live');
  });

  it('send the model only plain JSON definitions', () => {
    for (const definition of toolDefinitions()) {
      expect(Object.keys(definition).sort()).toEqual(['description', 'name', 'parameters']);
      expect(JSON.parse(JSON.stringify(definition))).toEqual(definition);
      expect(definition.parameters).toMatchObject({ type: 'object' });
    }
  });

  it('take their schema from the host unless they override it', async () => {
    const { host } = await import('../host');
    const live = toolDefinitions().find((t) => t.name === 'list_live');
    expect(live?.parameters).toEqual(JSON.parse(JSON.stringify(host.catalog.live.info.args)));
  });

  it('cannot seek forward even if the model sends a negative rewind', async () => {
    const seek = vi.spyOn((await import('../data/session')).sessionControl, 'seekBy');
    const open = { contentId: 1, title: 'x', status: 'replay' } as SessionInfo;
    useSession.setState({ session: open, clock: { ...useSession.getState().clock, end: 100 } });
    await expect(runTool('seek_back', { seconds: -30 })).rejects.toThrow(/must be positive/);
    expect(seek).not.toHaveBeenCalled();
    await runTool('seek_back', { seconds: 30 });
    expect(seek).toHaveBeenCalledWith(-30);
    useSession.setState({ session: null, clock: { ...useSession.getState().clock, end: 0 } });
    seek.mockRestore();
  });

  it('reject an unknown tool', async () => {
    await expect(runTool('seek_forward', {})).rejects.toThrow(/Unknown tool/);
  });

  it('refuse to act with no session open', async () => {
    await expect(runTool('suggest_tiles', { streams: ['HAM'] })).rejects.toThrow(/No session is open/);
    await expect(runTool('seek_back', { seconds: 5 })).rejects.toThrow(/No session is open/);
    await expect(runTool('set_audio', { stream: 'HAM' })).rejects.toThrow(/No session is open/);
  });
});

const { host, read } = await import('../host');
const { layout } = await import('../layout/store');
const { videoSpec } = await import('../host/viewing');

describe('suggested tiles', () => {
  const open = { contentId: 1, title: 'x', status: 'replay' } as SessionInfo;
  const keys = () => read().suggestions.items.map((i) => i.label);

  beforeEach(() => {
    useSession.setState({ session: open, channels });
    layout.clear();
    layout.add(videoSpec('1:101', 'F1 LIVE'));
  });
  afterEach(() => {
    host.suggestions.newTurn();
    layout.clear();
    useSession.setState({ session: null, channels: [] });
  });

  it('the agent can only suggest, never add', () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(names).toContain('suggest_tiles');
    expect(names).not.toContain('add_streams');
  });

  it('suggesting puts nothing on screen', async () => {
    const out = await runTool('suggest_tiles', { streams: ['Hamilton', 'Verstappen'] });
    expect(out).toMatch(/Suggested: HAM, VER/);
    expect(keys()).toEqual(['HAM', 'VER']);
    expect(layout.tiles().map((t) => t.component.label)).toEqual(['F1 LIVE']);
  });

  it('a stream already on screen is still suggested, and marked so', async () => {
    const out = await runTool('suggest_tiles', { streams: ['main'] });
    expect(out).toMatch(/Already on screen.*F1 LIVE/);
    expect(keys()).toEqual(['F1 LIVE']);
  });

  it('suggesting again in a turn adds to the strip, skipping repeats and what was added', async () => {
    await runTool('suggest_tiles', { streams: ['HAM', 'VER'] });
    host.suggestions.add({ key: '1:44' });
    const out = await runTool('suggest_tiles', { streams: ['HAM', 'VER', 'NOR'] });
    expect(out).toMatch(/Suggested: NOR/);
    expect(out).toMatch(/Already suggested this turn: HAM, VER/);
    expect(keys()).toEqual(['VER', 'NOR']);
  });

  it('holds at most four streams at a time', async () => {
    const out = await runTool('suggest_tiles', { streams: ['HAM', 'VER', 'NOR', 'LEC', 'PER'] });
    expect(keys()).toHaveLength(4);
    expect(out).toMatch(/strip is full: PER/);
  });

  it('adding a suggestion puts it on screen and takes it out of the strip', async () => {
    await runTool('suggest_tiles', { streams: ['HAM', 'main'] });
    expect(host.suggestions.add({ key: '1:44' })).toBe(true);
    expect(layout.tiles().map((t) => t.component.label)).toEqual(['F1 LIVE', 'HAM']);
    // A duplicate only leaves the strip.
    host.suggestions.add({ key: '1:101' });
    expect(layout.tiles()).toHaveLength(2);
    expect(keys()).toEqual([]);
  });

  it('nothing joins a dismissed strip until the next turn', async () => {
    await runTool('suggest_tiles', { streams: ['HAM'] });
    host.suggestions.dismiss();
    await expect(runTool('suggest_tiles', { streams: ['VER'] })).rejects.toThrow(/dismissed/);
    host.suggestions.newTurn();
    await runTool('suggest_tiles', { streams: ['VER'] });
    expect(keys()).toEqual(['VER']);
  });

  it('a new turn clears the strip and tells the agent what the user did', async () => {
    await runTool('suggest_tiles', { streams: ['HAM', 'VER', 'NOR'] });
    host.suggestions.add({ key: '1:44' });
    expect(host.suggestions.newTurn()).toBe('From your last suggestions the user added HAM; left VER, NOR unanswered.');
    expect(keys()).toEqual([]);
    expect(host.suggestions.newTurn()).toBeNull();
  });

  it('opening another session clears the strip', async () => {
    await runTool('suggest_tiles', { streams: ['HAM'] });
    useSession.setState({ session: { ...open, contentId: 2 } });
    expect(keys()).toEqual([]);
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
    vi.stubGlobal('window', { f1a: { f1tv, data: { onStatus: () => () => {}, open: vi.fn(async () => {}), close: vi.fn(async () => {}) } } });
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

  it('loading a session that has not started shows a countdown instead', async () => {
    f1tv.upcoming.mockResolvedValue([session(1, 'Race', 'upcoming')]);
    await runTool('list_upcoming', {});
    expect(JSON.parse(await runTool('load_session', { contentId: 1, title: 'Race' }))).toMatchObject({ countdown: 'Race' });
    expect(useSession.getState().session).toBeNull();
    expect(useCountdown.getState().countdown).toMatchObject({ title: 'Race' });
  });

  it('loads a listed upcoming session once it has gone live', async () => {
    f1tv.upcoming.mockResolvedValue([session(1, 'Race', 'upcoming')]);
    await runTool('list_upcoming', {});
    f1tv.liveNow.mockResolvedValue([live(1)]);
    await runTool('load_session', { contentId: 1, title: 'Race' });
    expect(useSession.getState().session).toMatchObject({ contentId: 1, status: 'live' });
  });

  it('reports where a live session starts playing', async () => {
    f1tv.sessions.mockResolvedValue([session(5, 'Live race', 'live')]);
    await runTool('list_sessions', { pageId: 1, year: 2026 });
    expect(JSON.parse(await runTool('load_session', { contentId: 5, title: 'x' })).playingFrom).toBe('live edge');
    expect(JSON.parse(await runTool('load_session', { contentId: 5, title: 'x', fromStart: true })).playingFrom).toBe('start');
  });

  it('refuses to rewind before anything has played', async () => {
    f1tv.sessions.mockResolvedValue([session(5, 'Live race', 'live')]);
    await runTool('list_sessions', { pageId: 1, year: 2026 });
    await runTool('load_session', { contentId: 5, title: 'x' });
    await expect(runTool('seek_back', { seconds: 30 })).rejects.toThrow(/Nothing is playing/);
    await expect(runTool('seek_to_start', {})).resolves.toMatch(/start/);
  });

  it('list_sessions refuses seasons before the first supported one', async () => {
    await expect(runTool('list_sessions', { pageId: 1, year: 2022 })).rejects.toThrow(/Only 2023 on/);
    expect(f1tv.sessions).not.toHaveBeenCalledWith(1, 2022);
  });

  it('there is no separate tool to wait for a session, or to list events', () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(names).not.toContain('wait_for_session');
    expect(names).not.toContain('list_events');
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
