/**
 * The agent's tools, each built from the host function it calls. A tool with no arguments of its own
 * takes the function's schema, and one with its own must type-check against the function's through
 * `adapt`. Only what's specific to the agent lives here: names, wording, name matching and gates.
 * These are not user commands: `/` commands are a separate, much smaller set in src/shell/commands.ts.
 *
 * Reading the session past the playhead and seeking forward both ask the spoiler gate first, on every
 * call, before anything runs. With approval the agent may answer from what it read, for that turn only:
 * a tool that reads past the playhead says so, and the agent forgets the result once the turn ends. See
 * docs/SPOILER_PREVENTION.md.
 *
 * Results are short and go back to the model. Apart from an approved read ahead, nothing returned here
 * may reveal how a session turned out, only what exists and what is on screen. A seek says only where
 * playback landed.
 */
import Type, { type Static, type TObject } from 'typebox';
import type { AgentMode, AgentToolDefinition, Channel } from '../../shared/api';
import { FIRST_SEASON, fitting, host, isDriverList, isDriverProp, misfit, read, specOf, tilesOf, type ComponentInfo, type Op } from '../host';
import { driversOf, normalize, resolveChannel, resolveDriver } from './matching';
import { OPEN_WAIT_MS, requireData, settleData } from './dataWait';
import { spoilerGate, type SpoilerRequest } from './spoilerGate';
import { formatClock } from '../../shared/clock';
import { rosterOf } from '../../shared/sessionData';

export interface AgentTool extends AgentToolDefinition {
  run(args: Record<string, unknown>): Promise<string>;
  /** Whether a call with these arguments reads past the playhead. */
  pastPlayhead?(args: Record<string, unknown>): boolean;
}

/** Refuses a call by throwing, or rejecting. Gets the host arguments, and what the model actually sent. */
type Gate<A, M> = (args: A, modelArgs: M) => void | Promise<void>;

interface Exposure<A, R, S extends TObject> {
  name: string;
  /** Model-facing wording, if the host's description isn't the right one. */
  description?: string;
  /** Model-facing arguments, if they differ from the host's. A function is called each time definitions are sent. */
  args?: S | (() => S);
  adapt?: (modelArgs: Static<S>) => A;
  gate?: Gate<A, Static<S>>[];
  result?: (out: Awaited<R>, modelArgs: Static<S>) => string;
  /** What to tell the model to do about an error from the host. */
  hints?: [RegExp, string][];
  /** Whether a call reads past the playhead, so the agent forgets its result after the turn. */
  pastPlayhead?: (modelArgs: Static<S>) => boolean;
}

function expose<A, R, S extends TObject = TObject>(op: Op<A, R>, options: Exposure<A, R, S>): AgentTool {
  const { name, description, args, adapt, gate = [], result, hints = [], pastPlayhead } = options;
  const schema = typeof args === 'function' ? args : () => args ?? op.info.args;
  return {
    name,
    description: description ?? op.info.description,
    // Plain JSON, since definitions cross IPC. Built when read, so it can list what's registered by then.
    get parameters() {
      return JSON.parse(JSON.stringify(schema()));
    },
    pastPlayhead: pastPlayhead && ((modelArgs) => pastPlayhead(modelArgs as Static<S>)),
    async run(modelArgs) {
      const model = modelArgs as Static<S>;
      const hostArgs = adapt ? adapt(model) : (modelArgs as A);
      for (const check of gate) await check(hostArgs, model);
      try {
        const out = await op(hostArgs);
        return result ? result(out as Awaited<R>, model) : JSON.stringify(out);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const hint = hints.find(([match]) => match.test(message))?.[1];
        throw new Error(hint ? `${message} ${hint}` : message);
      }
    },
  };
}

// Gates

const sessionOpen = (): void => {
  if (!read().session) throw new Error('No session is open.');
};

/**
 * The data has to be ready, and a call made while it loads waits for it: see dataWait.ts. Reading the whole
 * session, `asOf: "session"`, only needs it to be there: it doesn't depend on the frame on screen.
 */
const dataReady = (args?: object): Promise<void> => requireData((args as { asOf?: unknown } | undefined)?.asOf === 'session');

/** Asks the spoiler gate, and refuses the call unless it approves. */
async function approve(request: SpoilerRequest): Promise<void> {
  const { approved, reason } = await spoilerGate(request);
  if (!approved) throw new Error(`The user did not allow that${reason ? `: ${reason}` : ''}. Tell them, and do not try another way.`);
}

const sessionTitle = (): string => read().session?.title ?? '';

function playheadMs(): number | null {
  const data = read().sessionData;
  return data.state === 'ready' ? data.playheadMs : null;
}

/** h:mm:ss on the session clock. */
export { formatClock };

// Session SQL

/** At most this many rows go back to the model. */
export const MAX_QUERY_ROWS = 200;

/**
 * The same on every turn, so it stays in the cached part of the request. The tables are in the system
 * prompt's reference instead, from `sessionData.tables`: see describeTables in bridge.ts.
 */
export const QUERY_DESCRIPTION = [
  'Read the open session\'s timing data with SQLite. SELECT only. The tables and their columns are in the table list at the end of the system prompt, once the session\'s data is ready.',
  'By default (asOf "playhead") each table holds only what the feed had revealed at the frame on screen. asOf "session" reads everything the session holds, including what the user has not watched yet: use it when a request needs what may be past the playhead. The app asks the user first. Once they approve, you may answer from what it showed, in this turn only.',
  'Times are UTC milliseconds. date, or date_start in laps, is when something happened; visible_from, in the tables that have it, is when the feed revealed the row. A laps, stints or pit row reads as it last stood at that point.',
  `At most ${MAX_QUERY_ROWS} rows come back, so aggregate or filter.`,
].join('\n');

export const BUILD_QUERY_DESCRIPTION = [
  'Read the open session\'s timing data with SQLite, to get a query right before a component uses it. SELECT only. The tables and their columns are in the table list at the end of the system prompt, once the session\'s data is ready. While the data is still loading, a call waits for it.',
  'By default (asOf "playhead") each table holds only what the feed had revealed at the frame on screen, which is what useSql sees. asOf "session" reads everything the session holds. Never tell the user what either shows.',
  'Times are UTC milliseconds. date, or date_start in laps, is when something happened; visible_from, in the tables that have it, is when the feed revealed the row. A laps, stints or pit row reads as it last stood at that point.',
  `At most ${MAX_QUERY_ROWS} rows come back, so aggregate or filter.`,
].join('\n');

const BuildAsOf = Type.Union([Type.Literal('playhead'), Type.Literal('session')], {
  description: '"playhead" (the default) sees up to the frame on screen; "session" sees the whole session.',
});

const AsOf = Type.Union([Type.Literal('playhead'), Type.Literal('session')], {
  description: '"playhead" (the default) sees up to the frame on screen; "session" sees the whole session, and asks the user first.',
});

// Name matching

const StreamRefs = Type.Array(Type.String(), {
  description:
    'Stream references: a driver code (HAM), surname (Hamilton), car number (44), or channel name (world feed, F1 Live, data, tracker).',
});

function matchAll(refs: string[]): { feeds: Channel[]; missing: string[] } {
  const available = read().feeds;
  const feeds: Channel[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const hit = resolveChannel(available, ref);
    if (!hit) missing.push(ref);
    else if (!feeds.includes(hit)) feeds.push(hit);
  }
  return { feeds, missing };
}

const videosOf = (feeds: Channel[]) => feeds.map((f) => ({ type: 'video', props: { feed: f.id } }));
/**
 * What the model meant by a stream that isn't one, when it names a component this session doesn't offer: its list leaves
 * those out, so asked for a race's timing tower in practice, it reaches for a stream of that name.
 */
function notOffered(ref: string): string | null {
  const key = normalize(ref).replace(/[\s_-]+/g, ' ');
  const c = componentsOf().find((x) => [x.name, x.title].some((n) => normalize(n).replace(/[\s_-]+/g, ' ') === key));
  const why = c && misfit(c, read().session);
  return why ? `"${ref}" is the ${c.name} component, not a stream, and it ${why}: tell the user so.` : null;
}

const missingNote = (missing: string[]) => {
  if (!missing.length) return '';
  const components = missing.map(notOffered).filter(Boolean);
  const streams = missing.filter((ref) => !notOffered(ref));
  return `${streams.length ? ` Not found: ${streams.join(', ')}. Use list_streams to see the options.` : ''}${components.length ? ` ${components.join(' ')}` : ''}`;
};
/** Whether a feed shows on screen: in its own tile, or in any component's. */
const onScreen = (id: string) => {
  const { layout, streams } = read();
  return tilesOf(layout).some((t) => t.component.key === id) || Object.values(streams).some((v) => v.feed === id && v.tile != null && !v.quiet);
};

/**
 * The video to hear for a stream the model named: the one already heard if it shows that feed, else
 * the one in the main tile, else the oldest. Undefined when no tile shows it.
 */
function videoToHear(ref: string): string | undefined {
  const { feeds, streams, audio, layout } = read();
  const feed = resolveChannel(feeds, ref)?.id;
  if (!feed) return undefined;
  const videos = Object.values(streams).filter((v) => v.feed === feed && v.tile != null && !v.quiet);
  return (videos.find((v) => v.id === audio) ?? videos.find((v) => v.tile === layout.main) ?? videos[0])?.id;
}

/** The heard video, as the agent is told it: its feed, and its tile. */
function heardName(): string | null {
  const { audio, streams, feeds } = read();
  const video = audio != null ? streams[audio] : undefined;
  if (!video) return null;
  const label = feeds.find((f) => f.id === video.feed)?.label ?? video.feed;
  return video.tile ? `${label} in ${video.tile}` : label;
}

function isoDate(ms: number | null): string | null {
  return ms ? new Date(ms).toISOString().slice(0, 16) + 'Z' : null;
}

// Components: every one but video, which `streams` names by feed. Charts are components like any other.
// The agent picks them by description and never sees what they show.

const VIDEO = 'video';
const componentsOf = (): ComponentInfo[] => read().components.filter((c) => c.name !== VIDEO);

/** The components the viewing agent is offered: those that fit the open session. */
export const offeredComponents = (): ComponentInfo[] => fitting(componentsOf(), read().session);

type PropSchema = { type?: string; description?: string; minItems?: number; maxItems?: number };
const propsOf = (c: ComponentInfo) => (c.args.properties ?? {}) as Record<string, PropSchema>;
const requiredOf = (c: ComponentInfo) => new Set((c.args.required ?? []) as string[]);

/** A component's props for the component list: each with whether it's required and what it is, or "no props". */
export function propsText(c: ComponentInfo): string {
  const required = requiredOf(c);
  const parts = Object.entries(propsOf(c)).map(([name, p]) => {
    const most = p.type === 'array' && p.maxItems != null ? `, at most ${p.maxItems}` : '';
    return `${name} (${required.has(name) ? 'required' : 'optional'}${most})${p.description ? `: ${p.description}` : ''}`;
  });
  return parts.length ? `props ${parts.join('; ')}` : 'no props';
}

const ComponentProps = Type.Record(Type.String(), Type.Unknown(), {
  description:
    "The component's props, from its line in the component list. Give every required one. A driver prop takes a driver code (HAM), surname (Hamilton) or car number (44): one for a prop named driver…, a list for drivers….",
});

const ComponentRef = Type.Object(
  {
    component: Type.String({ description: 'A component name from the component list' }),
    props: Type.Optional(ComponentProps),
  },
  { additionalProperties: false },
);

const SuggestArgs = Type.Object(
  {
    streams: Type.Optional(StreamRefs),
    components: Type.Optional(Type.Array(ComponentRef, { description: 'Components, each with its props' })),
  },
  { additionalProperties: false },
);

/** `suggest_tiles` as the model sees it: the names of the components it is offered, or no components at all. */
function suggestArgs(): typeof SuggestArgs {
  const schema = JSON.parse(JSON.stringify(SuggestArgs));
  const names = offeredComponents().map((c) => c.name);
  if (names.length) schema.properties.components.items.properties.component.enum = names;
  else delete schema.properties.components;
  return schema;
}

type Item = { type: string; props: Record<string, unknown> };

const rosterNow = () => {
  const { sessionData, feeds } = read();
  return driversOf(rosterOf(sessionData), feeds);
};

/**
 * The props the model gave a component, with drivers as car numbers, and what's wrong with them. Each driver
 * prop takes codes, names or numbers, one or a list by its name. `given` replaces what's in `base`, and a
 * null takes a prop away. Props the component doesn't declare are refused, so a typo isn't silently dropped.
 * `base` loses any it doesn't declare: a tile from before an edit to its mod can hold props the mod no longer has.
 */
export function resolveProps(component: ComponentInfo, given: Record<string, unknown>, base: Record<string, unknown> = {}): { props: Record<string, unknown>; problems: string[] } {
  const declared = propsOf(component);
  const roster = rosterNow();
  const props: Record<string, unknown> = Object.fromEntries(Object.entries(base).filter(([name]) => name in declared));
  const problems: string[] = [];
  const unknown: string[] = [];
  for (const [name, value] of Object.entries(given)) {
    if (!(name in declared)) {
      problems.push(`${component.name} has no prop "${name}": it takes ${Object.keys(declared).join(', ') || 'none'}.`);
      continue;
    }
    if (value === null) {
      delete props[name];
      continue;
    }
    if (!isDriverProp(name)) {
      props[name] = value;
      continue;
    }
    const refs = (Array.isArray(value) ? value : [value]).map(String);
    const numbers: number[] = [];
    for (const ref of refs) {
      const hit = resolveDriver(roster, ref);
      if (!hit) unknown.push(ref);
      else if (!numbers.includes(hit.number)) numbers.push(hit.number);
    }
    if (isDriverList(name)) props[name] = numbers;
    else if (numbers.length === 1) props[name] = numbers[0];
    else if (refs.length > 1) problems.push(`${component.name}'s ${name} is one driver, and ${refs.length} were given.`);
  }
  if (unknown.length) problems.push(`No driver matches ${unknown.map((u) => `"${u}"`).join(', ')} in this session: ask the user who they mean.`);
  if (problems.length) return { props, problems };
  const missing = [...requiredOf(component)].filter((name) => !(name in props));
  if (missing.length) {
    const drivers = missing.some(isDriverProp) ? ': ask the user which driver, unless the conversation already says' : '';
    return { props, problems: [`${component.name} needs ${missing.join(' and ')}, and none was given${drivers}.`] };
  }
  try {
    specOf({ type: component.name, props });
  } catch (e) {
    problems.push(`${component.name}: ${(e as Error).message.replace(/^Invalid props for [^:]+: /, '')}.`);
  }
  return { props, problems };
}

/**
 * Turns the components the model named into items, with drivers as car numbers. A problem never depends on
 * how the session is going: only on the session's type and whether it is live, missing data, an unknown name or the props.
 */
function planComponents(components: Static<typeof ComponentRef>[]): { items: Item[]; problems: string[] } {
  const { session, sessionData } = read();
  const items: Item[] = [];
  const problems: string[] = [];
  for (const { component, props: given = {} } of components) {
    const info = componentsOf().find((c) => c.name === component || normalize(c.title) === normalize(component));
    if (!info) {
      problems.push(`There is no component "${component}": pick a name from the component list.`);
      continue;
    }
    const why = misfit(info, session);
    if (why) {
      problems.push(`${info.name} ${why}: leave it out.`);
      continue;
    }
    if (info.needs.length && sessionData.state === 'unsupported') {
      problems.push(`${info.name} has no data for this session: ${sessionData.reason}`);
      continue;
    }
    const resolved = resolveProps(info, given);
    if (resolved.problems.length) problems.push(...resolved.problems);
    else items.push({ type: info.name, props: resolved.props });
  }
  return { items, problems };
}

/** Tiles are named by their id, as app_state lists them. */
const TileId = Type.String({ description: 'A tile id as app_state lists it, such as "tile-3"' });
const ID_HINT = 'Name tiles by the ids app_state lists, such as tile-3.';
const tileOnScreen = (id: string) => tilesOf(read().layout).find((t) => t.id === id) ?? null;

/**
 * `suggest_tiles`. The viewing agent's lists the component names registered when the message was sent. The
 * build agent's takes any name, since it suggests mods it wrote during the turn.
 */
const suggestTiles = (args: typeof SuggestArgs | (() => typeof SuggestArgs)): AgentTool =>
  expose(host.suggestions.offer, {
    name: 'suggest_tiles',
    description:
      'Suggest streams and components as tiles, in a strip under the conversation: the user adds the ones they want, or dismisses them. This is the only way to put anything on screen. It returns at once, before the user answers. Calling it again in the same turn adds to the strip. Components come from the component list, each with its props filled in.',
    args,
    adapt: ({ streams = [], components = [] }) => ({ items: [...videosOf(matchAll(streams).feeds), ...planComponents(components).items] }),
    gate: [
      sessionOpen,
      (_, { streams = [], components = [] }) => {
        if (streams.length === 0 && components.length === 0) throw new Error('Name at least one stream or component.');
      },
      (_, { components = [] }) => {
        const { problems } = planComponents(components);
        if (problems.length) throw new Error(`${problems.join(' ')} Nothing was suggested.`);
      },
      ({ items }, { streams = [] }) => {
        if (items.length === 0) throw new Error(`No matching streams.${missingNote(matchAll(streams).missing)}`);
      },
    ],
    result: ({ suggested, onScreen, repeated }, { streams = [] }) => {
      const parts = [
        suggested.length ? `Suggested: ${suggested.join(', ')}.` : '',
        onScreen.length ? `Already on screen, shown as such: ${onScreen.join(', ')}.` : '',
        repeated.length ? `Already suggested this turn: ${repeated.join(', ')}.` : '',
      ];
      return `${parts.filter(Boolean).join(' ')}${missingNote(matchAll(streams).missing)} The user decides; nothing is on screen until they add it.`;
    },
    hints: [[/dismissed/, 'Do not suggest again until they ask.']],
  });

/**
 * `query_session`. The viewing agent's asks the spoiler gate before reading past the playhead. The build
 * agent's doesn't: build mode reads the whole session, which the viewer agreed to on entering it.
 */
const querySession = (gated: boolean): AgentTool =>
  expose(host.data.sql, {
    name: 'query_session',
    description: gated ? QUERY_DESCRIPTION : BUILD_QUERY_DESCRIPTION,
    args: Type.Object(
      {
        sql: Type.String({ description: 'One SELECT statement. Use ? for params.' }),
        params: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Null()]))),
        asOf: Type.Optional(gated ? AsOf : BuildAsOf),
      },
      { additionalProperties: false },
    ),
    adapt: ({ sql, params, asOf }) => ({ sql, params, asOf }),
    pastPlayhead: ({ asOf }) => asOf === 'session',
    gate: [
      sessionOpen,
      dataReady,
      async ({ sql, asOf }) => {
        if (gated && asOf === 'session') await approve({ kind: 'read_ahead', session: sessionTitle(), playheadMs: playheadMs(), sql });
      },
    ],
    hints: [[/no such (table|column)/, 'Use the table list at the end of the system prompt: it is there once the data has loaded.']],
    result: ({ columns, rows }, { asOf }) => {
      const shown = rows.slice(0, MAX_QUERY_ROWS).map((row) => columns.map((c) => row[c]));
      // Nothing at the playhead often just means it hasn't happened on screen yet.
      const note =
        rows.length > MAX_QUERY_ROWS
          ? `Showing ${MAX_QUERY_ROWS} of ${rows.length} rows. Narrow the query to see the rest.`
          : rows.length === 0 && asOf !== 'session' && !gated
            ? 'Nothing up to the frame on screen. asOf "session" reads the whole session.'
            : rows.length === 0 && asOf !== 'session'
              ? 'Nothing up to the frame on screen. If the moment may be later, call query_session again with asOf "session": the app asks the user, so do not ask them yourself.'
            : undefined;
      return JSON.stringify({ columns, rows: shown, ...(note ? { note } : {}) });
    },
  });

/** `seek_to`. Gated like `query_session`: only the viewing agent's asks before a forward seek. */
const seekTo = (gated: boolean): AgentTool =>
  expose(host.playback.seekToDate, {
    name: 'seek_to',
    description:
      gated
        ? 'Move playback to a moment, given as a UTC millisecond time exactly as it comes from a date column of query_session. A moment later than the frame on screen asks the user first. Playback stays within what can be played.'
        : 'Move playback to a moment, given as a UTC millisecond time exactly as it comes from a date column of query_session. It moves what the user is watching, so only do it when they ask. Playback stays within what can be played.',
    args: Type.Object({ date: Type.Number({ description: 'UTC milliseconds, from a query_session date column' }) }, { additionalProperties: false }),
    adapt: ({ date }) => ({ dateMs: date }),
    gate: [
      sessionOpen,
      dataReady,
      async ({ dateMs }) => {
        const playhead = playheadMs();
        // With the frame on screen unknown, a seek may be forward: ask.
        if (gated && (playhead === null || dateMs > playhead)) await approve({ kind: 'seek_forward', session: sessionTitle(), playheadMs: playhead, targetMs: dateMs });
      },
    ],
    result: ({ timeSec, clamped }) =>
      `Playback is at ${formatClock(timeSec)}.${clamped ? ' That moment is outside what can be played, so it stopped at the nearest end.' : ''}`,
  });

const MAX_UPCOMING = 16;

const loadSession = expose(host.session.open, {
  name: 'load_session',
  description:
    "Open one session, once the user has chosen it. A replay or live one starts the main broadcast and replaces whatever is open. One that hasn't started shows a countdown, and starts by itself when F1 TV goes live.",
  args: Type.Object(
    {
      contentId: Type.Integer({ description: 'contentId from list_sessions, list_live or list_upcoming' }),
      title: Type.String({ description: 'Session title to show the user' }),
      fromStart: Type.Optional(
        Type.Boolean({
          description: 'For a live session: true starts at the beginning of the broadcast, otherwise it joins at the live edge. Replays always start at the beginning.',
        }),
      ),
    },
    { additionalProperties: false },
  ),
  result: ({ session, feeds }, { fromStart }) =>
    feeds == null
      ? JSON.stringify({ countdown: session.title, note: 'It starts by itself when F1 TV goes live.' })
      : JSON.stringify({
          opened: session.title,
          playingFrom: session.status === 'live' && fromStart !== true ? 'live edge' : 'start',
          streams: feeds.map((f) => f.label),
        }),
});

export const AGENT_TOOLS: AgentTool[] = [
  expose(host.catalog.sessions, {
    name: 'list_sessions',
    description: 'List all sessions of one event: practice, qualifying, sprint, race, and shows, each with its status: replay, live, or upcoming.',
    args: Type.Object(
      {
        pageId: Type.Integer({ description: 'Event pageId, from the event list' }),
        year: Type.Integer({ description: `Season of the event, ${FIRST_SEASON} or later` }),
      },
      { additionalProperties: false },
    ),
    gate: [
      (_, { year }) => {
        if (year < FIRST_SEASON) throw new Error(`Only ${FIRST_SEASON} on is supported.`);
      },
    ],
    result: (sessions) =>
      JSON.stringify(sessions.map((s) => ({ contentId: s.contentId, title: s.title, type: s.type, status: s.status, startedAt: isoDate(s.startMs) }))),
  }),
  expose(host.catalog.live, {
    name: 'list_live',
    description: 'List what F1 TV has live right now.',
    result: (items) => JSON.stringify(items.map((i) => ({ contentId: i.contentId, title: i.title }))),
  }),
  expose(host.catalog.upcoming, {
    name: 'list_upcoming',
    description: 'List the next sessions that have not started yet, across events, with UTC start times.',
    result: (sessions) =>
      JSON.stringify(sessions.slice(0, MAX_UPCOMING).map((s) => ({ contentId: s.contentId, title: s.title, type: s.type, startsAt: isoDate(s.startMs) }))),
  }),
  {
    ...loadSession,
    /**
     * Returns once the session's timing data has settled, or after a while without it: what the message asks next
     * often needs it, and the conversation for the session starts from what is there when this returns.
     */
    async run(args) {
      const out = await loadSession.run(args);
      if (read().session) await settleData({ timeoutMs: OPEN_WAIT_MS });
      return out;
    },
  },
  expose(host.session.feeds, {
    name: 'list_streams',
    description: 'List every stream the open session offers, and which are on screen.',
    gate: [sessionOpen],
    result: (feeds) =>
      JSON.stringify(feeds.map((f) => ({ name: f.label, kind: f.kind, driver: f.driverName, team: f.team, number: f.number, onScreen: onScreen(f.id) }))),
  }),
  suggestTiles(suggestArgs),
  expose(host.layout.remove, {
    name: 'remove_tiles',
    description: 'Take tiles off screen, streams or components, by their tile ids.',
    args: Type.Object({ tiles: Type.Array(TileId) }, { additionalProperties: false }),
    gate: [
      sessionOpen,
      ({ tiles }) => {
        const missing = tiles.filter((id) => !tileOnScreen(id));
        if (missing.length) throw new Error(`Not on screen: ${missing.join(', ')}. Nothing was removed. ${ID_HINT}`);
      },
    ],
    result: (removed) => `Removed: ${removed.join(', ') || 'nothing'}.`,
  }),
  expose(host.layout.setProps, {
    name: 'edit_tile',
    description:
      'Change the props of one component on screen, in place: who it is about, who it highlights or who it draws. It keeps its id and place. Only the props named change; null takes one away. To show the same component for someone else as well, suggest another with suggest_tiles instead.',
    args: Type.Object({ tile: TileId, props: ComponentProps }, { additionalProperties: false }),
    adapt: ({ tile, props }) => {
      const hit = tileOnScreen(tile);
      const info = hit && componentsOf().find((c) => c.name === hit.component.type);
      return { tile, props: info ? resolveProps(info, props, hit.component.props).props : {} };
    },
    gate: [
      sessionOpen,
      (_, { tile, props }) => {
        const hit = tileOnScreen(tile);
        if (!hit) throw new Error(`No tile ${tile} is on screen. ${ID_HINT}`);
        const info = componentsOf().find((c) => c.name === hit.component.type);
        if (!info) throw new Error(`${tile} is a stream: only a component's props can be changed. To show another stream, suggest it.`);
        const { problems } = resolveProps(info, props, hit.component.props);
        if (problems.length) throw new Error(`${problems.join(' ')} Nothing was changed.`);
      },
    ],
    result: (out) => (out ? `Changed: ${out.label}.` : 'That tile is no longer on screen.'),
    hints: [[/Already on screen/, 'A component with those props is already on screen: leave this one as it is, or remove it.']],
  }),
  expose(host.build.offer, {
    name: 'offer_build',
    description:
      "Offer the user build mode, where the build agent writes components' code: to fix tiles whose render error is in it, or to build a component for something the user wants to follow, keep happening or have controls for, that no component does. What it builds is always something a tile shows. The user need not have asked for a build. The user answers in the palette. If they switch, the build agent gets the errors of the tiles you name and your note, and starts on them at once. It returns straight away: end your turn saying in a few words that it was offered, and why.",
    args: Type.Object(
      {
        reason: Type.String({
          description:
            'What build mode would do, for the user, as a few words that start with a verb, like "fix the gap chart" or "build a tyre wear chart for HAM". The offer reads "<reason> in build mode?".',
        }),
        note: Type.String({
          description:
            "The handoff, for the build agent, which sees nothing else of this conversation: what the user wants the tile to show or do, in their words where they matter, the drivers or tiles it is about, the tables you expect it to read, and what you found. One to three sentences.",
        }),
        error_tiles: Type.Optional(Type.Array(TileId, { description: "Tiles on screen whose errors the build agent should get, to fix. Leave it out when nothing is broken." })),
      },
      { additionalProperties: false },
    ),
    adapt: ({ reason, note, error_tiles }) => ({ reason, note, tiles: error_tiles ?? [] }),
    gate: [
      ({ tiles }) => {
        const gone = tiles.filter((t) => !tileOnScreen(t));
        if (gone.length) throw new Error(`No tile ${gone.join(', ')} is on screen. ${ID_HINT}`);
      },
    ],
    result: () => 'Offered. The user answers in the palette.',
  }),
  expose(host.audio.set, {
    name: 'set_audio',
    description:
      'Choose which single stream is heard, or mute everything with "none". With a stream on screen in more than one tile, the app picks which one: say only which stream.',
    args: Type.Object({ stream: Type.String({ description: 'A stream reference, or "none"' }) }, { additionalProperties: false }),
    adapt: ({ stream }) => ({ video: normalize(stream) === 'none' ? null : (videoToHear(stream) ?? null) }),
    gate: [
      sessionOpen,
      (_, { stream }) => {
        if (normalize(stream) !== 'none' && videoToHear(stream) === undefined) throw new Error(`"${stream}" is not on screen. Suggest it first.`);
      },
    ],
    result: () => {
      const label = heardName();
      if (label == null) return 'All streams muted.';
      return read().volume === 0 ? `Audio is now ${label}, but the volume is 0, so nothing can be heard.` : `Audio is now ${label}.`;
    },
  }),
  expose(host.audio.setVolume, {
    name: 'set_volume',
    description: 'Set the master volume, as a percentage. 0 silences everything. The audible stream stays the same.',
    args: Type.Object(
      { volume: Type.Number({ minimum: 0, maximum: 100, description: 'Percent, from 0 to 100. The current level is in app_state.' }) },
      { additionalProperties: false },
    ),
    adapt: ({ volume }) => ({ volume: volume / 100 }),
    gate: [sessionOpen],
    result: () => {
      const { audio, volume } = read();
      const level = `Volume is now ${Math.round(volume * 100)}%.`;
      return audio == null ? `${level} No stream is audible; choose one with set_audio.` : level;
    },
  }),
  expose(host.playback.play, {
    name: 'play',
    description: 'Resume playback of all streams.',
    gate: [sessionOpen],
    result: () => 'Playing.',
  }),
  expose(host.playback.pause, {
    name: 'pause',
    description: 'Pause playback of all streams.',
    gate: [sessionOpen],
    result: () => 'Paused.',
  }),
  expose(host.playback.seekToStart, {
    name: 'seek_to_start',
    description: 'Go back to the very beginning of the open session. It can never skip anything forward.',
    gate: [sessionOpen],
    result: () => 'Back at the start.',
  }),
  expose(host.playback.goLive, {
    name: 'go_live',
    description:
      "Return to the live edge of a live session. It skips what the user hasn't watched, so the app asks them first unless playback is already there: do not ask them yourself.",
    gate: [
      sessionOpen,
      () => {
        if (read().session?.status !== 'live') throw new Error('This session is not live, so there is no live edge. seek_to moves within it.');
      },
      async () => {
        const { clock } = read();
        if (clock.atLiveEdge) return;
        const playhead = playheadMs();
        const behindMs = Math.max(0, (clock.end - clock.timeSec) * 1000);
        await approve({ kind: 'seek_forward', session: sessionTitle(), playheadMs: playhead, targetMs: (playhead ?? Date.now()) + behindMs });
      },
    ],
    result: () => 'At the live edge.',
  }),
  querySession(true),
  seekTo(true),
];

/**
 * What the build agent has of the viewing tools, beside its own file tools in the main process: enough
 * to look at the data, show a draft with props, and try a control. None of it asks the spoiler gate.
 * See docs/BUILD_MODE.md.
 */
const BUILD_VIEW_TOOLS = ['list_streams', 'remove_tiles', 'edit_tile', 'play', 'pause'];
export const BUILD_TOOLS: AgentTool[] = [
  ...AGENT_TOOLS.filter((t) => BUILD_VIEW_TOOLS.includes(t.name)),
  suggestTiles(SuggestArgs),
  querySession(false),
  seekTo(false),
];

/**
 * The picking agent's tools, for when no session is open: finding a session and opening it. The viewing
 * agent keeps them, to switch sessions. See docs/ARCHITECTURE.md.
 */
export const PICKING_TOOLS = ['list_sessions', 'list_live', 'list_upcoming', 'load_session'];

const PICK_TOOLS = AGENT_TOOLS.filter((t) => PICKING_TOOLS.includes(t.name));

const toolsFor = (mode: AgentMode): AgentTool[] => (mode === 'build' ? BUILD_TOOLS : mode === 'pick' ? PICK_TOOLS : AGENT_TOOLS);

/**
 * The tools the model is shown now. The viewing agent's act on the open session, so if a failed switch
 * left none open, the bridge sends only the picking ones mid-turn. A tool that isn't shown still runs if
 * called, from an older turn, and its gate refuses it.
 */
export const toolDefinitions = (mode: AgentMode = 'view'): AgentToolDefinition[] =>
  toolsFor(mode)
    .filter((t) => mode !== 'view' || read().session != null || PICKING_TOOLS.includes(t.name))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));

/** Only the viewing agent forgets what it read ahead: the build agent's whole conversation ends with the build. */
export const readsPastPlayhead = (name: string, args: Record<string, unknown>, mode: AgentMode = 'view'): boolean =>
  mode === 'view' && (AGENT_TOOLS.find((t) => t.name === name)?.pastPlayhead?.(args) ?? false);

/** Returns the model-facing result text; throws on failure. */
export async function runTool(name: string, args: Record<string, unknown>, mode: AgentMode = 'view'): Promise<string> {
  const tool = toolsFor(mode).find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(args);
}
