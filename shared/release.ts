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
