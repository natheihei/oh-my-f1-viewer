/** The extension's options page: links the mods folder to one on disk. The app's tab does the rest. See folderLink.ts. */
import { FOLDER_CHANNEL, loadFolder, saveFolder, type FolderStatus } from './folderLink';

type Permitted = FileSystemDirectoryHandle & { requestPermission(o: { mode: string }): Promise<string>; queryPermission(o: { mode: string }): Promise<string> };

const channel = new BroadcastChannel(FOLDER_CHANNEL);
const status = document.getElementById('status')!;
const [choose, allow, unlink] = ['choose', 'allow', 'unlink'].map((id) => document.getElementById(id) as HTMLButtonElement);

async function show(app: FolderStatus | null): Promise<void> {
  const handle = (await loadFolder().catch(() => null)) as Permitted | null;
  const granted = handle ? (await handle.queryPermission({ mode: 'readwrite' })) === 'granted' : false;
  unlink.hidden = !handle;
  allow.hidden = !handle || granted;
  choose.textContent = handle ? 'Choose another folder' : 'Choose a folder';
  if (!handle) status.textContent = 'No folder is linked.';
  else if (!granted) status.textContent = `"${handle.name}" is linked, but the browser wants it allowed again.`;
  else if (app?.state === 'failed') status.textContent = `"${handle.name}" is linked, but it couldn't be read: ${app.error}`;
  else if (app?.state === 'linked') status.textContent = `"${handle.name}" is linked, and f1a is keeping it up to date.`;
  else status.textContent = `"${handle.name}" is linked. It's kept up to date while f1a is open.`;
}

const changed = (): void => {
  channel.postMessage({ type: 'changed' });
  void show(null);
};

choose.addEventListener('click', async () => {
  const handle = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'f1a-mods', mode: 'readwrite' }).catch(() => null);
  if (!handle) return;
  await saveFolder(handle);
  changed();
});
allow.addEventListener('click', async () => {
  const handle = (await loadFolder()) as Permitted | null;
  if (handle && (await handle.requestPermission({ mode: 'readwrite' })) === 'granted') changed();
});
unlink.addEventListener('click', async () => {
  await saveFolder(null);
  changed();
});
channel.onmessage = (e: MessageEvent<{ type: string; status?: FolderStatus }>) => {
  if (e.data?.type === 'status') void show(e.data.status ?? null);
};
channel.postMessage({ type: 'ask' });
void show(null);
