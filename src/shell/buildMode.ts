/**
 * Build mode, as the palette runs it: `/build` enters, and Save or Undo all leaves. While it's on,
 * what the viewer types goes to the build agent. See docs/BUILD_MODE.md.
 */
import { formatClock } from '../agent/tools';
import { tellViewingAgent } from '../agent/bridge';
import { host, read } from '../host';
import { sendToAgent } from './agentFeed';
import { lookAhead } from './lookAhead';
import { palette } from './palette';

/** Leaving offers the way back only when playback has moved this far from where the viewer entered. */
const RETURN_WORTH_SEC = 5;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');

/** Enters build mode if it isn't on, then sends `request` to the build agent, if there is one. */
export async function enterBuild(request: string): Promise<void> {
  if (!read().build.active) {
    try {
      await host.build.begin();
    } catch (e) {
      palette.push('error', `Couldn't start build mode: ${errorText(e)}`);
      return;
    }
    // Trying a draft moves the playhead, and the race shouldn't run on unwatched while the viewer builds.
    if (read().session) host.playback.pause();
    palette.push('system', 'Build mode. Save keeps what gets built, Undo all puts everything back.');
  }
  if (request) await sendToAgent(request, { echo: false });
}

/** Offers to go back to where the viewer was on entering, since trying a control moves the playhead. */
function offerReturn(enteredAtSec: number | null): void {
  const { session, clock } = read();
  if (!session || enteredAtSec == null || Math.abs(clock.timeSec - enteredAtSec) < RETURN_WORTH_SEC) return;
  const at = formatClock(enteredAtSec);
  palette.push('system', `You entered build mode at ${at}.`, {
    label: `back to ${at}`,
    run: () => host.playback.seek({ time: enteredAtSec }),
  });
}

/** Leaves build mode, keeping what it changed or putting the mods folder back. */
export async function leaveBuild(how: 'save' | 'undo'): Promise<void> {
  const { active, enteredAtSec } = read().build;
  if (!active) return;
  // The build agent stops here: a turn still running would go on writing files.
  await host.agent.endBuild();
  lookAhead.endTurn();
  palette.setBusy(false);
  try {
    if (how === 'save') {
      const summary = await host.build.save();
      palette.push('system', summary ? `Saved. ${summary}` : 'Left build mode. Nothing was changed.');
      // The viewing agent learns of the build from this line and nothing else.
      if (summary) tellViewingAgent(summary);
    } else {
      const count = await host.build.undo();
      palette.push('system', count ? `Undid ${count} ${count === 1 ? 'change' : 'changes'}.` : 'Left build mode. Nothing was changed.');
    }
  } catch (e) {
    palette.push('error', `Couldn't leave build mode: ${errorText(e)}`);
    return;
  }
  offerReturn(enteredAtSec);
}
