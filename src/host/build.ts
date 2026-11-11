/**
 * Build mode: while it's on, the app's agent writes mods, and everything it changes can be undone as
 * one. The main process keeps the snapshot and says what differs from it. See docs/BUILD_MODE.md.
 */
import { create } from 'zustand';
import type { BuildChange, BuildState } from '../../shared/mods';
import { buildLink } from '../data/build';
import { useSession } from '../data/session';
import { write } from './op';

export interface BuildView {
  active: boolean;
  /** The mods that differ from how the folder stood when the build started. */
  changes: BuildChange[];
  /** Where the session clock stood on entry, to offer on the way out. Null with no session open. */
  enteredAtSec: number | null;
}

export const useBuild = create<BuildView>(() => ({ active: false, changes: [], enteredAtSec: null }));

function apply(state: BuildState): void {
  const { active, changes, enteredAtSec } = useBuild.getState();
  if (active === state.active && JSON.stringify(changes) === JSON.stringify(state.changes)) return;
  useBuild.setState({ active: state.active, changes: state.changes, enteredAtSec: state.active ? enteredAtSec : null });
}

export const buildOps = {
  begin: write({ description: 'Enter build mode: from here until save or undo, every change to the mods folder can be undone as one.' }, async () => {
    const { session, clock } = useSession.getState();
    if (!useBuild.getState().active) useBuild.setState({ enteredAtSec: session ? clock.timeSec : null });
    apply(await buildLink.begin());
  }),
  save: write({ description: "Leave build mode and keep its changes. Resolves to what changed, in the app's words, or null for nothing." }, async () => {
    const summary = await buildLink.save();
    apply({ active: false, changes: [] });
    return summary;
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
