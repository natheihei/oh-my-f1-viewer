/**
 * The link to a mods folder on disk, shared by the options page, which makes it, and the app's tab, which
 * keeps the folder and the volume the same (`backend/modsFolder.ts`). A folder's handle can be kept in
 * IndexedDB. The two talk over a BroadcastChannel.
 */
export const FOLDER_CHANNEL = 'f1a-mods-folder';

export interface FolderStatus {
  /** `needs-permission`: the browser wants the folder allowed again, which takes a click on the options page. */
  state: 'none' | 'linked' | 'needs-permission' | 'failed';
  name: string | null;
  error: string | null;
}

const DB = 'f1a-folder';
const STORE = 'handles';
const KEY = 'mods';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadFolder(): Promise<FileSystemDirectoryHandle | null> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

/** Null removes the link. */
export async function saveFolder(handle: FileSystemDirectoryHandle | null): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    if (handle) tx.objectStore(STORE).put(handle, KEY);
    else tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
