/** Connects the agent's events to the palette and its tool calls to the executor. */
import type { AgentEvent } from '../../shared/api';
import { palette, usePalette } from '../shell/palette';
import { isSessionOpen } from '../shell/viewing';
import { describeAppState, handleToolCall } from './executor';

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
        const asking = finalText.trim().endsWith('?');
        if (event.acted && !asking && isSessionOpen()) palette.hideAfter(AUTO_HIDE_MS);
        break;
      }
      case 'error':
        palette.setBusy(false);
        palette.push('error', event.message);
        break;
    }
  };

  const offEvent = window.f1a.ai.onEvent(onEvent);
  const offTool = window.f1a.ai.onToolCall((call) => void handleToolCall(call));
  return () => {
    offEvent();
    offTool();
  };
}

export async function sendToAgent(text: string): Promise<void> {
  palette.push('user', text);
  const status = await window.f1a.ai.status().catch(() => ({ signedIn: false, model: null }));
  if (!status.signedIn) {
    palette.push('system', 'The agent needs a ChatGPT sign-in first: /login-chatgpt');
    return;
  }
  if (usePalette.getState().busy) await window.f1a.ai.cancel();
  await window.f1a.ai.send(text, describeAppState());
}
