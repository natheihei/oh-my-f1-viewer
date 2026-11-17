/** Installed components: their sources copied into the mods folder to read, and forked into mods to change. See docs/MODS.md. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModStatus } from '../../shared/mods';
import { Mods, relabel, renameIn, retitle, specLabel } from './index';

let mods: Mods | null = null;
const roots: string[] = [];

afterEach(async () => {
  await mods?.stop();
  mods = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function until<T>(get: () => T | null | undefined | false, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function writeAll(dir: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
}

/** A mods folder whose installed components are `installed`, or the app's own when that's a path. */
async function start(installed: Record<string, string> | string, files: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omfv-installed-'));
  roots.push(root);
  const dir = path.join(root, 'mods');
  let from = installed as string;
  if (typeof installed !== 'string') {
    from = path.join(root, 'components');
    writeAll(from, installed);
  }
  writeAll(dir, files);
  let latest: ModStatus[] = [];
  mods = new Mods(dir, (list) => (latest = list), { declarations: path.join(root, 'none'), installed: from });
  await mods.start();
  return { mods, dir, last: () => latest };
}

const TOWER = `import { defineComponent } from 'omfv';
export default defineComponent({
  name: 'tower',
  title: 'Timing',
  description: 'The order.',
  spec: ({ drivers }) => ({ key: drivers ? \`tower:\${drivers}\` : 'tower', label: 'Timing' }),
  View: () => <div className="tower-row">tower</div>,
});
`;

describe('installed components', () => {
  it('are copied to .installed/builtin, read-only, without tests, and replaced on every start', async () => {
    const { mods, dir } = await start(
      { 'tower/main.tsx': TOWER, 'tower/rows.ts': 'export const rows = 1;', 'tower/main.test.ts': 'test', 'notes/readme.md': 'not a component' },
      { '.installed/builtin/gone/main.tsx': 'old' },
    );
    expect(mods.installed()).toEqual(['tower']);
    const main = path.join(dir, '.installed/builtin/tower/main.tsx');
    expect(readFileSync(main, 'utf8')).toBe(TOWER);
    expect(statSync(main).mode & 0o222).toBe(0);
    expect(existsSync(path.join(dir, '.installed/builtin/tower/rows.ts'))).toBe(true);
    expect(existsSync(path.join(dir, '.installed/builtin/tower/main.test.ts'))).toBe(false);
    expect(existsSync(path.join(dir, '.installed/builtin/notes'))).toBe(false);
    expect(existsSync(path.join(dir, '.installed/builtin/gone'))).toBe(false);
    // Not mods: nothing builds them.
    expect(mods.list()).toEqual([]);
  });

  it('fork into a new mod, renamed and retitled, saying where it came from, and it builds', async () => {
    const { mods, dir, last } = await start({ 'tower/main.tsx': TOWER, 'tower/rows.ts': `export const rows = 'tower';` });
    const fork = await mods.fork('tower', 'tower_pits', 'Timing tower · pits', { label: 'Timing · pits', on: new Date('2026-11-17T10:00:00Z') });
    expect(fork).toEqual({ from: '.installed/builtin/tower', origin: 'installed', files: ['tower_pits/main.tsx', 'tower_pits/rows.ts'], renamed: 4, oldTitle: 'Timing', oldLabel: 'Timing' });
    const main = readFileSync(path.join(dir, 'tower_pits/main.tsx'), 'utf8');
    expect(main.split('\n')[0]).toBe('// A fork of the installed component tower, made on 2026-11-17. Its original is in .installed/builtin/tower/ and stays as it is.');
    expect(main).toContain(`name: 'tower_pits'`);
    expect(main).toContain(`title: 'Timing tower · pits'`);
    expect(main).toContain('`tower_pits:${drivers}`');
    expect(main).toContain(`: 'tower_pits'`);
    // Its tiles' title bars say which they are.
    expect(main).toContain(`label: 'Timing · pits'`);
    expect(main).not.toContain(`label: 'Timing'`);
    // A string that only starts with the name stays.
    expect(main).toContain('"tower-row"');
    expect(readFileSync(path.join(dir, 'tower_pits/rows.ts'), 'utf8')).toBe(`export const rows = 'tower_pits';`);
    expect(statSync(path.join(dir, 'tower_pits/main.tsx')).mode & 0o200).not.toBe(0);
    // The original stays as it was.
    expect(readFileSync(path.join(dir, '.installed/builtin/tower/main.tsx'), 'utf8')).toBe(TOWER);
    await until(() => last().find((m) => m.name === 'tower_pits' && m.version === 1));
    expect(mods.status('tower_pits')?.error).toBeNull();
  });

  it('fork a mod too, and refuse a name that is taken or not a name, or a component that is not there', async () => {
    const { mods, dir, last } = await start({ 'tower/main.tsx': TOWER }, { 'mine/main.tsx': TOWER.replaceAll('tower', 'mine') });
    await until(() => last().find((m) => m.name === 'mine'));
    const fork = await mods.fork('mine', 'mine_two', 'Mine two');
    expect(fork).toMatchObject({ from: 'mine', origin: 'local' });
    expect(readFileSync(path.join(dir, 'mine_two/main.tsx'), 'utf8')).toMatch(/^\/\/ A fork of the mod mine, made on \d{4}-\d\d-\d\d\.\n/);
    await expect(mods.fork('tower', 'tower', 'T')).rejects.toThrow(`"tower" is an installed component's name`);
    await expect(mods.fork('tower', 'mine', 'T')).rejects.toThrow(`There's already a mod named "mine"`);
    await expect(mods.fork('tower', 'Bad', 'T')).rejects.toThrow(`"Bad" can't be a mod's name`);
    await expect(mods.fork('nothing', 'x', 'T')).rejects.toThrow(`There's no component "nothing". Installed: tower. Mods: mine`);
    // Nothing half-made is left behind.
    expect(existsSync(path.join(dir, 'x'))).toBe(false);
  });

  it('are every one of the app\'s own, and each forks into a mod that compiles', async () => {
    const own = path.join(__dirname, '..', '..', 'src', 'components');
    const { mods, last } = await start(own);
    const names = mods.installed();
    expect(names).toEqual(expect.arrayContaining(['video', 'battle', 'chase', 'timing_tower', 'pit_window', 'pit_windows', 'race_control', 'race_status']));
    expect(names).toHaveLength(16);
    for (const name of names) {
      const fork = await mods.fork(name, `${name}_fork`, `${name} fork`);
      expect(fork.oldTitle, name).not.toBeNull();
      expect(fork.renamed, name).toBeGreaterThan(0);
      // Every one but the video, whose label is the feed's, gets a label of its own.
      if (name !== 'video') expect(fork.oldLabel, name).not.toBeNull();
    }
    const built = await until(() => {
      const list = last();
      return list.length === names.length && list.every((m) => m.state !== 'loading' || m.version > 0) ? list : null;
    }, 30000);
    expect(built.filter((m) => m.error).map((m) => `${m.name}: ${m.error}`)).toEqual([]);
  });
});

describe('renaming a fork', () => {
  it('finds the spec\'s label, and relabels every title bar that shows it', () => {
    const source = `useTileHeader({ label: 'Battle', drivers });\nconst x = { label: 'Other' };\nexport default defineComponent({\n  spec: () => ({ key: 'battle', label: 'Battle' }),\n});`;
    expect(specLabel(source)).toBe('Battle');
    expect(relabel(source, 'Battle', 'Battle · gaps')).toBe(source.replaceAll(`label: 'Battle'`, `label: 'Battle · gaps'`));
    // One that isn't written out as text, or is empty, isn't touched.
    expect(specLabel(`spec: ({ feed }) => ({ key: feed, label: channel.label })`)).toBeNull();
    expect(specLabel(`spec: () => ({ key: 'v', label: '' })`)).toBeNull();
  });

  it('changes strings that are the name or start a key with it, and nothing else', () => {
    const source = `name: 'chase', key: \`chase:\${d}\`, x: "chase", y: 'chase-bar', z: chase, w: 'chased', v: ChaseAid`;
    expect(renameIn(source, 'chase', 'chase_two')).toEqual({
      source: `name: 'chase_two', key: \`chase_two:\${d}\`, x: "chase_two", y: 'chase-bar', z: chase, w: 'chased', v: ChaseAid`,
      count: 3,
    });
  });

  it('sets the component\'s title, the first after defineComponent, quoting it', () => {
    const source = `const a = { title: 'Other' };\nexport default defineComponent({\n  name: 'x',\n  title: "Timing",\n});`;
    expect(retitle(source, `It's new`)).toEqual({ source: source.replace(`title: "Timing"`, `title: 'It\\'s new'`), oldTitle: 'Timing' });
    expect(retitle('nothing here', 'T')).toBeNull();
  });
});
