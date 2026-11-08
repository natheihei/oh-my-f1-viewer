/** Connects the agent to the palette: what the user types goes to it, and what it says comes back. */
import type { AgentEvent } from '../../shared/api';
import { askAgent, connectTools } from '../agent/bridge';
import { host, read } from '../host';
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
        // Only hide once the agent did something and isn't waiting on an answer.
        const asking = finalText.includes('?');
        if (event.acted && !asking && read().session != null) palette.hideAfter(AUTO_HIDE_MS);
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
  if (usePalette.getState().busy) await host.agent.cancel();
  await askAgent(text);
}
