import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ModStatus } from '../../../shared/mods';
import { MOD_FILE_TOOLS, modFilesExtension } from './modFiles';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The extension over a fresh mods folder, with a secret beside it that nothing may read. */
async function setup(status: (name: string, dir: string) => ModStatus | null = (name, dir) => (existsSync(path.join(dir, name, 'main.tsx')) ? { name, state: 'ready', version: 1, url: null, error: null } : null)) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'f1a-modfiles-'));
  roots.push(root);
  const dir = path.join(root, 'mods');
  mkdirSync(dir);
  writeFileSync(path.join(root, 'secret.txt'), 'TOKEN');
  const settled = vi.fn(async (name: string) => status(name, dir));
  const reports: [string, boolean, string | null][] = [];
  const tools = new Map<string, ToolDefinition>();
  await modFilesExtension(
    () => ({ dir, settled, logs: () => [], picture: async () => null }),
    (name, ok, note) => reports.push([name, ok, note]),
  )({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as never);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tools.get(name)!.execute('call', args as never, undefined, undefined, undefined as never);
    return { isError: !!result.isError, text: result.content.map((c) => ('text' in c ? c.text : '')).join('\n') };
  };
  const file = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  };
  const read = (rel: string) => readFileSync(path.join(dir, rel), 'utf8');
  return { root, dir, tools, call, settled, reports, file, read };
}

describe('the build agent\'s file tools', () => {
  it('are pi\'s six and our three, worded for the mods folder', async () => {
    const { tools } = await setup();
    expect([...tools.keys()]).toEqual(MOD_FILE_TOOLS);
    expect(MOD_FILE_TOOLS).not.toContain('bash');
    for (const name of ['read', 'write', 'edit', 'ls', 'grep', 'find']) {
      const tool = tools.get(name)!;
      const params = tool.parameters as unknown as { properties: { path: { description: string } } };
      expect(params.properties.path.description).toContain('mods folder');
      expect(params.properties.path.description).not.toMatch(/absolute|current directory/);
      expect(tool.promptSnippet).toBeUndefined();
      expect(tool.promptGuidelines).toBeUndefined();
    }
    expect(tools.get('write')!.description).toContain('says whether it did');
    expect(tools.get('edit')!.description).toContain('says whether it did');
    expect(tools.get('grep')!.description).not.toContain('gitignore');
    // pi's edit still takes several edits in one call.
    expect(Object.keys((tools.get('edit')!.parameters as unknown as { properties: object }).properties)).toEqual(['path', 'edits']);
  });

  describe('each refuses paths outside the mods folder', () => {
    // ~ expands to a home of the test's own, so a broken check can't touch the real one.
    const tag = 'escape.txt';
    const realHome = process.env.HOME;
    let home = '';
    beforeEach(() => {
      home = mkdtempSync(path.join(os.tmpdir(), 'f1a-home-'));
      process.env.HOME = home;
      writeFileSync(path.join(home, tag), 'TOKEN');
    });
    afterEach(() => {
      process.env.HOME = realHome;
      rmSync(home, { recursive: true, force: true });
    });
    // A file outside, for read, write and edit, and a folder outside, for ls, grep and find.
    const ways = (root: string) => ({
      absolute: [path.join(root, 'secret.txt'), root],
      home: [`~/${tag}`, '~'],
      escape: ['../secret.txt', '..'],
      at: [`@${path.join(root, 'secret.txt')}`, `@${root}`],
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

    for (const tool of ['read', 'write', 'edit', 'ls', 'grep', 'find']) {
      it(tool, async () => {
        const { root, call, settled, reports } = await setup();
        expect(os.homedir()).toBe(home);
        for (const [way, [file, folder]] of Object.entries(ways(root))) {
          const result = await call(tool, args(tool, file, folder));
          expect(result.isError, way).toBe(true);
          expect(result.text, way).toMatch(/outside the mods folder/);
          expect(result.text, way).not.toContain('TOKEN');
          // pi expanded ~ to the test's home, and the check saw that path.
          if (way === 'home') expect(result.text).toContain(home);
        }
        expect(readFileSync(path.join(root, 'secret.txt'), 'utf8')).toBe('TOKEN');
        expect(readFileSync(path.join(home, tag), 'utf8')).toBe('TOKEN');
        expect(readdirSync(home)).toEqual([tag]);
        expect(settled).not.toHaveBeenCalled();
        expect(reports.every(([name, ok, note]) => name === tool && !ok && note === null)).toBe(true);
        expect(reports).toHaveLength(4);
      });
    }
  });

  it('find never lists past the folder, whatever the pattern', async () => {
    const { call, file } = await setup();
    file('a_mod/main.tsx', '');
    for (const pattern of ['../*', '../**', '/**/secret.txt', '**/secret.txt']) {
      expect((await call('find', { pattern })).text).not.toContain('secret');
    }
  });

  it('write and edit refuse the app\'s files and files not inside a mod', async () => {
    const { call, file, read, settled, dir } = await setup();
    const owned = ['tsconfig.json', '.types/a.d.ts', 'a_mod/mod.log', 'a_mod/mod.error', 'a_mod/node_modules/x.js', 'a_mod/.hidden', 'Bad Name/main.tsx', 'top.tsx'];
    for (const rel of owned) file(rel, 'old');
    for (const rel of owned) {
      const wrote = await call('write', { path: rel, content: 'new' });
      const edited = await call('edit', { path: rel, edits: [{ oldText: 'old', newText: 'new' }] });
      for (const result of [wrote, edited]) {
        expect(result.isError, rel).toBe(true);
        expect(result.text, rel).toMatch(/is the app's|writes mod\.\w+ itself|can't be a mod's name|inside a mod's folder/);
      }
      expect(read(rel), rel).toBe('old');
    }
    // A bad mod name isn't made as a folder.
    expect(existsSync(path.join(dir, 'Bad_Name'))).toBe(false);
    expect((await call('write', { path: 'Other Bad/main.tsx', content: 'x' })).isError).toBe(true);
    expect(existsSync(path.join(dir, 'Other Bad'))).toBe(false);
    expect(settled).not.toHaveBeenCalled();
  });

  it('a write waits for the mod to load, and says so', async () => {
    const { call, read, settled, reports } = await setup();
    const result = await call('write', { path: 'lap_stepper/main.tsx', content: 'const a = 1;' });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('lap_stepper/main.tsx');
    expect(result.text).toMatch(/lap_stepper loaded\.$/);
    expect(read('lap_stepper/main.tsx')).toBe('const a = 1;');
    expect(settled).toHaveBeenCalledWith('lap_stepper');
    expect(reports).toEqual([['write', true, 'wrote lap_stepper/main.tsx · loaded']]);
  });

  it('an edit with several changes saves once, and says whether it loaded', async () => {
    const failed = (name: string): ModStatus => ({ name, state: 'failed', version: 1, url: null, error: 'main.tsx:2 b is not defined' });
    const { call, file, read, settled, reports } = await setup(failed);
    file('lap_stepper/main.tsx', 'const a = 1;\nconst b = 2;\n');
    const result = await call('edit', {
      path: 'lap_stepper/main.tsx',
      edits: [
        { oldText: 'a = 1', newText: 'a = 10' },
        { oldText: 'b = 2', newText: 'b = 20' },
      ],
    });
    expect(result.isError).toBe(false);
    expect(read('lap_stepper/main.tsx')).toBe('const a = 10;\nconst b = 20;\n');
    expect(result.text).toContain('lap_stepper did not load:\nmain.tsx:2 b is not defined\nThe last version that loaded is still running.');
    expect(settled).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([['edit', true, "edited lap_stepper/main.tsx · didn't load"]]);
  });

  it('a pi call that fails doesn\'t wait for a load', async () => {
    const { call, file, read, settled, reports } = await setup();
    file('lap_stepper/main.tsx', 'const a = 1;');
    const missing = await call('edit', { path: 'lap_stepper/main.tsx', edits: [{ oldText: 'nowhere', newText: 'x' }] });
    expect(missing.isError).toBe(true);
    expect(read('lap_stepper/main.tsx')).toBe('const a = 1;');
    // A folder where the file should go.
    file('other/main.tsx/keep', '');
    const blocked = await call('write', { path: 'other/main.tsx', content: 'x' });
    expect(blocked.isError).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    expect(reports).toEqual([
      ['edit', false, null],
      ['write', false, null],
    ]);
  });

  it('read, ls, grep and find see the types under .types, and skip node_modules', async () => {
    const { call, file } = await setup();
    file('.types/f1a.d.ts', 'export type Lap = number;');
    file('lap_form/main.tsx', 'const lap: Lap = 1;');
    file('lap_form/node_modules/dep/index.ts', 'Lap');
    expect((await call('read', { path: '.types/f1a.d.ts' })).text).toContain('export type Lap');
    expect((await call('ls', {})).text).toContain('.types/');
    const grep = await call('grep', { pattern: 'Lap' });
    expect(grep.text).toContain('.types/f1a.d.ts:1:');
    expect(grep.text).toContain('lap_form/main.tsx:1:');
    expect((await call('grep', { pattern: 'Lap', path: '.types' })).text).toContain('f1a.d.ts:1:');
    const found = (await call('find', { pattern: '*.ts' })).text.split('\n');
    expect(found).toEqual(['.types/f1a.d.ts']);
    expect((await call('find', { pattern: 'lap_form/*.tsx' })).text).toBe('lap_form/main.tsx');
    expect((await call('find', { pattern: '*.d.ts', path: '.types' })).text).toBe('f1a.d.ts');
  });

  describe('grep', () => {
    const lines = (text: string) => text.split('\n');

    it('skips node_modules', async () => {
      const { call, file } = await setup();
      file('lap_form/main.tsx', 'Lap');
      file('lap_form/node_modules/dep/index.ts', 'Lap');
      expect((await call('grep', { pattern: 'Lap' })).text).toBe('lap_form/main.tsx:1: Lap');
    });

    it('takes plain text with literal, and ignores case when asked', async () => {
      const { call, file } = await setup();
      file('a/main.tsx', 'a.b\naxb\nA.B');
      expect((await call('grep', { pattern: 'a.b' })).text).toBe('a/main.tsx:1: a.b\na/main.tsx:2: axb');
      expect((await call('grep', { pattern: 'a.b', literal: true })).text).toBe('a/main.tsx:1: a.b');
      expect((await call('grep', { pattern: 'a.b', literal: true, ignoreCase: true })).text).toBe('a/main.tsx:1: a.b\na/main.tsx:3: A.B');
    });

    it('filters files by glob, a name pattern at any depth', async () => {
      const { call, file } = await setup();
      file('a/main.tsx', 'Lap');
      file('a/util.ts', 'Lap');
      file('.types/f1a.d.ts', 'Lap');
      expect((await call('grep', { pattern: 'Lap', glob: '*.tsx' })).text).toBe('a/main.tsx:1: Lap');
      expect((await call('grep', { pattern: 'Lap', glob: './.types/*.ts' })).text).toBe('.types/f1a.d.ts:1: Lap');
      expect(lines((await call('grep', { pattern: 'Lap', glob: '!*.d.ts' })).text)).toEqual(['a/main.tsx:1: Lap', 'a/util.ts:1: Lap']);
    });

    it('shows lines around a match the way pi does', async () => {
      const { call, file } = await setup();
      file('a/main.tsx', 'one\ntwo\nLap\nfour\nfive\nLap\r\n');
      expect(lines((await call('grep', { pattern: 'Lap', context: 1 })).text)).toEqual([
        'a/main.tsx-2- two',
        'a/main.tsx:3: Lap',
        'a/main.tsx-4- four',
        'a/main.tsx-5- five',
        'a/main.tsx:6: Lap',
      ]);
    });

    it('searches one file, shown by its name', async () => {
      const { call, file } = await setup();
      file('a/main.tsx', 'x\nLap');
      file('a/other.tsx', 'Lap');
      expect((await call('grep', { pattern: 'Lap', path: 'a/main.tsx' })).text).toBe('main.tsx:2: Lap');
    });

    it('stops at the limit, and says when it cut results off', async () => {
      const { call, file } = await setup();
      file('a/main.tsx', 'Lap 1\nLap 2\nLap 3');
      file('b/main.tsx', 'Lap 4');
      expect((await call('grep', { pattern: 'Lap', limit: 2 })).text).toBe('a/main.tsx:1: Lap 1\na/main.tsx:2: Lap 2\n\n[2 matches limit reached. Use limit=4 for more, or refine pattern]');
      expect((await call('grep', { pattern: 'Lap', limit: 3 })).text).toMatch(/Lap 3\n\n\[3 matches limit reached/);
      expect((await call('grep', { pattern: 'Lap', limit: 4 })).text).toBe('a/main.tsx:1: Lap 1\na/main.tsx:2: Lap 2\na/main.tsx:3: Lap 3\nb/main.tsx:1: Lap 4');
      expect((await call('grep', { pattern: 'nowhere' })).text).toBe('No matches found');
    });

    it('cuts long lines', async () => {
      const { call, file } = await setup();
      file('a/main.tsx', `Lap${'x'.repeat(600)}`);
      const { text } = await call('grep', { pattern: 'Lap' });
      expect(text).toContain('... [truncated]');
      expect(text).toContain('[Some lines truncated to 500 chars. Use read tool to see full lines]');
    });

    it('says plainly when the pattern isn\'t a regular expression', async () => {
      const { call, file, reports } = await setup();
      file('a/main.tsx', 'Lap(');
      const result = await call('grep', { pattern: 'Lap(' });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^"Lap\(" isn't a valid JavaScript regular expression: .+\. Set literal to true/);
      expect((await call('grep', { pattern: 'Lap(', literal: true })).text).toBe('a/main.tsx:1: Lap(');
      expect(reports[0]).toEqual(['grep', false, null]);
    });

    it('skips binary and very large files', async () => {
      const { call, file } = await setup();
      file('a/main.tsx', 'Lap');
      file('a/picture.png', 'Lap\0\x01');
      file('a/huge.json', `Lap\n${'x'.repeat(1024 * 1024)}`);
      expect((await call('grep', { pattern: 'Lap' })).text).toBe('a/main.tsx:1: Lap');
    });

    it('needs no ripgrep', async () => {
      const { call, file } = await setup();
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
      const { tools, file } = await setup();
      file('a/main.tsx', 'Lap');
      const abort = new AbortController();
      abort.abort();
      const result = await tools.get('grep')!.execute('call', { pattern: 'Lap' } as never, abort.signal, undefined, undefined as never);
      expect(result).toMatchObject({ isError: true, content: [{ text: 'Operation aborted' }] });
    });
  });

  describe('when pi answers with an error instead of throwing', () => {
    // pi's write and edit throw today. These stand-ins return an error result, to check nothing leans on that.
    afterEach(() => {
      vi.doUnmock('@earendil-works/pi-coding-agent');
    });
    const failing = { content: [{ type: 'text' as const, text: 'pi said no' }], details: undefined, isError: true };
    type Ops = { access?: (p: string) => Promise<void>; readFile?: (p: string) => Promise<Buffer>; writeFile: (p: string, c: string) => Promise<void> };
    const mockPi = (name: 'createEditToolDefinition' | 'createWriteToolDefinition', run: (ops: Ops, file: string) => Promise<void>) =>
      vi.doMock('@earendil-works/pi-coding-agent', async (importOriginal) => {
        const pi = await importOriginal<Record<string, (cwd: string, options: { operations: Ops }) => ToolDefinition>>();
        return {
          ...pi,
          [name]: (cwd: string, options: { operations: Ops }) => ({
            ...pi[name](cwd, options),
            execute: async (_id: string, args: { path: string }) => {
              await run(options.operations, path.join(cwd, args.path));
              return failing;
            },
          }),
        };
      });

    it('an edit that only read the file waits for nothing', async () => {
      mockPi('createEditToolDefinition', async (ops, file) => {
        await ops.access!(file);
        await ops.readFile!(file);
      });
      const { call, file, settled, reports } = await setup();
      file('lap_stepper/main.tsx', 'const a = 1;');
      const result = await call('edit', { path: 'lap_stepper/main.tsx', edits: [{ oldText: 'a', newText: 'b' }] });
      expect(result).toEqual({ isError: true, text: 'pi said no' });
      expect(settled).not.toHaveBeenCalled();
      expect(reports).toEqual([['edit', false, null]]);
    });

    it('a write pi calls failed waits for nothing, even after writing', async () => {
      mockPi('createWriteToolDefinition', (ops, file) => ops.writeFile(file, 'x'));
      const { call, read, settled, reports } = await setup();
      const result = await call('write', { path: 'lap_stepper/main.tsx', content: 'x' });
      expect(result).toEqual({ isError: true, text: 'pi said no' });
      expect(read('lap_stepper/main.tsx')).toBe('x');
      expect(settled).not.toHaveBeenCalled();
      expect(reports).toEqual([['write', false, null]]);
    });
  });
});
