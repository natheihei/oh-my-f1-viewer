/**
 * The build agent's own tools: reading and writing files in the mods folder, a mod's status, and a
 * picture of a draft. They run here, not in the renderer, and reach nothing outside the mods folder.
 * See docs/BUILD_MODE.md.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { ModLogLine, ModStatus } from '../../../shared/mods';

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

const MAX_READ = 60_000;
const LOG_LINES = 40;
const WRITTEN = new Set(['mod.error', 'mod.log']);

type Schema = ToolDefinition['parameters'];
const object = (properties: Record<string, unknown>, required: string[]): Schema =>
  ({ type: 'object', properties, required, additionalProperties: false }) as unknown as Schema;
const string = (description: string) => ({ type: 'string', description });

/** Where a path the model gave points, or an error if it leaves the mods folder. */
export function resolveInside(dir: string, given: string): string {
  const target = path.resolve(dir, given || '.');
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error(`"${given}" is outside the mods folder. Paths are relative to it, like "my_mod/main.tsx".`);
  return target;
}

/** Refuses anything a build shouldn't write: files the app owns, and files that aren't inside a mod. */
function writable(dir: string, given: string): { file: string; mod: string; rel: string } {
  const file = resolveInside(dir, given);
  const parts = path.relative(dir, file).split(path.sep);
  if (parts.length < 2) throw new Error('Write inside a mod\'s folder, like "my_mod/main.tsx".');
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) throw new Error(`"${given}" is the app's, and can't be written.`);
  if (parts.length === 2 && WRITTEN.has(parts[1])) throw new Error(`The app writes ${parts[1]} itself.`);
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(parts[0])) throw new Error(`"${parts[0]}" can't be a mod's name: use lower-case letters, digits, _ and -, starting with a letter.`);
  return { file, mod: parts[0], rel: parts.join('/') };
}

async function listing(dir: string, base: string, depth: number): Promise<string[]> {
  const entries = await fsp.readdir(path.join(dir, base), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules') continue;
    const rel = path.posix.join(base.split(path.sep).join('/'), entry.name);
    if (entry.isDirectory()) {
      out.push(`${rel}/`);
      if (depth > 1) out.push(...(await listing(dir, rel, depth - 1)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function describeStatus(name: string, status: ModStatus | null): string {
  if (!status) return `${name} isn't a mod yet: it needs a main.tsx.`;
  if (status.state === 'ready') return `${name} loaded.`;
  if (status.state === 'failed') return `${name} did not load:\n${status.error ?? 'unknown error'}${status.version > 0 ? '\nThe last version that loaded is still running.' : ''}`;
  return `${name} is still loading.`;
}

const text = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], details: undefined, isError });

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

  /** A save's result: whether the mod loaded, for the model and for the palette. */
  const saved = async (verb: string, mod: string, rel: string) => {
    const status = await host().settled(mod);
    const loaded = status?.state === 'ready';
    const outcome = !status ? 'not a mod yet' : loaded ? 'loaded' : status.state === 'failed' ? "didn't load" : 'loading';
    return { result: text(`Saved ${rel}. ${describeStatus(mod, status)}`), note: `${verb} ${rel} · ${outcome}` };
  };

  return (pi) => {
    const tools: ToolDefinition[] = [
      {
        name: 'list_files',
        label: 'list_files',
        description: 'List files in the mods folder, or in one folder of it. Folders end with /.',
        parameters: object({ path: string('A folder, relative to the mods folder. Leave out for the top level.') }, []),
        execute: (_id, args) =>
          run('list_files', async () => {
            const { path: given = '' } = args as { path?: string };
            const { dir } = host();
            const target = resolveInside(dir, given);
            const lines = await listing(dir, path.relative(dir, target), given ? 4 : 2);
            return { result: text(lines.join('\n') || '(empty)') };
          }),
      },
      {
        name: 'read_file',
        label: 'read_file',
        description: 'Read a text file in the mods folder: a mod\'s source, its mod.error or mod.log, or the types under .types.',
        parameters: object({ path: string('Relative to the mods folder, like "lap_form/main.tsx".') }, ['path']),
        execute: (_id, args) =>
          run('read_file', async () => {
            const { path: given } = args as { path: string };
            const content = await fsp.readFile(resolveInside(host().dir, given), 'utf8');
            return { result: text(content.length > MAX_READ ? `${content.slice(0, MAX_READ)}\n… (${content.length - MAX_READ} more characters)` : content) };
          }),
      },
      {
        name: 'write_file',
        label: 'write_file',
        description: 'Create or replace a file in a mod\'s folder, making the folder if needed. Waits for the app to compile and load the mod, and says whether it did.',
        parameters: object({ path: string('Relative to the mods folder, like "lap_stepper/main.tsx".'), content: string('The whole file.') }, ['path', 'content']),
        execute: (_id, args) =>
          run('write_file', async () => {
            const { path: given, content } = args as { path: string; content: string };
            const { file, mod, rel } = writable(host().dir, given);
            await fsp.mkdir(path.dirname(file), { recursive: true });
            await fsp.writeFile(file, content);
            return saved('wrote', mod, rel);
          }),
      },
      {
        name: 'edit_file',
        label: 'edit_file',
        description: 'Replace one piece of text in a mod\'s file. `old` must appear exactly once. Waits for the mod to load, like write_file.',
        parameters: object({ path: string('Relative to the mods folder.'), old: string('The exact text to replace.'), new: string('What to put there.') }, ['path', 'old', 'new']),
        execute: (_id, args) =>
          run('edit_file', async () => {
            const { path: given, old, new: next } = args as { path: string; old: string; new: string };
            const { file, mod, rel } = writable(host().dir, given);
            const content = await fsp.readFile(file, 'utf8');
            const count = old ? content.split(old).length - 1 : 0;
            if (count !== 1) throw new Error(count === 0 ? `That text isn't in ${rel}. Read the file and try again.` : `That text appears ${count} times in ${rel}. Include more around it.`);
            await fsp.writeFile(file, content.replace(old, () => next));
            return saved('edited', mod, rel);
          }),
      },
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
            return saved('deleted', parts[0], parts.join('/'));
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
    for (const tool of tools) pi.registerTool(tool);
  };
}

export const MOD_FILE_TOOLS = ['list_files', 'read_file', 'write_file', 'edit_file', 'delete_path', 'mod_status', 'look_at'];
