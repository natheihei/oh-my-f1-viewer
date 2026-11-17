/**
 * Loads mods: the main process compiles each one on save and says so, and this imports the build and
 * registers its component, replacing the last version by name. See docs/MODS.md.
 */
import { create } from 'zustand';
import type { ModLogLine, ModStatus } from '../../shared/mods';
import { modsLink } from '../data/mods';
import { componentOps, useComponents, type ComponentDefinition } from './components';

declare global {
  // eslint-disable-next-line no-var
  var __omfvShared: Record<string, unknown> | undefined;
  // eslint-disable-next-line no-var
  var __omfvModConsole: ((name: string) => Console) | undefined;
}

/** Every mod in the folder, as the main process reports it. Replaced as a whole on each change. */
export const useMods = create<{ list: ModStatus[] }>(() => ({ list: [] }));

/** The version of each mod that's registered now. */
const running = new Map<string, number>();
/** The installed components, the app's own: a mod can't take one of their names. */
let builtins = new Set<string>();

function textOf(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function writeLog(name: string, level: ModLogLine['level'], text: string): void {
  modsLink.log(name, { at: Date.now(), level, text });
}

/** A mod's `console`: the app's, and its mod.log. */
function modConsole(name: string): Console {
  const real = globalThis.console;
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const routed = Object.fromEntries(
    levels.map((level) => [
      level,
      (...args: unknown[]) => {
        real[level](`[mod:${name}]`, ...args);
        writeLog(name, level, textOf(args));
      },
    ]),
  );
  return Object.assign(Object.create(real), routed) as Console;
}

const isView = (v: unknown) => typeof v === 'function' || (typeof v === 'object' && v !== null && '$$typeof' in v);

/** Why a mod's default export can't be registered, or null if it can. */
function problemWith(definition: unknown, name: string): string | null {
  if (!definition || typeof definition !== 'object') return 'main must `export default defineComponent({ ... })`.';
  const d = definition as Partial<ComponentDefinition>;
  if (d.name !== name) return `Its name is "${String(d.name)}", but the component's name must match the mod's folder: "${name}".`;
  if (builtins.has(name)) return `"${name}" is an installed component's name. A changed copy of it is a fork with a name of its own: rename the folder and the component.`;
  if (typeof d.title !== 'string' || !d.title) return 'It needs a title.';
  if (typeof d.description !== 'string' || !d.description) return 'It needs a description.';
  if (!d.args || typeof d.args !== 'object' || (d.args as { type?: unknown }).type !== 'object') return 'Its args must be a TypeBox object schema: Type.Object({ ... }).';
  if (typeof d.spec !== 'function') return 'It needs spec(props), returning the tile\'s { key, label }.';
  if (!isView(d.View)) return 'Its View must be a React component.';
  return null;
}

async function load(mod: ModStatus): Promise<string | null> {
  try {
    const module = (await import(/* @vite-ignore */ mod.url!)) as { default?: unknown };
    const problem = problemWith(module.default, mod.name);
    if (problem) return problem;
    componentOps.register({ components: [module.default as ComponentDefinition] });
    running.set(mod.name, mod.version);
    return null;
  } catch (e) {
    return e instanceof Error ? (e.stack ?? e.message) : String(e);
  }
}

/** Brings what's registered in line with the folder: new builds in, removed mods out. */
async function sync(list: ModStatus[]): Promise<void> {
  const present = new Set(list.map((m) => m.name));
  const gone = [...running.keys()].filter((name) => !present.has(name));
  if (gone.length) {
    componentOps.unregister({ names: gone });
    for (const name of gone) running.delete(name);
  }
  for (const mod of list) {
    if (mod.state !== 'loading' || !mod.url || (running.get(mod.name) ?? 0) >= mod.version) continue;
    modsLink.loaded(mod.name, mod.version, await load(mod));
  }
}

let queue = Promise.resolve();
function apply(list: ModStatus[]): void {
  useMods.setState({ list });
  queue = queue.then(() => sync(list)).catch((e) => console.error('[mods] sync failed', e));
}

/**
 * Starts loading mods. `shared` holds the modules a mod imports, as the app's own copies: the host,
 * the chart kit, React and TypeBox. Call it once, after the app's own components are registered.
 */
export function startMods(shared: Record<string, object>): void {
  builtins = new Set(useComponents.getState().list.map((c) => c.name));
  // Marked as ES modules, so a mod's default imports (`import Type from 'typebox'`) find their default.
  globalThis.__omfvShared = Object.fromEntries(Object.entries(shared).map(([name, ns]) => [name, { ...ns, __esModule: true }]));
  globalThis.__omfvModConsole = modConsole;
  modsLink.onChanged(apply);
  void modsLink.list().then(apply, (e) => console.warn('[mods] list failed', e));
}

/** A tile's component threw while drawing: a mod's error goes to its log. */
export function reportTileError(type: string, error: unknown): void {
  if (running.has(type)) writeLog(type, 'error', `Render error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
}
