import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, SessionInfo } from '../../shared/api';
import type { DriverEntry, SessionDataView } from '../../shared/sessionData';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

// A file of its own, so the stand-in charts registered here don't leak into other tests.
const { runTool, toolDefinitions } = await import('./tools');
const { describeAppState, describeCharts } = await import('./bridge');
const { driversOf, resolveDriver } = await import('./matching');
const { defineComponent, host, read } = await import('../host');
const { useSession } = await import('../data/session');
const { useSessionData } = await import('../data/sessionData');
const { layout } = await import('../layout/store');
const { components } = await import('../components/registry');
const Type = (await import('typebox')).default;

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
  onboard('HAM', 'Lewis Hamilton', 44),
  onboard('VER', 'Max Verstappen', 1),
  onboard('NOR', 'Lando Norris', 4),
];

const entry = (driver_number: number, name_acronym: string, first_name: string, last_name: string): DriverEntry => ({
  driver_number,
  name_acronym,
  first_name,
  last_name,
  full_name: `${first_name} ${last_name.toUpperCase()}`,
  broadcast_name: null,
  team_name: null,
  team_colour: null,
  headshot_url: null,
  country_code: null,
});

// Gasly has no onboard feed here, so only the roster knows him.
const roster = [entry(44, 'HAM', 'Lewis', 'Hamilton'), entry(1, 'VER', 'Max', 'Verstappen'), entry(10, 'GAS', 'Pierre', 'Gasly')];

describe('driver matching', () => {
  it.each([
    ['HAM', 44],
    ['hamilton', 44],
    ['Lewis', 44],
    ['44', 44],
    ['Verstapen', 1],
    ['Gasly', 10],
    ['10', 10],
  ])('%s resolves to car %i from the roster', (ref, number) => {
    expect(resolveDriver(driversOf(roster, channels), ref)?.number).toBe(number);
  });

  it('falls back to the onboard feeds without a roster', () => {
    const drivers = driversOf([], channels);
    expect(drivers.map((d) => d.number)).toEqual([44, 1, 4]);
    expect(resolveDriver(drivers, 'Norris')?.number).toBe(4);
    expect(resolveDriver(drivers, 'Gasly')).toBeNull();
  });

  it.each(['main', 'F1 Live', 'nobody', ''])('%s is not a driver', (ref) => {
    expect(resolveDriver(driversOf(roster, channels), ref)).toBeNull();
  });
});

const Drivers = (options: { minItems?: number; maxItems?: number }) => Type.Array(Type.Integer(), options);
const keyOf = (name: string, drivers?: number[]) => `${name}:${drivers?.join('-') ?? 'auto'}`;

const gap = defineComponent({
  name: 'test_gap',
  title: 'Test gap',
  description: 'The gap between two drivers.',
  args: Type.Object({ drivers: Drivers({ minItems: 2, maxItems: 2 }) }),
  sessions: ['race', 'sprint'],
  needs: ['timing'],
  spec: ({ drivers }) => ({ key: keyOf('test_gap', drivers), label: `Gap ${drivers.join(' v ')}` }),
  View: () => null,
});
const pit = defineComponent({
  name: 'test_pit',
  title: 'Test pit window',
  description: 'When one driver could stop.',
  args: Type.Object({ drivers: Drivers({ minItems: 1, maxItems: 1 }) }),
  spec: ({ drivers }) => ({ key: keyOf('test_pit', drivers), label: `Pit ${drivers[0]}` }),
  View: () => null,
});
const field = defineComponent({
  name: 'test_field',
  title: 'Test field',
  description: 'Up to six drivers, or the ones it picks.',
  args: Type.Object({ drivers: Type.Optional(Drivers({ maxItems: 6 })) }),
  spec: ({ drivers }) => ({ key: keyOf('test_field', drivers), label: 'Field' }),
  View: () => null,
});
const weather = defineComponent({
  name: 'test_weather',
  title: 'Test weather',
  description: 'The weather.',
  args: Type.Object({}),
  needs: ['timing'],
  spec: () => ({ key: 'test_weather', label: 'Weather' }),
  View: () => null,
});

describe('the chart list', () => {
  it('is left out while only video is registered', () => {
    host.components.register({ components: components.filter((c) => c.name === 'video') });
    expect(describeCharts(read().components)).toBe('');
    const suggest = toolDefinitions().find((t) => t.name === 'suggest_tiles');
    expect(Object.keys((suggest?.parameters as { properties: object }).properties)).toEqual(['streams']);
  });

  it('lists each chart in a line, and the tool takes their names', () => {
    host.components.register({ components: [gap, pit, field, weather] });
    expect(describeCharts(read().components).split('\n')).toEqual([
      'Charts for suggest_tiles. Each line: name, title, drivers it takes, session types, what it is for. One marked replays only cannot be suggested in a live session. One that can take none picks its own.',
      'test_gap, Test gap, exactly 2 drivers, race/sprint: The gap between two drivers.',
      'test_pit, Test pit window, exactly 1 driver, any session: When one driver could stop.',
      'test_field, Test field, 0 to 6 drivers, any session: Up to six drivers, or the ones it picks.',
      'test_weather, Test weather, no drivers, any session: The weather.',
    ]);
    const suggest = toolDefinitions().find((t) => t.name === 'suggest_tiles');
    expect(suggest?.parameters).toMatchObject({
      properties: { charts: { items: { properties: { chart: { enum: ['test_gap', 'test_pit', 'test_field', 'test_weather'] } } } } },
    });
    expect(JSON.parse(JSON.stringify(suggest))).toEqual(suggest);
  });
});

describe('suggesting charts', () => {
  const race = { contentId: 1, title: 'Race', status: 'replay', type: 'race' } as SessionInfo;
  const ready = { state: 'ready', drivers: roster } as unknown as SessionDataView;
  const props = () => read().suggestions.items.map((i) => ({ type: i.type, props: i.props }));

  beforeEach(() => {
    host.components.register({ components: [...components, gap, pit, field, weather] });
    useSession.setState({ session: race, channels });
    useSessionData.setState(ready, true);
    layout.clear();
  });
  afterEach(() => {
    host.suggestions.newTurn();
    layout.clear();
    useSession.setState({ session: null, channels: [] });
    useSessionData.setState({ state: 'idle' }, true);
  });

  it('lists a replay-only chart as such, and refuses it in a live session', async () => {
    expect(describeCharts(read().components)).toContain('car_telemetry, Telemetry, exactly 1 driver, any session, replays only: ');
    useSession.setState({ session: { ...race, status: 'live' }, channels });
    await expect(runTool('suggest_tiles', { charts: [{ chart: 'car_telemetry', drivers: ['HAM'] }] })).rejects.toThrow(
      'car_telemetry works in replays only, and this session is live: leave it out. Nothing was suggested.',
    );
    useSession.setState({ session: race, channels });
    await expect(runTool('suggest_tiles', { charts: [{ chart: 'car_telemetry', drivers: ['HAM'] }] })).resolves.toContain('Suggested: Telemetry');
  });

  it('suggests a chart next to the onboards, with drivers as car numbers', async () => {
    const out = await runTool('suggest_tiles', { streams: ['HAM', 'VER'], charts: [{ chart: 'test_gap', drivers: ['Hamilton', 'max'] }] });
    expect(out).toBe('Suggested: HAM, VER, Gap 44 v 1. The user decides; nothing is on screen until they add it.');
    expect(props()).toEqual([
      { type: 'video', props: { feed: '1:44' } },
      { type: 'video', props: { feed: '1:1' } },
      { type: 'test_gap', props: { drivers: [44, 1] } },
    ]);
    expect(layout.tiles()).toEqual([]);
  });

  it('resolves drivers from the roster, even without an onboard', async () => {
    await runTool('suggest_tiles', { charts: [{ chart: 'test_pit', drivers: ['GAS'] }] });
    expect(props()).toEqual([{ type: 'test_pit', props: { drivers: [10] } }]);
  });

  it('lets a chart that can take no drivers pick its own', async () => {
    await runTool('suggest_tiles', { charts: [{ chart: 'test_field' }, { chart: 'test_weather' }] });
    expect(props()).toEqual([
      { type: 'test_field', props: {} },
      { type: 'test_weather', props: {} },
    ]);
  });

  it('refuses the wrong number of drivers, and suggests nothing', async () => {
    await expect(runTool('suggest_tiles', { streams: ['HAM'], charts: [{ chart: 'test_gap', drivers: ['HAM'] }] })).rejects.toThrow(
      'test_gap takes exactly 2 drivers, and 1 was given. Nothing was suggested.',
    );
    await expect(runTool('suggest_tiles', { charts: [{ chart: 'test_pit' }] })).rejects.toThrow(/takes exactly 1 driver, and none were given: ask the user which/);
    await expect(runTool('suggest_tiles', { charts: [{ chart: 'test_weather', drivers: ['HAM'] }] })).rejects.toThrow(/takes no drivers/);
    // The same driver twice is one driver.
    await expect(runTool('suggest_tiles', { charts: [{ chart: 'test_gap', drivers: ['HAM', '44'] }] })).rejects.toThrow(/1 was given/);
    expect(props()).toEqual([]);
  });

  it('refuses a driver it cannot find', async () => {
    await expect(runTool('suggest_tiles', { charts: [{ chart: 'test_pit', drivers: ['Senna'] }] })).rejects.toThrow(
      /No driver matches "Senna" in this session: ask the user who they mean/,
    );
  });

  it('refuses a chart for another session type', async () => {
    useSession.setState({ session: { ...race, type: 'sprint-qualifying' } });
    await expect(runTool('suggest_tiles', { charts: [{ chart: 'test_gap', drivers: ['HAM', 'VER'] }] })).rejects.toThrow(
      'test_gap is for race, sprint sessions, and this is sprint qualifying: leave it out. Nothing was suggested.',
    );
    // One for any session is fine.
    await runTool('suggest_tiles', { charts: [{ chart: 'test_pit', drivers: ['HAM'] }] });
    expect(props()).toHaveLength(1);
  });

  it('refuses an unknown chart, and video', async () => {
    await expect(runTool('suggest_tiles', { charts: [{ chart: 'lap_chart' }] })).rejects.toThrow(/There is no chart "lap_chart": pick a name from the chart list/);
    await expect(runTool('suggest_tiles', { charts: [{ chart: 'video' }] })).rejects.toThrow(/There is no chart "video"/);
  });

  it('refuses a chart that needs data the session does not have, passing the reason on', async () => {
    useSessionData.setState({ state: 'unsupported', reason: 'Data starts in 2023.' }, true);
    await expect(runTool('suggest_tiles', { charts: [{ chart: 'test_weather' }] })).rejects.toThrow('test_weather has no data for this session: Data starts in 2023.');
  });

  it('refuses a call that names nothing', async () => {
    await expect(runTool('suggest_tiles', {})).rejects.toThrow(/at least one stream or chart/);
  });

  it('refuses with no session open', async () => {
    useSession.setState({ session: null });
    await expect(runTool('suggest_tiles', { charts: [{ chart: 'test_weather' }] })).rejects.toThrow(/No session is open/);
  });

  it('shows chart tiles in the app state by label and chart name', () => {
    host.layout.add({ items: [{ type: 'video', props: { feed: '1:44' } }, { type: 'test_gap', props: { drivers: [44, 1] } }] });
    expect(describeAppState()).toMatch(/^on screen: HAM; Gap 44 v 1 \(test_gap chart\)$/m);
  });

  describe('remove_tiles', () => {
    beforeEach(() => {
      host.layout.add({
        items: [
          { type: 'video', props: { feed: '1:44' } },
          { type: 'video', props: { feed: '1:1' } },
          { type: 'test_gap', props: { drivers: [44, 1] } },
          { type: 'test_pit', props: { drivers: [44] } },
          { type: 'test_pit', props: { drivers: [1] } },
        ],
      });
    });
    const labels = () => layout.tiles().map((t) => t.component.label);

    it('takes off a stream', async () => {
      expect(await runTool('remove_tiles', { tiles: ['Hamilton'] })).toBe('Removed: HAM.');
      expect(labels()).toEqual(['VER', 'Gap 44 v 1', 'Pit 44', 'Pit 1']);
    });

    it('takes off a chart by its label', async () => {
      expect(await runTool('remove_tiles', { tiles: ['pit 44'] })).toBe('Removed: Pit 44.');
      expect(labels()).toEqual(['HAM', 'VER', 'Gap 44 v 1', 'Pit 1']);
    });

    it('takes off every chart of a kind by its name or title', async () => {
      expect(await runTool('remove_tiles', { tiles: ['test_pit', 'Test gap'] })).toBe('Removed: Pit 44, Pit 1, Gap 44 v 1.');
      expect(labels()).toEqual(['HAM', 'VER']);
    });

    it('says what it could not find', async () => {
      expect(await runTool('remove_tiles', { tiles: ['VER', 'nobody', 'test_field'] })).toBe('Removed: VER. Not found: nobody.');
    });
  });
});
