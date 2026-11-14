import Type from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { useBuild } = await import('./build');
const { componentOps, defineComponent } = await import('./components');
const { layoutOps } = await import('./layoutOps');
const { previewScope, tileLookAhead, useTileLookAhead } = await import('./lookAhead');
const { clearSuggestions, suggestionOps, useSuggestions } = await import('./suggestions');
const { layout, useLayout } = await import('../layout/store');
const { allTiles } = await import('../layout/model');

const component = (name: string, args = Type.Object({ drivers: Type.Optional(Type.Array(Type.Number())) })) =>
  defineComponent({
    name,
    title: name,
    description: 'A test component.',
    args,
    spec: (props) => {
      const drivers = (props as { drivers?: number[] }).drivers ?? [];
      return { key: [name, ...drivers].join(':'), label: name };
    },
    View: () => null,
  });

const keys = () => useSuggestions.getState().items.map((i) => i.key);
const building = (changes: { name: string; change: 'added' | 'edited' | 'deleted' }[]) => useBuild.setState({ active: true, changes, enteredAtSec: 0 });

beforeEach(() => {
  componentOps.register({ components: [component('stepper'), component('form'), component('needy', Type.Object({ driver: Type.Number() }) as never)] });
});

afterEach(() => {
  useBuild.setState({ active: false, changes: [], enteredAtSec: null });
  layout.clear();
  clearSuggestions();
  componentOps.unregister({ names: ['stepper', 'form', 'needy'] });
  useTileLookAhead.setState({ approved: {} });
});

describe('drafts in the strip', () => {
  it('shows each mod a build added or edited, with no props, and nothing outside a build', () => {
    useBuild.setState({ active: false, changes: [{ name: 'stepper', change: 'added' }], enteredAtSec: null });
    expect(keys()).toEqual([]);
    building([
      { name: 'stepper', change: 'added' },
      { name: 'form', change: 'edited' },
      { name: 'gone', change: 'deleted' },
    ]);
    expect(keys()).toEqual(['stepper', 'form']);
    expect(useSuggestions.getState().items[0].props).toEqual({});
  });

  it('leaves out a mod with a tile on screen, and brings it back when the tile goes', () => {
    const [tile] = layoutOps.add({ items: [{ type: 'form', props: { drivers: [44] } }] });
    building([{ name: 'form', change: 'edited' }]);
    expect(keys()).toEqual([]);
    layoutOps.remove({ tiles: [tile] });
    expect(keys()).toEqual(['form']);
  });

  it('outlasts a turn, unlike what the agent suggests', () => {
    building([{ name: 'stepper', change: 'added' }]);
    suggestionOps.offer({ items: [{ type: 'form', props: {} }] });
    expect(keys()).toEqual(['form', 'stepper']);
    suggestionOps.newTurn();
    expect(keys()).toEqual(['stepper']);
  });

  it('previews with the props the agent suggested it with, from then on', () => {
    building([{ name: 'stepper', change: 'added' }]);
    expect(suggestionOps.offer({ items: [{ type: 'stepper', props: { drivers: [44, 4] } }] }).suggested).toEqual(['stepper']);
    expect(keys()).toEqual(['stepper:44:4']);
    suggestionOps.newTurn();
    expect(keys()).toEqual(['stepper:44:4']);
    // Not into the next build.
    useBuild.setState({ active: false, changes: [] });
    building([{ name: 'stepper', change: 'edited' }]);
    expect(keys()).toEqual(['stepper']);
  });

  it('takes the props even when they make the same key as none', () => {
    // A component whose key doesn't change with its props, like one that names its own default drivers.
    componentOps.register({
      components: [defineComponent({ name: 'duel', title: 'duel', description: 'x', args: Type.Object({ drivers: Type.Optional(Type.Array(Type.Number())) }), spec: () => ({ key: 'duel', label: 'Duel' }), View: () => null })],
    });
    building([{ name: 'duel', change: 'added' }]);
    expect(useSuggestions.getState().items[0].props).toEqual({});
    expect(suggestionOps.offer({ items: [{ type: 'duel', props: { drivers: [44, 1] } }] }).suggested).toEqual(['Duel']);
    expect(useSuggestions.getState().items).toHaveLength(1);
    expect(useSuggestions.getState().items[0].props).toEqual({ drivers: [44, 1] });
    componentOps.unregister({ names: ['duel'] });
  });

  it("shows a mod that can't draw without props, with none, so its card can say what it needs", () => {
    building([{ name: 'needy', change: 'added' }]);
    expect(useSuggestions.getState().items).toMatchObject([{ type: 'needy', key: 'needy', label: 'needy', props: {} }]);
  });

  it('swaps that card for a real preview once the mod is suggested with its props', () => {
    building([{ name: 'needy', change: 'added' }]);
    suggestionOps.offer({ items: [{ type: 'needy', props: { driver: 44 } }] });
    expect(useSuggestions.getState().items).toMatchObject([{ type: 'needy', props: { driver: 44 } }]);
  });

  it('stays away once dismissed, until the next turn', () => {
    building([{ name: 'stepper', change: 'added' }]);
    suggestionOps.dismiss();
    expect(keys()).toEqual([]);
    suggestionOps.newTurn();
    expect(keys()).toEqual(['stepper']);
  });

  it('goes when the build ends', () => {
    building([{ name: 'stepper', change: 'added' }]);
    useBuild.setState({ active: false, changes: [] });
    expect(keys()).toEqual([]);
  });

  it('goes when the mod is removed', () => {
    building([{ name: 'stepper', change: 'added' }]);
    componentOps.unregister({ names: ['stepper'] });
    expect(keys()).toEqual([]);
  });
});

describe('look-ahead approval', () => {
  const approved = () => Object.keys(useTileLookAhead.getState().approved);

  it('belongs to one tile, and goes with it', () => {
    tileLookAhead.approve('tile-1');
    expect(approved()).toEqual(['tile-1']);
    tileLookAhead.forget('tile-1');
    expect(approved()).toEqual([]);
  });

  it('carries over from a preview to the tile it becomes', () => {
    building([{ name: 'stepper', change: 'added' }]);
    tileLookAhead.approve(previewScope('stepper'));
    expect(suggestionOps.add({ key: 'stepper' })).toBe(true);
    const tile = allTiles(useLayout.getState()).find((t) => t.component.key === 'stepper')!;
    expect(approved()).toEqual([tile.id]);
  });

  it('is not given to a tile whose preview was never allowed', () => {
    building([{ name: 'stepper', change: 'added' }]);
    suggestionOps.add({ key: 'stepper' });
    expect(approved()).toEqual([]);
  });
});
