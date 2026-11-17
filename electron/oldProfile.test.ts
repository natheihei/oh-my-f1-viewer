import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyOldProfile, renameImports } from './oldProfile';

let appData: string;
let old: string;
let next: string;

const write = (dir: string, files: Record<string, string>) => {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
};
const read = (name: string) => fs.readFileSync(path.join(next, name), 'utf8');
const has = (name: string) => fs.existsSync(path.join(next, name));

beforeEach(() => {
  appData = fs.mkdtempSync(path.join(os.tmpdir(), 'omfv-old-profile-'));
  old = path.join(appData, 'f1a');
  next = path.join(appData, 'oh-my-f1-viewer');
  fs.mkdirSync(next);
});
afterEach(() => fs.rmSync(appData, { recursive: true, force: true }));

describe('renameImports', () => {
  it('renames the host and the kit, in either quotes, and nothing else', () => {
    const source = `import { useSql } from 'f1a';\nimport { text } from "f1a/kit";\nconst s = 'f1a-like';`;
    expect(renameImports(source)).toBe(`import { useSql } from 'omfv';\nimport { text } from "omfv/kit";\nconst s = 'f1a-like';`);
  });
});

describe('copyOldProfile', () => {
  it('does nothing without an old profile', () => {
    expect(copyOldProfile(appData, next)).toEqual([]);
    expect(fs.readdirSync(next)).toEqual([]);
  });

  it('copies mods, settings and data under the new names, and leaves the sign-ins and the old profile', () => {
    write(old, {
      'mods/gap/main.tsx': `import { defineComponent } from 'f1a';\nimport { text } from 'f1a/kit';`,
      'mods/gap/mod.log': 'from f1a',
      'mods/gap/node_modules/x/index.js': `require('f1a')`,
      'mods/AGENTS.md': 'old guide',
      'mods/tsconfig.json': '{}',
      'mods/.types/a.d.ts': 'x',
      'conversations/a.sqlite': 'c',
      'f1a-settings.json': '{"agent":{}}',
      'f1a-install-id': 'id',
      'f1a-credentials.json': 'secret',
      'f1a-session.json': 'secret',
      'timing.sqlite': 'db',
      'timing.sqlite-wal': 'wal',
    });
    expect(copyOldProfile(appData, next)).toEqual(['mods', 'conversations', 'omfv-settings.json', 'omfv-install-id', 'timing.sqlite']);
    expect(read('mods/gap/main.tsx')).toBe(`import { defineComponent } from 'omfv';\nimport { text } from 'omfv/kit';`);
    expect(read('mods/gap/mod.log')).toBe('from f1a');
    expect(['mods/gap/node_modules', 'mods/AGENTS.md', 'mods/tsconfig.json', 'mods/.types'].filter(has)).toEqual([]);
    expect(read('omfv-settings.json')).toBe('{"agent":{}}');
    expect(read('timing.sqlite-wal')).toBe('wal');
    expect(['omfv-credentials.json', 'omfv-session.json', 'f1a-credentials.json', 'f1a-session.json'].filter(has)).toEqual([]);
    expect(fs.readFileSync(path.join(old, 'mods/gap/main.tsx'), 'utf8')).toContain(`from 'f1a'`);
  });

  it('never writes over the new profile, and copies once', () => {
    write(old, { 'f1a-settings.json': 'old', 'mods/gap/main.tsx': 'old' });
    write(next, { 'omfv-settings.json': 'new', 'mods/gap/main.tsx': 'new' });
    expect(copyOldProfile(appData, next)).toEqual(['mods']);
    expect(read('omfv-settings.json')).toBe('new');
    expect(read('mods/gap/main.tsx')).toBe('new');
    fs.rmSync(path.join(next, 'omfv-settings.json'));
    expect(copyOldProfile(appData, next)).toEqual([]);
    expect(has('omfv-settings.json')).toBe(false);
  });
});
