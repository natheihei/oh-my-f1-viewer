/**
 * Going home: closing the open session, or the countdown to one, back to the screen the app starts on with
 * nothing open, where the landing page lists sessions and a message goes to the picking agent. `/close-session`,
 * the timeline's close button and the countdown's both come here. The viewing agent's `close_session` calls the
 * host itself, in its own turn. See docs/DESIGN.md (Leaving a session).
 */
import { host, read } from '../host';
import { lookAhead } from './lookAhead';
import { palette, usePalette } from './palette';

export async function goHome(): Promise<void> {
  const { session, countdown, build } = read();
  if (!session && !countdown) return;
  // Build mode works on the open session, and has its own way out that keeps or undoes what it changed.
  if (build.active) {
    palette.push('system', 'Leave build mode first: Save or Undo all.');
    return;
  }
  // A turn still running is about the session that's going.
  if (usePalette.getState().busy) {
    await host.agent.cancel();
    lookAhead.endTurn();
    palette.setBusy(false);
  }
  host.session.close();
  palette.push('system', session ? `Closed ${session.title}.` : `Stopped the countdown to ${countdown!.title}.`);
}
