/**
 * Keeps a release of OMFV up to date: checks GitHub for a newer release, downloads it in the background, and
 * installs it when the app quits, so the next start is the new release. Never restarts the app, never asks.
 * Only the AppImage and the Mac app. The AUR package, oh-my-f1-viewer-bin, is the system's to update: for it, the
 * feed is only read to say that a release is out. See docs/RELEASE.md.
 *
 * electron-updater does the work, from the feed electron-builder.yml names under `publish`: `latest-linux.yml` or
 * `latest-mac.yml` on the release marked latest.
 */
import { readdirSync } from 'node:fs';
import { app, net } from 'electron';
import { autoUpdater } from 'electron-updater';
import { compareReleases, LINUX_FEED_URL, releaseName, type UpdateState } from '../shared/release';
import { appSettings, type Settings } from './settings';

/** The first check waits for the app to settle, then they come every 10 minutes. */
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 10 * 60_000;

/** What the settings keep under `update` between runs. */
export interface SavedUpdate {
  /** The release that ran last. */
  last?: string;
  /** The release that was to install when the app last quit. */
  installing?: string;
}

const NOTHING: UpdateState = { ready: null, out: null, updated: null, failed: null };
let state: UpdateState = NOTHING;

/** Whether this build updates itself: a release, installed as an AppImage or a Mac app. */
export function canUpdate(): boolean {
  if (!app.isPackaged || !releaseName(app.getVersion())) return false;
  return process.platform === 'darwin' || (process.platform === 'linux' && !!process.env.APPIMAGE);
}

/** Where the AUR package installs the app, and where pacman keeps what's installed. */
const AUR_INSTALL = '/opt/oh-my-f1-viewer/';
const PACMAN_DB = '/var/lib/pacman/local';

/**
 * Whether the system updates this build: a release that the AUR package installed, so `yay` or `omarchy update`
 * installs the next. Not the .pacman file releases carried before, which installs to the same place by another name.
 */
export function fromSystem(pacmanDb = PACMAN_DB): boolean {
  if (!app.isPackaged || !releaseName(app.getVersion())) return false;
  if (process.platform !== 'linux' || process.env.APPIMAGE || !process.execPath.startsWith(AUR_INSTALL)) return false;
  try {
    return readdirSync(pacmanDb).some((d) => d.startsWith('oh-my-f1-viewer-bin-'));
  } catch {
    return false;
  }
}

/** The release a feed names, from its `version` line: `version: 20261121.1.0` is `20261121.1`. */
export function feedRelease(yml: string): string | null {
  const version = /^version:\s*['"]?([^'"\s]+)/m.exec(yml)?.[1];
  return version ? releaseName(version) : null;
}

/** Reads what the last run kept, ignoring anything that isn't a release name. */
export function readSaved(value: unknown): SavedUpdate {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const name = (x: unknown) => (typeof x === 'string' && /^\d{8}\.\d+$/.test(x) ? x : undefined);
  return { last: name(v.last), installing: name(v.installing) };
}

/**
 * What a start says about the last run: the release it updated to, if it's newer than the one that ran last, and
 * the release that was to install on the last quit, if this one is older than it.
 */
export function afterStart(current: string, saved: SavedUpdate): Pick<UpdateState, 'updated' | 'failed'> {
  return {
    updated: saved.last && compareReleases(current, saved.last) > 0 ? current : null,
    failed: saved.installing && compareReleases(current, saved.installing) < 0 ? saved.installing : null,
  };
}

/** What the renderer is told: what's ready, and what happened to the last update. */
export function updateState(): UpdateState {
  return state;
}

/**
 * Starts checking, when this build updates itself. Call it before the window opens, so the renderer's first
 * question has the answer. `send` passes each change on to the renderer.
 */
export function startUpdates(send: (state: UpdateState) => void, settings: Settings & { flush?(): void } = appSettings()): void {
  const current = releaseName(app.getVersion());
  const self = canUpdate();
  if (!current || (!self && !fromSystem())) return;
  state = { ...NOTHING, ...afterStart(current, readSaved(settings.get('update'))) };
  settings.set('update', { last: current } satisfies SavedUpdate);
  if (!self) return watchFeed(current, send);

  autoUpdater.logger = {
    info: (m: unknown) => console.log('[update]', m),
    warn: (m: unknown) => console.warn('[update]', m),
    error: (m: unknown) => console.warn('[update]', m),
    debug: () => {},
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  // A differential download needs the old release's blockmap beside the new one, which the feed doesn't have.
  autoUpdater.disableDifferentialDownload = true;

  autoUpdater.on('update-downloaded', (info) => {
    const name = releaseName(info.version);
    if (!name || compareReleases(name, current) <= 0 || name === state.ready) return;
    console.log(`[update] ${name} is ready, and installs when the app quits`);
    state = { ...state, ready: name };
    send(state);
  });
  // A failed check or download is tried again at the next check, so it's only logged.
  autoUpdater.on('error', (e) => console.warn('[update]', e?.message ?? e));

  // Kept before electron-updater installs on `quit`, so the next start can tell whether it did.
  app.on('will-quit', () => {
    if (!state.ready) return;
    settings.set('update', { last: current, installing: state.ready } satisfies SavedUpdate);
    settings.flush?.();
  });

  every(() => void autoUpdater.checkForUpdates().catch((e: Error) => console.warn('[update] check:', e.message)));
}

/** For the AUR package: reads the feed to say once that a newer release is out. Downloads and installs nothing. */
function watchFeed(current: string, send: (state: UpdateState) => void): void {
  every(async () => {
    try {
      const res = await net.fetch(LINUX_FEED_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${LINUX_FEED_URL}: ${res.status}`);
      const name = feedRelease(await res.text());
      if (!name || compareReleases(name, current) <= 0 || name === state.out) return;
      console.log(`[update] ${name} is out, and the next system update installs it`);
      state = { ...state, out: name };
      send(state);
    } catch (e) {
      // Tried again at the next check, so it's only logged.
      console.warn('[update] check:', (e as Error).message);
    }
  });
}

function every(check: () => void): void {
  setTimeout(() => {
    check();
    setInterval(check, CHECK_EVERY_MS);
  }, FIRST_CHECK_MS);
}
