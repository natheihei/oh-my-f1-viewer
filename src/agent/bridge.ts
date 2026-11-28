/** Runs the agent's tool calls, and tells it what the app looks like with each message. */
import type { AgentHandoff, AgentMode, AgentScope, AgentToolCall, AgentToolDefinition, AgentToolResult, SessionInfo } from '../../shared/api';
import { describePlace, notDrawing } from '../../shared/health';
import { rosterOf, type SessionDataView } from '../../shared/sessionData';
import { FIRST_SEASON, host, labelText, misfit, read, tilesOf, type ComponentInfo, type EventIndex, type Live, type Tile } from '../host';
import { beginTurn } from './dataWait';
import { formatClock, offeredComponents, propsText, readsPastPlayhead, runTool, toolDefinitions } from './tools';

/**
 * A tile by its id, then what its title bar says, which its component may set itself, then its
 * component and props, and the feeds it shows, so the agent can name and change it. The tile with
 * the main place says so, so "close all" can leave it.
 */
function describeTile({ id, component: c }: Tile, live: Live): string {
  const header = live.headers[id];
  // A place is said with whoever holds it at the playhead, as the title bar draws it: "Telemetry P1 VER".
  const own = c.title ? labelText(c.title.name, c.title.drivers, undefined, { now: true }) : c.label;
  const label = header?.drivers ? labelText(header.label ?? '', header.drivers) : (header?.label ?? own);
  const main = live.layout.main === id ? ', main' : '';
  if (c.type === 'video') return `${id} ${label} (stream${typeof c.props.driver === 'string' ? `, following ${c.props.driver}` : ''}${main})`;
  const shows = Object.values(live.streams)
    .filter((v) => v.tile === id && !v.quiet)
    .map((v) => live.feeds.find((f) => f.id === v.feed)?.label ?? v.feed);
  const props = Object.keys(c.props).length ? `, props ${JSON.stringify(c.props)}` : '';
  return `${id} ${label} (${c.type}${props}${shows.length ? `, shows ${shows.join(', ')}` : ''}${main})`;
}

const describeLayout = (live: Live): string => (live.layout.tiles.length === 0 ? 'nothing' : live.layout.tiles.map((t) => describeTile(t, live)).join('; '));

/** The heard video as the agent names it: its feed, and the tile it's in. */
function heardLabel(live: Live): string | null {
  const video = live.audio != null ? live.streams[live.audio] : undefined;
  if (!video) return null;
  const feed = live.feeds.find((f) => f.id === video.feed)?.label ?? video.feed;
  return video.tile ? `${feed} in ${video.tile}` : feed;
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
/** Playback in a word. Until a stream is ready, the clock hasn't moved and would read as paused. */
function describePlayback(live: Live): string {
  const { clock, streams } = live;
  const shown = Object.values(streams);
  if (shown.length > 0 && !shown.some((s) => s.status === 'ready')) return 'starting';
  return clock.playing ? 'playing' : 'paused';
}

export function describeAppState(note: string | null = null, build: string | null = null): string {
  const live = read();
  const { session, volume, clock, streams, countdown, layout, sessionData } = live;
  const lines = [`now: ${new Date().toISOString().slice(0, 16)}Z`];
  if (countdown) lines.push(`countdown running for: ${countdown.title}`);
  if (build) lines.push(build);
  if (!session) {
    lines.push('session: none open');
    return lines.join('\n');
  }
  const failed = tilesOf(layout).flatMap((t) =>
    Object.values(streams)
      .filter((v) => v.tile === t.id && v.status === 'error')
      .map((v) => `${t.id} ${live.feeds.find((f) => f.id === v.feed)?.label ?? v.feed}: ${v.error}`),
  );
  lines.push(
    `session: ${session.title} (${session.status})`,
    `playback: ${describePlayback(live)} at ${formatClock(clock.timeSec)}`,
    `on screen: ${describeLayout(live)}`,
    `audio: ${describeAudio(heardLabel(live), volume)}`,
  );
  const roster = rosterOf(sessionData)
    .filter((d) => d.name_acronym)
    .map((d) => `${d.name_acronym} ${d.driver_number}`)
    .join(', ');
  const describeBackfill = (bf: { state: string } | null | undefined): string | null => {
    if (!bf) return null;
    if (bf.state === 'catching-up') {
      return 'live backfill: catching up in the background (live data is ready now; earlier session history is still filling in automatically)';
    }
    if (bf.state === 'unavailable') {
      return 'live backfill: unavailable for this session (only live data from when the viewer joined is present)';
    }
    if (bf.state === 'complete') {
      return 'live backfill: complete (historical live data backfilled up to join time)';
    }
    return null;
  };
  if (sessionData.state === 'ready') {
    if (sessionData.playheadMs != null) lines.push(`playhead: ${Math.round(sessionData.playheadMs)} (UTC ms, as in date columns)`);
    const bfLine = describeBackfill(sessionData.backfill);
    if (bfLine) lines.push(bfLine);
    if (roster) lines.push(`drivers: ${roster}`);
  } else if (sessionData.state === 'waiting') {
    lines.push(`timing data: waiting, so nothing at the frame on screen can be read. ${sessionData.reason}: ${sessionData.detail}`);
    const bfLine = describeBackfill(sessionData.backfill);
    if (bfLine) lines.push(bfLine);
    if (roster) lines.push(`drivers: ${roster}`);
  } else if (sessionData.state === 'failed' || sessionData.state === 'unsupported') {
    lines.push(`timing data: ${sessionData.state}. ${sessionData.reason}`);
  } else {
    lines.push('timing data: loading. query_session and seek_to wait for it, so call them as usual');
  }
  if (failed.length) lines.push(`failed streams: ${failed.join('; ')}`);
  if (note) lines.push(`suggestions: ${note}`);
  return lines.join('\n');
}

/** Which agent the turn in progress belongs to, and what its conversation is about: its tool calls arrive without saying. */
let turnMode: AgentMode = 'pick';
let turnScope: AgentScope = 'pick';
/** The names of the tools the model has now, to tell when a call changed them. */
let shownTools = '';
/** Whether the model has the session's table list. It's sent with a call's result once the data that was loading has it. */
let shownTables = true;

/** Each opening of a session, by the object it opened with: the data layer makes a new one every time. */
const openings = new WeakMap<SessionInfo, AgentScope>();
let opened = 0;

/** What a viewing message is about: picking, with no session open, or this opening of the open one. */
function scopeOf(session: SessionInfo | null): AgentScope {
  if (!session) return 'pick';
  let scope = openings.get(session);
  if (!scope) {
    opened += 1;
    scope = `view-${opened}`;
    openings.set(session, scope);
  }
  return scope;
}

/**
 * What the picking or viewing agent knows up front, least likely to change first. The picking agent has only
 * the events. The viewing one keeps them, to switch sessions, then has the components and tables.
 */
function referenceFor(mode: AgentMode): string {
  const { events, sessionData } = read();
  if (mode === 'pick') return describeEvents(events);
  return [describeEvents(events), [describeComponents(offeredComponents()), describeUnoffered()].filter(Boolean).join('\n'), describeTables(sessionData)]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * A call that opened a session hands the message on to a new viewing conversation for it, which answers it
 * from the start with what the open session offers. One that closed it doesn't: the turn goes on without a
 * session, and the next message starts picking.
 */
function handoff(): AgentHandoff | undefined {
  if (turnMode === 'build') return undefined;
  const scope = scopeOf(read().session);
  if (scope === turnScope || scope === 'pick') return undefined;
  const tools = toolDefinitions('view');
  turnMode = 'view';
  turnScope = scope;
  shownTools = namesOf(tools);
  shownTables = hasTables();
  // The new conversation sees only an open session: without this, it tells the user it was already open.
  const appState = `${describeAppState()}\njust opened: this message's own earlier step opened the session, a moment ago`;
  return { mode: 'view', scope, appState, reference: referenceFor('view'), tools };
}

const namesOf = (tools: AgentToolDefinition[]): string => tools.map((t) => t.name).join(',');

/** The tools to send with a call's result: the new set, when the call opened or closed a session. */
function changedTools(mode: AgentMode): AgentToolDefinition[] | undefined {
  const tools = toolDefinitions(mode);
  if (namesOf(tools) === shownTools) return undefined;
  shownTools = namesOf(tools);
  return tools;
}

const hasTables = (): boolean => describeTables(read().sessionData) !== '';

/**
 * The reference to send with a call's result: the whole of it again, once the table list it went without is
 * there. A message sent while the session's data was loading has no tables to write a query from until then.
 */
function changedReference(mode: AgentMode): string | undefined {
  if (shownTables || mode === 'pick' || !hasTables()) return undefined;
  shownTables = true;
  return mode === 'build' ? buildReference() : referenceFor(mode);
}

/** What changed for the model with a call, whether it worked or not: a handoff, or new tools and the table list. */
function changes(mode: AgentMode): Pick<AgentToolResult, 'handoff' | 'tools' | 'reference'> {
  const next = handoff();
  if (next) return { handoff: next };
  return { tools: changedTools(mode), reference: changedReference(mode) };
}

async function handleToolCall(call: AgentToolCall): Promise<void> {
  const mode = turnMode;
  try {
    const content = await runTool(call.name, call.args, mode);
    const pastPlayhead = readsPastPlayhead(call.name, call.args, mode);
    host.agent.toolResult({ callId: call.callId, ok: true, content, pastPlayhead, ...changes(mode) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Even a call that failed may have opened a session, part way.
    host.agent.toolResult({
      callId: call.callId,
      ok: false,
      content: message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ''),
      ...changes(mode),
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
 * The components `suggest_tiles` can offer, for the system prompt: one line each, or nothing when
 * there are none. Video isn't one: `streams` names feeds. Only what each is for, never what it shows.
 * The viewing agent gets only those that fit the open session; the build agent gets every one, since
 * it writes and edits them, each marked installed or local.
 */
export function describeComponents(components: ComponentInfo[], { origins = false } = {}): string {
  const offered = components.filter((c) => c.name !== 'video');
  if (offered.length === 0) return '';
  const lines = [
    'Components for suggest_tiles. Each line: name, title, session types, what it is for, then its props. One marked replays only cannot be suggested in a live session. Give a component every required prop; an optional one left out does what its description says. A prop named driver… is one driver and drivers… a list, each by code, surname or car number.' +
      (origins ? ' Each name is followed by (installed), read-only with its source in .installed/builtin/<name>/, or (local), a mod in the folder <name>/.' : ''),
  ];
  for (const c of offered) {
    const origin = origins ? ` (${c.origin})` : '';
    lines.push(`${c.name}${origin}, ${c.title}, ${c.sessions ? c.sessions.join('/') : 'any session'}${c.replayOnly ? ', replays only' : ''}: ${c.description} ${propsText(c)}.`);
  }
  return lines.join('\n');
}

/**
 * The components left out of the viewing agent's list because they don't fit the open session, by name and why, so
 * asked for one it can say why rather than that it can't. Not one that declares no sessions, which isn't ready for any.
 */
export function describeUnoffered(): string {
  const { components, session } = read();
  const out = components.flatMap((c) => {
    const why = c.name === 'video' || c.sessions?.length === 0 ? null : misfit(c, session);
    return why ? [`${c.name} (${c.title}) ${why}`] : [];
  });
  return out.length ? `Not offered in this session, so not in suggest_tiles: ${out.join('; ')}. When the user asks for one, tell them why.` : '';
}

/** Columns said once for every table that has them, instead of on each line. */
const EVERY_TABLE = ['session_key', 'meeting_key'];

/**
 * Every table query_session can read, for the system prompt: one line each, with its columns as the
 * database reports them. Nothing until the session's data is there to query: while it's waiting for the video,
 * the whole session still can be.
 */
export function describeTables(data: SessionDataView): string {
  if ((data.state !== 'ready' && data.state !== 'waiting') || data.tables.length === 0) return '';
  const shared = EVERY_TABLE.filter((column) => data.tables.every((t) => t.columns.includes(column)));
  const lines = [`Tables for query_session. Each line: name: columns.${shared.length ? ` Every table also has ${shared.join(' and ')}.` : ''}`];
  for (const t of data.tables) {
    const columns = t.columns.filter((column) => !shared.includes(column)).join(', ');
    lines.push(`${t.name}: ${columns}${t.about ? `. ${t.about}` : ''}`);
  }
  return lines.join('\n');
}

/** What became of build mode, for the viewing agent's next message: a saved build's changes, the one line of it that agent ever sees, or an offer turned down. */
let buildNote: string | null = null;

/** `line` is the app's own account, such as "the user left it having saved this. Built lap_stepper." */
export function tellViewingAgent(line: string): void {
  buildNote = line;
}

/** What the build has changed so far, and every mod there is, for the build agent. */
function describeBuild(): string {
  const { build, mods, health } = read();
  const sign = { added: '+', edited: '~', deleted: '-' } as const;
  const changes = build.changes.map((c) => `${sign[c.change]}${c.name}`).join(', ') || 'none yet';
  const all = mods.map((m) => `${m.name} (${m.state})`).join(', ') || 'none';
  // What stopped drawing since the last turn, such as an error at a lap the code didn't expect.
  const broken = notDrawing(health).map((p) => `\nnot drawing: ${describePlace(p)}`);
  return `build changes so far: ${changes}\nmods: ${all}${broken.join('')}`;
}

/** What the build agent knows up front: every component, and the tables. */
function buildReference(): string {
  const { components, sessionData } = read();
  return [describeComponents(components, { origins: true }), describeTables(sessionData)].filter(Boolean).join('\n\n');
}

/**
 * A message starts a new turn, which clears the suggestion strip. While build mode is on it goes to the
 * build agent, with its own tools and no event list. See docs/BUILD_MODE.md.
 */
export function askAgent(text: string): Promise<void> {
  const note = host.suggestions.newTurn();
  const { build, session } = read();
  // The turn's waits for data end with it, however it ends.
  const endTurn = beginTurn();
  shownTables = hasTables();
  if (build.active) {
    turnMode = 'build';
    const tools = toolDefinitions('build');
    shownTools = namesOf(tools);
    return host.agent.send(text, describeAppState(note, describeBuild()), tools, buildReference(), 'build').finally(endTurn);
  }
  const mode: AgentMode = session ? 'view' : 'pick';
  turnMode = mode;
  turnScope = scopeOf(session);
  const fromBuild = buildNote ? `build mode: ${buildNote}` : null;
  buildNote = null;
  const tools = toolDefinitions(mode);
  shownTools = namesOf(tools);
  return host.agent.send(text, describeAppState(note, fromBuild), tools, referenceFor(mode), mode, turnScope).finally(endTurn);
}
