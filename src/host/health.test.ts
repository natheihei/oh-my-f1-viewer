import Type from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { useAgentTurn } = await import('./agentTurn');
const { useBuild } = await import('./build');
const { componentOf, componentOps, defineComponent, specOf } = await import('./components');
const { fitProps, fixable, fixRequest, health, healthOps, list, useHealth } = await import('./health');
const { read } = await import('./live');
const { layout } = await import('../layout/store');
const { allTiles } = await import('../layout/model');
const { useLayout } = await import('../layout/store');

type Place = Parameters<typeof health.report>[0];
const place = (over: Partial<Place> = {}): Place => ({ scope: 'tile-1', where: 'tile', type: 'pace', label: 'Pace HAM', state: 'drawn', missing: [], dropped: [], message: null, ...over });

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
    expect(read().health).toEqual([place({ state: 'error', message: 'boom' }), place({ scope: 'preview:pace', where: 'strip' })]);
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

describe('asking the agent to fix', () => {
  const asked = () => read().fixRequests.map((r) => r.text);
  afterEach(() => {
    for (const r of read().fixRequests) healthOps.takeFix({ id: r.id });
  });

  it('leaves the request in live state for a tile that needs props, in or out of build mode', () => {
    health.report(place({ state: 'needs_props', missing: ['driver'], message: 'Needs driver' }), null);
    expect(healthOps.askFix({ scope: 'tile-1' })).toBe(true);
    expect(read().fixRequests).toMatchObject([{ scope: 'tile-1', text: 'The Pace HAM tile needs driver.' }]);
  });

  it('asks about a tile that threw only in build mode, where the code can be fixed', () => {
    health.report(place({ state: 'error', message: 'boom' }), null);
    expect(healthOps.askFix({ scope: 'tile-1' })).toBe(false);
    useBuild.setState({ active: true });
    expect(healthOps.askFix({ scope: 'tile-1' })).toBe(true);
    expect(asked()).toEqual(['The Pace HAM tile stopped with an error: boom. Fix it.']);
  });

  it('never asks for a preview in the strip, a tile that draws, or one that waits', () => {
    expect(fixable({ state: 'needs_props', where: 'strip' }, true)).toBe(false);
    expect(fixable({ state: 'drawn', where: 'tile' }, true)).toBe(false);
    expect(fixable({ state: 'waiting', where: 'tile' }, true)).toBe(false);
    expect(fixRequest(place())).toBeNull();
    expect(healthOps.askFix({ scope: 'nowhere' })).toBe(false);
    expect(asked()).toEqual([]);
  });

  it('asks nothing more while a request waits, for that place or another', () => {
    health.report(place({ state: 'needs_props', missing: ['driver'], message: 'Needs driver' }), null);
    health.report(place({ scope: 'tile-2', label: 'Pace NOR', state: 'needs_props', missing: ['driver'], message: 'Needs driver' }), null);
    expect(healthOps.askFix({ scope: 'tile-1' })).toBe(true);
    expect(healthOps.askFix({ scope: 'tile-1' })).toBe(false);
    expect(healthOps.askFix({ scope: 'tile-2' })).toBe(false);
    expect(asked()).toHaveLength(1);
    const [{ id }] = read().fixRequests;
    expect(healthOps.takeFix({ id })).toMatchObject({ id, scope: 'tile-1' });
    expect(read().fixRequests).toEqual([]);
    expect(healthOps.askFix({ scope: 'tile-2' })).toBe(true);
  });

  it('asks nothing while the agent is busy: a new message would stop its turn', () => {
    health.report(place({ state: 'needs_props', missing: ['driver'], message: 'Needs driver' }), null);
    useAgentTurn.setState({ busy: true });
    expect(read().agentBusy).toBe(true);
    expect(healthOps.askFix({ scope: 'tile-1' })).toBe(false);
    expect(asked()).toEqual([]);
    useAgentTurn.setState({ busy: false });
    expect(healthOps.askFix({ scope: 'tile-1' })).toBe(true);
  });

  it('hands a request to whoever takes it first, and nobody after', () => {
    health.report(place({ state: 'needs_props', missing: ['driver'], message: 'Needs driver' }), null);
    healthOps.askFix({ scope: 'tile-1' });
    const [{ id }] = read().fixRequests;
    expect(healthOps.takeFix({ id })).not.toBeNull();
    expect(healthOps.takeFix({ id })).toBeNull();
    expect(healthOps.takeFix({ id: 'no-such' })).toBeNull();
  });

  it('keeps live.fixRequests the same object while nothing is asked', () => {
    const before = read().fixRequests;
    health.report(place(), null);
    expect(read().fixRequests).toBe(before);
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
    await expect(settled).resolves.toEqual([place({ scope: t.id })]);
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
    await expect(settled).resolves.toEqual([place({ scope: t.id })]);
  });
});
