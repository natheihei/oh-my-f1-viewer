import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    const tag = `f1a-escape-${process.pid}`;
    afterEach(() => rmSync(path.join(os.homedir(), tag), { force: true }));
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
        writeFileSync(path.join(os.homedir(), tag), 'TOKEN');
        for (const [way, [file, folder]] of Object.entries(ways(root))) {
          const result = await call(tool, args(tool, file, folder));
          expect(result.isError, way).toBe(true);
          expect(result.text, way).toMatch(/outside the mods folder/);
          expect(result.text, way).not.toContain('TOKEN');
        }
        expect(readFileSync(path.join(root, 'secret.txt'), 'utf8')).toBe('TOKEN');
        expect(readFileSync(path.join(os.homedir(), tag), 'utf8')).toBe('TOKEN');
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
});
