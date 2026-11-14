/**
 * The build agent's own tools: pi's read, write, edit, ls, grep and find, kept inside the mods folder,
 * and our own for deleting, a mod's status, and a picture of a draft. They run here, not in the
 * renderer, and reach nothing outside the mods folder. See docs/BUILD_MODE.md.
 */
import { constants, promises as fsp } from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { ModLogLine, ModStatus } from '../../../shared/mods';

type Pi = typeof import('@earendil-works/pi-coding-agent', { with: { 'resolution-mode': 'import' } });

/** What the tools need from the app. */
export interface ModFilesHost {
  /** The mods folder. */
  dir: string;
  /** Waits for a mod's last save to load or fail. Null when the folder isn't a mod. */
  settled(name: string): Promise<ModStatus | null>;
  logs(name: string): ModLogLine[];
  /** A PNG of a component as it shows now, in the strip or on the grid, or null if it's on neither. */
  picture(name: string): Promise<Buffer | null>;
}

/** Told about each call as it ends, with a line for the palette when there's one to show. */
export type ModToolReport = (name: string, ok: boolean, note: string | null) => void;

const LOG_LINES = 40;
const WRITTEN = new Set(['mod.error', 'mod.log']);

type Schema = ToolDefinition['parameters'];
const object = (properties: Record<string, unknown>, required: string[]): Schema =>
  ({ type: 'object', properties, required, additionalProperties: false }) as unknown as Schema;
const string = (description: string) => ({ type: 'string', description });

/** Where a path points, or an error if it leaves the mods folder. */
export function resolveInside(dir: string, given: string): string {
  const target = path.resolve(dir, given || '.');
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error(`"${given}" is outside the mods folder. Paths are relative to it, like "my_mod/main.tsx".`);
  return target;
}

/** Refuses anything a build shouldn't write: files the app owns, and files that aren't inside a mod. */
function writable(dir: string, given: string): { file: string; mod: string; rel: string } {
  const file = resolveInside(dir, given);
  const parts = path.relative(dir, file).split(path.sep);
  const rel = parts.join('/');
  if (parts.length < 2) throw new Error('Write inside a mod\'s folder, like "my_mod/main.tsx".');
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) throw new Error(`"${rel}" is the app's, and can't be written.`);
  if (parts.length === 2 && WRITTEN.has(parts[1])) throw new Error(`The app writes ${parts[1]} itself.`);
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(parts[0])) throw new Error(`"${parts[0]}" can't be a mod's name: use lower-case letters, digits, _ and -, starting with a letter.`);
  return { file, mod: parts[0], rel };
}

/**
 * Checks each path pi is about to touch. pi hands its operations the absolute path it resolved, after
 * stripping a leading @ and expanding ~, so the check runs on the path really opened. The first
 * refusal is kept, so the model hears it rather than pi's wrapping of it.
 */
class Guard {
  refused: Error | null = null;
  /** The mod file a write or edit saved. */
  saved: { mod: string; rel: string } | null = null;
  constructor(private readonly dir: string) {}
  private hold<T>(check: () => T): T {
    try {
      return check();
    } catch (e) {
      this.refused ??= e instanceof Error ? e : new Error(String(e));
      throw e;
    }
  }
  read(file: string): string {
    return this.hold(() => resolveInside(this.dir, file));
  }
  write(file: string): string {
    return this.hold(() => {
      const { file: target, mod, rel } = writable(this.dir, file);
      this.saved = { mod, rel };
      return target;
    });
  }
}

/** Files under a folder whose path matches a glob, for find. A pattern without / matches names at any depth. */
async function glob(root: string, pattern: string, limit: number): Promise<string[]> {
  const options = { dot: true, matchBase: !pattern.includes('/') };
  const out: string[] = [];
  const walk = async (rel: string) => {
    const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      // Links aren't followed, so the walk stays in the folder.
      const folder = entry.isDirectory();
      if (minimatch(child, pattern, options) || (folder && minimatch(`${child}/`, pattern, options))) out.push(folder ? `${child}/` : child);
      if (folder) await walk(child);
    }
  };
  await walk('');
  return out;
}

function describeStatus(name: string, status: ModStatus | null): string {
  if (!status) return `${name} isn't a mod yet: it needs a main.tsx.`;
  if (status.state === 'ready') return `${name} loaded.`;
  if (status.state === 'failed') return `${name} did not load:\n${status.error ?? 'unknown error'}${status.version > 0 ? '\nThe last version that loaded is still running.' : ''}`;
  return `${name} is still loading.`;
}

const text = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], details: undefined, isError });

const PATH = 'Relative to the mods folder, like "my_mod/main.tsx".';
const FOLDER = 'A folder, relative to the mods folder, like "my_mod" or ".types". Leave out for the whole mods folder.';

/** pi's definition with our wording: paths are relative to the mods folder, and pi's prompt lines are left out. */
function reworded(def: ToolDefinition, pathDescription: string, description = def.description): ToolDefinition {
  const params = def.parameters as unknown as { properties: Record<string, object> };
  const parameters = { ...params, properties: { ...params.properties, path: { ...params.properties.path, description: pathDescription } } } as unknown as Schema;
  return { ...def, description, parameters, promptSnippet: undefined, promptGuidelines: undefined };
}

export function modFilesExtension(host: () => ModFilesHost, report: ModToolReport): ExtensionFactory {
  /** Runs a tool, turning what it throws into an error result, and reports how it went. */
  const run = async (name: string, work: () => Promise<{ result: ReturnType<typeof text> | { content: unknown[]; details: undefined; isError: boolean }; note?: string | null }>) => {
    try {
      const { result, note = null } = await work();
      report(name, !result.isError, note);
      return result as ReturnType<typeof text>;
    } catch (e) {
      report(name, false, null);
      return text(e instanceof Error ? e.message : String(e), true);
    }
  };

  /** Whether a save loaded, for the model and for the palette. */
  const loaded = async (verb: string, mod: string, rel: string) => {
    const status = await host().settled(mod);
    const outcome = !status ? 'not a mod yet' : status.state === 'ready' ? 'loaded' : status.state === 'failed' ? "didn't load" : 'loading';
    return { line: describeStatus(mod, status), note: `${verb} ${rel} · ${outcome}` };
  };

  return async (pi) => {
    const tools: Pi = await import('@earendil-works/pi-coding-agent');

    /**
     * One of pi's tools, made for each call with operations that check every path. A write or edit
     * that saved waits for the mod to load and adds whether it did.
     */
    const wrapped = (name: string, make: (dir: string, guard: Guard) => ToolDefinition, shape: (def: ToolDefinition) => ToolDefinition, verb?: string): ToolDefinition => ({
      ...shape(make('/', new Guard('/'))),
      execute: async (id, args, signal, onUpdate, ctx) => {
        let guard: Guard | null = null;
        try {
          const { dir } = host();
          guard = new Guard(dir);
          const result = await make(dir, guard).execute(id, args, signal, onUpdate, ctx);
          if (!verb || !guard.saved) {
            report(name, !result.isError, null);
            return result;
          }
          const { line, note } = await loaded(verb, guard.saved.mod, guard.saved.rel);
          report(name, true, note);
          return { ...result, content: [...result.content, { type: 'text' as const, text: line }] };
        } catch (e) {
          report(name, false, null);
          return text(guard?.refused?.message ?? (e instanceof Error ? e.message : String(e)), true);
        }
      },
    });

    const exists = (p: string) =>
      fsp.access(p).then(
        () => true,
        () => false,
      );

    const piTools: ToolDefinition[] = [
      wrapped(
        'read',
        (dir, guard) =>
          tools.createReadToolDefinition(dir, {
            operations: {
              access: async (p) => fsp.access(guard.read(p), constants.R_OK),
              readFile: async (p) => fsp.readFile(guard.read(p)),
            },
          }) as ToolDefinition,
        (def) => reworded(def, PATH, `In the mods folder: a mod's source, its mod.error or mod.log, or the types under .types. ${def.description}`),
      ),
      wrapped(
        'write',
        (dir, guard) =>
          tools.createWriteToolDefinition(dir, {
            operations: {
              // pi makes the folder before writing. It's made below instead, once the file is known to be writable.
              mkdir: async () => {},
              writeFile: async (p, content) => {
                const file = guard.write(p);
                await fsp.mkdir(path.dirname(file), { recursive: true });
                await fsp.writeFile(file, content);
              },
            },
          }) as ToolDefinition,
        (def) => reworded(def, PATH, `${def.description} Only inside a mod's folder. Waits for the app to compile and load the mod, and says whether it did.`),
        'wrote',
      ),
      wrapped(
        'edit',
        (dir, guard) =>
          tools.createEditToolDefinition(dir, {
            operations: {
              access: async (p) => fsp.access(guard.write(p), constants.R_OK | constants.W_OK),
              readFile: async (p) => fsp.readFile(guard.write(p)),
              writeFile: async (p, content) => fsp.writeFile(guard.write(p), content),
            },
          }) as ToolDefinition,
        (def) => reworded(def, PATH, `${def.description} Only inside a mod's folder. Waits for the mod to load and says whether it did, like write.`),
        'edited',
      ),
      wrapped(
        'ls',
        (dir, guard) =>
          tools.createLsToolDefinition(dir, {
            operations: {
              exists: async (p) => exists(guard.read(p)),
              stat: async (p) => fsp.stat(guard.read(p)),
              readdir: async (p) => fsp.readdir(guard.read(p)),
            },
          }) as ToolDefinition,
        (def) => reworded(def, FOLDER),
      ),
      wrapped(
        'grep',
        // pi checks the folder here before ripgrep starts, so a refusal stops the search.
        (dir, guard) => tools.createGrepToolDefinition(dir, { operations: { isDirectory: async (p) => (await fsp.stat(guard.read(p))).isDirectory() } }) as ToolDefinition,
        (def) => reworded(def, `${FOLDER} Or one file.`, def.description.replace(' Respects .gitignore.', '')),
      ),
      wrapped(
        'find',
        // With its own glob, pi checks the folder through exists and never runs fd.
        (dir, guard) =>
          tools.createFindToolDefinition(dir, {
            operations: {
              exists: async (p) => exists(guard.read(p)),
              glob: async (pattern, cwd, { limit }) => glob(guard.read(cwd), pattern, limit),
            },
          }) as ToolDefinition,
        (def) =>
          reworded(
            def,
            FOLDER,
            "Find files and folders by glob pattern, like '*.tsx' or 'my_mod/**/*.ts'. A pattern without '/' matches names at any depth. Returns paths relative to the folder searched, with '/' after folders. Includes dot folders like .types, and skips node_modules. Output is truncated to 1000 results.",
          ),
      ),
    ];

    const ours: ToolDefinition[] = [
      {
        name: 'delete_path',
        label: 'delete_path',
        description: 'Delete a file in a mod\'s folder, or a whole mod by its folder name: that removes the component and takes its tiles off screen.',
        parameters: object({ path: string('A mod\'s folder, like "lap_stepper", or a file in one.') }, ['path']),
        execute: (_id, args) =>
          run('delete_path', async () => {
            const { path: given } = args as { path: string };
            const { dir } = host();
            const target = resolveInside(dir, given);
            const parts = path.relative(dir, target).split(path.sep);
            if (!parts[0] || parts.some((p) => p.startsWith('.'))) throw new Error(`"${given}" can't be deleted.`);
            if (parts.length === 1) {
              if (!(await fsp.stat(target).catch(() => null))?.isDirectory()) throw new Error(`There is no mod "${parts[0]}".`);
              await fsp.rm(target, { recursive: true, force: true });
              await host().settled(parts[0]);
              return { result: text(`Removed the mod ${parts[0]}.`), note: `removed ${parts[0]}` };
            }
            await fsp.rm(target, { recursive: true });
            const rel = parts.join('/');
            const { line, note } = await loaded('deleted', parts[0], rel);
            return { result: text(`Deleted ${rel}. ${line}`), note };
          }),
      },
      {
        name: 'mod_status',
        label: 'mod_status',
        description: 'Whether a mod\'s latest save loaded, its error if not, and the last lines of its log: what it printed to the console, and errors thrown while drawing.',
        parameters: object({ mod: string('The mod\'s folder name.') }, ['mod']),
        execute: (_id, args) =>
          run('mod_status', async () => {
            const { mod } = args as { mod: string };
            const status = await host().settled(mod);
            const log = host()
              .logs(mod)
              .slice(-LOG_LINES)
              .map((l) => `${l.level} ${l.text}`);
            return { result: text(`${describeStatus(mod, status)}\n\nLog:\n${log.join('\n') || '(nothing)'}`) };
          }),
      },
      {
        name: 'look_at',
        label: 'look_at',
        description: 'A picture of a mod\'s component as it shows right now: its tile on the grid, or its preview in the strip. To check how it looks.',
        parameters: object({ mod: string('The mod\'s folder name.') }, ['mod']),
        execute: (_id, args) =>
          run('look_at', async () => {
            const { mod } = args as { mod: string };
            await host().settled(mod);
            const png = await host().picture(mod);
            if (!png) return { result: text(`${mod} isn't showing: it's on neither the grid nor the strip.`, true) };
            return {
              result: { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }], details: undefined, isError: false },
              note: `looked at ${mod}`,
            };
          }),
      },
    ];
    for (const tool of [...piTools, ...ours]) pi.registerTool(tool);
  };
}

export const MOD_FILE_TOOLS = ['read', 'write', 'edit', 'ls', 'grep', 'find', 'delete_path', 'mod_status', 'look_at'];
