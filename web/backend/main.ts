/**
 * The browser's main process: what electron/main.ts sets up, in the page. The same services run here
 * (F1 TV, the license proxy, the session database, mods, the agent), on shims of Node's and Electron's
 * modules (`web/shims`), and `window.f1a` calls them directly. See docs/WEB.md.
 */
import '../shims/http';
import './piRuntime';
import fs from 'node:fs';
import path from 'node:path';
import { setupIpc } from '../../electron/ipc';
import { Mods } from '../../electron/mods';
import { setRendererSink } from '../../electron/windows';
import type { ModStatus } from '../../shared/mods';
import { MOD_CACHE, MOD_PATH, modCacheKey } from '../modCache';
import { flushFs, loadFs } from '../shims/fsPersist';
import { connectAgentSignIn } from './agentSignIn';
import { startModsFolder } from './modsFolder';
import { api, pagePlatform } from './platform';

/* eslint-disable @typescript-eslint/no-require-imports */
const { USER_DATA } = require('../shims/electron') as { USER_DATA: string };
const sessionState = require('../../electron/vendor/f1ov/session');
const licenseProxy = require('../../electron/vendor/f1ov/licenseProxy');
const livetiming = require('../../electron/vendor/f1ov/livetiming');

const MOD_BASE = new URL(MOD_PATH.slice(0, -1), location.origin).href;
const KEPT_CONVERSATIONS = 40;
/** The app's own files, put in the volume on every start. */
const APP_DIR = '/app';

addEventListener('unhandledrejection', (e) => console.error('[main] unhandled rejection:', e.reason));

/** The host's and kit's type declarations, which a mod's author reads: `dist-types` in the desktop app. */
async function writeDeclarations(): Promise<void> {
  const files = (await (await fetch(new URL('mod-types.json', location.href))).json()) as Record<string, string>;
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(APP_DIR, 'dist-types', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

/**
 * A page imports a mod's build from the extension's own origin, the only origin its policy lets scripts
 * come from, and the service worker answers that request from this cache. So a build is in the cache
 * before the renderer hears of it.
 */
function publishMods(mods: Mods): (list: ModStatus[]) => void {
  let turn: Promise<void> = Promise.resolve();
  const stored = new Map<string, number>();
  return (list) => {
    turn = turn
      .then(async () => {
        const cache = await caches.open(MOD_CACHE);
        for (const mod of list) {
          const code = mods.codeOf(mod.name);
          if (!mod.url || code === null || stored.get(mod.name) === mod.version) continue;
          await cache.put(modCacheKey(mod.url), new Response(code, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } }));
          stored.set(mod.name, mod.version);
        }
        for (const request of await cache.keys()) {
          const name = decodeURIComponent(new URL(request.url).pathname.split('/').at(-2) ?? '');
          const current = list.find((mod) => mod.name === name);
          if (!current?.url || modCacheKey(current.url) !== request.url) await cache.delete(request);
        }
      })
      .catch((e) => console.warn('[mods] publish:', e))
      .then(() => pagePlatform.send('mods:changed', list));
  };
}

/**
 * Keeps the newest conversations of each agent. The desktop app keeps them all, on disk. Here the whole
 * volume is held in memory, so it has to stay small.
 */
function pruneConversations(): void {
  for (const folder of ['sessions', 'build-sessions']) {
    const dir = path.join(USER_DATA, 'pi-agent', folder);
    try {
      const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
      for (const name of files.slice(0, Math.max(0, files.length - KEPT_CONVERSATIONS))) fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // No conversations yet.
    }
  }
}

export async function start(): Promise<void> {
  await loadFs([USER_DATA]);
  pruneConversations();
  await writeDeclarations().catch((e: Error) => console.warn('[mods] declarations:', e.message));

  // The static timing archive requires the F1 TV subscription token.
  livetiming.setAuthTokenProvider(() => sessionState.memSession.accessToken);
  licenseProxy.startLicenseProxy();
  setRendererSink((channel, payload) => pagePlatform.send(channel, payload));
  connectAgentSignIn();

  const mods: Mods = new Mods(
    path.join(USER_DATA, 'mods'),
    (list) => publish(list),
    { declarations: path.join(APP_DIR, 'dist-types'), nodeModules: path.join(APP_DIR, 'node_modules') },
    path.join(USER_DATA, 'mods-snapshot'),
    (state) => pagePlatform.send('build:changed', state),
  );
  mods.urlBase = MOD_BASE;
  const publish = publishMods(mods);
  const data = setupIpc('timing.sqlite', mods, pagePlatform);
  window.f1a = api;
  void mods
    .start()
    .catch((e: Error) => console.warn('[mods] start:', e.message))
    .then(() => startModsFolder(mods.dir));

  // Before the renderer starts, as the desktop app restores before its window opens: the first thing
  // the renderer asks is whether F1 TV is signed in.
  try {
    await sessionState.restoreSessionOnStartup();
  } catch (e) {
    console.warn('[main] session restore failed:', (e as Error).message);
  }
  sessionState.startProactiveRefreshLoop();
  // The calendar is refreshed on every start. Until it's done, the last one is still there to read.
  void data.refreshSchedule().catch((e: Error) => console.warn('[timingdb] schedule:', e.message));

  // For checks and for looking around from devtools.
  Object.assign(window, { __f1aWeb: { flushFs, fs, mods, picture: pagePlatform.picture } });
}
