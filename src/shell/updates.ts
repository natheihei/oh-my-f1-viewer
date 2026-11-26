/**
 * What the palette says about updates. A release installed as an AppImage, a Mac app or a Windows app downloads
 * the next one in the background and installs it when it quits (electron/updates.ts): the palette says once that
 * it's ready with a one-click restart button, and on the next start, which release it is now. Nothing over the
 * video, and it never restarts on its own. See docs/RELEASE.md.
 */
import type { UpdateState } from '../../shared/release';
import { host } from '../host';
import { palette, type PaletteEntry } from './palette';

export const readyLine = (release: string) => `OMFV ${release} is ready.`;
export const updatedLine = (release: string) => `Updated to OMFV ${release}. /whats-new lists what changed.`;
export const failedLine = (release: string) => `OMFV ${release} didn't install. It tries again next time you start oh-my-f1-viewer.`;

const errorText = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '').trim();

/** The inline button on an update-ready line: restarts straight away to install `release`. */
export function restartAction(release: string): NonNullable<PaletteEntry['action']> {
  return {
    label: 'restart to update',
    run: () => {
      palette.push('system', `Restarting to install OMFV ${release}…`);
      void host.app.installUpdate().catch((e: unknown) => {
        palette.push('error', `Couldn't restart to install OMFV ${release}: ${errorText(e)}`);
      });
    },
  };
}

/**
 * Says what the last update did, then each release once it's ready. `reported` settles once the start's lines are
 * in, so they come before "Ready.".
 */
export function watchUpdates(): { reported: Promise<void>; off: () => void } {
  let said: string | null = null;
  const sayReady = (state: UpdateState) => {
    if (!state.ready || state.ready === said) return;
    said = state.ready;
    palette.push('system', readyLine(state.ready), restartAction(state.ready));
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
