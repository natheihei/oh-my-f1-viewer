/** Runs the agent's tool calls, and tells it what the app looks like with each message. */
import type { AgentToolCall } from '../../shared/api';
import { FIRST_SEASON, host, read, tilesOf, type ComponentInfo, type ComponentSpec, type EventIndex, type GroupNode, type LayoutState } from '../host';
import { driverCount, formatClock, runTool, toolDefinitions } from './tools';

/** A stream by its label, a chart by its label and chart name. */
const describeTile = (c: ComponentSpec) => (c.type === 'video' ? c.label : `${c.label} (${c.type} chart)`);

function describeLayout(state: LayoutState): string {
  if (state.nodes.length === 0) return 'nothing';
  return state.nodes
    .map((n) => (n.kind === 'tile' ? describeTile(n.component) : `group "${(n as GroupNode).title}" [${n.children.map((c) => describeTile(c.component)).join(', ')}]`))
    .join('; ');
}

/** The audible feed and the master volume together, so a feed is never called audible at volume 0. */
function describeAudio(label: string | null, volume: number): string {
  if (label == null) return 'muted';
  if (volume === 0) return `${label}, but the volume is 0 so nothing can be heard`;
  return `${label} at ${Math.round(volume * 100)}% volume`;
}

/**
 * The state block sent with each user message. Contains nothing about how the race goes: the roster is
 * who is entered, not where they are. `note` is what the user did with the last turn's suggestions.
 */
export function describeAppState(note: string | null = null): string {
  const { session, audio, volume, feeds, clock, streams, countdown, layout, sessionData } = read();
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
    `audio: ${describeAudio(feeds.find((f) => f.id === audio)?.label ?? null, volume)}`,
  );
  if (sessionData.state === 'ready') {
    if (sessionData.playheadMs != null) lines.push(`playhead: ${Math.round(sessionData.playheadMs)} (UTC ms, as in date columns)`);
    const roster = sessionData.drivers
      .filter((d) => d.name_acronym)
      .map((d) => `${d.name_acronym} ${d.driver_number}`)
      .join(', ');
    if (roster) lines.push(`drivers: ${roster}`);
  } else {
    lines.push(`timing data: ${sessionData.state}`);
  }
  if (failed.length) lines.push(`failed streams: ${failed.join('; ')}`);
  if (note) lines.push(`suggestions: ${note}`);
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 24-26", or "Feb 28-Mar 2" across a month, in UTC. */
function dateRange(startMs: number, endMs: number): string {
  const a = new Date(startMs);
  const b = new Date(endMs || startMs);
  const start = `${MONTHS[a.getUTCMonth()]} ${a.getUTCDate()}`;
  if (a.getUTCMonth() === b.getUTCMonth()) return a.getUTCDate() === b.getUTCDate() ? start : `${start}-${b.getUTCDate()}`;
  return `${start}-${MONTHS[b.getUTCMonth()]} ${b.getUTCDate()}`;
}

/**
 * Every supported event, for the system prompt: one line each, with the pageId list_sessions takes.
 * Names, rounds and dates only, so nothing in it can spoil a result.
 */
export function describeEvents(index: EventIndex): string {
  const lines = [`Events on F1 TV, ${FIRST_SEASON} on. Each line: pageId, round, name, dates (UTC).`];
  for (const { year, events } of index.seasons) {
    lines.push('', `${year}:`);
    for (const e of [...events].sort((a, b) => a.startMs - b.startMs)) {
      const round = e.isTest ? 'test' : `R${e.round}`;
      lines.push(`${e.pageId} ${round} ${e.shortName || e.name}, ${dateRange(e.startMs, e.endMs)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Every chart `suggest_tiles` can offer, for the system prompt: one line each, or nothing when there
 * are none. Only what each chart is for, never what it shows.
 */
export function describeCharts(components: ComponentInfo[]): string {
  const charts = components.filter((c) => c.name !== 'video');
  if (charts.length === 0) return '';
  const lines = ['Charts for suggest_tiles. Each line: name, title, drivers it takes, session types, what it is for. One that can take none picks its own.'];
  for (const c of charts) {
    lines.push(`${c.name}, ${c.title}, ${driverCount(c).text}, ${c.sessions ? c.sessions.join('/') : 'any session'}: ${c.description}`);
  }
  return lines.join('\n');
}

/** A message starts a new turn, which clears the suggestion strip. */
export function askAgent(text: string): Promise<void> {
  const note = host.suggestions.newTurn();
  const { events, components } = read();
  const reference = [describeEvents(events), describeCharts(components)].filter(Boolean).join('\n\n');
  return host.agent.send(text, describeAppState(note), toolDefinitions(), reference);
}
