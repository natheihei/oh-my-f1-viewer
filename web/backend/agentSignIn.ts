/**
 * How the agent's sign-ins reach the user in the browser. A ChatGPT sign-in ends with the provider sending
 * the browser to a callback on localhost, where pi listens. Here pi's listener is a server made by
 * `web/shims/http.ts`, with no socket behind it, so the tab's move to that address is noticed and handed
 * to it. An API key is typed into a small window of its own, as in the desktop app.
 */
import { signInWays } from '../../electron/agent/agent';

const CALLBACK = /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\//;

function openSignIn(url: string): void {
  void (async () => {
    const tab = await chrome.tabs.create({ url });
    if (tab.id === undefined) return;
    const tabId = tab.id;
    const stop = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    const onRemoved = (id: number) => {
      if (id === tabId) stop();
    };
    const onUpdated = (id: number, change: { url?: string }) => {
      if (id !== tabId || !change.url || !CALLBACK.test(change.url)) return;
      stop();
      // Answered by pi's listener, through the page's fetch: the tab itself finds nothing at that address.
      void fetch(change.url)
        .then(async (response) => {
          if (response.ok) return chrome.tabs.remove(tabId);
          // pi's page says why, and the tab can't show it, so its words go on a page of ours.
          const said = (await response.text()).replace(/<(style|script|title)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          const page = new URL('signin.html', location.href);
          page.searchParams.set('text', said.slice(0, 400));
          await chrome.tabs.update(tabId, { url: page.href });
        })
        .catch((e) => console.warn('[ai] sign-in callback:', e));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  })();
}

/** Asks for a key in its own window. Rejects if the window is closed, cancelled or `signal` aborts. */
function askForKey(title: string, message: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const channel = new BroadcastChannel('f1a-key');
    let windowId: number | undefined;
    let settled = false;
    const finish = (error: Error | null, key?: string) => {
      if (settled) return;
      settled = true;
      channel.close();
      chrome.windows.onRemoved.removeListener(onRemoved);
      signal.removeEventListener('abort', onAbort);
      if (windowId !== undefined) void chrome.windows.remove(windowId).catch(() => {});
      if (error) reject(error);
      else resolve(key as string);
    };
    const cancelled = () => new Error('Sign-in cancelled');
    const onAbort = () => finish(cancelled());
    const onRemoved = (removed: number) => {
      if (removed === windowId) finish(cancelled());
    };
    channel.onmessage = (e: MessageEvent<{ id: string; key?: string; cancel?: boolean }>) => {
      if (e.data?.id !== id) return;
      const key = typeof e.data.key === 'string' ? e.data.key.trim() : '';
      if (e.data.cancel) finish(cancelled());
      else if (key) finish(null, key);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    chrome.windows.onRemoved.addListener(onRemoved);
    if (signal.aborted) return onAbort();
    const url = new URL('key.html', location.href);
    url.searchParams.set('id', id);
    url.searchParams.set('title', title);
    url.searchParams.set('message', message);
    chrome.windows
      .create({ url: url.href, type: 'popup', width: 480, height: 190, focused: true })
      .then((win) => {
        windowId = win?.id;
        if (settled && windowId !== undefined) void chrome.windows.remove(windowId).catch(() => {});
      })
      .catch((e) => finish(e as Error));
  });
}

export function connectAgentSignIn(): void {
  signInWays.open = openSignIn;
  signInWays.askForKey = askForKey;
}
