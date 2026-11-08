/** Runs the agent's tool calls, and tells it what the app looks like with each message. */
import type { AgentToolCall } from '../../shared/api';
import { host, read, tilesOf, type GroupNode, type LayoutState } from '../host';
import { runTool, toolDefinitions } from './tools';

function describeLayout(state: LayoutState): string {
  if (state.nodes.length === 0) return 'nothing';
  return state.nodes
    .map((n) => (n.kind === 'tile' ? n.component.label : `group "${(n as GroupNode).title}" [${n.children.map((c) => c.component.label).join(', ')}]`))
    .join('; ');
}

function formatClock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** The state block sent with each user message. Contains nothing about how the race goes. */
export function describeAppState(): string {
  const { session, audio, feeds, clock, streams, countdown, layout } = read();
  const lines = [`now: ${new Date().toISOString().slice(0, 16)}Z`];
  if (countdown) lines.push(`countdown running for: ${countdown.title}`);
  if (!session) {
    lines.push('session: none open');
    return lines.join('\n');
  }
  const failed = tilesOf(layout)
    .filter((t) => streams[t.component.key]?.status === 'error')
    .map((t) => `${t.component.label}: ${streams[t.component.key]?.error}`);
  lines.push(
    `session: ${session.title} (${session.status})`,
    `playback: ${clock.playing ? 'playing' : 'paused'} at ${formatClock(clock.timeSec)}`,
    `on screen: ${describeLayout(layout)}`,
    `audio: ${feeds.find((f) => f.id === audio)?.label ?? 'muted'}`,
  );
  if (failed.length) lines.push(`failed streams: ${failed.join('; ')}`);
  return lines.join('\n');
}

async function handleToolCall(call: AgentToolCall): Promise<void> {
  try {
    const content = await runTool(call.name, call.args);
    host.agent.toolResult({ callId: call.callId, ok: true, content });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    host.agent.toolResult({
      callId: call.callId,
      ok: false,
      content: message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ''),
    });
  }
}

export function connectTools(): () => void {
  return host.agent.onToolCall((call) => void handleToolCall(call));
}

export function askAgent(text: string): Promise<void> {
  return host.agent.send(text, describeAppState(), toolDefinitions());
}
