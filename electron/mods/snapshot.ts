/**
 * Build mode's snapshot: a copy of the mods folder taken when a build starts, which Undo all puts back
 * and Save throws away. A build that never finished, because the app quit or crashed, is undone on the
 * next start by the same restore. See docs/BUILD_MODE.md.
 */
import { createHash } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import type { BuildChange } from '../../shared/mods';

const ENTRIES = ['main.tsx', 'main.ts', 'main.jsx', 'main.js'];
/** What the app writes into a mod's folder itself: never copied, compared or removed. */
const APP_IN_MOD = new Set(['mod.error', 'mod.log']);
const FILES = 'files';
/** Written last: a snapshot without it is a copy that didn't finish. */
const MARKER = 'complete';

const skipped = (name: string) => name.startsWith('.') || name === 'node_modules';

/** Every file under `dir` the snapshot covers, as paths relative to it. */
async function filesIn(dir: string, base = ''): Promise<string[]> {
  const entries = await fsp.readdir(path.join(dir, base), { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    if (skipped(entry.name)) continue;
    const rel = path.join(base, entry.name);
    const depth = rel.split(path.sep).length;
    if (depth === 2 && APP_IN_MOD.has(entry.name)) continue;
    if (entry.isDirectory()) out.push(...(await filesIn(dir, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

async function copyFiles(from: string, to: string): Promise<void> {
  for (const rel of await filesIn(from)) {
    await fsp.mkdir(path.dirname(path.join(to, rel)), { recursive: true });
    await fsp.copyFile(path.join(from, rel), path.join(to, rel));
  }
}

/** Each mod under `dir`, a folder with a `main` file, with a hash of everything in it. */
async function modsIn(dir: string): Promise<Map<string, string>> {
  const byMod = new Map<string, string[]>();
  for (const rel of (await filesIn(dir)).sort()) {
    const [name, ...rest] = rel.split(path.sep);
    if (rest.length === 0) continue;
    const list = byMod.get(name) ?? [];
    list.push(rel);
    byMod.set(name, list);
  }
  const out = new Map<string, string>();
  for (const [name, files] of byMod) {
    if (!ENTRIES.some((entry) => existsSync(path.join(dir, name, entry)))) continue;
    const hash = createHash('sha1');
    for (const rel of files) hash.update(rel).update('\0').update(await fsp.readFile(path.join(dir, rel))).update('\0');
    out.set(name, hash.digest('hex'));
  }
  return out;
}

export class BuildSnapshot {
  private readonly files: string;
  private readonly marker: string;

  /** `dir` is where the snapshot lives, beside the mods folder and never inside it. */
  constructor(
    private readonly modsDir: string,
    private readonly dir: string,
  ) {
    this.files = path.join(dir, FILES);
    this.marker = path.join(dir, MARKER);
  }

  /** A build is under way: its snapshot finished copying and hasn't been saved or undone. */
  get active(): boolean {
    return existsSync(this.marker);
  }

  /** Copies the mods folder. A snapshot that's already there is kept: the build it belongs to is still open. */
  async take(): Promise<void> {
    if (this.active) return;
    await fsp.rm(this.dir, { recursive: true, force: true });
    await fsp.mkdir(this.files, { recursive: true });
    await copyFiles(this.modsDir, this.files);
    await fsp.writeFile(this.marker, new Date().toISOString() + '\n');
  }

  /** Keeps the mods folder as it is now. */
  async discard(): Promise<void> {
    await fsp.rm(this.dir, { recursive: true, force: true });
  }

  /**
   * Puts the mods folder back as it was when the snapshot was taken, then drops the snapshot. The marker
   * goes last, so a restore that's interrupted runs again on the next start. Returns whether there was
   * a snapshot to restore.
   */
  async restore(): Promise<boolean> {
    if (!this.active) {
      // A copy that never finished: the mods folder was never touched by that build.
      await this.discard();
      return false;
    }
    const kept = new Set(await filesIn(this.files));
    for (const rel of await filesIn(this.modsDir)) {
      if (!kept.has(rel)) await fsp.rm(path.join(this.modsDir, rel), { force: true });
    }
    await copyFiles(this.files, this.modsDir);
    // Folders the build made, and the app's files in them, go once nothing of the build is left inside.
    const wanted = new Set([...kept].map((rel) => rel.split(path.sep)[0]));
    for (const entry of await fsp.readdir(this.modsDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || skipped(entry.name) || wanted.has(entry.name)) continue;
      await fsp.rm(path.join(this.modsDir, entry.name), { recursive: true, force: true });
    }
    await this.discard();
    return true;
  }

  /** The mods that differ from the snapshot, by name. Nothing when no build is under way. */
  async changes(): Promise<BuildChange[]> {
    if (!this.active) return [];
    const [before, now] = await Promise.all([modsIn(this.files), modsIn(this.modsDir)]);
    const out: BuildChange[] = [];
    for (const [name, hash] of now) {
      if (!before.has(name)) out.push({ name, change: 'added' });
      else if (before.get(name) !== hash) out.push({ name, change: 'edited' });
    }
    for (const name of before.keys()) {
      if (!now.has(name)) out.push({ name, change: 'deleted' });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** "Built lap_stepper, edited lap_form, removed old_one.", or null when nothing changed. Written by the app, never the model. */
export function describeChanges(changes: BuildChange[]): string | null {
  const names = (kind: BuildChange['change']) => changes.filter((c) => c.change === kind).map((c) => c.name);
  const parts = [
    names('added').length ? `built ${names('added').join(', ')}` : '',
    names('edited').length ? `edited ${names('edited').join(', ')}` : '',
    names('deleted').length ? `removed ${names('deleted').join(', ')}` : '',
  ].filter(Boolean);
  if (!parts.length) return null;
  const text = parts.join(', ');
  return text[0].toUpperCase() + text.slice(1) + '.';
}
