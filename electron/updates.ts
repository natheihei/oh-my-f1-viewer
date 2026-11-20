/**
 * Keeps a release of OMFV up to date: checks GitHub for a newer release, downloads it in the background, and
 * installs it when the app quits, so the next start is the new release. Never restarts the app, never asks.
 * Only the AppImage and the Mac app: the pacman package is installed by hand (issue 181). See docs/RELEASE.md.
 *
 * electron-updater does the work, from the feed electron-builder.yml names under `publish`: `latest-linux.yml` or
 * `latest-mac.yml` on the release marked latest.
 */
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { compareReleases, releaseName, type UpdateState } from '../shared/release';
import { appSettings, type Settings } from './settings';

/** The first check waits for the app to settle, then they come every few hours. */
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;

/** What the settings keep under `update` between runs. */
export interface SavedUpdate {
  /** The release that ran last. */
  last?: string;
  /** The release that was to install when the app last quit. */
  installing?: string;
}

const NOTHING: UpdateState = { ready: null, updated: null, failed: null };
let state: UpdateState = NOTHING;

/** Whether this build updates itself: a release, installed as an AppImage or a Mac app. */
export function canUpdate(): boolean {
  if (!app.isPackaged || !releaseName(app.getVersion())) return false;
  return process.platform === 'darwin' || (process.platform === 'linux' && !!process.env.APPIMAGE);
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
  if (!current || !canUpdate()) return;
  state = { ready: null, ...afterStart(current, readSaved(settings.get('update'))) };
  settings.set('update', { last: current } satisfies SavedUpdate);

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

  const check = () => void autoUpdater.checkForUpdates().catch((e: Error) => console.warn('[update] check:', e.message));
  setTimeout(() => {
    check();
    setInterval(check, CHECK_EVERY_MS);
  }, FIRST_CHECK_MS);
}
