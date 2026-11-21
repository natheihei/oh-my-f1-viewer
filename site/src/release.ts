/**
 * The latest app release, for the download page. The site and the app are released apart (docs/RELEASE.md), so the
 * page is built with the release that was latest then, and its script asks GitHub again in the browser and moves the
 * links on to a newer one. A release's files are named by version, so neither can link to a fixed name.
 */

/** GitHub's API for the release marked latest. It answers browsers too (it sends CORS headers), with no token. */
export const LATEST_API = 'https://api.github.com/repos/natheihei/oh-my-f1-viewer/releases/latest';

/** Each file the page offers, by how the release names it (see `artifactName` in electron-builder.yml). */
export const TARGETS = {
  mac: /-mac-arm64\.dmg$/,
  appimage: /-linux-x86_64\.AppImage$/,
  pacman: /-linux-x64\.pacman$/,
} as const;
export type Target = keyof typeof TARGETS;

export interface File {
  name: string;
  /** Bytes */
  size: number;
  url: string;
}

export interface Release {
  /** "OMFV 20261121.1" */
  name: string;
  /** When it was published, ISO 8601 */
  published: string;
  /** Its page on GitHub, with the notes */
  url: string;
  files: Partial<Record<Target, File>>;
  sums?: File;
}

interface GitHubAsset {
  name: string;
  size: number;
  browser_download_url: string;
}
interface GitHubRelease {
  name: string | null;
  tag_name: string;
  published_at: string;
  html_url: string;
  assets: GitHubAsset[];
}

const file = (a: GitHubAsset): File => ({ name: a.name, size: a.size, url: a.browser_download_url });

/** Reads GitHub's answer. Used on the server and in the browser, so it stays plain. */
export function readRelease(json: GitHubRelease): Release {
  const files: Release['files'] = {};
  for (const [target, pattern] of Object.entries(TARGETS) as [Target, RegExp][]) {
    const found = json.assets.find((a) => pattern.test(a.name));
    if (found) files[target] = file(found);
  }
  const sums = json.assets.find((a) => a.name === 'SHA256SUMS');
  return {
    name: json.name || json.tag_name,
    published: json.published_at,
    url: json.html_url,
    files,
    sums: sums && file(sums),
  };
}

export async function fetchLatest(): Promise<Release> {
  const res = await fetch(LATEST_API, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return readRelease(await res.json());
}

/** "146 MB" */
export const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** "21 Nov 2026", in UTC like the release's name */
export const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
