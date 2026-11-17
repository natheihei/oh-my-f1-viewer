/** Connects the agent to the palette: what the user types goes to it, and what it says comes back. */
import type { AgentEvent } from '../../shared/api';
import { askAgent, connectTools } from '../agent/bridge';
import { setSpoilerAsker } from '../agent/spoilerGate';
import { errorBlock } from '../../shared/health';
import { host, read, type Attachment } from '../host';
import { loadEvents } from './commands';
import { agentFix, f1tvFix } from './fixes';
import { askViewer, lookAhead } from './lookAhead';
import type { PromptPart } from './mentions';
import { palette, usePalette, type AttachedTag } from './palette';

// Long enough to read the reply before the palette goes.
const AUTO_HIDE_MS = 10_000;

/**
 * The last message sent to the agent, as it went: what a fix sends again once the agent can answer. Only the
 * viewing agent's: build mode's conversation may have moved on by then.
 */
let lastSent: string | null = null;

export function connectAgent(): () => void {
  let streaming: number | null = null;
  let finalText = '';

  const onEvent = (event: AgentEvent) => {
    switch (event.type) {
      case 'turn_start':
        lookAhead.endTurn();
        streaming = null;
        finalText = '';
        palette.setBusy(true);
        break;
      case 'text_delta':
        if (streaming == null) {
          streaming = palette.push('agent', '');
          finalText = '';
        }
        palette.append(streaming, event.delta);
        finalText += event.delta;
        break;
      case 'tool_start':
        // A later reply gets its own line under the tool calls.
        streaming = null;
        break;
      case 'tool_end':
        // What the build agent did to a file, in the app's words.
        if (event.note) palette.push('system', event.note);
        break;
      case 'turn_end': {
        lookAhead.endTurn();
        palette.setBusy(false);
        // Only hide once the agent did something and isn't waiting on an answer, or on suggestions.
        const asking = finalText.includes('?');
        const { session, suggestions, build } = read();
        if (event.acted && !asking && session != null && suggestions.items.length === 0 && !build.active) palette.hideAfter(AUTO_HIDE_MS);
        break;
      }
      case 'error': {
        lookAhead.endTurn();
        palette.setBusy(false);
        if (!event.fix) {
          palette.push('error', event.message);
          break;
        }
        const message = lastSent;
        palette.pushFix(event.message, agentFix(event.fix, message != null && !read().build.active ? () => askAgent(message) : undefined));
        break;
      }
    }
  };

  const offEvent = host.agent.onEvent(onEvent);
  const offTools = connectTools();
  const offAsker = setSpoilerAsker(askViewer);
  return () => {
    offEvent();
    offTools();
    offAsker();
  };
}

/** The tag a tile's attachment is drawn with: its id, and the label in its title bar. */
export const tagOf = ({ scope, report }: Attachment): AttachedTag => ({ scope, label: report.place.label });

/**
 * Sends what the user typed to the agent: the build agent while build mode is on, else the viewing one.
 * `echo: false` when the palette already shows the line, as it does for a `/` command. `parts` is the
 * prompt with its mentions, for the history to draw as tags; `text` is it as the agent reads it.
 *
 * The viewer's message takes the tiles' errors they attached (`live.attached`), as `<error>` blocks before
 * their words, which may be none. `attach: false` leaves them for the next one, for a message the app sends.
 * The viewer's own message also withdraws an offer of build mode. While the agent is working, sending
 * stops its turn and starts one with this.
 */
export async function sendToAgent(text: string, { echo = true, parts, attach = true }: { echo?: boolean; parts?: PromptPart[]; attach?: boolean } = {}): Promise<void> {
  const tagged = parts?.some((p) => typeof p !== 'string');
  const attached = attach ? read().attached : [];
  if (echo) palette.push('user', text, undefined, tagged ? parts : undefined, attached.map(tagOf));
  // Once whatever's missing is fixed, the same message goes again, without echoing it a second time.
  const again = () => sendToAgent(text, { echo: false, parts, attach });
  const status = await host.agent.status();
  if (!status.ready) {
    palette.pushFix("The agent isn't set up yet.", agentFix('setup', again));
    return;
  }
  // The viewing agent finds sessions from the event list: without it, it would only guess.
  if (!read().build.active && read().events.state !== 'ready') {
    const { f1tv } = await host.account.status();
    if (!f1tv.signedIn) {
      palette.pushFix("F1 TV isn't signed in.", f1tvFix('missing', again));
      return;
    }
    if (!(await loadEvents(again))) return;
  }
  if (attach) host.build.dismissOffer();
  // Taken only now: a message that couldn't go leaves them in the tray for the next one.
  const blocks = attach ? host.health.takeAttached().map((a) => errorBlock(a.report)) : [];
  if (usePalette.getState().busy) await host.agent.cancel();
  const message = [...blocks, text].filter(Boolean).join('\n\n');
  lastSent = message;
  await askAgent(message);
}

/** Stops the agent mid-turn. A stopped turn never reports its end, so the palette stops waiting here. */
export async function stopTurn(): Promise<void> {
  await host.agent.cancel();
  lookAhead.endTurn();
  palette.setBusy(false);
  palette.push('system', 'Stopped.');
}
