/** Which OMFV this is. See docs/RELEASE.md. */
import type { AppVersion } from '../../shared/release';

export const appInfo = {
  version: (): Promise<AppVersion> => window.omfv.app.version(),
};
