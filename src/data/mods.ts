/** The link to the main process's mods: it watches and compiles them, and the host loads them. See docs/MODS.md. */
import type { PlaceHealth } from '../../shared/health';
import type { ModLogLine, ModStatus, PictureResult } from '../../shared/mods';

export type { PictureResult };

export const modsLink = {
  list: (): Promise<ModStatus[]> => window.f1a.mods.list(),
  onChanged: (cb: (list: ModStatus[]) => void): (() => void) => window.f1a.mods.onChanged(cb),
  loaded: (name: string, version: number, error: string | null): void => window.f1a.mods.loaded(name, version, error),
  log: (name: string, line: ModLogLine): void => window.f1a.mods.log(name, line),
  onHealthAsked: (cb: (id: string) => void): (() => void) => window.f1a.mods.onHealthAsked(cb),
  health: (id: string, places: PlaceHealth[] | null): void => window.f1a.mods.health(id, places),
  onPictureAsked: (cb: (ask: { id: string; type: string }) => void): (() => void) => window.f1a.mods.onPictureAsked(cb),
  picture: (id: string, result: PictureResult): void => window.f1a.mods.picture(id, result),
};
