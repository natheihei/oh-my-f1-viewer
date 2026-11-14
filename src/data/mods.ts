/** The link to the main process's mods: it watches and compiles them, and the host loads them. See docs/MODS.md. */
import type { PlaceHealth } from '../../shared/health';
import type { ModLogLine, ModStatus } from '../../shared/mods';

export const modsLink = {
  list: (): Promise<ModStatus[]> => window.f1a.mods.list(),
  onChanged: (cb: (list: ModStatus[]) => void): (() => void) => window.f1a.mods.onChanged(cb),
  loaded: (name: string, version: number, error: string | null): void => window.f1a.mods.loaded(name, version, error),
  log: (name: string, line: ModLogLine): void => window.f1a.mods.log(name, line),
  onHealthAsked: (cb: (id: string) => void): (() => void) => window.f1a.mods.onHealthAsked(cb),
  health: (id: string, places: PlaceHealth[] | null): void => window.f1a.mods.health(id, places),
};
