import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Mods } from './index';
import { BuildSnapshot, describeChanges } from './snapshot';

let root = '';
let mods = '';
let snap = '';

const MOD = `export default { name: 'x' };`;

function write(files: Record<string, string>, base = mods): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
    writeFileSync(path.join(base, file), text);
  }
}
const read = (file: string) => readFileSync(path.join(mods, file), 'utf8');
const has = (file: string) => existsSync(path.join(mods, file));

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'omfv-snapshot-'));
  mods = path.join(root, 'mods');
  snap = path.join(root, 'mods-snapshot');
  mkdirSync(mods);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('a build snapshot', () => {
  it('says what a build added, edited and deleted, by mod', async () => {
    write({ 'keep/main.tsx': MOD, 'edit/main.tsx': MOD, 'edit/util.ts': 'export const a = 1;', 'gone/main.tsx': MOD });
    const snapshot = new BuildSnapshot(mods, snap);
    expect(await snapshot.changes()).toEqual([]);
    await snapshot.take();
    expect(snapshot.active).toBe(true);
    expect(await snapshot.changes()).toEqual([]);

    write({ 'new/main.tsx': MOD, 'edit/util.ts': 'export const a = 2;' });
    rmSync(path.join(mods, 'gone'), { recursive: true });
    expect(await snapshot.changes()).toEqual([
      { name: 'edit', change: 'edited' },
      { name: 'gone', change: 'deleted' },
      { name: 'new', change: 'added' },
    ]);
  });

  it("ignores the app's own files, and folders that aren't mods yet", async () => {
    write({ 'one/main.tsx': MOD });
    const snapshot = new BuildSnapshot(mods, snap);
    await snapshot.take();
    write({ 'one/mod.log': 'log', 'one/mod.error': 'error', '.types/index.d.ts': 'x', 'half/notes.txt': 'no main yet' });
    expect(await snapshot.changes()).toEqual([]);
  });

  it('puts everything back on restore, and leaves what the app wrote', async () => {
    write({ 'edit/main.tsx': 'old', 'gone/main.tsx': MOD, 'gone/deep/more.ts': 'kept', '.types/a.d.ts': 'types' });
    const snapshot = new BuildSnapshot(mods, snap);
    await snapshot.take();
    write({ 'edit/main.tsx': 'new', 'edit/extra.ts': 'extra', 'made/main.tsx': MOD, 'made/mod.log': 'log' });
    rmSync(path.join(mods, 'gone'), { recursive: true });

    expect(await snapshot.restore()).toBe(true);
    expect(read('edit/main.tsx')).toBe('old');
    expect(has('edit/extra.ts')).toBe(false);
    expect(has('made')).toBe(false);
    expect(read('gone/main.tsx')).toBe(MOD);
    expect(read('gone/deep/more.ts')).toBe('kept');
    expect(read('.types/a.d.ts')).toBe('types');
    expect(snapshot.active).toBe(false);
    expect(existsSync(snap)).toBe(false);
  });

  it('keeps the changes on discard', async () => {
    write({ 'one/main.tsx': 'old' });
    const snapshot = new BuildSnapshot(mods, snap);
    await snapshot.take();
    write({ 'one/main.tsx': 'new' });
    await snapshot.discard();
    expect(read('one/main.tsx')).toBe('new');
    expect(snapshot.active).toBe(false);
    expect(await snapshot.restore()).toBe(false);
    expect(read('one/main.tsx')).toBe('new');
  });

  it('keeps the first snapshot when a build is entered twice', async () => {
    write({ 'one/main.tsx': 'old' });
    const snapshot = new BuildSnapshot(mods, snap);
    await snapshot.take();
    write({ 'one/main.tsx': 'new' });
    await snapshot.take();
    await snapshot.restore();
    expect(read('one/main.tsx')).toBe('old');
  });

  it('ignores a copy that never finished, and clears it away', async () => {
    write({ 'one/main.tsx': 'current' });
    // As if the app died while copying: files, but no marker.
    write({ 'files/one/main.tsx': 'half a copy' }, snap);
    const snapshot = new BuildSnapshot(mods, snap);
    expect(snapshot.active).toBe(false);
    expect(await snapshot.restore()).toBe(false);
    expect(read('one/main.tsx')).toBe('current');
    expect(existsSync(snap)).toBe(false);
  });
});

describe('the mods folder at start', () => {
  it('undoes a build the app quit in the middle of, before loading anything', async () => {
    write({ 'one/main.tsx': 'old' });
    await new BuildSnapshot(mods, snap).take();
    write({ 'one/main.tsx': 'new', 'made/main.tsx': MOD });

    const started = new Mods(mods, () => {}, null, snap);
    await started.start();
    try {
      expect(read('one/main.tsx')).toBe('old');
      expect(has('made')).toBe(false);
      expect(await started.buildState()).toEqual({ active: false, changes: [] });
      expect(started.list().map((m) => m.name)).toEqual(['one']);
    } finally {
      await started.stop();
    }
  });

  it('reports a build as it changes, then saves or undoes it', async () => {
    write({ 'one/main.tsx': MOD.replace('x', 'one') });
    const states: unknown[] = [];
    const started = new Mods(mods, () => {}, null, snap, (state) => states.push(state));
    await started.start();
    try {
      expect(await started.beginBuild()).toEqual({ active: true, changes: [] });
      write({ 'two/main.tsx': MOD.replace('x', 'two') });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !JSON.stringify(states.at(-1)).includes('two')) await new Promise((r) => setTimeout(r, 25));
      expect(states.at(-1)).toEqual({ active: true, changes: [{ name: 'two', change: 'added' }] });
      expect(await started.saveBuild()).toBe('Built two.');
      expect(has('two/main.tsx')).toBe(true);

      await started.beginBuild();
      rmSync(path.join(mods, 'one'), { recursive: true });
      expect(await started.undoBuild()).toBe(1);
      expect(has('one/main.tsx')).toBe(true);
      expect(await started.buildState()).toEqual({ active: false, changes: [] });
    } finally {
      await started.stop();
    }
  });
});

describe('describeChanges', () => {
  it('names what a build did, in the order built, edited, removed', () => {
    expect(describeChanges([])).toBeNull();
    expect(describeChanges([{ name: 'lap_stepper', change: 'added' }])).toBe('Built lap_stepper.');
    expect(
      describeChanges([
        { name: 'old', change: 'deleted' },
        { name: 'lap_form', change: 'edited' },
        { name: 'a', change: 'added' },
        { name: 'b', change: 'added' },
      ]),
    ).toBe('Built a, b, edited lap_form, removed old.');
    expect(describeChanges([{ name: 'lap_form', change: 'edited' }])).toBe('Edited lap_form.');
  });
});
