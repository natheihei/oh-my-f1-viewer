import Type from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { useAgentTurn } = await import('./agentTurn');
const { useBuild } = await import('./build');
const { componentOf, componentOps, defineComponent, specOf } = await import('./components');
const { fitProps, health, healthOps, list, useHealth } = await import('./health');
const { read } = await import('./live');
const { useMods } = await import('./mods');
const { useSession } = await import('../data/session');
const { useSessionData } = await import('../data/sessionData');
const { layout } = await import('../layout/store');
const { allTiles } = await import('../layout/model');
const { useLayout } = await import('../layout/store');

type Place = Parameters<typeof health.report>[0];
const place = (over: Partial<Place> = {}): Place => ({ scope: 'tile-1', where: 'tile', type: 'pace', label: 'Pace HAM', state: 'drawn', missing: [], dropped: [], message: null, ...over });
/** A place as the report holds it, with no session open to stamp it. */
const held = (over: Partial<Place> = {}) => ({ ...place(over), since: null });
const sessionBefore = useSession.getState();
const dataBefore = useSessionData.getState();

const pace = defineComponent({
  name: 'pace',
  title: 'Pace',
  description: 'A test component.',
  args: Type.Object({ driver: Type.Integer(), laps: Type.Optional(Type.Integer()) }),
  spec: ({ driver }) => ({ key: `pace:${driver}`, label: `Pace ${driver}` }),
  View: () => null,
});

afterEach(() => {
  for (const p of useHealth.getState().places) health.forget(p.scope);
  useBuild.setState({ active: false, changes: [], enteredAtSec: null });
  useAgentTurn.setState({ busy: false });
  useHealth.setState({ attached: [] });
  useSession.setState(sessionBefore, true);
  useSessionData.setState(dataBefore, true);
  useMods.setState({ list: [] });
  layout.clear();
  componentOps.unregister({ names: ['pace'] });
  vi.useRealTimers();
});

describe('fitting props to args', () => {
  const args = Type.Object({ driver: Type.Integer(), laps: Type.Optional(Type.Integer()) });

  it('keeps props that fit as they are', () => {
    const props = { driver: 44, laps: 12 };
    expect(fitProps(args, props)).toEqual({ props, missing: [], dropped: [], message: null });
  });

  it('names a required prop that is missing, and cannot draw', () => {
    expect(fitProps(args, {})).toEqual({ props: {}, missing: ['driver'], dropped: [], message: 'Needs driver' });
  });

  it('drops a prop the args no longer accept, and still needs the one that replaced it', () => {
    expect(fitProps(args, { drivers: [44], laps: 12 })).toEqual({ props: { laps: 12 }, missing: ['driver'], dropped: ['drivers'], message: 'Needs driver' });
  });

  it('drops a prop of the wrong type, and draws with the rest', () => {
    expect(fitProps(args, { driver: 44, laps: 'many' })).toEqual({ props: { driver: 44 }, missing: [], dropped: ['laps'], message: null });
  });

  it('names every missing prop', () => {
    const duel = Type.Object({ driver_a: Type.Integer(), driver_b: Type.Integer() });
    expect(fitProps(duel, { driver_a: 1 }).message).toBe('Needs driver_b');
    expect(fitProps(duel, {}).message).toBe('Needs driver_a and driver_b');
    expect(list(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('the report', () => {
  it('holds one record per place, on the read surface', () => {
    health.report(place(), null);
    health.report(place({ scope: 'preview:pace', where: 'strip' }), null);
    health.report(place({ state: 'error', message: 'boom' }), null);
    expect(read().health).toEqual([held({ state: 'error', message: 'boom' }), held({ scope: 'preview:pace', where: 'strip' })]);
  });

  it('changes nothing when a place reports the same again', () => {
    health.report(place(), null);
    const before = read().health;
    health.report(place(), null);
    expect(read().health).toBe(before);
  });

  it('forgets a place that goes away', () => {
    health.report(place(), null);
    health.forget('tile-1');
    expect(read().health).toEqual([]);
  });
});

describe('when a place stopped drawing', () => {
  /** A session open with its clock at `clockSec`, and the playhead at `playheadMs`. */
  const at = (clockSec: number, playheadMs: number) => {
    useSession.setState({ session: { contentId: 1 } as never, clock: { ...sessionBefore.clock, timeSec: clockSec } });
    useSessionData.setState({ state: 'ready', playheadMs } as never);
  };
  const since = () => read().health[0].since;

  it('stamps the moment it stops, and keeps it while it fails the same way', () => {
    at(4360, 1761512880000);
    health.report(place({ state: 'error', message: 'boom' }), null);
    expect(since()).toEqual({ clockSec: 4360, playheadMs: 1761512880000 });
    at(4400, 1761512920000);
    health.report(place({ state: 'error', message: 'boom', label: 'Pace NOR' }), null);
    expect(since()).toEqual({ clockSec: 4360, playheadMs: 1761512880000 });
  });

  it('stamps again for a new problem, and forgets it once the place draws', () => {
    at(4360, 1761512880000);
    health.report(place({ state: 'error', message: 'boom' }), null);
    at(4385, 1761512905000);
    health.report(place({ state: 'error', message: 'another' }), null);
    expect(since()).toEqual({ clockSec: 4385, playheadMs: 1761512905000 });
    health.report(place(), null);
    expect(since()).toBeNull();
  });

  it('has no moment with no session open', () => {
    health.report(place({ state: 'needs_props', missing: ['driver'], message: 'Needs driver' }), null);
    expect(since()).toBeNull();
  });
});

describe('attaching a tile\'s error to the next message', () => {
  beforeEach(() => componentOps.register({ components: [pace] }));

  /** A pace tile on screen, for `driver`, reported as `over`. */
  const tileThat = (over: Partial<Place>, driver = 44) => {
    const id = layout.add(specOf({ type: 'pace', props: { driver } }));
    health.report(place({ scope: id, ...over }), null);
    return id;
  };
  const threw = { state: 'error', message: "Cannot read properties of undefined (reading 'interval')" } as const;

  it('puts the tile in live.attached as it stands, with its props, whatever the agent is doing', () => {
    useAgentTurn.setState({ busy: true });
    const id = tileThat(threw);
    expect(healthOps.attach({ scope: id })).toBe(true);
    expect(read().attached).toEqual([{ scope: id, report: { place: held({ scope: id, ...threw }), props: { driver: 44 }, log: null } }]);
  });

  it("points at a mod's log, where its stack is", () => {
    useMods.setState({ list: [{ name: 'pace', state: 'ready', version: 1 }] as never });
    const id = tileThat(threw);
    healthOps.attach({ scope: id });
    expect(read().attached[0].report.log).toBe('pace/mod.log');
  });

  it('replaces what was attached for a tile with how it stands now, in its place', () => {
    const a = tileThat(threw, 44);
    const b = tileThat({ state: 'needs_props', missing: ['driver'], message: 'Needs driver' }, 4);
    healthOps.attach({ scope: a });
    healthOps.attach({ scope: b });
    health.report(place({ scope: a, state: 'error', message: 'another' }), null);
    healthOps.attach({ scope: a });
    expect(read().attached.map((x) => [x.scope, x.report.place.message])).toEqual([
      [a, 'another'],
      [b, 'Needs driver'],
    ]);
  });

  it('attaches nothing for a tile that draws or waits, a preview, or a tile that is gone', () => {
    const drawn = tileThat({});
    const waiting = tileThat({ state: 'waiting' }, 4);
    health.report(place({ scope: 'preview:pace', where: 'strip', state: 'needs_props', missing: ['driver'], message: 'Needs driver' }), null);
    health.report(place({ scope: 'tile-99', ...threw }), null);
    for (const scope of [drawn, waiting, 'preview:pace', 'tile-99', 'nowhere']) expect(healthOps.attach({ scope })).toBe(false);
    expect(read().attached).toEqual([]);
  });

  it('takes one off, or all of them for a message', () => {
    const a = tileThat(threw, 44);
    const b = tileThat(threw, 4);
    healthOps.attach({ scope: a });
    healthOps.attach({ scope: b });
    expect(healthOps.detach({ scope: a })).toBe(true);
    expect(healthOps.detach({ scope: a })).toBe(false);
    expect(healthOps.takeAttached().map((x) => x.scope)).toEqual([b]);
    expect(read().attached).toEqual([]);
    expect(healthOps.takeAttached()).toEqual([]);
  });

  it('keeps live.attached the same object while nothing changes it', () => {
    const before = read().attached;
    health.report(place(), null);
    healthOps.takeAttached();
    expect(read().attached).toBe(before);
  });

  it('lets a tile go when it closes', () => {
    const a = tileThat(threw, 44);
    const b = tileThat(threw, 4);
    healthOps.attach({ scope: a });
    healthOps.attach({ scope: b });
    layout.remove(a);
    expect(read().attached.map((x) => x.scope)).toEqual([b]);
  });

  it("reports the tiles asked about that aren't drawing now", () => {
    const a = tileThat(threw, 44);
    const b = tileThat({}, 4);
    expect(healthOps.errors({ tiles: [a, b, 'nowhere'] }).map((r) => r.place.scope)).toEqual([a]);
  });
});

describe('waiting for what is on screen to draw', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    componentOps.register({ components: [pace] });
  });

  const tile = () => {
    layout.add(specOf({ type: 'pace', props: { driver: 44 } }));
    return allTiles(useLayout.getState())[0];
  };

  it('answers as soon as every tile has drawn with its current code', async () => {
    const t = tile();
    health.report(place({ scope: t.id }), componentOf('pace')!.View);
    const settled = healthOps.settled();
    await vi.advanceTimersByTimeAsync(60);
    await expect(settled).resolves.toEqual([held({ scope: t.id })]);
  });

  it('waits for a tile that has not reported, or reported with older code, then answers anyway after a second', async () => {
    const t = tile();
    let done = false;
    const settled = healthOps.settled().then((places) => {
      done = true;
      return places;
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(done).toBe(false);
    health.report(place({ scope: t.id }), 'older code');
    await vi.advanceTimersByTimeAsync(300);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    await expect(settled).resolves.toEqual([held({ scope: t.id })]);
  });
});
