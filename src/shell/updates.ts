/**
 * What the palette says about updates. A release installed as an AppImage or a Mac app downloads the next one in
 * the background and installs it when it quits (electron/updates.ts): the palette says once that it's ready, and
 * on the next start, which release it is now. The AUR package is updated with the system: the palette says once
 * that a release is out. Nothing to do, and nothing over the video. See docs/RELEASE.md.
 */
import type { UpdateState } from '../../shared/release';
import { host } from '../host';
import { palette } from './palette';

export const readyLine = (release: string) => `OMFV ${release} is ready. It automatically installs next time you start oh-my-f1-viewer.`;
export const updatedLine = (release: string) => `Updated to OMFV ${release}. /whats-new lists what changed.`;
export const outLine = (release: string) => `OMFV ${release} is out. Your next system update installs it.`;
export const failedLine = (release: string) => `OMFV ${release} didn't install. It tries again next time you start oh-my-f1-viewer.`;

/**
 * Says what the last update did, then each release once it's ready. `reported` settles once the start's lines are
 * in, so they come before "Ready.".
 */
export function watchUpdates(): { reported: Promise<void>; off: () => void } {
  let ready: string | null = null;
  let out: string | null = null;
  const sayReady = (state: UpdateState) => {
    if (state.ready && state.ready !== ready) {
      ready = state.ready;
      palette.push('system', readyLine(state.ready));
    }
    if (state.out && state.out !== out) {
      out = state.out;
      palette.push('system', outLine(state.out));
    }
  };
  const off = host.app.onUpdate(sayReady);
  const reported = host.app
    .update()
    .then((state) => {
      if (state.updated) palette.push('system', updatedLine(state.updated));
      if (state.failed) palette.push('error', failedLine(state.failed));
      sayReady(state);
    })
    .catch((e: Error) => console.warn('[update]', e.message));
  return { reported, off };
}
