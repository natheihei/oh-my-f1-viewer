import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModStatus } from '../../shared/mods';
import { MODS_AGENTS_MD } from '../../shared/modGuide';
import { Mods } from './index';

let mods: Mods | null = null;
let dir = '';

async function until<T>(get: () => T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function start(files: Record<string, string>): Promise<{ mods: Mods; last: () => ModStatus[] }> {
  dir = mkdtempSync(path.join(os.tmpdir(), 'f1a-mods-'));
  write(files);
  let latest: ModStatus[] = [];
  mods = new Mods(dir, (list) => (latest = list));
  await mods.start();
  return { mods, last: () => latest };
}

function write(files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
}

const code = async (m: Mods, name: string) => (await m.serve(new Request(`f1a-mod://mods/${name}/main.js?v=1`))).text();

/** Waits for text in a file the app writes in the background, which can be missing or still empty until then. */
const untilFileHas = (file: string, text: string) =>
  until(() => existsSync(path.join(dir, file)) && readFileSync(path.join(dir, file), 'utf8').includes(text));

afterEach(async () => {
  await mods?.stop();
  mods = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('mods', () => {
  it('compiles a mod with the shared modules left to the app', async () => {
    const { mods, last } = await start({
      'tower/main.tsx': `import { useLive } from 'f1a';\nimport { helper } from './helper';\nexport default { name: 'tower', View: () => <b>{helper(useLive((s) => s.volume))}</b> };`,
      'tower/helper.ts': `export const helper = (n: number) => n.toFixed(1);`,
    });
    const status = await until(() => last().find((m) => m.version === 1));
    expect(status).toMatchObject({ name: 'tower', state: 'loading', url: 'f1a-mod://mods/tower/main.js?v=1', error: null });
    const js = await code(mods, 'tower');
    expect(js).toContain('globalThis.__f1aShared["f1a"]');
    expect(js).toContain('globalThis.__f1aShared["react/jsx-runtime"]');
    expect(js).toContain('globalThis.__f1aModConsole("tower")');
    expect(js).toContain('toFixed(1)');
  });

  it('refuses imports outside the shared modules and its own folder, and keeps the last good build', async () => {
    const { mods, last } = await start({ 'one/main.ts': `export default { name: 'one' };` });
    await until(() => last().find((m) => m.version === 1));
    mods.loaded('one', 1, null);
    expect(mods.status('one')?.state).toBe('ready');

    write({ 'one/main.ts': `import axios from 'axios';\nexport default axios;` });
    const failed = await until(() => last().find((m) => m.state === 'failed'));
    expect(failed.version).toBe(1);
    expect(failed.error).toContain(`"axios" isn't available to mods`);
    expect(readFileSync(path.join(dir, 'one/mod.error'), 'utf8')).toContain('axios');
    expect(await code(mods, 'one')).toContain(`name: "one"`);

    write({ 'one/main.ts': `import x from '../secret';\nexport default x;` });
    expect((await until(() => last().find((m) => m.error?.includes('own folder')))).state).toBe('failed');

    write({ 'one/main.ts': `export default { name: 'one', again: true };` });
    await until(() => last().find((m) => m.version === 2));
    mods.loaded('one', 2, null);
    await until(() => !existsSync(path.join(dir, 'one/mod.error')));
  });

  it('records a load the renderer refused', async () => {
    const { mods, last } = await start({ 'two/main.js': `export default 1;` });
    await until(() => last().find((m) => m.version === 1));
    mods.loaded('two', 1, 'main must export default defineComponent');
    expect(mods.status('two')).toMatchObject({ state: 'failed', error: 'main must export default defineComponent' });
    await untilFileHas('two/mod.error', 'defineComponent');
  });

  it('writes the guide for agents into the folder, over any edit', async () => {
    const { mods: m } = await start({ 'AGENTS.md': 'edited' });
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe(MODS_AGENTS_MD);
    expect(m.list()).toEqual([]);
  });

  it('finds new mods and drops removed ones', async () => {
    const { mods, last } = await start({});
    write({ 'late/main.ts': `export default {};` });
    await until(() => last().find((m) => m.name === 'late' && m.version === 1));
    rmSync(path.join(dir, 'late'), { recursive: true });
    await until(() => last().length === 0 && mods.list().length === 0);
  });

  it('refuses a folder name that cannot be a component name', async () => {
    const { mods } = await start({ 'Bad Name/main.ts': `export default {};` });
    expect(mods.status('Bad Name')).toMatchObject({ state: 'failed', version: 0 });
  });

  it('keeps logs and writes them to mod.log', async () => {
    const { mods, last } = await start({ 'logs/main.ts': `export default {};` });
    await until(() => last().find((m) => m.version === 1));
    mods.log('logs', { at: 1000, level: 'warn', text: 'hello' });
    expect(mods.logs('logs')).toEqual([{ at: 1000, level: 'warn', text: 'hello' }]);
    await untilFileHas('logs/mod.log', 'warn hello');
  });
});
