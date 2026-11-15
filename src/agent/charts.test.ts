import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, SessionInfo } from '../../shared/api';
import type { DriverEntry, SessionDataView } from '../../shared/sessionData';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

// A file of its own, so the stand-in charts registered here don't leak into other tests.
const { offeredComponents, runTool, toolDefinitions } = await import('./tools');
const { askAgent, describeAppState, describeComponents } = await import('./bridge');
const { driversOf, resolveDriver } = await import('./matching');
const { defineComponent, Displayed, Driver, Highlighted, host, keyPart, read } = await import('../host');
const { useSession } = await import('../data/session');
const { useSessionData } = await import('../data/sessionData');
const { useBuild } = await import('../host/build');
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

const gap = defineComponent({
  name: 'test_gap',
  title: 'Test gap',
  description: 'The gap between two drivers.',
  args: Type.Object({ driver_a: Driver('One'), driver_b: Driver('The other') }),
  sessions: ['race', 'sprint'],
  needs: ['timing'],
  spec: ({ driver_a, driver_b }) => ({ key: `test_gap:${driver_a}-${driver_b}`, label: `Gap ${driver_a} v ${driver_b}` }),
  View: () => null,
});
const pit = defineComponent({
  name: 'test_pit',
  title: 'Test pit window',
  description: 'When one driver could stop.',
  args: Type.Object({ driver: Driver('The driver') }),
  spec: ({ driver }) => ({ key: `test_pit:${driver}`, label: `Pit ${driver}` }),
  View: () => null,
});
const field = defineComponent({
  name: 'test_field',
  title: 'Test field',
  description: 'Every car.',
  args: Type.Object({ drivers_to_display: Displayed(), drivers: Highlighted(6), laps: Type.Optional(Type.Integer({ description: 'Laps to show' })) }),
  spec: ({ drivers_to_display, drivers, laps }) => ({
    key: `test_field:${keyPart(drivers_to_display)}:${keyPart(drivers, 'none')}:${laps ?? 'all'}`,
    label: `Field ${keyPart(drivers_to_display)}/${keyPart(drivers, 'none')}`,
  }),
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
    expect(describeComponents(read().components)).toBe('');
    const suggest = toolDefinitions().find((t) => t.name === 'suggest_tiles');
    expect(Object.keys((suggest?.parameters as { properties: object }).properties)).toEqual(['streams']);
  });

  it('lists each chart in a line with its props, and the tool takes their names', () => {
    host.components.register({ components: [gap, pit, field, weather] });
    const lines = describeComponents(read().components).split('\n');
    expect(lines[0]).toMatch(/^Components for suggest_tiles\. .*Give a component every required prop/);
    expect(lines.slice(1)).toEqual([
      'test_gap, Test gap, race/sprint: The gap between two drivers. props driver_a (required): One, as a car number; driver_b (required): The other, as a car number.',
      'test_pit, Test pit window, any session: When one driver could stop. props driver (required): The driver, as a car number.',
      'test_field, Test field, any session: Every car. props drivers_to_display (optional): Drivers to draw. Left out, everyone, as car numbers; drivers (optional, at most 6): Drivers to highlight among those drawn. Left out, none is, as car numbers; laps (optional): Laps to show.',
      'test_weather, Test weather, any session: The weather. no props.',
    ]);
    const suggest = toolDefinitions().find((t) => t.name === 'suggest_tiles');
    expect(suggest?.parameters).toMatchObject({
      properties: { components: { items: { properties: { component: { enum: ['test_gap', 'test_pit', 'test_field', 'test_weather'] } } } } },
    });
    expect(JSON.parse(JSON.stringify(suggest))).toEqual(suggest);
  });
});

describe('suggesting charts', () => {
  const race = { contentId: 1, title: 'Race', status: 'replay', type: 'race' } as SessionInfo;
  const ready = { state: 'ready', drivers: roster, tables: [] } as unknown as SessionDataView;
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
    expect(describeComponents(read().components)).toContain('car_telemetry, Telemetry, race/sprint, replays only: ');
    useSession.setState({ session: { ...race, status: 'live' }, channels });
    await expect(runTool('suggest_tiles', { components: [{ component: 'car_telemetry', props: { driver: 'HAM' } }] })).rejects.toThrow(
      'car_telemetry works in replays only, and this session is live: leave it out. Nothing was suggested.',
    );
    useSession.setState({ session: race, channels });
    await expect(runTool('suggest_tiles', { components: [{ component: 'car_telemetry', props: { driver: 'HAM' } }] })).resolves.toContain('Suggested: Telemetry HAM');
  });

  it('needs the driver a one-driver chart is about, and never picks one', async () => {
    for (const chart of ['pedal_barcode', 'speed_ribbon', 'car_telemetry', 'pit_window']) {
      await expect(runTool('suggest_tiles', { components: [{ component: chart }] }), chart).rejects.toThrow(`${chart} needs driver, and none was given: ask the user which driver`);
    }
    await expect(runTool('suggest_tiles', { components: [{ component: 'pedal_barcode', props: { driver: 'HAM' } }] })).resolves.toContain('Suggested: Pedals HAM');
    // A list given to a one-driver prop is one too many.
    await expect(runTool('suggest_tiles', { components: [{ component: 'pedal_barcode', props: { driver: ['HAM', 'VER'] } }] })).rejects.toThrow(/driver is one driver, and 2 were given/);
    expect(props()).toEqual([{ type: 'pedal_barcode', props: { driver: 44 } }]);
  });

  it('suggests a chart next to the onboards, with drivers as car numbers', async () => {
    const out = await runTool('suggest_tiles', { streams: ['HAM', 'VER'], components: [{ component: 'test_gap', props: { driver_a: 'Hamilton', driver_b: 'max' } }] });
    expect(out).toBe('Suggested: HAM, VER, Gap 44 v 1. The user decides; nothing is on screen until they add it.');
    expect(props()).toEqual([
      { type: 'video', props: { feed: '1:44' } },
      { type: 'video', props: { feed: '1:1' } },
      { type: 'test_gap', props: { driver_a: 44, driver_b: 1 } },
    ]);
    expect(layout.tiles()).toEqual([]);
  });

  it('resolves drivers from the roster, even without an onboard, and takes a number as one', async () => {
    await runTool('suggest_tiles', { components: [{ component: 'test_pit', props: { driver: 'GAS' } }, { component: 'test_gap', props: { driver_a: 10, driver_b: '44' } }] });
    expect(props()).toEqual([
      { type: 'test_pit', props: { driver: 10 } },
      { type: 'test_gap', props: { driver_a: 10, driver_b: 44 } },
    ]);
  });

  it('fills in who a whole-field chart draws and highlights, and leaves both out when not given', async () => {
    await runTool('suggest_tiles', {
      components: [
        { component: 'test_field' },
        { component: 'test_field', props: { drivers_to_display: ['HAM', 'VER', 'GAS'], drivers: 'HAM', laps: 10 } },
        { component: 'test_weather' },
      ],
    });
    expect(props()).toEqual([
      { type: 'test_field', props: {} },
      { type: 'test_field', props: { drivers_to_display: [44, 1, 10], drivers: [44], laps: 10 } },
      { type: 'test_weather', props: {} },
    ]);
  });

  it('refuses props a chart does not take, or that do not fit, and suggests nothing', async () => {
    await expect(runTool('suggest_tiles', { streams: ['HAM'], components: [{ component: 'test_gap', props: { driver_a: 'HAM' } }] })).rejects.toThrow(
      'test_gap needs driver_b, and none was given: ask the user which driver, unless the conversation already says. Nothing was suggested.',
    );
    await expect(runTool('suggest_tiles', { components: [{ component: 'test_weather', props: { drivers: ['HAM'] } }] })).rejects.toThrow(
      'test_weather has no prop "drivers": it takes none.',
    );
    await expect(runTool('suggest_tiles', { components: [{ component: 'test_pit', props: { drivers: ['HAM'] } }] })).rejects.toThrow(/test_pit has no prop "drivers": it takes driver\./);
    // The same driver named three ways is one driver.
    await runTool('suggest_tiles', { components: [{ component: 'test_field', props: { drivers: ['HAM', '44', 'Hamilton'] } }] });
    expect(props()).toEqual([{ type: 'test_field', props: { drivers: [44] } }]);
    host.suggestions.newTurn();
    await expect(runTool('suggest_tiles', { components: [{ component: 'test_field', props: { laps: 'ten' } }] })).rejects.toThrow(/^test_field: \/laps /);
    expect(props()).toEqual([]);
  });

  it('refuses a driver it cannot find', async () => {
    await expect(runTool('suggest_tiles', { components: [{ component: 'test_pit', props: { driver: 'Senna' } }] })).rejects.toThrow(
      /No driver matches "Senna" in this session: ask the user who they mean/,
    );
  });

  it('refuses a chart for another session type', async () => {
    useSession.setState({ session: { ...race, type: 'sprint-qualifying' } });
    await expect(runTool('suggest_tiles', { components: [{ component: 'test_gap', props: { driver_a: 'HAM', driver_b: 'VER' } }] })).rejects.toThrow(
      'test_gap is for race, sprint sessions, and this is sprint qualifying: leave it out. Nothing was suggested.',
    );
    // One for any session is fine.
    await runTool('suggest_tiles', { components: [{ component: 'test_pit', props: { driver: 'HAM' } }] });
    expect(props()).toHaveLength(1);
  });

  it('offers the viewing agent only the charts that fit the open session, and the build agent every one', async () => {
    const send = vi.spyOn(host.agent, 'send').mockResolvedValue();
    const offered = () => send.mock.lastCall![3].split('\n').filter((l) => l.startsWith('test_') || l.startsWith('car_telemetry,')).map((l) => l.split(',')[0]).sort();
    const enumOf = () =>
      (toolDefinitions().find((t) => t.name === 'suggest_tiles')?.parameters as { properties: { components: { items: { properties: { component: { enum: string[] } } } } } })
        .properties.components.items.properties.component.enum;
    try {
      await askAgent('charts?');
      expect(offered()).toEqual(['car_telemetry', 'test_field', 'test_gap', 'test_pit', 'test_weather']);

      // A race chart isn't offered in qualifying, in the list or the tool.
      useSession.setState({ session: { ...race, type: 'qualifying' } });
      await askAgent('charts?');
      expect(offered()).toEqual(['test_field', 'test_pit', 'test_weather']);
      expect(enumOf()).toEqual(['test_pit', 'test_field', 'test_weather']);

      // A replay-only chart isn't offered while a race is live.
      useSession.setState({ session: { ...race, status: 'live' } });
      await askAgent('charts?');
      expect(offered()).toEqual(['test_field', 'test_gap', 'test_pit', 'test_weather']);

      // With no session open, nothing is ruled out.
      useSession.setState({ session: null });
      await askAgent('charts?');
      expect(offered()).toEqual(['car_telemetry', 'test_field', 'test_gap', 'test_pit', 'test_weather']);

      // The build agent writes and edits charts, so it sees them all.
      useSession.setState({ session: { ...race, type: 'qualifying' } });
      useBuild.setState({ active: true, changes: [], enteredAtSec: 0 });
      await askAgent('charts?');
      expect(offered()).toEqual(['car_telemetry', 'test_field', 'test_gap', 'test_pit', 'test_weather']);
    } finally {
      useBuild.setState({ active: false, changes: [], enteredAtSec: null });
      send.mockRestore();
    }
  });

  it('never offers a chart that declares no sessions', async () => {
    const never = defineComponent({
      name: 'test_never',
      title: 'Test never',
      description: 'Not ready for any session.',
      sessions: [],
      args: Type.Object({}),
      spec: () => ({ key: 'test_never', label: 'Never' }),
      View: () => null,
    });
    host.components.register({ components: [never] });
    try {
      expect(read().components.find((c) => c.name === 'test_never')?.sessions).toEqual([]);
      expect(describeComponents(offeredComponents())).not.toContain('test_never');
      await expect(runTool('suggest_tiles', { components: [{ component: 'test_never' }] })).rejects.toThrow('test_never is for no session: leave it out.');
    } finally {
      host.components.unregister({ names: ['test_never'] });
    }
  });

  it('refuses an unknown chart, and video', async () => {
    await expect(runTool('suggest_tiles', { components: [{ component: 'lap_chart' }] })).rejects.toThrow(/There is no component "lap_chart": pick a name from the component list/);
    await expect(runTool('suggest_tiles', { components: [{ component: 'video' }] })).rejects.toThrow(/There is no component "video"/);
  });

  it('refuses a chart that needs data the session does not have, passing the reason on', async () => {
    useSessionData.setState({ state: 'unsupported', reason: 'Data starts in 2023.' }, true);
    await expect(runTool('suggest_tiles', { components: [{ component: 'test_weather' }] })).rejects.toThrow('test_weather has no data for this session: Data starts in 2023.');
  });

  it('refuses a call that names nothing', async () => {
    await expect(runTool('suggest_tiles', {})).rejects.toThrow(/at least one stream or component/);
  });

  it('refuses with no session open', async () => {
    useSession.setState({ session: null });
    await expect(runTool('suggest_tiles', { components: [{ component: 'test_weather' }] })).rejects.toThrow(/No session is open/);
  });

  it('shows tiles in the app state by id, then streams by label and charts by label, chart name and props', () => {
    const [ham, gap, weather] = host.layout.add({ items: [{ type: 'video', props: { feed: '1:44' } }, { type: 'test_gap', props: { driver_a: 44, driver_b: 1 } }, { type: 'test_weather', props: {} }] });
    expect(describeAppState()).toContain(`\non screen: ${ham} HAM (stream); ${gap} Gap 44 v 1 (test_gap, props {"driver_a":44,"driver_b":1}); ${weather} Weather (test_weather)\n`);
  });

  it('can have the same chart twice, for different drivers', async () => {
    host.layout.add({ items: [{ type: 'test_pit', props: { driver: 44 } }, { type: 'test_pit', props: { driver: 1 } }, { type: 'test_pit', props: { driver: 44 } }] });
    expect(layout.tiles().map((t) => t.component.label)).toEqual(['Pit 44', 'Pit 1']);
  });

  describe('offer_build', () => {
    afterEach(() => host.build.dismissOffer());

    it('leaves the offer for the user to answer, and returns straight away', async () => {
      const [pit] = host.layout.add({ items: [{ type: 'test_pit', props: { driver: 44 } }] });
      expect(await runTool('offer_build', { reason: 'fix the pit chart', note: 'It throws in the pit lane.', error_tiles: [pit] })).toBe('Offered. The user answers in the palette.');
      expect(read().build.offer).toEqual({ reason: 'fix the pit chart', note: 'It throws in the pit lane.', tiles: [pit] });
    });

    it('offers to build a component with no tiles', async () => {
      expect(await runTool('offer_build', { reason: 'build a tyre wear chart', note: 'The user wants tyre wear for HAM.' })).toBe('Offered. The user answers in the palette.');
      expect(read().build.offer).toEqual({ reason: 'build a tyre wear chart', note: 'The user wants tyre wear for HAM.', tiles: [] });
    });

    it('names a tile that is not on screen by its id, and offers nothing', async () => {
      await expect(runTool('offer_build', { reason: 'fix it', note: '', error_tiles: ['tile-99'] })).rejects.toThrow('No tile tile-99 is on screen.');
      expect(read().build.offer).toBeNull();
    });

    it('is the viewing agent\'s alone', async () => {
      expect(toolDefinitions('build').map((t) => t.name)).not.toContain('offer_build');
      expect(toolDefinitions('view').map((t) => t.name)).toContain('offer_build');
    });
  });

  describe('edit_tile', () => {
    let ids: string[] = [];
    beforeEach(() => {
      ids = host.layout.add({
        items: [
          { type: 'video', props: { feed: '1:44' } },
          { type: 'test_field', props: { drivers: [44] } },
          { type: 'test_pit', props: { driver: 44 } },
          { type: 'test_pit', props: { driver: 1 } },
        ],
      });
    });
    const tiles = () => layout.tiles().map((t) => ({ id: t.id, label: t.component.label, props: t.component.props }));

    it("drops props the tile holds that its chart doesn't declare any more", async () => {
      layout.clear();
      // As a tile stands after its mod swapped `drivers` for `driver`: the old prop is still in its spec.
      const [pit] = host.layout.add({ items: [{ type: 'test_pit', props: { driver: 44, drivers: [44] } }] });
      expect(await runTool('edit_tile', { tile: pit, props: { driver: 'GAS' } })).toBe('Changed: Pit 10.');
      expect(tiles().map((t) => t.props)).toEqual([{ driver: 10 }]);
    });

    it('changes only the props it names, in place, and the tile keeps its id', async () => {
      const before = tiles();
      const rects = () => layout.tiles().map((t) => [t.x, t.y, t.w, t.h]);
      const placed = rects();
      expect(await runTool('edit_tile', { tile: ids[1], props: { drivers_to_display: ['HAM', 'VER', 'GAS'] } })).toBe('Changed: Field 44-1-10/44.');
      const after = tiles();
      expect(after[1]).toEqual({ id: before[1].id, label: 'Field 44-1-10/44', props: { drivers: [44], drivers_to_display: [44, 1, 10] } });
      expect(rects()).toEqual(placed);
      // Null takes a prop away, and the same id still names the tile.
      await runTool('edit_tile', { tile: ids[1], props: { drivers: null } });
      expect(tiles()[1].props).toEqual({ drivers_to_display: [44, 1, 10] });
    });

    it('changes who a one-driver chart is about', async () => {
      expect(await runTool('edit_tile', { tile: ids[3], props: { driver: 'Gasly' } })).toBe('Changed: Pit 10.');
      expect(tiles().map((t) => t.label)).toEqual(['HAM', 'Field all/44', 'Pit 44', 'Pit 10']);
    });

    it('refuses a tile that is not on screen, by label too, or a stream, and changes nothing', async () => {
      await expect(runTool('edit_tile', { tile: 'nothing', props: {} })).rejects.toThrow('No tile nothing is on screen. Name tiles by the ids app_state lists, such as tile-3.');
      await expect(runTool('edit_tile', { tile: 'Pit 44', props: { driver: 'GAS' } })).rejects.toThrow(/No tile Pit 44 is on screen/);
      await expect(runTool('edit_tile', { tile: ids[0], props: {} })).rejects.toThrow(`${ids[0]} is a stream: only a component's props can be changed`);
      expect(tiles().map((t) => t.label)).toEqual(['HAM', 'Field all/44', 'Pit 44', 'Pit 1']);
    });

    it('refuses props that do not fit, or a chart that is already on screen', async () => {
      await expect(runTool('edit_tile', { tile: ids[3], props: { driver: null } })).rejects.toThrow(/test_pit needs driver/);
      await expect(runTool('edit_tile', { tile: ids[3], props: { driver: 'Senna' } })).rejects.toThrow(/No driver matches "Senna"/);
      await expect(runTool('edit_tile', { tile: ids[3], props: { driver: 'HAM' } })).rejects.toThrow(/already on screen/);
      expect(tiles().map((t) => t.label)).toEqual(['HAM', 'Field all/44', 'Pit 44', 'Pit 1']);
    });
  });

  describe('remove_tiles', () => {
    let ids: string[] = [];
    beforeEach(() => {
      ids = host.layout.add({
        items: [
          { type: 'video', props: { feed: '1:44' } },
          { type: 'video', props: { feed: '1:1' } },
          { type: 'test_gap', props: { driver_a: 44, driver_b: 1 } },
          { type: 'test_pit', props: { driver: 44 } },
          { type: 'test_pit', props: { driver: 1 } },
        ],
      });
    });
    const labels = () => layout.tiles().map((t) => t.component.label);

    it('takes off streams and charts by their ids', async () => {
      expect(await runTool('remove_tiles', { tiles: [ids[0], ids[3]] })).toBe('Removed: HAM, Pit 44.');
      expect(labels()).toEqual(['VER', 'Gap 44 v 1', 'Pit 1']);
    });

    it('refuses ids that are not on screen, and labels, and removes nothing', async () => {
      await expect(runTool('remove_tiles', { tiles: [ids[1], 'tile-999', 'Pit 1'] })).rejects.toThrow('Not on screen: tile-999, Pit 1. Nothing was removed.');
      expect(labels()).toEqual(['HAM', 'VER', 'Gap 44 v 1', 'Pit 44', 'Pit 1']);
    });
  });
});
