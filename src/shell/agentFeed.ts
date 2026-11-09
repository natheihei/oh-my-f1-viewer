/** Connects the agent to the palette: what the user types goes to it, and what it says comes back. */
import type { AgentEvent } from '../../shared/api';
import { askAgent, connectTools } from '../agent/bridge';
import { host, read } from '../host';
import { loadEvents } from './commands';
import { palette, usePalette } from './palette';

const AUTO_HIDE_MS = 2000;

export function connectAgent(): () => void {
  let streaming: number | null = null;
  let finalText = '';

  const onEvent = (event: AgentEvent) => {
    switch (event.type) {
      case 'turn_start':
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
      case 'turn_end': {
        palette.setBusy(false);
        // Only hide once the agent did something and isn't waiting on an answer, or on suggestions.
        const asking = finalText.includes('?');
        const { session, suggestions } = read();
        if (event.acted && !asking && session != null && suggestions.items.length === 0) palette.hideAfter(AUTO_HIDE_MS);
        break;
      }
      case 'error':
        palette.setBusy(false);
        palette.push('error', event.message);
        break;
    }
  };

  const offEvent = host.agent.onEvent(onEvent);
  const offTools = connectTools();
  return () => {
    offEvent();
    offTools();
  };
}

export async function sendToAgent(text: string): Promise<void> {
  palette.push('user', text);
  const status = await host.agent.status();
  if (!status.signedIn) {
    palette.push('system', 'The agent needs a ChatGPT sign-in first: /login-chatgpt');
    return;
  }
  // The agent finds sessions from the event list: without it, it would only guess.
  if (read().events.state !== 'ready') {
    const { f1tv } = await host.account.status();
    if (!f1tv.signedIn) {
      palette.push('system', 'The agent needs F1 TV signed in first: /login-f1tv');
      return;
    }
    if (!(await loadEvents())) return;
  }
  if (usePalette.getState().busy) await host.agent.cancel();
  await askAgent(text);
}

/** Stops the agent mid-turn. A stopped turn never reports its end, so the palette stops waiting here. */
export async function stopTurn(): Promise<void> {
  await host.agent.cancel();
  palette.setBusy(false);
  palette.push('system', 'Stopped.');
}
