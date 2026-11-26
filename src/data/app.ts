/** Which OMFV this is, and its updates. See docs/RELEASE.md. */
import type { AppVersion, UpdateState } from '../../shared/release';

export const appInfo = {
  version: (): Promise<AppVersion> => window.omfv.app.version(),
  /** What the updater has to say: a release ready to install on quit, and what the last update did. */
  update: (): Promise<UpdateState> => window.omfv.app.update(),
  onUpdate: (cb: (state: UpdateState) => void): (() => void) => window.omfv.app.onUpdate(cb),
  /** Installs the ready update and restarts the app. */
  installUpdate: (): Promise<void> => window.omfv.app.installUpdate(),
  /** Opens this release's notes in the browser. */
  whatsNew: (): Promise<void> => window.omfv.app.whatsNew(),
  /** Opens the OMFV site in the browser. */
  about: (): Promise<void> => window.omfv.app.about(),
};
