/**
 * Keeps the in-memory volume in IndexedDB: every file and folder under the roots given, one record each.
 * `loadFs` must finish before anything reads the volume. After that, changes are saved shortly after they
 * happen, and `flushFs` saves what's waiting.
 */
import fs from 'node:fs';
import path from 'node:path';

const DB = 'f1a-fs';
const STORE = 'entries';
const SAVE_DELAY_MS = 250;

interface Entry {
  path: string;
  /** Null for a folder. */
  data: Uint8Array | null;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'path' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

let db: IDBDatabase | null = null;
let roots: string[] = [];
const dirty = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();

const persisted = (file: string) => roots.some((root) => file === root || file.startsWith(root + '/'));

function walk(dir: string, out: string[]): void {
  out.push(dir);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

const bytesOf = (file: string) => new Uint8Array(fs.readFileSync(file) as unknown as Uint8Array);

/** The saved paths under a folder, at any depth. */
function savedUnder(dir: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const request = db!.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys(IDBKeyRange.bound(dir + '/', dir + '/\uffff'));
    request.onsuccess = () => resolve(request.result as string[]);
    request.onerror = () => reject(request.error);
  });
}

async function save(): Promise<void> {
  if (!db || !dirty.size) return;
  const paths = [...dirty];
  dirty.clear();
  const puts = new Map<string, Entry>();
  const deletes = new Set<string>();
  for (const file of paths) {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) {
      deletes.add(file);
      for (const key of await savedUnder(file)) deletes.add(key);
    } else if (stat.isDirectory()) {
      // A watcher reports a rename or a copied folder by one name only, so a changed folder is compared
      // with what's saved: what left it is dropped, and what arrived whole is saved whole.
      const saved = new Set(await savedUnder(file));
      const present: string[] = [];
      walk(file, present);
      const now = new Set(present);
      for (const key of saved) if (!now.has(key)) deletes.add(key);
      for (const each of present) {
        if (each !== file && saved.has(each)) continue;
        puts.set(each, { path: each, data: fs.statSync(each).isDirectory() ? null : bytesOf(each) });
      }
    } else {
      puts.set(file, { path: file, data: bytesOf(file) });
    }
  }
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const key of deletes) if (!puts.has(key)) store.delete(key);
  for (const entry of puts.values()) store.put(entry);
  await done(tx);
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    saving = saving.then(save).catch((e) => console.warn('[fs] save failed:', e));
  }, SAVE_DELAY_MS);
}

/** Saves what's waiting now. */
export function flushFs(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  saving = saving.then(save).catch((e) => console.warn('[fs] save failed:', e));
  return saving;
}

/** Fills the volume from IndexedDB, then starts saving changes under `persistRoots`. */
export async function loadFs(persistRoots: string[]): Promise<void> {
  roots = persistRoots;
  for (const root of roots) fs.mkdirSync(root, { recursive: true });
  db = await open();
  const tx = db.transaction(STORE, 'readonly');
  const request = tx.objectStore(STORE).getAll();
  const entries = await new Promise<Entry[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as Entry[]);
    request.onerror = () => reject(request.error);
  });
  entries.sort((a, b) => a.path.length - b.path.length);
  for (const entry of entries) {
    if (!persisted(entry.path)) continue;
    if (entry.data === null) fs.mkdirSync(entry.path, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      fs.writeFileSync(entry.path, entry.data);
    }
  }
  for (const root of roots) {
    fs.watch(root, { recursive: true }, (_event, name) => {
      const file = name ? path.join(root, String(name)) : root;
      dirty.add(file);
      // A rename reports the new name only: the folder's record is checked, so what left it is dropped.
      dirty.add(path.dirname(file));
      schedule();
    });
  }
  addEventListener('pagehide', () => void flushFs());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushFs();
  });
}
