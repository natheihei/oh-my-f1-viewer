/**
 * Releases are named by date and run, like 20261119.1: the first release made on 19 November 2026. electron-builder
 * needs a semver version, so a release's package version is 20261119.1.0. See docs/RELEASE.md.
 */

/** A release's name from its package version: `20261119.1.0` is `20261119.1`. Null for a version that isn't one. */
export function releaseName(version: string): string | null {
  return /^(\d{8}\.\d+)\.0$/.exec(version)?.[1] ?? null;
}

/** Which OMFV this is. */
export interface AppVersion {
  /** The release's name, or null when it isn't a release, as when it runs from a checkout. */
  release: string | null;
  /** Whether it runs as a packaged app, not from a checkout. */
  packaged: boolean;
}

/** Where releases are published. Each is tagged `app-<name>`. */
export const RELEASES_URL = 'https://github.com/natheihei/oh-my-f1-viewer/releases';

/** The product site, which `/about` opens. See site/DEPLOY.md. */
export const SITE_URL = 'https://oh-my-f1-viewer.yueyao.run';

/** Orders release names, oldest first: negative when `a` came before `b`. */
export function compareReleases(a: string, b: string): number {
  const [aDay, aRun] = a.split('.').map(Number);
  const [bDay, bRun] = b.split('.').map(Number);
  return aDay - bDay || aRun - bRun;
}

/** What the updater has to say: a release ready to install, and what happened to the last one. See electron/updates.ts. */
export interface UpdateState {
  /** A newer release, downloaded, that installs when the app quits. */
  ready: string | null;
  /** The release this start updated to, once, on the first start after an update. */
  updated: string | null;
  /** A release that should have installed when the app last quit, and didn't. */
  failed: string | null;
}
