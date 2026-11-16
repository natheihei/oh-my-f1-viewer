/**
 * The mods folder on disk. In the browser the mods folder is in the volume, which no editor or coding agent
 * outside the app can reach. Linking a real folder (from the extension's options page, `folder.html`) keeps
 * the two the same from then on, in both directions: a save on disk reaches the volume, where the app
 * compiles it as usual, and what the app or its build agent writes reaches the disk. The files the app owns
 * (AGENTS.md, tsconfig.json, .types, mod.error, mod.log) only ever go out.
 *
 * The browser has no way to watch a folder, so the disk is read once a second. It's told apart from the
 * volume by what was last the same on both sides (`known`): a file that left one side is removed from the
 * other, and one changed on one side is copied to the other.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FOLDER_CHANNEL, loadFolder, type FolderStatus } from '../folderLink';

const POLL_MS = 1000;
const SKIPPED = new Set(['node_modules', '.git', '.DS_Store']);
const APP_TOP_LEVEL = new Set(['AGENTS.md', 'tsconfig.json']);
const APP_IN_MOD = new Set(['mod.error', 'mod.log']);

/** What the app writes itself: copied to the disk, never read back from it. */
function appOwned(rel: string): boolean {
  const parts = rel.split('/');
  return parts[0] === '.types' || (parts.length === 1 && APP_TOP_LEVEL.has(parts[0])) || (parts.length === 2 && APP_IN_MOD.has(parts[1]));
}

function hashOf(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193);
  return `${bytes.length}:${hash >>> 0}`;
}

interface DiskFile {
  handle: FileSystemFileHandle;
  parent: FileSystemDirectoryHandle;
}

async function scanDisk(dir: FileSystemDirectoryHandle, base: string, out: Map<string, DiskFile>): Promise<void> {
  for await (const [name, entry] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (SKIPPED.has(name) || (name.startsWith('.') && !(base === '' && name === '.types'))) continue;
    const rel = base ? `${base}/${name}` : name;
    if (entry.kind === 'directory') await scanDisk(entry as FileSystemDirectoryHandle, rel, out);
    else out.set(rel, { handle: entry as FileSystemFileHandle, parent: dir });
  }
}

function scanVolume(dir: string, base: string, out: Map<string, { mtimeMs: number; size: number }>): void {
  for (const entry of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const name = String(entry.name);
    if (SKIPPED.has(name)) continue;
    const rel = base ? `${base}/${name}` : name;
    if (entry.isDirectory()) scanVolume(dir, rel, out);
    else if (entry.isFile()) {
      const stat = fs.statSync(path.join(dir, rel));
      out.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
}

async function diskDir(root: FileSystemDirectoryHandle, rel: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const part of rel.split('/').slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

class FolderSync {
  /** Each file's content, as a hash, when both sides last held the same. */
  private known = new Map<string, string>();
  /** What a file looked like on each side when it was last read, to skip reading one that hasn't changed. */
  private diskSeen = new Map<string, string>();
  private volumeSeen = new Map<string, { sig: string; hash: string }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watcher: fs.FSWatcher | null = null;
  private running: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly root: FileSystemDirectoryHandle,
    private readonly dir: string,
    private readonly onError: (e: Error) => void,
  ) {}

  start(): void {
    this.watcher = fs.watch(this.dir, { recursive: true }, () => this.soon(150));
    this.soon(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.close();
  }

  private soon(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.running
        .then(() => this.reconcile())
        .catch((e) => {
          if (!this.stopped) this.onError(e as Error);
        })
        .then(() => this.soon(POLL_MS));
    }, ms);
  }

  private volumeHash(rel: string, seen: { mtimeMs: number; size: number }): string {
    const sig = `${seen.mtimeMs}:${seen.size}`;
    const last = this.volumeSeen.get(rel);
    if (last?.sig === sig) return last.hash;
    const hash = hashOf(fs.readFileSync(path.join(this.dir, rel)) as unknown as Uint8Array);
    this.volumeSeen.set(rel, { sig, hash });
    return hash;
  }

  private async toDisk(rel: string): Promise<void> {
    const bytes = new Uint8Array(fs.readFileSync(path.join(this.dir, rel)) as unknown as Uint8Array);
    const parent = await diskDir(this.root, rel, true);
    const handle = await parent.getFileHandle(rel.split('/').at(-1)!, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    const file = await handle.getFile();
    this.diskSeen.set(rel, `${file.lastModified}:${file.size}`);
    this.known.set(rel, hashOf(bytes));
  }

  private toVolume(rel: string, bytes: Uint8Array): void {
    const target = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    this.known.set(rel, hashOf(bytes));
  }

  private async fromDisk(rel: string): Promise<void> {
    const parent = await diskDir(this.root, rel, false).catch(() => null);
    await parent?.removeEntry(rel.split('/').at(-1)!).catch(() => {});
    // A mod's folder goes with its last file.
    const parts = rel.split('/').slice(0, -1);
    while (parts.length) {
      const name = parts.pop()!;
      const above = await diskDir(this.root, [...parts, name].join('/'), false).catch(() => null);
      if (!above) break;
      const inside = await above.getDirectoryHandle(name).catch(() => null);
      if (!inside) break;
      let empty = true;
      for await (const _ of inside as unknown as AsyncIterable<unknown>) {
        empty = false;
        break;
      }
      if (!empty) break;
      await above.removeEntry(name).catch(() => {});
    }
    this.known.delete(rel);
    this.diskSeen.delete(rel);
  }

  private fromVolume(rel: string): void {
    fs.rmSync(path.join(this.dir, rel), { force: true });
    let dir = path.dirname(path.join(this.dir, rel));
    while (dir !== this.dir && dir.startsWith(this.dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
    this.known.delete(rel);
    this.volumeSeen.delete(rel);
  }

  private async reconcile(): Promise<void> {
    const disk = new Map<string, DiskFile>();
    await scanDisk(this.root, '', disk);
    const volume = new Map<string, { mtimeMs: number; size: number }>();
    scanVolume(this.dir, '', volume);
    for (const rel of new Set([...disk.keys(), ...volume.keys(), ...this.known.keys()])) {
      if (this.stopped) return;
      const onDisk = disk.get(rel);
      const inVolume = volume.get(rel);
      const known = this.known.get(rel);
      const app = appOwned(rel);
      // A mod whose own files are all gone is gone: what the app wrote beside them goes too.
      if (app && rel.split('/').length === 2 && !rel.startsWith('.types/')) {
        const prefix = `${rel.split('/')[0]}/`;
        const alive = [...volume.keys(), ...disk.keys()].some((other) => other.startsWith(prefix) && !appOwned(other));
        if (!alive) {
          if (inVolume) this.fromVolume(rel);
          if (onDisk) await this.fromDisk(rel);
          continue;
        }
      }
      if (inVolume && onDisk) {
        const ours = this.volumeHash(rel, inVolume);
        const file = await onDisk.handle.getFile();
        const sig = `${file.lastModified}:${file.size}`;
        if (app) {
          if (ours !== known || this.diskSeen.get(rel) !== sig) await this.toDisk(rel);
          continue;
        }
        if (ours === known && this.diskSeen.get(rel) === sig) continue;
        const bytes = new Uint8Array(await file.arrayBuffer());
        const theirs = hashOf(bytes);
        this.diskSeen.set(rel, sig);
        if (theirs === ours) this.known.set(rel, ours);
        else if (ours === known) this.toVolume(rel, bytes);
        else if (theirs === known) await this.toDisk(rel);
        // Changed on both sides, or met for the first time: the newer one stays.
        else if (file.lastModified >= inVolume.mtimeMs) this.toVolume(rel, bytes);
        else await this.toDisk(rel);
      } else if (inVolume) {
        if (known !== undefined && !app) this.fromVolume(rel);
        else await this.toDisk(rel);
      } else if (onDisk) {
        if (known !== undefined) await this.fromDisk(rel);
        else if (!app) this.toVolume(rel, new Uint8Array(await (await onDisk.handle.getFile()).arrayBuffer()));
      } else {
        this.known.delete(rel);
      }
    }
  }
}

let current: FolderSync | null = null;

/** Starts keeping the linked folder and the volume's mods folder the same, and starts again whenever the link changes. */
export function startModsFolder(dir: string): void {
  const channel = new BroadcastChannel(FOLDER_CHANNEL);
  let status: FolderStatus = { state: 'none', name: null, error: null };
  const say = (next: FolderStatus) => {
    status = next;
    channel.postMessage({ type: 'status', status });
  };
  const restart = async (): Promise<void> => {
    current?.stop();
    current = null;
    const handle = await loadFolder().catch(() => null);
    if (!handle) return say({ state: 'none', name: null, error: null });
    const permission = await (handle as unknown as { queryPermission(o: { mode: string }): Promise<string> }).queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') return say({ state: 'needs-permission', name: handle.name, error: null });
    current = new FolderSync(handle, dir, (e) => {
      console.warn('[mods] folder:', e.message);
      current?.stop();
      current = null;
      // The browser takes access back when the last tab of a session closes, unless it was allowed for good.
      say({ state: e.name === 'NotAllowedError' ? 'needs-permission' : 'failed', name: handle.name, error: e.message });
    });
    current.start();
    say({ state: 'linked', name: handle.name, error: null });
  };
  channel.onmessage = (e: MessageEvent<{ type: string }>) => {
    if (e.data?.type === 'changed') void restart();
    else if (e.data?.type === 'ask') channel.postMessage({ type: 'status', status });
  };
  void restart();
}
