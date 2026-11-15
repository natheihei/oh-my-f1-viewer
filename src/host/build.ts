/**
 * Build mode: while it's on, the app's agent writes mods, and everything it changes can be undone as
 * one. The main process keeps the snapshot and says what differs from it. See docs/BUILD_MODE.md.
 */
import Type from 'typebox';
import { create } from 'zustand';
import type { BuildChange, BuildState } from '../../shared/mods';
import { buildLink } from '../data/build';
import { useSession } from '../data/session';
import { allTiles } from '../layout/model';
import { useLayout } from '../layout/store';
import { write } from './op';

/**
 * Build mode, offered to the viewer from view mode: to fix tiles in their component's code, or to build or
 * change a component. It waits for their answer.
 */
export interface BuildOffer {
  /** What build mode would do, for the viewer, as a phrase like "fix the gap chart": the offer asks it. */
  reason: string;
  /** The handoff, for the build agent: its conversation starts with this and the tiles' errors. */
  note: string;
  /** Tile ids whose errors go to the build agent, as they stand when the viewer switches. May be none. */
  tiles: string[];
}

export interface BuildView {
  active: boolean;
  /** The mods that differ from how the folder stood when the build started. */
  changes: BuildChange[];
  /** Where the session clock stood on entry, to offer on the way out. Null with no session open. */
  enteredAtSec: number | null;
  /** Build mode, offered and not yet answered. Only outside build mode. */
  offer: BuildOffer | null;
}

export const useBuild = create<BuildView>(() => ({ active: false, changes: [], enteredAtSec: null, offer: null }));

function apply(state: BuildState): void {
  const { active, changes, enteredAtSec } = useBuild.getState();
  if (active === state.active && JSON.stringify(changes) === JSON.stringify(state.changes)) return;
  useBuild.setState({ active: state.active, changes: state.changes, enteredAtSec: state.active ? enteredAtSec : null, ...(state.active ? { offer: null } : {}) });
}

export const buildOps = {
  begin: write({ description: 'Enter build mode: from here until save or undo, every change to the mods folder can be undone as one. It answers an offer of it.' }, async () => {
    const { session, clock } = useSession.getState();
    if (!useBuild.getState().active) useBuild.setState({ enteredAtSec: session ? clock.timeSec : null, offer: null });
    apply(await buildLink.begin());
  }),
  save: write({ description: "Leave build mode and keep its changes. Resolves to what changed, in the app's words, or null for nothing." }, async () => {
    const summary = await buildLink.save();
    apply({ active: false, changes: [] });
    return summary;
  }),
  offer: write(
    {
      description:
        "Offer the viewer build mode, to fix tiles in their component's code or to build or change a component. It waits in live.build.offer, replacing any offer before it, until the viewer answers or sends another message. Whoever takes the offer up enters build mode and gives the build agent the tiles' errors and the note.",
      args: Type.Object({
        reason: Type.String({ description: 'What build mode would do, for the viewer, as a phrase like "fix the gap chart"' }),
        note: Type.String({ description: 'The handoff, for the build agent' }),
        tiles: Type.Optional(Type.Array(Type.String({ description: "A tile's id" }), { description: 'Tiles whose errors go to the build agent' })),
      }),
    },
    ({ reason, note, tiles = [] }): void => {
      if (useBuild.getState().active) throw new Error('Build mode is already on.');
      const onScreen = new Set(allTiles(useLayout.getState()).map((t) => t.id));
      const gone = tiles.filter((t) => !onScreen.has(t));
      if (gone.length) throw new Error(`Not on screen: ${gone.join(', ')}.`);
      useBuild.setState({ offer: { reason, note, tiles: [...new Set(tiles)] } });
    },
  ),
  dismissOffer: write({ description: 'Withdraw the offer of build mode, if there is one: the viewer stayed, or moved on.' }, (): void => {
    if (useBuild.getState().offer) useBuild.setState({ offer: null });
  }),
  undo: write({ description: 'Leave build mode and put the mods folder back as it was on entry. Resolves to how many mods that undid.' }, async () => {
    const count = await buildLink.undo();
    apply({ active: false, changes: [] });
    return count;
  }),
};

/** Starts following the main process's build state. Call it once, at start. */
export function startBuild(): void {
  buildLink.onChanged(apply);
  void buildLink.state().then(apply, (e) => console.warn('[build] state failed', e));
}
