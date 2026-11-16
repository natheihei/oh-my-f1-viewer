import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context';
import * as durable from '@earendil-works/pi-durable';
import type { ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable';
import type { PlaceHealth } from '../../../shared/health';
import type { ModStatus } from '../../../shared/mods';
import { MOD_FILE_TOOLS, modFilesExtension, type ModFilesHost } from './modFiles';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ready = (name: string): ModStatus => ({ name, state: 'ready', version: 1, url: null, error: null });
const place = (over: Partial<PlaceHealth>): PlaceHealth => ({ scope: 'tile-1', where: 'tile', type: 'pace', label: 'Pace HAM', state: 'drawn', missing: [], dropped: [], message: null, since: null, ...over });

/** The extension over a fresh mods folder, with a secret beside it that nothing may read. */
function setup(
  status: (name: string, dir: string) => ModStatus | null = (name, dir) => (existsSync(path.join(dir, name, 'main.tsx')) ? ready(name) : null),
  more: Partial<ModFilesHost> = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'f1a-modfiles-'));
  roots.push(root);
  const dir = path.join(root, 'mods');
  mkdirSync(dir);
  writeFileSync(path.join(root, 'secret.txt'), 'TOKEN');
  const settled = vi.fn(async (name: string) => status(name, dir));
  const reports: [string, boolean, string | null][] = [];
  const told: PlaceHealth[][] = [];
  const extension = modFilesExtension(
    durable,
    () => ({ dir, settled, logs: () => [], picture: async () => null, health: async () => [], ...more }),
    (name, ok, note) => reports.push([name, ok, note]),
    (places) => told.push(places),
  );
  const tools = new Map<string, ToolRegistration>((extension.tools ?? []).map((t) => [t.name, t]));
  const run = async (name: string, args: Record<string, unknown>, context: Context = BACKGROUND_CONTEXT) => {
    const tool = tools.get(name)!;
    // The Harness repairs arguments before it runs a tool.
    const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
    return tool.execute(prepared, {} as ToolExecutionApi, context);
  };
  const call = async (name: string, args: Record<string, unknown>, context?: Context) => {
    const result = await run(name, args, context);
    return { isError: !!result.isError, text: (result.output ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n') };
  };
  const file = (rel: string, content: string | Buffer) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  };
  const read = (rel: string) => readFileSync(path.join(dir, rel), 'utf8');
  /** The absolute path pi resolved, which its messages named. */
  const abs = (rel: string) => path.join(dir, rel);
  return { root, dir, extension, tools, run, call, settled, reports, told, file, read, abs };
}

const FILE_TOOLS = ['read', 'write', 'edit', 'ls', 'grep', 'find'];
const PATH = { type: 'string', description: 'Relative to the mods folder, like "my_mod/main.tsx".' };
const FOLDER = 'A folder, relative to the mods folder, like "my_mod" or ".types". Leave out for the whole mods folder.';
const outside = (p: string) => `"${p}" is outside the mods folder. Paths are relative to it, like "my_mod/main.tsx".`;

describe('the build agent\'s file tools', () => {
  it('are six file tools and our three, in one pi-durable extension', () => {
    const { extension, tools } = setup();
    expect(extension.name).toBe('mod-files');
    expect([...tools.keys()]).toEqual(MOD_FILE_TOOLS);
    expect(MOD_FILE_TOOLS).not.toContain('bash');
    // Saves run one at a time.
    for (const name of ['write', 'edit', 'delete_path']) expect(tools.get(name)!.executionMode).toBe('sequential');
  });

  it('show the model the descriptions and schemas the wrapped pi tools did', () => {
    const { tools } = setup();
    const shown = (name: string) => {
      const { description, parameters, constrainedSampling } = tools.get(name)!;
      return { description, parameters, constrainedSampling };
    };
    const strict = { type: 'json_schema', strict: 'prefer' };
    expect(shown('read')).toEqual({
      description:
        "In the mods folder: a mod's source, its mod.error or mod.log, or the types under .types. Read the contents of a file as text, images and binary files too. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
      parameters: {
        type: 'object',
        required: ['path'],
        properties: { path: PATH, offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' }, limit: { type: 'number', description: 'Maximum number of lines to read' } },
      },
      constrainedSampling: strict,
    });
    expect(shown('write')).toEqual({
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories. Only inside a mod's folder. Waits for the app to compile and load the mod, and says whether it did.",
      parameters: { type: 'object', required: ['path', 'content'], properties: { path: PATH, content: { type: 'string', description: 'Content to write to the file' } } },
      constrainedSampling: strict,
    });
    expect(shown('edit')).toEqual({
      description:
        "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes. Only inside a mod's folder. Waits for the mod to load and says whether it did, like write.",
      parameters: {
        type: 'object',
        required: ['path', 'edits'],
        properties: {
          path: PATH,
          edits: {
            type: 'array',
            items: {
              type: 'object',
              required: ['oldText', 'newText'],
              properties: {
                oldText: { type: 'string', description: 'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.' },
                newText: { type: 'string', description: 'Replacement text for this targeted edit.' },
              },
            },
            description:
              'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
          },
        },
      },
      constrainedSampling: strict,
    });
    expect(shown('ls')).toEqual({
      description: "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).",
      parameters: { type: 'object', properties: { path: { type: 'string', description: FOLDER }, limit: { type: 'number', description: 'Maximum number of entries to return (default: 500)' } } },
      constrainedSampling: undefined,
    });
    expect(shown('grep')).toEqual({
      description:
        'Search the contents of files under the mods folder for a JavaScript regular expression, or for plain text with literal. Returns matching lines as file:line: text, with paths relative to the folder searched. Includes dot folders like .types, and skips node_modules, binary files and files over 1 MB. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.',
      parameters: {
        type: 'object',
        required: ['pattern'],
        properties: {
          pattern: { type: 'string', description: 'A JavaScript regular expression, or plain text when literal is true.' },
          path: { type: 'string', description: `${FOLDER} Or one file.` },
          glob: { type: 'string', description: "Filter files by glob pattern, relative to path, e.g. '*.ts', 'src/**/*.ts' or '**/*.spec.ts'. A pattern without '/' matches file names at any depth" },
          ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
          literal: { type: 'boolean', description: 'Treat pattern as literal string instead of regex (default: false)' },
          context: { type: 'number', description: 'Number of lines to show before and after each match (default: 0)' },
          limit: { type: 'number', description: 'Maximum number of matches to return (default: 100)' },
        },
      },
      constrainedSampling: undefined,
    });
    expect(shown('find')).toEqual({
      description:
        "Find files and folders by glob pattern, like '*.tsx' or 'my_mod/**/*.ts'. A pattern without '/' matches names at any depth. Returns paths relative to the folder searched, with '/' after folders. Includes dot folders like .types, and skips node_modules. Output is truncated to 1000 results.",
      parameters: {
        type: 'object',
        required: ['pattern'],
        properties: {
          pattern: { type: 'string', description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" },
          path: { type: 'string', description: FOLDER },
          limit: { type: 'number', description: 'Maximum number of results (default: 1000)' },
        },
      },
      constrainedSampling: undefined,
    });
    // Key order too, as the schema reaches the provider.
    expect(Object.keys(tools.get('read')!.parameters)).toEqual(['type', 'required', 'properties']);
  });

  describe('each refuses paths outside the mods folder, naming the absolute path it resolved', () => {
    // ~ expands to a home of the test's own, so a broken check can't touch the real one.
    const realHome = process.env.HOME;
    let home = '';
    beforeEach(() => {
      home = mkdtempSync(path.join(os.tmpdir(), 'f1a-home-'));
      process.env.HOME = home;
      writeFileSync(path.join(home, 'escape.txt'), 'TOKEN');
    });
    afterEach(() => {
      process.env.HOME = realHome;
      rmSync(home, { recursive: true, force: true });
    });
    // A file outside, for read, write and edit, and a folder outside, for ls, grep and find, each with the path pi resolved.
    const ways = (root: string) => ({
      absolute: [path.join(root, 'secret.txt'), root, path.join(root, 'secret.txt'), root],
      home: ['~/escape.txt', '~', path.join(home, 'escape.txt'), home],
      escape: ['../secret.txt', '..', path.join(root, 'secret.txt'), root],
      deep: ['a/../../secret.txt', 'a/../..', path.join(root, 'secret.txt'), root],
      at: [`@${path.join(root, 'secret.txt')}`, `@${root}`, path.join(root, 'secret.txt'), root],
      url: [`file://${path.join(root, 'secret.txt')}`, `file://${root}`, path.join(root, 'secret.txt'), root],
    });
    const args = (tool: string, file: string, folder: string): Record<string, unknown> =>
      ({
        read: { path: file },
        write: { path: file, content: 'x' },
        edit: { path: file, edits: [{ oldText: 'TOKEN', newText: 'x' }] },
        ls: { path: folder },
        grep: { pattern: 'TOKEN', path: folder },
        find: { pattern: '*', path: folder },
      })[tool]!;

    for (const tool of FILE_TOOLS) {
      it(tool, async () => {
        const { root, call, settled, reports } = setup();
        expect(os.homedir()).toBe(home);
        const all = Object.entries(ways(root));
        for (const [way, [file, folder, resolvedFile, resolvedFolder]] of all) {
          const result = await call(tool, args(tool, file, folder));
          expect(result, way).toEqual({ isError: true, text: outside(['ls', 'grep', 'find'].includes(tool) ? resolvedFolder : resolvedFile) });
        }
        expect(readFileSync(path.join(root, 'secret.txt'), 'utf8')).toBe('TOKEN');
        expect(readdirSync(root).sort()).toEqual(['mods', 'secret.txt']);
        expect(readdirSync(home)).toEqual(['escape.txt']);
        expect(settled).not.toHaveBeenCalled();
        expect(reports).toEqual(all.map(() => [tool, false, null]));
      });
    }

    it('delete_path, naming the path as given', async () => {
      const { root, call } = setup();
      expect(await call('delete_path', { path: root })).toEqual({ isError: true, text: outside(root) });
      expect(await call('delete_path', { path: '..' })).toEqual({ isError: true, text: outside('..') });
    });
  });

  it('take a path as pi did: @, Unicode spaces and file:// inside the folder', async () => {
    const { call, file, dir } = setup();
    file('a_mod/my file.tsx', 'hello');
    expect(await call('read', { path: '@a_mod/my file.tsx' })).toEqual({ isError: false, text: 'hello' });
    expect(await call('read', { path: 'a_mod/my file.tsx' })).toEqual({ isError: false, text: 'hello' });
    expect(await call('read', { path: `file://${dir}/a_mod/my%20file.tsx` })).toEqual({ isError: false, text: 'hello' });
    expect(await call('read', { path: path.join(dir, 'a_mod/my file.tsx') })).toEqual({ isError: false, text: 'hello' });
  });

  it('read finds a screenshot named the way macOS names it', async () => {
    const { call, file } = setup();
    file('a_mod/Shot at 10.00 AM.txt', 'am');
    file('a_mod/it’s.txt', 'curly');
    expect(await call('read', { path: 'a_mod/Shot at 10.00 AM.txt' })).toEqual({ isError: false, text: 'am' });
    expect(await call('read', { path: "a_mod/it's.txt" })).toEqual({ isError: false, text: 'curly' });
  });

  it('find never lists past the folder, whatever the pattern', async () => {
    const { call, file } = setup();
    file('a_mod/main.tsx', '');
    for (const pattern of ['../*', '../**', '/**/secret.txt', '**/secret.txt', '**']) {
      expect((await call('find', { pattern })).text).not.toContain('secret');
    }
  });

  it('write and edit refuse the app\'s files and files not inside a mod', async () => {
    const { call, file, read, settled, dir, reports } = setup();
    const owned: [string, string][] = [
      ['tsconfig.json', 'Write inside a mod\'s folder, like "my_mod/main.tsx".'],
      ['top.tsx', 'Write inside a mod\'s folder, like "my_mod/main.tsx".'],
      ['.types/a.d.ts', '".types/a.d.ts" is the app\'s, and can\'t be written.'],
      ['a_mod/node_modules/x.js', '"a_mod/node_modules/x.js" is the app\'s, and can\'t be written.'],
      ['a_mod/.hidden', '"a_mod/.hidden" is the app\'s, and can\'t be written.'],
      ['a_mod/mod.log', 'The app writes mod.log itself.'],
      ['a_mod/mod.error', 'The app writes mod.error itself.'],
      ['Bad Name/main.tsx', '"Bad Name" can\'t be a mod\'s name: use lower-case letters, digits, _ and -, starting with a letter.'],
    ];
    for (const [rel] of owned) file(rel, 'old');
    for (const [rel, message] of owned) {
      const wrote = await call('write', { path: rel, content: 'new' });
      const edited = await call('edit', { path: rel, edits: [{ oldText: 'old', newText: 'new' }] });
      expect(wrote, rel).toEqual({ isError: true, text: message });
      expect(edited, rel).toEqual({ isError: true, text: message });
      expect(read(rel), rel).toBe('old');
    }
    // A bad mod name isn't made as a folder.
    expect((await call('write', { path: 'Other Bad/main.tsx', content: 'x' })).isError).toBe(true);
    expect(existsSync(path.join(dir, 'Other Bad'))).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    expect(reports.every(([, ok, note]) => !ok && note === null)).toBe(true);
  });

  describe('write', () => {
    it('says it wrote, as given, then whether the mod loaded, as two blocks', async () => {
      const { run, read, settled, reports } = setup();
      const result = await run('write', { path: 'lap_stepper/main.tsx', content: 'const a = 1;' });
      expect(result).toEqual({
        output: [
          { type: 'text', text: 'Successfully wrote to lap_stepper/main.tsx' },
          { type: 'text', text: 'lap_stepper loaded.' },
        ],
        isError: false,
      });
      expect(read('lap_stepper/main.tsx')).toBe('const a = 1;');
      expect(settled).toHaveBeenCalledWith('lap_stepper');
      expect(reports).toEqual([['write', true, 'wrote lap_stepper/main.tsx · loaded']]);
    });

    it('names the path as the model wrote it', async () => {
      const { call, read } = setup();
      expect((await call('write', { path: '@lap_stepper/main.tsx', content: 'x' })).text).toBe('Successfully wrote to @lap_stepper/main.tsx\nlap_stepper loaded.');
      expect(read('lap_stepper/main.tsx')).toBe('x');
    });

    it('makes the folders a file needs, and says when the folder is not a mod yet', async () => {
      const { call, read, reports } = setup();
      const result = await call('write', { path: 'lap_stepper/parts/util.ts', content: 'export const x = 1;' });
      expect(result.text).toBe("Successfully wrote to lap_stepper/parts/util.ts\nlap_stepper isn't a mod yet: it needs a main.tsx.");
      expect(read('lap_stepper/parts/util.ts')).toBe('export const x = 1;');
      expect(reports).toEqual([['write', true, 'wrote lap_stepper/parts/util.ts · not a mod yet']]);
    });

    it('adds what of that mod is not drawing, and tells the turn\'s check', async () => {
      const draft = place({ scope: 'preview:lap_stepper', where: 'strip', type: 'lap_stepper', state: 'needs_props', missing: ['driver'], message: 'Needs driver' });
      const other = place({ state: 'error', message: 'lap is undefined' });
      const { call, reports, told } = setup(undefined, { health: async () => [draft, other] });
      const result = await call('write', { path: 'lap_stepper/main.tsx', content: 'x' });
      expect(result.text).toBe('Successfully wrote to lap_stepper/main.tsx\nlap_stepper loaded. Draft lap_stepper in the strip: needs driver. Call suggest_tiles with it and its props, or ask the user whose.');
      expect(told).toEqual([[draft]]);
      expect(reports).toEqual([['write', true, 'wrote lap_stepper/main.tsx · loaded · not drawing']]);
    });

    it('that fails says what the file system said, and doesn\'t wait for a load', async () => {
      const { call, file, settled, reports, abs } = setup();
      // A folder where the file should go.
      file('other/main.tsx/keep', '');
      expect(await call('write', { path: 'other/main.tsx', content: 'x' })).toEqual({ isError: true, text: `EISDIR: illegal operation on a directory, open '${abs('other/main.tsx')}'` });
      expect(settled).not.toHaveBeenCalled();
      expect(reports).toEqual([['write', false, null]]);
    });
  });

  describe('edit', () => {
    it('with several changes saves once, says so as given, then whether it loaded', async () => {
      const failed = (name: string): ModStatus => ({ name, state: 'failed', version: 1, url: null, error: 'main.tsx:2 b is not defined' });
      const { run, file, read, settled, reports } = setup(failed);
      file('lap_stepper/main.tsx', 'const a = 1;\nconst b = 2;\n');
      const result = await run('edit', {
        path: 'lap_stepper/main.tsx',
        edits: [
          { oldText: 'b = 2', newText: 'b = 20' },
          { oldText: 'a = 1', newText: 'a = 10' },
        ],
      });
      expect(result).toEqual({
        output: [
          { type: 'text', text: 'Successfully replaced 2 block(s) in lap_stepper/main.tsx.' },
          { type: 'text', text: 'lap_stepper did not load:\nmain.tsx:2 b is not defined\nThe last version that loaded is still running.' },
        ],
        isError: false,
      });
      expect(read('lap_stepper/main.tsx')).toBe('const a = 10;\nconst b = 20;\n');
      expect(settled).toHaveBeenCalledTimes(1);
      expect(reports).toEqual([['edit', true, "edited lap_stepper/main.tsx · didn't load"]]);
    });

    const refusals: [string, string, { oldText: string; newText: string }[], string][] = [
      ['no match', 'const a = 1;', [{ oldText: 'nowhere', newText: 'x' }], 'Could not find the exact text in a_mod/main.tsx. The old text must match exactly including all whitespace and newlines.'],
      ['no match among several', 'const a = 1;', [{ oldText: 'a', newText: 'b' }, { oldText: 'nowhere', newText: 'x' }], 'Could not find edits[1] in a_mod/main.tsx. The oldText must match exactly including all whitespace and newlines.'],
      ['several matches', 'a a a', [{ oldText: 'a', newText: 'b' }], 'Found 3 occurrences of the text in a_mod/main.tsx. The text must be unique. Please provide more context to make it unique.'],
      ['several matches among several', 'x a a', [{ oldText: 'x', newText: 'y' }, { oldText: 'a', newText: 'b' }], 'Found 2 occurrences of edits[1] in a_mod/main.tsx. Each oldText must be unique. Please provide more context to make it unique.'],
      ['overlap', 'abcdef', [{ oldText: 'cde', newText: 'x' }, { oldText: 'abcd', newText: 'y' }], 'edits[1] and edits[0] overlap in a_mod/main.tsx. Merge them into one edit or target disjoint regions.'],
      ['empty oldText', 'abc', [{ oldText: '', newText: 'b' }], 'oldText must not be empty in a_mod/main.tsx.'],
      ['empty oldText among several', 'abc', [{ oldText: 'a', newText: 'b' }, { oldText: '', newText: 'x' }], 'edits[1].oldText must not be empty in a_mod/main.tsx.'],
      ['no change', 'abc', [{ oldText: 'b', newText: 'b' }], 'No changes made to a_mod/main.tsx. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.'],
      ['no change among several', 'abc', [{ oldText: 'a', newText: 'a' }, { oldText: 'c', newText: 'c' }], 'No changes made to a_mod/main.tsx. The replacements produced identical content.'],
      // Exactly once, but twice once quotes are made plain: still ambiguous, as in pi.
      ['an exact match that is fuzzily ambiguous', 'x = “a”;\ny = "a";', [{ oldText: '"a"', newText: '"b"' }], 'Found 2 occurrences of the text in a_mod/main.tsx. The text must be unique. Please provide more context to make it unique.'],
      ['an ambiguous fuzzy match', 'a “q” b\nc “q” d', [{ oldText: '"q"', newText: '"r"' }], 'Found 2 occurrences of the text in a_mod/main.tsx. The text must be unique. Please provide more context to make it unique.'],
      ['one good edit and one missing', 'a\r\nb\r\n', [{ oldText: 'a', newText: 'A' }, { oldText: 'zzz', newText: 'x' }], 'Could not find edits[1] in a_mod/main.tsx. The oldText must match exactly including all whitespace and newlines.'],
    ];
    for (const [name, before, edits, message] of refusals) {
      it(`makes no change on ${name}`, async () => {
        const { call, file, read, settled, reports } = setup();
        file('a_mod/main.tsx', before);
        expect(await call('edit', { path: 'a_mod/main.tsx', edits })).toEqual({ isError: true, text: message });
        expect(read('a_mod/main.tsx')).toBe(before);
        expect(settled).not.toHaveBeenCalled();
        expect(reports).toEqual([['edit', false, null]]);
      });
    }

    it('names the path as the model wrote it, in success and in errors', async () => {
      const { call, file } = setup();
      file('a_mod/main.tsx', 'abc');
      expect((await call('edit', { path: './a_mod/main.tsx', edits: [{ oldText: 'zzz', newText: 'x' }] })).text).toBe(
        'Could not find the exact text in ./a_mod/main.tsx. The old text must match exactly including all whitespace and newlines.',
      );
      expect((await call('edit', { path: './a_mod/main.tsx', edits: [{ oldText: 'b', newText: 'B' }] })).text).toBe('Successfully replaced 1 block(s) in ./a_mod/main.tsx.\na_mod loaded.');
    });

    it('says when there are no edits, before it looks at the path', async () => {
      const { call } = setup();
      expect(await call('edit', { path: '../secret.txt', edits: [] })).toEqual({ isError: true, text: 'Edit tool input is invalid. edits must contain at least one replacement.' });
    });

    it('says when the file is missing or a folder, as pi did', async () => {
      const { call, file } = setup();
      file('a_mod/sub/x.ts', '');
      expect(await call('edit', { path: 'a_mod/nope.tsx', edits: [{ oldText: 'a', newText: 'b' }] })).toEqual({ isError: true, text: 'Could not edit file: a_mod/nope.tsx. Error code: ENOENT.' });
      // Node's own words, which name the path from Node 22 on.
      expect((await call('edit', { path: 'a_mod/sub', edits: [{ oldText: 'a', newText: 'b' }] })).text).toMatch(/^EISDIR: illegal operation on a directory, read/);
    });

    it('keeps a file\'s CRLF line endings, and matches across them', async () => {
      const { call, file, read } = setup();
      file('a_mod/main.tsx', 'a\r\nb\r\nc\r\n');
      expect((await call('edit', { path: 'a_mod/main.tsx', edits: [{ oldText: 'b\nc', newText: 'B\nC\nD' }] })).isError).toBe(false);
      expect(read('a_mod/main.tsx')).toBe('a\r\nB\r\nC\r\nD\r\n');
      // oldText with CRLF matches too.
      expect((await call('edit', { path: 'a_mod/main.tsx', edits: [{ oldText: 'a\r\nB', newText: 'x\r\ny' }] })).isError).toBe(false);
      expect(read('a_mod/main.tsx')).toBe('x\r\ny\r\nC\r\nD\r\n');
    });

    it('keeps each line\'s own ending in a file that mixes them', async () => {
      const { call, file, read } = setup();
      file('a_mod/main.tsx', 'a\nb\r\nc\n');
      expect((await call('edit', { path: 'a_mod/main.tsx', edits: [{ oldText: 'c', newText: 'C' }] })).isError).toBe(false);
      expect(read('a_mod/main.tsx')).toBe('a\nb\r\nC\n');
      expect((await call('edit', { path: 'a_mod/main.tsx', edits: [{ oldText: 'b', newText: 'B1\nB2' }] })).isError).toBe(false);
      expect(read('a_mod/main.tsx')).toBe('a\nB1\r\nB2\r\nC\n');
    });

    it('keeps a BOM', async () => {
      const { call, file, read } = setup();
      file('a_mod/main.tsx', '﻿const a = 1;\n');
      expect((await call('edit', { path: 'a_mod/main.tsx', edits: [{ oldText: 'const a = 1;', newText: 'const a = 2;' }] })).isError).toBe(false);
      expect(read('a_mod/main.tsx')).toBe('﻿const a = 2;\n');
    });

    it('falls back to a fuzzy match, rewriting only the lines it touches', async () => {
      const { call, file, read } = setup();
      // Smart quotes, an en dash, a no-break space and trailing spaces in the file; plain text in the edit.
      file('a_mod/main.tsx', 'const s = “hi” – ok;  \nconst t = 1; \nkeep “this”  \n');
      const result = await call('edit', { path: 'a_mod/main.tsx', edits: [{ oldText: 'const s = "hi" - ok;\nconst t = 1; ', newText: 'const s = "bye";\nconst t = 2;' }] });
      expect(result.isError).toBe(false);
      expect(read('a_mod/main.tsx')).toBe('const s = "bye";\nconst t = 2;\nkeep “this”  \n');
    });

    it('with one fuzzy edit among several, keeps the untouched lines as they were', async () => {
      const { call, file, read } = setup();
      file('a_mod/main.tsx', 'a = 1;  \nb = “2”;\nc = 3;  \n');
      const edits = [
        { oldText: 'a = 1;', newText: 'a = 10;' },
        { oldText: 'b = "2";', newText: 'b = "20";' },
      ];
      expect((await call('edit', { path: 'a_mod/main.tsx', edits })).isError).toBe(false);
      expect(read('a_mod/main.tsx')).toBe('a = 10;\nb = "20";\nc = 3;  \n');
    });

    it('prefers an exact match, leaving the rest of the file alone', async () => {
      const { call, file, read } = setup();
      file('a_mod/main.tsx', 'name = "x";   \nother “y”  \n');
      expect((await call('edit', { path: 'a_mod/main.tsx', edits: [{ oldText: '"x"', newText: '"z"' }] })).isError).toBe(false);
      expect(read('a_mod/main.tsx')).toBe('name = "z";   \nother “y”  \n');
    });

    it('takes edits as a JSON string, or one edit at the top, as pi did', async () => {
      const { call, file, read } = setup();
      file('a_mod/main.tsx', 'a b');
      expect((await call('edit', { path: 'a_mod/main.tsx', edits: JSON.stringify([{ oldText: 'a', newText: 'x' }]) })).isError).toBe(false);
      expect((await call('edit', { path: 'a_mod/main.tsx', oldText: 'b', newText: 'y' })).isError).toBe(false);
      expect(read('a_mod/main.tsx')).toBe('x y');
    });
  });

  describe('read', () => {
    it('reads a file as it is, and passes on what the file system says when it can\'t', async () => {
      const { call, file, reports, abs } = setup();
      file('a_mod/main.tsx', 'one\ntwo\n');
      file('a_mod/empty.ts', '');
      expect(await call('read', { path: 'a_mod/main.tsx' })).toEqual({ isError: false, text: 'one\ntwo\n' });
      expect(await call('read', { path: 'a_mod/empty.ts' })).toEqual({ isError: false, text: '' });
      expect(await call('read', { path: 'a_mod/nope.tsx' })).toEqual({ isError: true, text: `ENOENT: no such file or directory, access '${abs('a_mod/nope.tsx')}'` });
      // Node's own words, which name the path from Node 22 on.
      expect((await call('read', { path: 'a_mod' })).text).toMatch(/^EISDIR: illegal operation on a directory, read/);
      expect(reports).toEqual([
        ['read', true, null],
        ['read', true, null],
        ['read', false, null],
        ['read', false, null],
      ]);
    });

    it('starts at a line, and stops at a limit, saying how to go on', async () => {
      const { call, file } = setup();
      file('a_mod/main.tsx', 'l1\nl2\nl3\nl4\nl5');
      expect((await call('read', { path: 'a_mod/main.tsx', offset: 4 })).text).toBe('l4\nl5');
      expect((await call('read', { path: 'a_mod/main.tsx', offset: 2, limit: 2 })).text).toBe('l2\nl3\n\n[2 more lines in file. Use offset=4 to continue.]');
      expect(await call('read', { path: 'a_mod/main.tsx', offset: 9 })).toEqual({ isError: true, text: 'Offset 9 is beyond end of file (5 lines total)' });
      // A final newline ends one more, empty, line, as pi counted.
      file('a_mod/nl.ts', 'a\nb\n');
      expect(await call('read', { path: 'a_mod/nl.ts', offset: 3 })).toEqual({ isError: false, text: '' });
      expect(await call('read', { path: 'a_mod/nl.ts', offset: 4 })).toEqual({ isError: true, text: 'Offset 4 is beyond end of file (3 lines total)' });
      expect((await call('read', { path: 'a_mod/nl.ts', limit: 1 })).text).toBe('a\n\n[2 more lines in file. Use offset=2 to continue.]');
    });

    it('cuts a long file at 2000 lines, and a big one at 50KB', async () => {
      const { call, file } = setup();
      file('a_mod/long.ts', Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n'));
      const long = (await call('read', { path: 'a_mod/long.ts' })).text.split('\n');
      expect(long).toHaveLength(2002);
      expect(long[1999]).toBe('line 2000');
      expect(long.at(-1)).toBe('[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]');
      expect((await call('read', { path: 'a_mod/long.ts', offset: 2001 })).text.split('\n')).toHaveLength(500);

      file('a_mod/big.ts', Array.from({ length: 1000 }, () => 'x'.repeat(99)).join('\n'));
      const big = (await call('read', { path: 'a_mod/big.ts' })).text;
      expect(Buffer.byteLength(big)).toBeLessThan(50 * 1024 + 200);
      expect(big).toMatch(/\n\n\[Showing lines 1-512 of 1000 \(50\.0KB limit\)\. Use offset=513 to continue\.\]$/);
    });

    it('says a line too big to show, in pi\'s words', async () => {
      const { call, file } = setup();
      file('a_mod/min.js', `${'x'.repeat(60 * 1024)}\nnext`);
      expect(await call('read', { path: 'a_mod/min.js' })).toEqual({ isError: false, text: "[Line 1 is 60.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' a_mod/min.js | head -c 51200]" });
    });

    it('reads an image or a binary file as text, its bytes decoded as UTF-8, as the wrapped pi read did', async () => {
      const { run, call, file, reports } = setup();
      // A PNG's signature and IHDR, 4x4.
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 4, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
      file('a_mod/pic.png', png);
      expect(await run('read', { path: 'a_mod/pic.png' })).toEqual({
        output: [{ type: 'text', text: '\uFFFDPNG\r\n\x1A\n\0\0\0\rIHDR\0\0\0\x04\0\0\0\x04\b\x06\0\0\0\0\0\0\0' }],
        isError: false,
      });
      file('a_mod/data.bin', 'a\0b');
      expect(await call('read', { path: 'a_mod/data.bin' })).toEqual({ isError: false, text: 'a\0b' });
      // Through the same line count and notices as any text: the PNG's signature holds two line feeds.
      expect(await call('read', { path: 'a_mod/pic.png', limit: 1 })).toEqual({ isError: false, text: '\uFFFDPNG\r\n\n[2 more lines in file. Use offset=2 to continue.]' });
      expect(reports).toEqual([
        ['read', true, null],
        ['read', true, null],
        ['read', true, null],
      ]);
    });
  });

  describe('ls', () => {
    it('lists a folder in name order, folders with a /', async () => {
      const { call, file, dir } = setup();
      file('b_mod/main.tsx', '');
      file('a_mod/Zed.ts', '');
      file('a_mod/main.tsx', '');
      file('a_mod/sub/x.ts', '');
      file('.types/f1a.d.ts', '');
      mkdirSync(path.join(dir, 'empty'));
      expect((await call('ls', {})).text).toBe('.types/\na_mod/\nb_mod/\nempty/');
      expect((await call('ls', { path: 'a_mod' })).text).toBe('main.tsx\nsub/\nZed.ts');
      expect((await call('ls', { path: 'empty' })).text).toBe('(empty directory)');
    });

    it('says what isn\'t there or isn\'t a folder, by its absolute path', async () => {
      const { call, file, abs } = setup();
      file('a_mod/main.tsx', '');
      expect(await call('ls', { path: 'nope' })).toEqual({ isError: true, text: `Path not found: ${abs('nope')}` });
      expect(await call('ls', { path: 'a_mod/main.tsx' })).toEqual({ isError: true, text: `Not a directory: ${abs('a_mod/main.tsx')}` });
    });

    it('leaves out a link it can\'t follow', async () => {
      const { call, file, dir } = setup();
      file('a_mod/main.tsx', '');
      symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'a_mod/broken'));
      expect((await call('ls', { path: 'a_mod' })).text).toBe('main.tsx');
    });

    it('stops at a limit, and says so', async () => {
      const { call, file } = setup();
      for (const name of ['a', 'b', 'c']) file(`m/${name}.ts`, '');
      expect((await call('ls', { path: 'm', limit: 2 })).text).toBe('a.ts\nb.ts\n\n[2 entries limit reached. Use limit=4 for more]');
      expect((await call('ls', { path: 'm', limit: 3 })).text).toBe('a.ts\nb.ts\nc.ts');
    });
  });

  describe('find', () => {
    it('matches names at any depth without a /, and paths with one', async () => {
      const { call, file } = setup();
      file('a_mod/main.tsx', '');
      file('a_mod/parts/x.tsx', '');
      file('b_mod/main.tsx', '');
      expect((await call('find', { pattern: '*.tsx' })).text).toBe('a_mod/main.tsx\na_mod/parts/x.tsx\nb_mod/main.tsx');
      expect((await call('find', { pattern: 'a_mod/**/*.tsx' })).text).toBe('a_mod/main.tsx\na_mod/parts/x.tsx');
      expect((await call('find', { pattern: 'parts' })).text).toBe('a_mod/parts/');
      expect((await call('find', { pattern: '*.tsx', path: 'a_mod/parts' })).text).toBe('x.tsx');
      expect((await call('find', { pattern: '*.css' })).text).toBe('No files found matching pattern');
    });

    it('says what isn\'t there by its absolute path, and passes on a file system error', async () => {
      const { call, file, abs } = setup();
      file('a_mod/main.tsx', '');
      expect(await call('find', { pattern: '*', path: 'nope' })).toEqual({ isError: true, text: `Path not found: ${abs('nope')}` });
      expect(await call('find', { pattern: '*', path: 'a_mod/main.tsx' })).toEqual({ isError: true, text: `ENOTDIR: not a directory, scandir '${abs('a_mod/main.tsx')}'` });
    });

    it('stops at a limit, and says so', async () => {
      const { call, file } = setup();
      for (const name of ['a', 'b', 'c']) file(`m/${name}.ts`, '');
      expect((await call('find', { pattern: '*.ts', limit: 2 })).text).toBe('m/a.ts\nm/b.ts\n\n[2 results limit reached]');
      expect((await call('find', { pattern: '*.ts', limit: 3 })).text).toBe('m/a.ts\nm/b.ts\nm/c.ts');
    });
  });

  it('read, ls, grep and find see the types under .types, and skip node_modules', async () => {
    const { call, file } = setup();
    file('.types/f1a.d.ts', 'export type Lap = number;');
    file('lap_form/main.tsx', 'const lap: Lap = 1;');
    file('lap_form/node_modules/dep/index.ts', 'Lap');
    file('.git/HEAD', 'Lap');
    expect((await call('read', { path: '.types/f1a.d.ts' })).text).toContain('export type Lap');
    expect((await call('ls', {})).text).toContain('.types/');
    const grep = await call('grep', { pattern: 'Lap' });
    expect(grep.text).toBe('.types/f1a.d.ts:1: export type Lap = number;\nlap_form/main.tsx:1: const lap: Lap = 1;');
    expect((await call('grep', { pattern: 'Lap', path: '.types' })).text).toContain('f1a.d.ts:1:');
    expect((await call('find', { pattern: '*.ts' })).text).toBe('.types/f1a.d.ts');
    expect((await call('find', { pattern: 'lap_form/*.tsx' })).text).toBe('lap_form/main.tsx');
    expect((await call('find', { pattern: '*.d.ts', path: '.types' })).text).toBe('f1a.d.ts');
  });

  describe('grep', () => {
    const lines = (text: string) => text.split('\n');

    it('takes plain text with literal, and ignores case when asked', async () => {
      const { call, file } = setup();
      file('a/main.tsx', 'a.b\naxb\nA.B');
      expect((await call('grep', { pattern: 'a.b' })).text).toBe('a/main.tsx:1: a.b\na/main.tsx:2: axb');
      expect((await call('grep', { pattern: 'a.b', literal: true })).text).toBe('a/main.tsx:1: a.b');
      expect((await call('grep', { pattern: 'a.b', literal: true, ignoreCase: true })).text).toBe('a/main.tsx:1: a.b\na/main.tsx:3: A.B');
      expect((await call('grep', { pattern: '^a\\wb$' })).text).toBe('a/main.tsx:2: axb');
    });

    it('filters files by glob, a name pattern at any depth', async () => {
      const { call, file } = setup();
      file('a/main.tsx', 'Lap');
      file('a/util.ts', 'Lap');
      file('.types/f1a.d.ts', 'Lap');
      expect((await call('grep', { pattern: 'Lap', glob: '*.tsx' })).text).toBe('a/main.tsx:1: Lap');
      expect((await call('grep', { pattern: 'Lap', glob: './.types/*.ts' })).text).toBe('.types/f1a.d.ts:1: Lap');
      expect(lines((await call('grep', { pattern: 'Lap', glob: '!*.d.ts' })).text)).toEqual(['a/main.tsx:1: Lap', 'a/util.ts:1: Lap']);
    });

    it('shows lines around a match the way pi does', async () => {
      const { call, file } = setup();
      file('a/main.tsx', 'one\ntwo\nLap\nfour\nfive\nLap\r\n');
      expect(lines((await call('grep', { pattern: 'Lap', context: 1 })).text)).toEqual([
        'a/main.tsx-2- two',
        'a/main.tsx:3: Lap',
        'a/main.tsx-4- four',
        'a/main.tsx-5- five',
        'a/main.tsx:6: Lap',
      ]);
    });

    it('searches one file, shown by its name, and names a missing one by its absolute path', async () => {
      const { call, file, abs } = setup();
      file('a/main.tsx', 'x\nLap');
      file('a/other.tsx', 'Lap');
      expect((await call('grep', { pattern: 'Lap', path: 'a/main.tsx' })).text).toBe('main.tsx:2: Lap');
      expect(await call('grep', { pattern: 'Lap', path: 'a/nope.tsx' })).toEqual({ isError: true, text: `Path not found: ${abs('a/nope.tsx')}` });
    });

    it('stops at the limit, and says when it cut results off', async () => {
      const { call, file } = setup();
      file('a/main.tsx', 'Lap 1\nLap 2\nLap 3');
      file('b/main.tsx', 'Lap 4');
      expect((await call('grep', { pattern: 'Lap', limit: 2 })).text).toBe('a/main.tsx:1: Lap 1\na/main.tsx:2: Lap 2\n\n[2 matches limit reached. Use limit=4 for more, or refine pattern]');
      expect((await call('grep', { pattern: 'Lap', limit: 3 })).text).toBe('a/main.tsx:1: Lap 1\na/main.tsx:2: Lap 2\na/main.tsx:3: Lap 3\n\n[3 matches limit reached. Use limit=6 for more, or refine pattern]');
      expect((await call('grep', { pattern: 'Lap', limit: 4 })).text).toBe('a/main.tsx:1: Lap 1\na/main.tsx:2: Lap 2\na/main.tsx:3: Lap 3\nb/main.tsx:1: Lap 4');
      expect((await call('grep', { pattern: 'nowhere' })).text).toBe('No matches found');
    });

    it('cuts long lines', async () => {
      const { call, file } = setup();
      file('a/main.tsx', `Lap${'x'.repeat(600)}`);
      expect((await call('grep', { pattern: 'Lap' })).text).toBe(`a/main.tsx:1: Lap${'x'.repeat(497)}... [truncated]\n\n[Some lines truncated to 500 chars. Use read tool to see full lines]`);
    });

    it('cuts its output at 50KB', async () => {
      const { call, file } = setup();
      file('a/main.tsx', Array.from({ length: 200 }, () => `Lap${'x'.repeat(400)}`).join('\n'));
      const { text } = await call('grep', { pattern: 'Lap', limit: 1000 });
      expect(Buffer.byteLength(text)).toBeLessThan(50 * 1024 + 100);
      expect(text).toMatch(/\n\n\[50\.0KB limit reached\]$/);
    });

    it('says plainly when the pattern isn\'t a regular expression', async () => {
      const { call, file, reports } = setup();
      file('a/main.tsx', 'Lap(');
      const result = await call('grep', { pattern: 'Lap(' });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^"Lap\(" isn't a valid JavaScript regular expression: .+\. Set literal to true to search for the text as written\.$/);
      expect((await call('grep', { pattern: 'Lap(', literal: true })).text).toBe('a/main.tsx:1: Lap(');
      expect(reports).toEqual([
        ['grep', false, null],
        ['grep', true, null],
      ]);
    });

    it('skips binary and very large files', async () => {
      const { call, file } = setup();
      file('a/main.tsx', 'Lap');
      file('a/picture.png', 'Lap\0\x01');
      file('a/huge.json', `Lap\n${'x'.repeat(1024 * 1024)}`);
      expect((await call('grep', { pattern: 'Lap' })).text).toBe('a/main.tsx:1: Lap');
    });

    it('needs no ripgrep', async () => {
      const { call, file } = setup();
      file('.types/f1a.d.ts', 'export type Lap = number;');
      const saved = process.env.PATH;
      process.env.PATH = '';
      try {
        expect((await call('grep', { pattern: 'Lap' })).text).toBe('.types/f1a.d.ts:1: export type Lap = number;');
      } finally {
        process.env.PATH = saved;
      }
    });

    it('stops between files once the call is aborted', async () => {
      const { call, file, reports } = setup();
      file('a/main.tsx', 'Lap');
      const abort = new AbortController();
      abort.abort();
      expect(await call('grep', { pattern: 'Lap' }, withAbortSignal(abort.signal, BACKGROUND_CONTEXT))).toEqual({ isError: true, text: 'Operation aborted' });
      expect(reports).toEqual([['grep', false, null]]);
    });
  });

  describe('delete_path', () => {
    it('removes a whole mod', async () => {
      const { call, file, dir, settled, reports } = setup();
      file('lap_stepper/main.tsx', '');
      expect(await call('delete_path', { path: 'lap_stepper' })).toEqual({ isError: false, text: 'Removed the mod lap_stepper.' });
      expect(existsSync(path.join(dir, 'lap_stepper'))).toBe(false);
      expect(settled).toHaveBeenCalledWith('lap_stepper');
      expect(reports).toEqual([['delete_path', true, 'removed lap_stepper']]);
    });

    it('deletes a file in a mod, and says whether the mod still loads', async () => {
      const { call, file, dir, reports } = setup();
      file('lap_stepper/main.tsx', '');
      file('lap_stepper/util.ts', '');
      expect(await call('delete_path', { path: 'lap_stepper/util.ts' })).toEqual({ isError: false, text: 'Deleted lap_stepper/util.ts. lap_stepper loaded.' });
      expect(existsSync(path.join(dir, 'lap_stepper/util.ts'))).toBe(false);
      expect(reports).toEqual([['delete_path', true, 'deleted lap_stepper/util.ts · loaded']]);
    });

    it('refuses the folder itself, the app\'s files, and mods that aren\'t there', async () => {
      const { call, file, dir, reports } = setup();
      file('.types/f1a.d.ts', '');
      expect(await call('delete_path', { path: '.' })).toEqual({ isError: true, text: '"." can\'t be deleted.' });
      expect(await call('delete_path', { path: '.types' })).toEqual({ isError: true, text: '".types" can\'t be deleted.' });
      expect(await call('delete_path', { path: 'nope' })).toEqual({ isError: true, text: 'There is no mod "nope".' });
      expect(existsSync(path.join(dir, '.types/f1a.d.ts'))).toBe(true);
      expect(reports.every(([, ok, note]) => !ok && note === null)).toBe(true);
    });
  });

  it('mod_status says whether the mod loaded, where it shows, and its log', async () => {
    const tile = place({ type: 'lap_stepper', label: 'Laps' });
    const { call, reports } = setup(ready, {
      health: async () => [tile],
      logs: () => Array.from({ length: 45 }, (_, i) => ({ level: 'log', text: `line ${i}` }) as never),
    });
    const { text, isError } = await call('mod_status', { mod: 'lap_stepper' });
    expect(isError).toBe(false);
    expect(text).toMatch(/^lap_stepper loaded\.\n\nOn screen:\nTile tile-1 "Laps" \(lap_stepper\): drawn\.\n\nLog:\nlog line 5\n/);
    expect(text).not.toContain('line 4\n');
    expect(text).toMatch(/log line 44$/);
    expect(reports).toEqual([['mod_status', true, null]]);
  });

  it('mod_status says when a mod shows nowhere and printed nothing', async () => {
    const { call } = setup(() => null);
    expect((await call('mod_status', { mod: 'x' })).text).toBe("x isn't a mod yet: it needs a main.tsx.\n\nOn screen:\n(nowhere)\n\nLog:\n(nothing)");
  });

  describe('look_at', () => {
    it('returns a picture of the component as a PNG image', async () => {
      const { run, settled, reports } = setup(ready, { picture: async () => Buffer.from('PNGDATA') });
      const result = await run('look_at', { mod: 'lap_stepper' });
      expect(result).toEqual({ output: [{ type: 'image', data: Buffer.from('PNGDATA').toString('base64'), mimeType: 'image/png' }], isError: false });
      expect(settled).toHaveBeenCalledWith('lap_stepper');
      expect(reports).toEqual([['look_at', true, 'looked at lap_stepper']]);
    });

    it('says when the component isn\'t showing', async () => {
      const { call, reports } = setup();
      expect(await call('look_at', { mod: 'lap_stepper' })).toEqual({ isError: true, text: "lap_stepper isn't showing: it's on neither the grid nor the strip." });
      expect(reports).toEqual([['look_at', false, null]]);
    });
  });

  it('a host that throws is an error the model sees', async () => {
    const reports: [string, boolean, string | null][] = [];
    const extension = modFilesExtension(
      durable,
      () => {
        throw new Error('The mods folder is not available.');
      },
      (name, ok, note) => reports.push([name, ok, note]),
    );
    const read = extension.tools!.find((t) => t.name === 'read')!;
    expect(await read.execute({ path: 'a' }, {} as ToolExecutionApi, BACKGROUND_CONTEXT)).toEqual({ output: [{ type: 'text', text: 'The mods folder is not available.' }], isError: true });
    expect(reports).toEqual([['read', false, null]]);
  });
});
