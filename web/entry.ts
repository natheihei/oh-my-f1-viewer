/**
 * The page's entry: starts the main-process code, which puts `window.f1a` in place, then the renderer,
 * which reads it as it loads. One tab at a time, as the desktop app is one instance per profile: the
 * session database's files can only be open in one.
 */
const root = document.getElementById('root')!;

function say(text: string): void {
  root.textContent = text;
  Object.assign(root.style, { display: 'grid', placeItems: 'center', height: '100vh', color: '#8a8a8a', font: "13px 'JetBrains Mono', ui-monospace, monospace" });
}

async function boot(): Promise<void> {
  const backend = (await import(/* @vite-ignore */ new URL('backend.js', location.href).href)) as { start(): Promise<void> };
  await backend.start();
  await import('../src/main');
}

void navigator.locks.request('f1a-instance', { ifAvailable: true }, async (lock) => {
  if (!lock) return say('f1a is already open in another tab.');
  try {
    await boot();
  } catch (e) {
    console.error('[web] failed to start:', e);
    say(`f1a could not start: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  // Held for as long as the tab lives.
  await new Promise(() => {});
});
