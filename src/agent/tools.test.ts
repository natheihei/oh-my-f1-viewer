import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Channel, LiveItem, SessionInfo } from '../../shared/api';
import type { DataStatus, DriverEntry, SessionDataView, SqlRows } from '../../shared/sessionData';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

// A test decides what the spoiler gate answers, and what a query returns.
const { spoilerGate, sessionSql } = vi.hoisted(() => ({
  spoilerGate: vi.fn(async (_request: unknown) => ({ approved: true }) as { approved: boolean; reason?: string }),
  sessionSql: vi.fn(async (..._args: unknown[]): Promise<SqlRows> => ({ columns: [], rows: [] })),
}));
vi.mock('./spoilerGate', () => ({ spoilerGate }));
vi.mock('../data/sessionData', async (original) => ({ ...(await original<object>()), sessionSql }));

const { AGENT_TOOLS, BUILD_TOOLS, PICKING_TOOLS, readsPastPlayhead, runTool, toolDefinitions } = await import('./tools');
const { beginTurn, DATA_WAIT_MS, OPEN_WAIT_MS, setWaitNotifier } = await import('./dataWait');
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
  it('seek through the spoiler gate, and have no other way forward', () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    // go_live asks the gate as seek_to does: see 'goes live only on a live session, asking first when behind the edge'.
    expect(names).toEqual(expect.arrayContaining(['seek_to', 'seek_to_start', 'go_live', 'query_session']));
    for (const banned of ['seek', 'seek_back', 'seek_forward', 'seek_to_lap', 'get_race_state', 'get_standings']) {
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

  it('show only finding and opening a session until one is open', () => {
    const shown = () => toolDefinitions().map((t) => t.name);
    expect(shown()).toEqual(PICKING_TOOLS);
    useSession.setState({ session: { contentId: 1, title: 'x', type: 'race', status: 'replay' } as SessionInfo, channels });
    expect(shown()).toEqual(AGENT_TOOLS.map((t) => t.name));
    useSession.setState({ session: null, channels: [] });
    expect(shown()).toEqual(PICKING_TOOLS);
  });

  it('show the build agent its own, with or without a session', () => {
    expect(toolDefinitions('build').map((t) => t.name)).toEqual(BUILD_TOOLS.map((t) => t.name));
  });

  it('reject an unknown tool', async () => {
    await expect(runTool('seek_forward', {})).rejects.toThrow(/Unknown tool/);
  });

  it('refuse to act with no session open', async () => {
    await expect(runTool('suggest_tiles', { streams: ['HAM'] })).rejects.toThrow(/No session is open/);
    await expect(runTool('seek_to', { date: 5 })).rejects.toThrow(/No session is open/);
    await expect(runTool('query_session', { sql: 'SELECT 1' })).rejects.toThrow(/No session is open/);
    await expect(runTool('set_audio', { stream: 'HAM' })).rejects.toThrow(/No session is open/);
    await expect(runTool('set_volume', { volume: 50 })).rejects.toThrow(/No session is open/);
  });
});

const { defineComponent, host, read } = await import('../host');
const { layout } = await import('../layout/store');
const { components } = await import('../components/registry');
const Type = (await import('typebox')).default;

// The app registers its components at start; tests do it here.
host.components.register({ components, origin: 'installed' });
const video = (feed: string) => ({ type: 'video', props: { feed } });

describe('suggested tiles', () => {
  const open = { contentId: 1, title: 'x', type: 'race', status: 'replay' } as SessionInfo;
  const keys = () => read().suggestions.items.map((i) => i.label);

  beforeEach(() => {
    useSession.setState({ session: open, channels });
    layout.clear();
    host.layout.add({ items: [video('1:101')] });
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

  it("says why a component named as a stream isn't offered, rather than that no stream matches", async () => {
    useSession.setState({ session: { ...open, type: 'practice' } });
    await expect(runTool('suggest_tiles', { streams: ['timing tower'] })).rejects.toThrow(
      /"timing tower" is the timing_tower component, not a stream, and it is for race, sprint sessions, and this is practice/,
    );
    await expect(runTool('suggest_tiles', { streams: ['timing tower'] })).rejects.not.toThrow(/Not found/);
    await expect(runTool('suggest_tiles', { streams: ['nobody'] })).rejects.toThrow(/Not found: nobody\. Use list_streams/);
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

  it('holds any number of streams', async () => {
    const out = await runTool('suggest_tiles', { streams: ['HAM', 'VER', 'NOR', 'LEC', 'PER'] });
    expect(keys()).toHaveLength(5);
    expect(out).not.toMatch(/full/);
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

describe('components', () => {
  // A stand-in for a chart: anything that isn't a stream.
  const chart = defineComponent({
    name: 'test-chart',
    title: 'Test chart',
    description: 'A chart for one driver.',
    args: Type.Object({ driver: Type.String() }),
    spec: ({ driver }) => ({ key: `test-chart:${driver}`, label: `Chart ${driver}` }),
    needs: ['timing'],
    View: () => null,
  });
  const open = { contentId: 1, title: 'x', type: 'race', status: 'replay' } as SessionInfo;
  const labels = () => read().suggestions.items.map((i) => i.label);

  beforeEach(() => {
    host.components.register({ components: [chart] });
    useSession.setState({ session: open, channels });
    layout.clear();
  });
  afterEach(() => {
    host.suggestions.newTurn();
    layout.clear();
    useSession.setState({ session: null, channels: [] });
  });

  it('are listed in the live state without their code, as plain JSON', () => {
    const list = read().components;
    expect(list.map((c) => c.name)).toEqual([...components.map((c) => c.name), 'test-chart']);
    expect(JSON.parse(JSON.stringify(list))).toEqual(list);
    expect(list[0].origin).toBe('installed');
    expect(list.at(-1)).toEqual({
      name: 'test-chart',
      origin: 'local',
      title: 'Test chart',
      description: 'A chart for one driver.',
      args: expect.objectContaining({ type: 'object', required: ['driver'] }),
      sessions: null,
      needs: ['timing'],
      replayOnly: false,
      size: null,
      looksAhead: false,
    });
    // The same reference until something registers, so a useLive selector over it is stable.
    expect(read().components).toBe(list);
  });

  it('build a video spec keyed by feed and labelled by channel', () => {
    host.layout.add({ items: [video('1:44')] });
    expect(layout.tiles().map((t) => t.component)).toEqual([
      { type: 'video', key: '1:44', label: 'HAM', title: { name: '', drivers: [44] }, props: { feed: '1:44' }, fit: { aspect: 16 / 9 }, size: { aspect: 16 / 9, min: { width: 320, height: 180 } } },
    ]);
    expect(() => host.layout.add({ items: [video('1:999')] })).toThrow(/Unknown feed/);
  });

  it('give a tile the main place only when asked, by its id', () => {
    const [tile] = host.layout.add({ items: [video('1:44')] });
    expect(layout.snapshot().main).toBeNull();
    expect(host.layout.setMain({ tile: 'nothing' })).toBe(false);
    expect(host.layout.setMain({ tile })).toBe(true);
    expect(layout.snapshot().main).toBe(tile);
    expect(host.layout.setMain({ tile: null })).toBe(true);
    expect(layout.snapshot().main).toBeNull();
  });

  it('reject an unknown type, or props that do not fit', () => {
    expect(() => host.suggestions.offer({ items: [{ type: 'nope', props: {} }] })).toThrow(/Unknown component: nope/);
    expect(() => host.layout.add({ items: [{ type: 'nope', props: {} }] })).toThrow(/Unknown component: nope/);
    expect(() => host.suggestions.offer({ items: [{ type: 'test-chart', props: { driver: 44 } }] })).toThrow(/Invalid props for test-chart/);
    expect(() => host.layout.add({ items: [{ type: 'video', props: {} }] })).toThrow(/video needs a feed/);
    expect(labels()).toEqual([]);
    expect(layout.tiles()).toEqual([]);
  });

  it('take any number of streams', () => {
    const out = host.suggestions.offer({
      items: [...['1:44', '1:1', '1:4', '1:16'].map(video), { type: 'test-chart', props: { driver: 'HAM' } }, video('1:11')],
    });
    expect(out.suggested).toEqual(['HAM', 'VER', 'NOR', 'LEC', 'Chart HAM', 'PER']);
    expect(labels()).toEqual(['HAM', 'VER', 'NOR', 'LEC', 'Chart HAM', 'PER']);
  });

  it('return the id of the tile showing each, whether added now or already on screen', () => {
    const [ham, chart] = host.layout.add({ items: [video('1:44'), { type: 'test-chart', props: { driver: 'HAM' } }] });
    expect(layout.tiles().map((t) => t.id)).toEqual([ham, chart]);
    expect(host.layout.add({ items: [video('1:1'), video('1:44')] })).toEqual([expect.not.stringMatching(new RegExp(`^(${ham}|${chart})$`)), ham]);
  });

  it('come off screen by tile id', () => {
    const [, chart] = host.layout.add({ items: [video('1:44'), { type: 'test-chart', props: { driver: 'HAM' } }] });
    expect(host.layout.remove({ tiles: [chart, 'nothing'] })).toEqual(['Chart HAM']);
    expect(layout.tiles().map((t) => t.component.label)).toEqual(['HAM']);
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
  const dataOpen = vi.fn(async () => {});
  let sendStatus: (status: DataStatus) => void = () => {};

  beforeEach(() => {
    // The data fails at once unless a test sends its status itself: opening a session waits for it to settle.
    dataOpen.mockRejectedValue(new Error('No archive in a test.'));
    vi.stubGlobal('window', { omfv: { f1tv, data: { onStatus: (cb: (status: DataStatus) => void) => ((sendStatus = cb), () => {}), onCircuit: () => () => {}, open: dataOpen, close: vi.fn(async () => {}), objects: async () => ({ drivers: [], lapCount: null }) } } });
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

  it('opening a session returns once its timing data has settled, so what comes next can use it', async () => {
    vi.useFakeTimers();
    dataOpen.mockResolvedValue(undefined);
    f1tv.sessions.mockResolvedValue([session(5, 'Race', 'replay')]);
    await runTool('list_sessions', { pageId: 1, year: 2026 });
    let returned = false;
    const run = runTool('load_session', { contentId: 5, title: 'Race' }).then((out) => ((returned = true), out));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(useSession.getState().session).toMatchObject({ contentId: 5 });
    expect(returned).toBe(false);
    const datasets = { timing: { state: 'complete', reason: null }, telemetry: { state: 'loading', reason: null }, results: { state: 'loading', reason: null } };
    sendStatus({ sessionKey: 5, state: 'ready', reason: null, coverage: { datasets } as never, clock: null, sessionStartSec: null, liveLeadMs: null, tables: [] });
    await vi.advanceTimersByTimeAsync(500);
    expect(JSON.parse(await run)).toMatchObject({ opened: 'Race' });
  });

  it('opening a session returns without its timing data after a while', async () => {
    vi.useFakeTimers();
    dataOpen.mockResolvedValue(undefined);
    f1tv.sessions.mockResolvedValue([session(5, 'Race', 'replay')]);
    await runTool('list_sessions', { pageId: 1, year: 2026 });
    const run = runTool('load_session', { contentId: 5, title: 'Race' });
    await vi.advanceTimersByTimeAsync(OPEN_WAIT_MS + 500);
    expect(JSON.parse(await run)).toMatchObject({ opened: 'Race' });
  });

  it('can go back to the start before anything has played', async () => {
    f1tv.sessions.mockResolvedValue([session(5, 'Live race', 'live')]);
    await runTool('list_sessions', { pageId: 1, year: 2026 });
    await runTool('load_session', { contentId: 5, title: 'x' });
    await expect(runTool('seek_to_start', {})).resolves.toMatch(/start/);
  });

  it('closes the open session, leaving only the picking tools', async () => {
    f1tv.sessions.mockResolvedValue([session(5, 'Race', 'replay')]);
    await runTool('list_sessions', { pageId: 1, year: 2026 });
    await runTool('load_session', { contentId: 5, title: 'Race' });
    expect(toolDefinitions('view').map((t) => t.name)).toContain('close_session');
    await expect(runTool('close_session', {})).resolves.toMatch(/^Closed\./);
    expect(useSession.getState().session).toBeNull();
    expect(toolDefinitions('view').map((t) => t.name).sort()).toEqual([...PICKING_TOOLS].sort());
    await expect(runTool('close_session', {})).rejects.toThrow(/No session is open/);
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

const { sessionControl } = await import('../data/session');
const { useSessionData } = await import('../data/sessionData');
const { askAgent, describeAppState } = await import('./bridge');

describe('seeking to a moment', () => {
  const open = { contentId: 1, title: 'Race', type: 'race', status: 'replay' } as SessionInfo;
  const PLAYHEAD = 1_700_000_000_000;
  const driver = (name_acronym: string, driver_number: number) => ({ driver_number, name_acronym }) as DriverEntry;
  const ready = (playheadMs: number | null): SessionDataView => ({
    state: 'ready',
    sessionKey: 9,
    datasets: {} as never,
    revision: 1,
    playheadMs,
    drivers: [driver('VER', 1), driver('HAM', 44)],
    lapCount: null,
    tables: [],
  });
  let seekToDate: MockInstance<typeof sessionControl.seekToDate>;

  beforeEach(() => {
    useSession.setState({ session: open, channels });
    useSessionData.setState(ready(PLAYHEAD), true);
    seekToDate = vi.spyOn(sessionControl, 'seekToDate').mockReturnValue({ timeSec: 3_723.4, clamped: false });
    spoilerGate.mockClear();
    sessionSql.mockClear();
  });
  afterEach(() => {
    seekToDate.mockRestore();
    useSessionData.setState({ state: 'idle' }, true);
    useSession.setState({ session: null, channels: [] });
  });

  it('a playhead query runs without asking', async () => {
    sessionSql.mockResolvedValueOnce({ columns: ['lap_number'], rows: [{ lap_number: 3 }] });
    const out = JSON.parse(await runTool('query_session', { sql: 'SELECT lap_number FROM laps' }));
    expect(out).toEqual({ columns: ['lap_number'], rows: [[3]] });
    expect(spoilerGate).not.toHaveBeenCalled();
    expect(sessionSql).toHaveBeenCalledWith('SELECT lap_number FROM laps', undefined, undefined);
  });

  it('a whole-session query asks the gate before it runs', async () => {
    const sql = 'SELECT date_start FROM laps WHERE lap_number = 30';
    spoilerGate.mockImplementationOnce(async () => {
      expect(sessionSql).not.toHaveBeenCalled();
      return { approved: true };
    });
    await runTool('query_session', { sql, asOf: 'session' });
    expect(spoilerGate).toHaveBeenCalledWith({ kind: 'read_ahead', session: 'Race', playheadMs: PLAYHEAD, sql });
    expect(sessionSql).toHaveBeenCalledWith(sql, undefined, 'session');
  });

  it('says a whole-session query reads past the playhead, and a playhead one does not', () => {
    expect(readsPastPlayhead('query_session', { sql: 'SELECT 1', asOf: 'session' })).toBe(true);
    expect(readsPastPlayhead('query_session', { sql: 'SELECT 1', asOf: 'playhead' })).toBe(false);
    expect(readsPastPlayhead('query_session', { sql: 'SELECT 1' })).toBe(false);
    expect(readsPastPlayhead('seek_to', { date: 1 })).toBe(false);
    expect(readsPastPlayhead('no_such_tool', {})).toBe(false);
  });

  it('a refused read ahead never runs the query', async () => {
    spoilerGate.mockResolvedValueOnce({ approved: false, reason: 'not yet' });
    await expect(runTool('query_session', { sql: 'SELECT 1', asOf: 'session' })).rejects.toThrow(/did not allow that: not yet/);
    expect(sessionSql).not.toHaveBeenCalled();
  });

  it('moves from the frame on screen without the session data, asking first only when going forward', async () => {
    const seekBy = vi.spyOn(sessionControl, 'seekBy').mockReturnValue({ timeSec: 100, clamped: false });
    const data = useSessionData.getState();
    try {
      // With no data at the frame on screen, as behind a live capture, there's no row to take a date from.
      useSessionData.setState({ state: 'idle' }, true);
      await expect(runTool('seek_to', { delta: -120 })).resolves.toBe('Playback is at 0:01:40.');
      expect(seekBy).toHaveBeenCalledWith(-120);
      expect(spoilerGate).not.toHaveBeenCalled();

      spoilerGate.mockResolvedValueOnce({ approved: false });
      await expect(runTool('seek_to', { delta: 30 })).rejects.toThrow(/did not allow that/);
      expect(seekBy).toHaveBeenCalledTimes(1);

      useSessionData.setState(data, true);
      await runTool('seek_to', { delta: 30 });
      expect(spoilerGate).toHaveBeenLastCalledWith({ kind: 'seek_forward', session: 'Race', playheadMs: PLAYHEAD, targetMs: PLAYHEAD + 30_000 });
      expect(seekBy).toHaveBeenLastCalledWith(30);
      expect(seekToDate).not.toHaveBeenCalled();

      await expect(runTool('seek_to', {})).rejects.toThrow(/Give a date, a delta, or both/);
    } finally {
      seekBy.mockRestore();
      useSessionData.setState(data, true);
    }
  });

  it('adds a delta to a date, and asks by where that lands', async () => {
    // Later than the playhead, but 30s before it is behind: no check.
    await runTool('seek_to', { date: PLAYHEAD + 10_000, delta: -30 });
    expect(seekToDate).toHaveBeenLastCalledWith(PLAYHEAD + 10_000, -30);
    expect(spoilerGate).not.toHaveBeenCalled();

    // The playhead plus a minute is ahead.
    await runTool('seek_to', { date: PLAYHEAD, delta: 60 });
    expect(spoilerGate).toHaveBeenLastCalledWith({ kind: 'seek_forward', session: 'Race', playheadMs: PLAYHEAD, targetMs: PLAYHEAD + 60_000 });
    expect(seekToDate).toHaveBeenLastCalledWith(PLAYHEAD, 60);
  });

  it('goes live only on a live session, asking first when behind the edge', async () => {
    const goLive = vi.spyOn(sessionControl, 'goLive').mockImplementation(() => {});
    const clock = useSession.getState().clock;
    try {
      await expect(runTool('go_live', {})).rejects.toThrow(/not live/);

      useSession.setState({ session: { ...open, status: 'live' }, clock: { ...clock, live: true, timeSec: 100, end: 160, atLiveEdge: false } });
      spoilerGate.mockResolvedValueOnce({ approved: false });
      await expect(runTool('go_live', {})).rejects.toThrow(/did not allow that/);
      expect(spoilerGate).toHaveBeenCalledWith({ kind: 'seek_forward', session: 'Race', playheadMs: PLAYHEAD, targetMs: PLAYHEAD + 60_000 });
      expect(goLive).not.toHaveBeenCalled();

      await expect(runTool('go_live', {})).resolves.toBe('At the live edge.');
      expect(goLive).toHaveBeenCalledTimes(1);

      // Already there, it doesn't ask.
      spoilerGate.mockClear();
      useSession.setState({ clock: { ...clock, live: true, timeSec: 152, end: 160, atLiveEdge: true } });
      await runTool('go_live', {});
      expect(spoilerGate).not.toHaveBeenCalled();
    } finally {
      goLive.mockRestore();
      useSession.setState({ clock });
    }
  });

  it('asks every time, not once per turn', async () => {
    await runTool('query_session', { sql: 'SELECT 1', asOf: 'session' });
    await runTool('query_session', { sql: 'SELECT 1', asOf: 'session' });
    expect(spoilerGate).toHaveBeenCalledTimes(2);
  });

  it('sends the model at most 200 rows, and says so', async () => {
    sessionSql.mockResolvedValueOnce({ columns: ['n'], rows: Array.from({ length: 250 }, (_, n) => ({ n })) });
    const out = JSON.parse(await runTool('query_session', { sql: 'SELECT n FROM x' }));
    expect(out.rows).toHaveLength(200);
    expect(out.note).toMatch(/200 of 250 rows. Narrow the query/);
  });

  it('says an empty playhead read may just be too early, but not for a whole-session one', async () => {
    sessionSql.mockResolvedValue({ columns: ['n'], rows: [] });
    expect(JSON.parse(await runTool('query_session', { sql: 'SELECT n FROM x' })).note).toMatch(/asOf "session"/);
    expect(JSON.parse(await runTool('query_session', { sql: 'SELECT n FROM x', asOf: 'session' })).note).toBeUndefined();
    sessionSql.mockReset();
  });

  describe('while the timing data loads', () => {
    const loading: SessionDataView = { state: 'loading', sessionKey: 9, datasets: null };
    let notes: string[];
    let offNotes: () => void;

    beforeEach(() => {
      vi.useFakeTimers();
      notes = [];
      offNotes = setWaitNotifier((text) => notes.push(text));
      beginTurn();
    });
    afterEach(() => {
      offNotes();
      vi.useRealTimers();
    });

    it('a query waits for it, telling the viewer, then runs', async () => {
      useSessionData.setState(loading, true);
      sessionSql.mockResolvedValueOnce({ columns: ['n'], rows: [{ n: 1 }] });
      const run = runTool('query_session', { sql: 'SELECT 1 AS n' });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(sessionSql).not.toHaveBeenCalled();
      expect(notes).toEqual(['Loading the timing data…']);
      useSessionData.setState(ready(PLAYHEAD), true);
      await vi.advanceTimersByTimeAsync(500);
      expect(JSON.parse(await run).rows).toEqual([[1]]);
      expect(notes).toEqual(['Loading the timing data…', 'Timing data loaded.']);
    });

    it('a seek waits for it too', async () => {
      useSessionData.setState(loading, true);
      const run = runTool('seek_to', { date: PLAYHEAD - 1000 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(seekToDate).not.toHaveBeenCalled();
      useSessionData.setState(ready(PLAYHEAD), true);
      await vi.advanceTimersByTimeAsync(500);
      await expect(run).resolves.toMatch(/Playback is at/);
    });

    it('says nothing to the viewer when there is nothing to wait for', async () => {
      await runTool('query_session', { sql: 'SELECT 1' });
      expect(notes).toEqual([]);
    });

    it('gives up after a while, and tells the agent not to try again', async () => {
      useSessionData.setState(loading, true);
      const run = runTool('query_session', { sql: 'SELECT 1' });
      const refused = expect(run).rejects.toThrow(/still isn't ready after 30s.*ask again in a moment/);
      await vi.advanceTimersByTimeAsync(DATA_WAIT_MS + 500);
      await refused;
      expect(sessionSql).not.toHaveBeenCalled();
    });

    it('stops waiting, and says why, when the data fails', async () => {
      useSessionData.setState(loading, true);
      const run = runTool('seek_to', { date: PLAYHEAD });
      const refused = expect(run).rejects.toThrow(/isn't available\. The archive was refused\..*won't change that/);
      await vi.advanceTimersByTimeAsync(300);
      useSessionData.setState({ state: 'failed', reason: 'The archive was refused.' }, true);
      await vi.advanceTimersByTimeAsync(500);
      await refused;
      expect(seekToDate).not.toHaveBeenCalled();
      expect(notes).toEqual(['Loading the timing data…']);
    });

    it('never acts for a turn that ended while it waited', async () => {
      useSessionData.setState(loading, true);
      const endTurn = beginTurn();
      const run = runTool('seek_to', { date: PLAYHEAD - 1000 });
      const refused = expect(run).rejects.toThrow(/The request ended/);
      await vi.advanceTimersByTimeAsync(300);
      endTurn();
      useSessionData.setState(ready(PLAYHEAD), true);
      await vi.advanceTimersByTimeAsync(500);
      await refused;
      expect(seekToDate).not.toHaveBeenCalled();
    });

    it('stops waiting when the session changes', async () => {
      useSessionData.setState(loading, true);
      const run = runTool('query_session', { sql: 'SELECT 1' });
      const refused = expect(run).rejects.toThrow(/closed or changed/);
      await vi.advanceTimersByTimeAsync(300);
      useSession.setState({ session: { ...open } });
      await vi.advanceTimersByTimeAsync(500);
      await refused;
    });

    it('waits for a live video to say what time it shows, but not for one behind the data', async () => {
      const waiting = { state: 'waiting', sessionKey: 9, datasets: {}, tables: [], drivers: [], reason: 'Not lined up with the video yet', detail: 'It appears as soon as it does.' };
      useSessionData.setState({ ...waiting, brief: true } as unknown as SessionDataView, true);
      const run = runTool('query_session', { sql: 'SELECT 1' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(notes).toEqual(['Lining the timing data up with the live video…']);
      useSessionData.setState({ ...waiting, brief: false, ahead: true, reason: 'Waiting for the video to reach the live data' } as unknown as SessionDataView, true);
      const refused = expect(run).rejects.toThrow(/Waiting for the video to reach the live data/);
      await vi.advanceTimersByTimeAsync(500);
      await refused;
      expect(notes.at(-1)).toBe("Timing data loaded. It's ahead of the live video, and shows once the video catches up.");
    });

    it('closes the loading line when the data loads but cannot show yet', async () => {
      const waiting = { state: 'waiting', sessionKey: 9, datasets: {}, tables: [], drivers: [], brief: false, detail: '' };
      // Joining a live session: loaded, and ahead of the video.
      useSessionData.setState(loading, true);
      let run = runTool('query_session', { sql: 'SELECT 1' });
      let refused = expect(run).rejects.toThrow(/can't be read at the frame on screen yet/);
      await vi.advanceTimersByTimeAsync(300);
      useSessionData.setState({ ...waiting, ahead: true, reason: 'Waiting for the video to reach the live data' } as unknown as SessionDataView, true);
      await vi.advanceTimersByTimeAsync(500);
      await refused;
      expect(notes).toEqual(['Loading the timing data…', "Timing data loaded. It's ahead of the live video, and shows once the video catches up."]);

      // A replay with no anchor yet says its own reason.
      notes.length = 0;
      useSessionData.setState(loading, true);
      run = runTool('query_session', { sql: 'SELECT 1' });
      refused = expect(run).rejects.toThrow(/Not lined up with the video yet/);
      await vi.advanceTimersByTimeAsync(300);
      useSessionData.setState({ ...waiting, ahead: false, reason: 'Not lined up with the video yet' } as unknown as SessionDataView, true);
      await vi.advanceTimersByTimeAsync(500);
      await refused;
      expect(notes).toEqual(['Loading the timing data…', 'Timing data loaded. Not lined up with the video yet.']);
    });
  });

  it('refuses at once when the timing data failed', async () => {
    useSessionData.setState({ state: 'failed', reason: 'The archive was refused.' }, true);
    await expect(runTool('seek_to', { date: PLAYHEAD })).rejects.toThrow(/The archive was refused/);
    expect(seekToDate).not.toHaveBeenCalled();
  });

  it('refuses a read at the frame on screen while the data waits for the video, but not a whole-session one', async () => {
    const waiting = { state: 'waiting', sessionKey: 9, datasets: {}, tables: [], brief: false, reason: 'Not lined up with the video yet', detail: 'MultiViewer has not published it.' };
    useSessionData.setState(waiting as unknown as SessionDataView, true);
    await expect(runTool('query_session', { sql: 'SELECT 1' })).rejects.toThrow(/at the frame on screen yet: Not lined up with the video yet\. MultiViewer.*won't change that/);
    await expect(runTool('seek_to', { date: PLAYHEAD })).rejects.toThrow(/Not lined up/);
    expect(sessionSql).not.toHaveBeenCalled();
    sessionSql.mockResolvedValue({ columns: ['n'], rows: [{ n: 1 }] });
    spoilerGate.mockResolvedValueOnce({ approved: true });
    await runTool('query_session', { sql: 'SELECT 1 AS n', asOf: 'session' });
  });

  it('says playback is starting, not paused, until a stream is ready', () => {
    const before = useSession.getState();
    const stream = { id: 'v1', feed: 'main', tile: null, quiet: false, status: 'loading', error: null };
    useSession.setState({ streams: { v1: stream }, clock: { ...before.clock, playing: false } } as never);
    expect(describeAppState()).toMatch(/playback: starting at/);
    useSession.setState({ streams: { v1: { ...stream, status: 'ready' } } } as never);
    expect(describeAppState()).toMatch(/playback: paused at/);
    useSession.setState(before, true);
  });

  it('says the data is waiting, and why', () => {
    useSessionData.setState({ state: 'waiting', sessionKey: 9, datasets: {}, tables: [], reason: 'Not lined up with the video yet', detail: 'MultiViewer has not published it.', drivers: [{ driver_number: 44, name_acronym: 'HAM' }] } as never, true);
    expect(describeAppState()).toContain('timing data: waiting, so nothing at the frame on screen can be read. Not lined up with the video yet: MultiViewer has not published it.');
    expect(describeAppState()).toContain('drivers: HAM 44');
  });

  it("says why there's no data", () => {
    useSessionData.setState({ state: 'failed', reason: "F1 hasn't published this session's timing yet. It's checked again every 5 minutes." }, true);
    expect(describeAppState()).toContain("timing data: failed. F1 hasn't published this session's timing yet. It's checked again every 5 minutes.");
  });
});

describe('the master volume', () => {
  const open = { contentId: 1, title: 'Race', type: 'race', status: 'replay' } as SessionInfo;
  let setAudio: MockInstance<typeof sessionControl.setAudio>;
  let ham = '';
  const videoOf = (id: string, feed: string, tile: string | null, quiet = false) => ({ id, feed, tile, quiet, status: 'ready' as const, error: null });

  beforeEach(() => {
    layout.clear();
    useSession.setState({ session: open, channels, volume: 0.6 });
    [ham] = host.layout.add({ items: [video('1:44')] });
    useSession.setState({ streams: { v1: videoOf('v1', '1:44', ham) }, audioVideoId: 'v1' });
    setAudio = vi.spyOn(sessionControl, 'setAudio').mockImplementation((id) => useSession.setState({ audioVideoId: id }));
  });
  afterEach(() => {
    setAudio.mockRestore();
    layout.clear();
    useSession.setState({ session: null, channels: [], streams: {}, audioVideoId: null, volume: 1 });
  });

  it('is in app_state next to the audible video and its tile', () => {
    expect(describeAppState()).toContain(`audio: HAM in ${ham} at 60% volume`);
    useSession.setState({ volume: 0 });
    expect(describeAppState()).toContain(`audio: HAM in ${ham}, but the volume is 0 so nothing can be heard`);
    useSession.setState({ audioVideoId: null });
    expect(describeAppState()).toContain('audio: muted');
  });

  it('is set as a percentage', async () => {
    expect(await runTool('set_volume', { volume: 35 })).toBe('Volume is now 35%.');
    expect(useSession.getState().volume).toBe(0.35);
    expect(useSession.getState().audioVideoId).toBe('v1');
  });

  it('says when no stream is audible to hear it', async () => {
    useSession.setState({ audioVideoId: null });
    expect(await runTool('set_volume', { volume: 80 })).toBe('Volume is now 80%. No stream is audible; choose one with set_audio.');
  });

  it('makes set_audio warn when nothing can be heard', async () => {
    expect(await runTool('set_audio', { stream: 'HAM' })).toBe(`Audio is now HAM in ${ham}.`);
    useSession.setState({ volume: 0 });
    expect(await runTool('set_audio', { stream: 'HAM' })).toBe(`Audio is now HAM in ${ham}, but the volume is 0, so nothing can be heard.`);
  });

  it('picks the video for a stream shown in more than one tile, without asking', async () => {
    const [battle] = host.layout.add({ items: [video('1:1')] });
    // HAM also shows in a second tile, as a component's picture would, and a preview of it is never heard.
    useSession.setState({
      streams: { v1: videoOf('v1', '1:44', ham), v2: videoOf('v2', '1:44', battle), v3: videoOf('v3', '1:44', null, true) },
      audioVideoId: null,
    });
    // No main tile: the oldest.
    await runTool('set_audio', { stream: 'Hamilton' });
    expect(setAudio).toHaveBeenLastCalledWith('v1');
    // The main tile's comes first.
    host.layout.setMain({ tile: battle });
    useSession.setState({ audioVideoId: null });
    await runTool('set_audio', { stream: 'HAM' });
    expect(setAudio).toHaveBeenLastCalledWith('v2');
    // The one already heard stays, if it shows that stream.
    useSession.setState({ audioVideoId: 'v1' });
    await runTool('set_audio', { stream: 'HAM' });
    expect(setAudio).toHaveBeenLastCalledWith('v1');
  });

  it('refuses a stream no tile shows', async () => {
    await expect(runTool('set_audio', { stream: 'NOR' })).rejects.toThrow('"NOR" is not on screen. Suggest it first.');
    expect(await runTool('set_audio', { stream: 'none' })).toBe('All streams muted.');
    expect(setAudio).toHaveBeenLastCalledWith(null);
  });
});
