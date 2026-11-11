/** Mods: plugins that live in a folder and reload on save. For now each defines one tile component. See docs/MODS.md. */

/** The modules a mod may import, which it shares with the app. */
export const SHARED_MODULES = ['f1a', 'f1a/kit', 'react', 'react/jsx-runtime', 'typebox'] as const;
export type SharedModule = (typeof SHARED_MODULES)[number];

export interface ModStatus {
  /** The folder's name, which is also the component's. */
  name: string;
  /**
   * `loading`: a build is waiting for the renderer to load it. `ready`: the latest build is running.
   * `failed`: the latest save didn't compile or load, and `error` says why; the last good build, if
   * there is one, keeps running.
   */
  state: 'loading' | 'ready' | 'failed';
  /** Goes up with each build that compiles. 0 means none has yet. */
  version: number;
  /** The build's address, for the renderer to import. Null until one compiles. */
  url: string | null;
  error: string | null;
}

export interface ModLogLine {
  /** Milliseconds since the epoch. */
  at: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
}

/** One mod that differs from how the mods folder stood when a build started. See docs/BUILD_MODE.md. */
export interface BuildChange {
  name: string;
  change: 'added' | 'edited' | 'deleted';
}

/** Build mode as the main process sees it: whether a snapshot is open, and what differs from it. */
export interface BuildState {
  active: boolean;
  changes: BuildChange[];
}
