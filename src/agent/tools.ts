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
import { FIRST_SEASON, fitting, host, isDriverList, isDriverProp, MAX_SUGGESTED_STREAMS, misfit, read, specOf, tilesOf, type ComponentInfo, type Op } from '../host';
import { driversOf, normalize, resolveChannel, resolveDriver } from './matching';
import { spoilerGate, type SpoilerRequest } from './spoilerGate';

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

const dataReady = (): void => {
  const data = read().sessionData;
  if (data.state === 'ready') return;
  const why = 'reason' in data ? ` ${data.reason}` : data.state === 'loading' ? ' It is still loading.' : '';
  throw new Error(`This session's timing data isn't available.${why}`);
};

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
export function formatClock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

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
  'Read the open session\'s timing data with SQLite, to get a query right before a component uses it. SELECT only. The tables and their columns are in the table list at the end of the system prompt, once the session\'s data is ready.',
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
const missingNote = (missing: string[]) => (missing.length ? ` Not found: ${missing.join(', ')}. Use list_streams to see the options.` : '');
const onScreen = (id: string) => tilesOf(read().layout).some((t) => t.component.key === id);

function isoDate(ms: number | null): string | null {
  return ms ? new Date(ms).toISOString().slice(0, 16) + 'Z' : null;
}

// Charts: every component but video. The agent picks them by description and never sees what they show.

const VIDEO = 'video';
const chartsOf = (): ComponentInfo[] => read().components.filter((c) => c.name !== VIDEO);

/** The charts the viewing agent is offered: those that fit the open session. */
export const offeredCharts = (): ComponentInfo[] => fitting(chartsOf(), read().session);

type PropSchema = { type?: string; description?: string; minItems?: number; maxItems?: number };
const propsOf = (chart: ComponentInfo) => (chart.args.properties ?? {}) as Record<string, PropSchema>;
const requiredOf = (chart: ComponentInfo) => new Set((chart.args.required ?? []) as string[]);

/** A chart's props for the chart list: each with whether it's required and what it is, or "no props". */
export function propsText(chart: ComponentInfo): string {
  const required = requiredOf(chart);
  const parts = Object.entries(propsOf(chart)).map(([name, p]) => {
    const most = p.type === 'array' && p.maxItems != null ? `, at most ${p.maxItems}` : '';
    return `${name} (${required.has(name) ? 'required' : 'optional'}${most})${p.description ? `: ${p.description}` : ''}`;
  });
  return parts.length ? `props ${parts.join('; ')}` : 'no props';
}

const ChartProps = Type.Record(Type.String(), Type.Unknown(), {
  description:
    "The chart's props, from its line in the chart list. Give every required one. A driver prop takes a driver code (HAM), surname (Hamilton) or car number (44): one for a prop named driver…, a list for drivers….",
});

const ChartRef = Type.Object(
  {
    chart: Type.String({ description: 'A chart name from the chart list' }),
    props: Type.Optional(ChartProps),
  },
  { additionalProperties: false },
);

const SuggestArgs = Type.Object(
  {
    streams: Type.Optional(StreamRefs),
    charts: Type.Optional(Type.Array(ChartRef, { description: 'Charts, each with its props' })),
  },
  { additionalProperties: false },
);

/** `suggest_tiles` as the model sees it: the names of the charts it is offered, or no charts at all. */
function suggestArgs(): typeof SuggestArgs {
  const schema = JSON.parse(JSON.stringify(SuggestArgs));
  const names = offeredCharts().map((c) => c.name);
  if (names.length) schema.properties.charts.items.properties.chart.enum = names;
  else delete schema.properties.charts;
  return schema;
}

type Item = { type: string; props: Record<string, unknown> };

const rosterNow = () => {
  const { sessionData, feeds } = read();
  return driversOf(sessionData.state === 'ready' ? sessionData.drivers : [], feeds);
};

/**
 * The props the model gave a chart, with drivers as car numbers, and what's wrong with them. Each driver
 * prop takes codes, names or numbers, one or a list by its name. `given` replaces what's in `base`, and a
 * null takes a prop away. Props the chart doesn't declare are refused, so a typo isn't silently dropped.
 * `base` loses any it doesn't declare: a tile from before an edit to its mod can hold props the mod no longer has.
 */
export function resolveProps(chart: ComponentInfo, given: Record<string, unknown>, base: Record<string, unknown> = {}): { props: Record<string, unknown>; problems: string[] } {
  const declared = propsOf(chart);
  const roster = rosterNow();
  const props: Record<string, unknown> = Object.fromEntries(Object.entries(base).filter(([name]) => name in declared));
  const problems: string[] = [];
  const unknown: string[] = [];
  for (const [name, value] of Object.entries(given)) {
    if (!(name in declared)) {
      problems.push(`${chart.name} has no prop "${name}": it takes ${Object.keys(declared).join(', ') || 'none'}.`);
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
    else if (refs.length > 1) problems.push(`${chart.name}'s ${name} is one driver, and ${refs.length} were given.`);
  }
  if (unknown.length) problems.push(`No driver matches ${unknown.map((u) => `"${u}"`).join(', ')} in this session: ask the user who they mean.`);
  if (problems.length) return { props, problems };
  const missing = [...requiredOf(chart)].filter((name) => !(name in props));
  if (missing.length) {
    const drivers = missing.some(isDriverProp) ? ': ask the user which driver, unless the conversation already says' : '';
    return { props, problems: [`${chart.name} needs ${missing.join(' and ')}, and none was given${drivers}.`] };
  }
  try {
    specOf({ type: chart.name, props });
  } catch (e) {
    problems.push(`${chart.name}: ${(e as Error).message.replace(/^Invalid props for [^:]+: /, '')}.`);
  }
  return { props, problems };
}

/**
 * Turns the charts the model named into items, with drivers as car numbers. A problem never depends on
 * how the session is going: only on the session's type and whether it is live, missing data, an unknown name or the props.
 */
function planCharts(charts: Static<typeof ChartRef>[]): { items: Item[]; problems: string[] } {
  const { session, sessionData } = read();
  const items: Item[] = [];
  const problems: string[] = [];
  for (const { chart, props: given = {} } of charts) {
    const info = chartsOf().find((c) => c.name === chart || normalize(c.title) === normalize(chart));
    if (!info) {
      problems.push(`There is no chart "${chart}": pick a name from the chart list.`);
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

const chartNamed = (needle: string) => chartsOf().find((c) => normalize(c.name) === needle || normalize(c.title) === needle);

/** The chart tiles on screen a reference names: by label, or else every one of a chart by its name or title. */
function chartTilesNamed(ref: string) {
  const charts = tilesOf(read().layout).filter((t) => t.component.type !== VIDEO);
  const needle = normalize(ref);
  const byLabel = charts.filter((t) => normalize(t.component.label) === needle);
  return byLabel.length ? byLabel : charts.filter((t) => t.component.type === chartNamed(needle)?.name);
}

/** The keys of what `remove_tiles` names: chart tiles by label, then by chart name or title, then streams. */
function tileKeys(refs: string[]): string[] {
  const keys = new Set<string>();
  for (const ref of refs) {
    const hits = chartTilesNamed(ref);
    if (hits.length) hits.forEach((t) => keys.add(t.component.key));
    else {
      const feed = resolveChannel(read().feeds, ref);
      if (feed) keys.add(feed.id);
    }
  }
  return [...keys];
}

/**
 * `suggest_tiles`. The viewing agent's lists the chart names registered when the message was sent. The
 * build agent's takes any name, since it suggests mods it wrote during the turn.
 */
const suggestTiles = (args: typeof SuggestArgs | (() => typeof SuggestArgs)): AgentTool =>
  expose(host.suggestions.offer, {
    name: 'suggest_tiles',
    description: `Suggest streams and charts as tiles, in a strip under the conversation: the user adds the ones they want, or dismisses them. This is the only way to put anything on screen. It returns at once, before the user answers. Calling it again in the same turn adds to the strip. At most ${MAX_SUGGESTED_STREAMS} streams wait in the strip at a time. Charts come from the chart list, each with its props filled in.`,
    args,
    adapt: ({ streams = [], charts = [] }) => ({ items: [...videosOf(matchAll(streams).feeds), ...planCharts(charts).items] }),
    gate: [
      sessionOpen,
      (_, { streams = [], charts = [] }) => {
        if (streams.length === 0 && charts.length === 0) throw new Error('Name at least one stream or chart.');
      },
      (_, { charts = [] }) => {
        const { problems } = planCharts(charts);
        if (problems.length) throw new Error(`${problems.join(' ')} Nothing was suggested.`);
      },
      ({ items }, { streams = [] }) => {
        if (items.length === 0) throw new Error(`No matching streams.${missingNote(matchAll(streams).missing)}`);
      },
    ],
    result: ({ suggested, onScreen, repeated, overLimit }, { streams = [] }) => {
      const parts = [
        suggested.length ? `Suggested: ${suggested.join(', ')}.` : '',
        onScreen.length ? `Already on screen, shown as such: ${onScreen.join(', ')}.` : '',
        repeated.length ? `Already suggested this turn: ${repeated.join(', ')}.` : '',
        overLimit.length ? `Left out, the strip is full: ${overLimit.join(', ')}.` : '',
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
  expose(host.session.open, {
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
  }),
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
    description: 'Take tiles off screen: streams, or charts.',
    args: Type.Object(
      {
        tiles: Type.Array(Type.String(), {
          description: 'Stream references as for suggest_tiles, or charts on screen by their tile label, chart name or title.',
        }),
      },
      { additionalProperties: false },
    ),
    adapt: ({ tiles }) => ({ keys: tileKeys(tiles) }),
    gate: [sessionOpen],
    result: (removed, { tiles }) => {
      // Worked out after the fact, so a chart is only missing if nothing by that name exists or was removed.
      const missing = tiles.filter((ref) => {
        const needle = normalize(ref);
        return !removed.some((l) => normalize(l) === needle) && !chartNamed(needle) && !resolveChannel(read().feeds, ref);
      });
      return `Removed: ${removed.join(', ') || 'nothing'}.${missing.length ? ` Not found: ${missing.join(', ')}.` : ''}`;
    },
  }),
  expose(host.layout.setProps, {
    name: 'edit_tile',
    description:
      'Change the props of one chart on screen, in place: who it is about, who it highlights or who it draws. It keeps its place. Only the props named change; null takes one away. To show the same chart for someone else as well, suggest another with suggest_tiles instead.',
    args: Type.Object(
      {
        tile: Type.String({ description: 'One chart on screen, by its tile label, chart name or title, as app_state lists it' }),
        props: ChartProps,
      },
      { additionalProperties: false },
    ),
    adapt: ({ tile, props }) => {
      const [hit] = chartTilesNamed(tile);
      const info = hit && chartsOf().find((c) => c.name === hit.component.type);
      return { key: hit?.component.key ?? '', props: info ? resolveProps(info, props, hit.component.props).props : {} };
    },
    gate: [
      sessionOpen,
      (_, { tile, props }) => {
        const hits = chartTilesNamed(tile);
        if (hits.length === 0) throw new Error(`No chart on screen is called "${tile}".`);
        if (hits.length > 1) throw new Error(`"${tile}" names ${hits.length} charts: ${hits.map((t) => t.component.label).join(', ')}. Name one by its label.`);
        const info = chartsOf().find((c) => c.name === hits[0].component.type)!;
        const { problems } = resolveProps(info, props, hits[0].component.props);
        if (problems.length) throw new Error(`${problems.join(' ')} Nothing was changed.`);
      },
    ],
    result: (out) => (out ? `Changed: ${out.label}.` : 'That chart is no longer on screen.'),
    hints: [[/Already on screen/, 'A chart with those props is already on screen: leave this one as it is, or remove it.']],
  }),
  expose(host.audio.set, {
    name: 'set_audio',
    description: 'Choose which single stream is audible, or mute everything with "none".',
    args: Type.Object({ stream: Type.String({ description: 'A stream reference, or "none"' }) }, { additionalProperties: false }),
    adapt: ({ stream }) => ({ feed: normalize(stream) === 'none' ? null : (resolveChannel(read().feeds, stream)?.id ?? stream) }),
    gate: [
      sessionOpen,
      ({ feed }, { stream }) => {
        if (feed != null && !onScreen(feed)) throw new Error(`"${stream}" is not on screen.`);
      },
    ],
    result: () => {
      const { audio, feeds, volume } = read();
      if (audio == null) return 'All streams muted.';
      const label = feeds.find((f) => f.id === audio)?.label;
      return volume === 0 ? `Audio is now ${label}, but the volume is 0, so nothing can be heard.` : `Audio is now ${label}.`;
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

const toolsFor = (mode: AgentMode): AgentTool[] => (mode === 'build' ? BUILD_TOOLS : AGENT_TOOLS);

export const toolDefinitions = (mode: AgentMode = 'view'): AgentToolDefinition[] =>
  toolsFor(mode).map(({ name, description, parameters }) => ({ name, description, parameters }));

/** Only the viewing agent forgets what it read ahead: the build agent's whole conversation ends with the build. */
export const readsPastPlayhead = (name: string, args: Record<string, unknown>, mode: AgentMode = 'view'): boolean =>
  mode === 'view' && (AGENT_TOOLS.find((t) => t.name === name)?.pastPlayhead?.(args) ?? false);

/** Returns the model-facing result text; throws on failure. */
export async function runTool(name: string, args: Record<string, unknown>, mode: AgentMode = 'view'): Promise<string> {
  const tool = toolsFor(mode).find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(args);
}
