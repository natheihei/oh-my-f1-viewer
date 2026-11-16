/**
 * The extension's service worker. It opens the app when the toolbar button is clicked, and serves compiled
 * mods to the page: an extension page may only run scripts from the extension's own origin, so a mod's
 * build is imported from there and answered here, from the cache the page fills. See docs/WEB.md.
 */
/// <reference lib="webworker" />
import { MOD_CACHE, MOD_PATH, modCacheKey } from './modCache';

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(MOD_PATH)) return;
  event.respondWith(
    caches
      .open(MOD_CACHE)
      .then((cache) => cache.match(modCacheKey(event.request.url)))
      .then((found) => found ?? new Response('// This build is gone.', { status: 404, headers: { 'content-type': 'text/javascript' } })),
  );
});

/** One tab holds the app: the session database can only be open in one. */
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('index.html');
  const [open] = await chrome.tabs.query({ url });
  if (open?.id !== undefined) {
    await chrome.tabs.update(open.id, { active: true });
    if (open.windowId !== undefined) await chrome.windows.update(open.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
