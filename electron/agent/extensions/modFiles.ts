/**
 * The build agent's own tools: pi's read, write, edit, ls, grep and find, kept inside the mods folder,
 * and our own for deleting, a mod's status, and a picture of a draft. They run here, not in the
 * renderer, and reach nothing outside the mods folder. See docs/BUILD_MODE.md.
 */
import { constants, promises as fsp } from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { describePlace, notDrawing, type PlaceHealth } from '../../../shared/health';
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
  /** How every tile and draft is drawing, once each has drawn with its latest code. Null when the app can't say. */
  health(): Promise<PlaceHealth[] | null>;
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
  /** The mod file a write or edit saved, once it really wrote it. */
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
  /** For a file that will be written: edit reads it this way first. */
  write(file: string): string {
    return this.hold(() => writable(this.dir, file).file);
  }
  /** Writes a file that may be written, and records the save. */
  async save(file: string, content: string): Promise<void> {
    const { file: target, mod, rel } = this.hold(() => writable(this.dir, file));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
    this.saved = { mod, rel };
  }
}

/**
 * Everything under a folder, in name order, for find and grep. Dot folders like .types are in. Links
 * aren't followed, so the walk stays in the folder, and node_modules and .git are left out.
 */
async function* walk(root: string, rel = ''): AsyncGenerator<{ rel: string; folder: boolean; file: boolean }> {
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    const folder = entry.isDirectory();
    yield { rel: child, folder, file: entry.isFile() };
    if (folder) yield* walk(root, child);
  }
}

/** Whether a path matches a glob. A pattern without / matches names at any depth, as in pi. */
function globMatcher(pattern: string): (rel: string, folder: boolean) => boolean {
  const options = { dot: true, matchBase: !pattern.includes('/') };
  return (rel, folder) => minimatch(rel, pattern, options) || (folder && minimatch(`${rel}/`, pattern, options));
}

/** Files and folders under a folder whose path matches a glob, for find. */
async function glob(root: string, pattern: string, limit: number): Promise<string[]> {
  const matches = globMatcher(pattern);
  const out: string[] = [];
  for await (const entry of walk(root)) {
    if (out.length >= limit) break;
    if (matches(entry.rel, entry.folder)) out.push(entry.folder ? `${entry.rel}/` : entry.rel);
  }
  return out;
}

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

const GREP_LIMIT = 100;
const GREP_LINE = 500;
/** Bigger files aren't searched. */
const GREP_FILE_BYTES = 1024 * 1024;

/** The pattern as a RegExp, or an error that says why it isn't one. */
function grepRegex({ pattern, literal, ignoreCase }: GrepArgs): RegExp {
  const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
  const flags = ignoreCase ? 'i' : '';
  try {
    return new RegExp(source, `${flags}u`);
  } catch {
    try {
      return new RegExp(source, flags);
    } catch (e) {
      throw new Error(`${JSON.stringify(pattern)} isn't a valid JavaScript regular expression: ${e instanceof Error ? e.message : String(e)}. Set literal to true to search for the text as written.`);
    }
  }
}

/**
 * grep in JavaScript, so the build agent needs no ripgrep. It prints what pi's grep prints: "file:line: text"
 * for a match and "file-line- text" around it, with pi's limits and notices. A file whose content has a NUL
 * byte is taken for binary and skipped, like ripgrep does.
 */
async function grep(
  pi: Pick<Pi, 'truncateHead' | 'truncateLine' | 'formatSize' | 'DEFAULT_MAX_BYTES'>,
  target: string,
  args: GrepArgs,
  signal: AbortSignal | undefined,
) {
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat) throw new Error(`Path not found: ${target}`);
  const regex = grepRegex(args);
  const around = args.context && args.context > 0 ? Math.floor(args.context) : 0;
  const limit = Math.max(1, Math.floor(args.limit ?? GREP_LIMIT));

  // A folder's files are shown relative to it, and one file by its name.
  const files: { file: string; shown: string }[] = [];
  if (stat.isDirectory()) {
    const filter = args.glob?.replace(/^(!?)(?:\.\/)+/, '$1');
    const negated = !!filter?.startsWith('!');
    const matches = filter ? globMatcher(negated ? filter.slice(1) : filter) : null;
    for await (const entry of walk(target)) {
      if (entry.file && (!matches || matches(entry.rel, false) !== negated)) files.push({ file: path.join(target, entry.rel), shown: entry.rel });
    }
  } else {
    files.push({ file: target, shown: path.basename(target) });
  }

  const lines: string[] = [];
  let count = 0;
  let more = false;
  let longLines = false;
  for (const { file, shown } of files) {
    if (signal?.aborted) throw new Error('Operation aborted');
    if ((await fsp.stat(file)).size > GREP_FILE_BYTES) continue;
    const content = await fsp.readFile(file).catch(() => null);
    if (!content || content.includes(0)) continue;
    const text = content.toString('utf8').split('\n');
    if (text.at(-1) === '') text.pop();
    const all = text.map((line) => line.replace(/\r$/, ''));
    const hits = all.flatMap((line, i) => (regex.test(line) ? [i] : []));
    if (!hits.length) continue;
    // Past the limit, one more match only says the limit cut results off.
    if (count >= limit) {
      more = true;
      break;
    }
    const kept = hits.slice(0, limit - count);
    count += kept.length;
    if (hits.length > kept.length) more = true;
    const shownLines = new Set<number>();
    for (const hit of kept) for (let i = Math.max(0, hit - around); i <= Math.min(all.length - 1, hit + around); i++) shownLines.add(i);
    const isKept = new Set(kept);
    for (const i of [...shownLines].sort((a, b) => a - b)) {
      const { text: line, wasTruncated } = pi.truncateLine(all[i], GREP_LINE);
      if (wasTruncated) longLines = true;
      lines.push(isKept.has(i) ? `${shown}:${i + 1}: ${line}` : `${shown}-${i + 1}- ${line}`);
    }
    if (more) break;
  }

  if (count === 0) return { content: [{ type: 'text' as const, text: 'No matches found' }], details: undefined };
  const truncation = pi.truncateHead(lines.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER });
  let output = truncation.content;
  const details: Record<string, unknown> = {};
  const notices: string[] = [];
  if (more) {
    notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
    details.matchLimitReached = limit;
  }
  if (truncation.truncated) {
    notices.push(`${pi.formatSize(pi.DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (longLines) {
    notices.push(`Some lines truncated to ${GREP_LINE} chars. Use read tool to see full lines`);
    details.linesTruncated = true;
  }
  if (notices.length) output += `\n\n[${notices.join('. ')}]`;
  return { content: [{ type: 'text' as const, text: output }], details: Object.keys(details).length ? details : undefined };
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

/** `told` hears what a save's result said isn't drawing, so the agent isn't told of it again as its turn ends. */
export function modFilesExtension(host: () => ModFilesHost, report: ModToolReport, told: (places: PlaceHealth[]) => void = () => {}): ExtensionFactory {
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
    // What loaded may still not draw: a save says so for this mod's own tiles and draft.
    const broken = status?.state === 'ready' ? notDrawing(await placesOf(mod)) : [];
    told(broken);
    const problems = broken.map(describePlace);
    return { line: [describeStatus(mod, status), ...problems].join(' '), note: `${verb} ${rel} · ${outcome}${problems.length ? ' · not drawing' : ''}` };
  };

  /** Where a mod shows, and how each place stands. Nothing when the app can't say. */
  const placesOf = async (mod: string): Promise<PlaceHealth[]> => ((await host().health().catch(() => null)) ?? []).filter((p) => p.type === mod);

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
          // Only a save that pi reports done waits for the mod to load.
          if (!verb || !guard.saved || result.isError) {
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

    const piGrep = tools.createGrepToolDefinition('/') as ToolDefinition;
    const grepParams = piGrep.parameters as unknown as { properties: Record<string, object> };
    const grepShape: ToolDefinition = reworded(
        piGrep,
        `${FOLDER} Or one file.`,
        `Search the contents of files under the mods folder for a JavaScript regular expression, or for plain text with literal. Returns matching lines as file:line: text, with paths relative to the folder searched. Includes dot folders like .types, and skips node_modules, binary files and files over 1 MB. Output is truncated to ${GREP_LIMIT} matches or ${tools.DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_LINE} chars.`,
    );
    grepShape.parameters = {
      ...(grepShape.parameters as object),
      properties: { ...(grepShape.parameters as unknown as { properties: object }).properties, pattern: { ...grepParams.properties.pattern, description: 'A JavaScript regular expression, or plain text when literal is true.' } },
    } as unknown as Schema;

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
              // pi makes the folder before writing. Guard.save makes it instead, once the file is known to be writable.
              mkdir: async () => {},
              writeFile: (p, content) => guard.save(p, content),
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
              writeFile: (p, content) => guard.save(p, content),
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
        // Ours, not pi's, so no ripgrep is needed. pi's find resolves the path, so it's read the way the other tools read it.
        (dir, guard) => ({
          ...grepShape,
          execute: async (id, args, signal, onUpdate, ctx) => {
            const given = args as GrepArgs;
            let resolved = '';
            await tools
              .createFindToolDefinition(dir, { operations: { exists: (p) => ((resolved = p), true), glob: () => [] } })
              .execute(id, { pattern: '*', path: given.path }, undefined, onUpdate, ctx);
            return grep(tools, guard.read(resolved), given, signal);
          },
        }),
        (def) => def,
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
        description: 'Whether a mod\'s latest save loaded, its error if not, how each of its tiles and its draft is drawing, and the last lines of its log: what it printed to the console, and errors thrown while drawing.',
        parameters: object({ mod: string('The mod\'s folder name.') }, ['mod']),
        execute: (_id, args) =>
          run('mod_status', async () => {
            const { mod } = args as { mod: string };
            const status = await host().settled(mod);
            const log = host()
              .logs(mod)
              .slice(-LOG_LINES)
              .map((l) => `${l.level} ${l.text}`);
            const places = (await placesOf(mod)).map(describePlace);
            return { result: text(`${describeStatus(mod, status)}\n\nOn screen:\n${places.join('\n') || '(nowhere)'}\n\nLog:\n${log.join('\n') || '(nothing)'}`) };
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
