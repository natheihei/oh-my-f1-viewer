/** The link to build mode's snapshot of the mods folder, which the main process keeps. See docs/BUILD_MODE.md. */
import type { BuildState } from '../../shared/mods';

export const buildLink = {
  state: (): Promise<BuildState> => window.omfv.build.state(),
  onChanged: (cb: (state: BuildState) => void): (() => void) => window.omfv.build.onChanged(cb),
  begin: (): Promise<BuildState> => window.omfv.build.begin(),
  save: (): Promise<string | null> => window.omfv.build.save(),
  undo: (): Promise<number> => window.omfv.build.undo(),
};
