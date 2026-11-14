/** Connects the agent to the palette: what the user types goes to it, and what it says comes back. */
import { useEffect } from 'react';
import type { AgentEvent } from '../../shared/api';
import { askAgent, connectTools } from '../agent/bridge';
import { setSpoilerAsker } from '../agent/spoilerGate';
import { host, read, useLive } from '../host';
import { loadEvents } from './commands';
import { askViewer, lookAhead } from './lookAhead';
import type { PromptPart } from './mentions';
import { palette, usePalette } from './palette';

// Long enough to read the reply before the palette goes.
const AUTO_HIDE_MS = 10_000;

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
      case 'error':
        lookAhead.endTurn();
        palette.setBusy(false);
        palette.push('error', event.message);
        break;
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

/**
 * A tile's "Ask agent to fix" leaves its request in `live.fixRequests`. This takes each one, opens the
 * palette, and sends it as a line of the viewer's.
 */
export function useFixRequests(): void {
  const requests = useLive((s) => s.fixRequests);
  useEffect(() => {
    for (const { id } of requests) {
      const request = host.health.takeFix({ id });
      if (!request) continue;
      palette.show();
      void sendToAgent(request.text);
    }
  }, [requests]);
}

/**
 * Sends what the user typed to the agent: the build agent while build mode is on, else the viewing one.
 * `echo: false` when the palette already shows the line, as it does for a `/` command. `parts` is the
 * prompt with its mentions, for the history to draw as tags; `text` is it as the agent reads it.
 */
export async function sendToAgent(text: string, { echo = true, parts }: { echo?: boolean; parts?: PromptPart[] } = {}): Promise<void> {
  const tagged = parts?.some((p) => typeof p !== 'string');
  if (echo) palette.push('user', text, undefined, tagged ? parts : undefined);
  const status = await host.agent.status();
  if (!status.ready) {
    palette.push('system', 'The agent needs setting up first: /settings-agent');
    return;
  }
  // The viewing agent finds sessions from the event list: without it, it would only guess.
  if (!read().build.active && read().events.state !== 'ready') {
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
  lookAhead.endTurn();
  palette.setBusy(false);
  palette.push('system', 'Stopped.');
}
