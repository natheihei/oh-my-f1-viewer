/** The window an API key is typed into. It hands the key to the app's tab and closes. See backend/agentSignIn.ts. */
const params = new URLSearchParams(location.search);
const id = params.get('id') ?? '';
const channel = new BroadcastChannel('f1a-key');
const key = document.getElementById('key') as HTMLInputElement;

document.title = params.get('title') ?? 'API key';
document.getElementById('message')!.textContent = `${params.get('message') ?? 'Paste your API key.'} f1a stores it in this browser.`;

const cancel = (): void => {
  channel.postMessage({ id, cancel: true });
  window.close();
};
document.getElementById('form')!.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!key.value.trim()) return;
  channel.postMessage({ id, key: key.value.trim() });
  window.close();
});
document.getElementById('cancel')!.addEventListener('click', cancel);
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') cancel();
});
