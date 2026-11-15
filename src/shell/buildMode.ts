/**
 * Build mode, as the palette runs it: `/build` or an offer from the viewing agent enters, and Save or
 * Undo all leaves. While it's on, what the viewer types goes to the build agent. See docs/BUILD_MODE.md.
 */
import { drawsAgainBlock, errorBlock } from '../../shared/health';
import { formatClock } from '../agent/tools';
import { tellViewingAgent } from '../agent/bridge';
import { host, read, type BuildOffer } from '../host';
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
  // The tray waits for the viewer's own next message: this one is the app's.
  if (request) await sendToAgent(request, { echo: false, attach: false });
}

/**
 * Takes up the viewing agent's offer: enters build mode, and starts the build agent on it at once. Its
 * conversation is its own, so its first message is all it knows: each offered tile as it stands now, and
 * the viewing agent's note. A tile drawing again by now still goes, saying so, and the build agent tells the
 * viewer there's nothing to fix.
 */
export async function switchToBuild(offer: BuildOffer): Promise<void> {
  const reports = host.health.errors({ tiles: offer.tiles });
  const blocks = offer.tiles.map((tile) => {
    const report = reports.find((r) => r.place.scope === tile);
    return report ? errorBlock(report) : drawsAgainBlock(tile, read().health.find((p) => p.scope === tile && p.where === 'tile') ?? null);
  });
  host.build.dismissOffer();
  const request = [...blocks, `<from_viewing_agent>\n${offer.note}\n</from_viewing_agent>`].join('\n\n');
  await enterBuild('');
  if (!read().build.active) return;
  if (offer.tiles.length) {
    const tags = offer.tiles.map((tile) => ({ scope: tile, label: read().health.find((p) => p.scope === tile)?.label ?? tile }));
    palette.push('system', 'went to the build agent.', undefined, undefined, tags);
  } else {
    palette.push('system', `Asked the build agent to ${offerReason(offer.reason, false)}.`);
  }
  await sendToAgent(request, { echo: false, attach: false });
}

/** The offer's reason as a phrase in a sentence: its first letter up to start one, or down to go inside one. */
export function offerReason(reason: string, start: boolean): string {
  const text = reason.trim().replace(/[\s.?!]+$/, '');
  // "HAM's tyres" keeps its capitals.
  if (!start && /^[A-Z][A-Z0-9]/.test(text)) return text;
  return (start ? text.charAt(0).toUpperCase() : text.charAt(0).toLowerCase()) + text.slice(1);
}

/** Turns the viewing agent's offer down: the tiles stay as they are, and can be attached again. */
export function stayInView(): void {
  host.build.dismissOffer();
  palette.push('system', 'Stayed in view mode.');
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
