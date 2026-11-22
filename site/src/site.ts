/** The repo on GitHub, where "Star on GitHub" goes. */
export const REPO_HREF = 'https://github.com/natheihei/oh-my-f1-viewer';

/** Every release on GitHub, with its notes, for following along there. */
export const RELEASES_HREF = `${REPO_HREF}/releases`;

/** Where "Download" goes: the page with a link to each file in the latest release. */
export const DOWNLOAD_HREF = '/download';

/** What the release builds for. See docs/RELEASE.md. */
export const PLATFORMS = 'macOS (Apple silicon), Windows and Linux';

/** Team colours, for driver and team tags drawn the way the app draws them. */
export const TEAM = {
  ferrari: '#e8002d',
  redbull: '#3671c6',
  mclaren: '#ff8000',
  mercedes: '#27f4d2',
} as const;
