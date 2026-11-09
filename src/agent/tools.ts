/**
 * The agent's tools, each built from the host function it calls. A tool with no arguments of its own
 * takes the function's schema, and one with its own must type-check against the function's through
 * `adapt`. Only what's specific to the agent lives here: names, wording, name matching and gates.
 * These are not user commands: `/` commands are a separate, much smaller set in src/shell/commands.ts.
 *
 * Reading the session past the playhead and seeking forward both ask the spoiler gate first, on every
 * call, before anything runs. The agent reads ahead only to find a moment to jump to. See docs/DESIGN.md.
 *
 * Results are short and go back to the model. Apart from an approved read ahead, nothing returned here
 * may reveal how a session turned out, only what exists and what is on screen. A seek says only where
 * playback landed.
 */
import Type, { type Static, type TObject } from 'typebox';
import type { AgentToolDefinition, Channel, SessionType } from '../../shared/api';
import { SQL_TABLES } from '../../shared/sessionData';
import { sqlColumns, TABLE_BY_NAME } from '../../shared/sessionTables';
import { FIRST_SEASON, host, MAX_SUGGESTED_STREAMS, read, tilesOf, type ComponentInfo, type Op } from '../host';
import { driversOf, normalize, resolveChannel, resolveDriver } from './matching';
import { spoilerGate, type SpoilerRequest } from './spoilerGate';

export interface AgentTool extends AgentToolDefinition {
  run(args: Record<string, unknown>): Promise<string>;
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
}

function expose<A, R, S extends TObject = TObject>(op: Op<A, R>, options: Exposure<A, R, S>): AgentTool {
  const { name, description, args, adapt, gate = [], result, hints = [] } = options;
  const schema = typeof args === 'function' ? args : () => args ?? op.info.args;
  return {
    name,
    description: description ?? op.info.description,
    // Plain JSON, since definitions cross IPC. Built when read, so it can list what's registered by then.
    get parameters() {
      return JSON.parse(JSON.stringify(schema()));
    },
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

/** Generated from the table definitions, so it can't drift from what the database holds. */
function describeTables(): string {
  const shared = new Set(['session_key', 'meeting_key', 'visible_from']);
  return SQL_TABLES.map((name) => `${name}: ${sqlColumns(TABLE_BY_NAME.get(name)!).filter((c) => !shared.has(c)).join(', ')}`).join('\n');
}

const QUERY_DESCRIPTION = [
  'Read the open session\'s timing data with SQLite. SELECT only.',
  'By default (asOf "playhead") each table holds only what the feed had revealed at the frame on screen. asOf "session" reads everything the session holds, including what the user has not watched yet: use it only to find a moment to jump to with seek_to, and never tell the user what it showed.',
  'Times are UTC milliseconds. date, or date_start in laps, is when something happened; visible_from is when the feed revealed the row. A laps, stints or pit row reads as it last stood at that point.',
  `At most ${MAX_QUERY_ROWS} rows come back, so aggregate or filter.`,
  'Every table also has session_key, meeting_key and visible_from. Tables and their other columns:',
  describeTables(),
].join('\n');

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

const sessionTypeName = (type: SessionType) => type.replace('-', ' ');

/** How many drivers a chart takes, from its `drivers` property, and that count in words. */
export function driverCount(chart: ComponentInfo): { fits(n: number): boolean; text: string } {
  const properties = (chart.args.properties ?? {}) as Record<string, { minItems?: number; maxItems?: number }>;
  const drivers = properties.drivers;
  if (!drivers) return { fits: (n) => n === 0, text: 'no drivers' };
  const optional = !(Array.isArray(chart.args.required) && chart.args.required.includes('drivers'));
  const min = drivers.minItems ?? 0;
  const max = drivers.maxItems ?? Infinity;
  const lo = optional && min <= 1 ? 0 : min;
  const range = lo === max ? `exactly ${lo}` : max === Infinity ? `${lo} or more` : `${lo} to ${max}`;
  const text = `${optional && min > 1 ? `none, or ${range}` : range} driver${max === 1 ? '' : 's'}`;
  return { fits: (n) => (optional && n === 0) || (n >= min && n <= max), text };
}

const DriverRefs = Type.Array(Type.String(), {
  description: 'The drivers the chart is about: a driver code (HAM), surname (Hamilton) or car number (44). Leave out for a chart that picks its own.',
});

const ChartRef = Type.Object(
  {
    chart: Type.String({ description: 'A chart name from the chart list' }),
    drivers: Type.Optional(DriverRefs),
  },
  { additionalProperties: false },
);

const SuggestArgs = Type.Object(
  {
    streams: Type.Optional(StreamRefs),
    charts: Type.Optional(Type.Array(ChartRef, { description: 'Charts, each with the drivers it is about' })),
  },
  { additionalProperties: false },
);

/** `suggest_tiles` as the model sees it: the chart names registered by now, or no charts at all. */
function suggestArgs(): typeof SuggestArgs {
  const schema = JSON.parse(JSON.stringify(SuggestArgs));
  const names = chartsOf().map((c) => c.name);
  if (names.length) schema.properties.charts.items.properties.chart.enum = names;
  else delete schema.properties.charts;
  return schema;
}

type Item = { type: string; props: Record<string, unknown> };

/**
 * Turns the charts the model named into items, with drivers as car numbers. A problem never depends on
 * how the session is going: only on the session type, missing data, an unknown name or the driver count.
 */
function planCharts(charts: Static<typeof ChartRef>[]): { items: Item[]; problems: string[] } {
  const { session, sessionData, feeds } = read();
  const roster = driversOf(sessionData.state === 'ready' ? sessionData.drivers : [], feeds);
  const items: Item[] = [];
  const problems: string[] = [];
  for (const { chart, drivers: refs = [] } of charts) {
    const info = chartsOf().find((c) => c.name === chart || normalize(c.title) === normalize(chart));
    if (!info) {
      problems.push(`There is no chart "${chart}": pick a name from the chart list.`);
      continue;
    }
    if (session && info.sessions && !info.sessions.includes(session.type)) {
      problems.push(`${info.name} is for ${info.sessions.map(sessionTypeName).join(', ')} sessions, and this is ${sessionTypeName(session.type)}: leave it out.`);
      continue;
    }
    if (info.needs.length && sessionData.state === 'unsupported') {
      problems.push(`${info.name} has no data for this session: ${sessionData.reason}`);
      continue;
    }
    const numbers: number[] = [];
    const unknown: string[] = [];
    for (const ref of refs) {
      const hit = resolveDriver(roster, ref);
      if (!hit) unknown.push(ref);
      else if (!numbers.includes(hit.number)) numbers.push(hit.number);
    }
    if (unknown.length) {
      problems.push(`No driver matches ${unknown.map((u) => `"${u}"`).join(', ')} in this session: ask the user who they mean.`);
      continue;
    }
    const count = driverCount(info);
    if (!count.fits(numbers.length)) {
      const got = numbers.length === 0 ? 'none were given: ask the user which' : `${numbers.length} ${numbers.length === 1 ? 'was' : 'were'} given`;
      problems.push(`${info.name} takes ${count.text}, and ${got}.`);
      continue;
    }
    items.push({ type: info.name, props: numbers.length ? { drivers: numbers } : {} });
  }
  return { items, problems };
}

const chartNamed = (needle: string) => chartsOf().find((c) => normalize(c.name) === needle || normalize(c.title) === needle);

/** The keys of what `remove_tiles` names: chart tiles by label, then by chart name or title, then streams. */
function tileKeys(refs: string[]): string[] {
  const charts = tilesOf(read().layout).filter((t) => t.component.type !== VIDEO);
  const keys = new Set<string>();
  for (const ref of refs) {
    const needle = normalize(ref);
    const byLabel = charts.filter((t) => normalize(t.component.label) === needle);
    const hits = byLabel.length ? byLabel : charts.filter((t) => t.component.type === chartNamed(needle)?.name);
    if (hits.length) hits.forEach((t) => keys.add(t.component.key));
    else {
      const feed = resolveChannel(read().feeds, ref);
      if (feed) keys.add(feed.id);
    }
  }
  return [...keys];
}

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
  expose(host.suggestions.offer, {
    name: 'suggest_tiles',
    description: `Suggest streams and charts as tiles, in a strip under the conversation: the user adds the ones they want, or dismisses them. This is the only way to put anything on screen. It returns at once, before the user answers. Calling it again in the same turn adds to the strip. At most ${MAX_SUGGESTED_STREAMS} streams wait in the strip at a time. Charts come from the chart list, each with the drivers it is about.`,
    args: suggestArgs,
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
  }),
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
  expose(host.data.sql, {
    name: 'query_session',
    description: QUERY_DESCRIPTION,
    args: Type.Object(
      {
        sql: Type.String({ description: 'One SELECT statement. Use ? for params.' }),
        params: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Null()]))),
        asOf: Type.Optional(AsOf),
      },
      { additionalProperties: false },
    ),
    adapt: ({ sql, params, asOf }) => ({ sql, params, asOf }),
    gate: [
      sessionOpen,
      dataReady,
      async ({ sql, asOf }) => {
        if (asOf === 'session') await approve({ kind: 'read_ahead', session: sessionTitle(), playheadMs: playheadMs(), sql });
      },
    ],
    result: ({ columns, rows }, { asOf }) => {
      const shown = rows.slice(0, MAX_QUERY_ROWS).map((row) => columns.map((c) => row[c]));
      // Nothing at the playhead often just means it hasn't happened on screen yet.
      const note =
        rows.length > MAX_QUERY_ROWS
          ? `Showing ${MAX_QUERY_ROWS} of ${rows.length} rows. Narrow the query to see the rest.`
          : rows.length === 0 && asOf !== 'session'
            ? 'Nothing up to the frame on screen. If the moment may be later, ask again with asOf "session".'
            : undefined;
      return JSON.stringify({ columns, rows: shown, ...(note ? { note } : {}) });
    },
  }),
  expose(host.playback.seekToDate, {
    name: 'seek_to',
    description:
      'Move playback to a moment, given as a UTC millisecond time exactly as it comes from a date column of query_session. A moment later than the frame on screen asks the user first. Playback stays within what can be played.',
    args: Type.Object({ date: Type.Number({ description: 'UTC milliseconds, from a query_session date column' }) }, { additionalProperties: false }),
    adapt: ({ date }) => ({ dateMs: date }),
    gate: [
      sessionOpen,
      dataReady,
      async ({ dateMs }) => {
        const playhead = playheadMs();
        // With the frame on screen unknown, a seek may be forward: ask.
        if (playhead === null || dateMs > playhead) await approve({ kind: 'seek_forward', session: sessionTitle(), playheadMs: playhead, targetMs: dateMs });
      },
    ],
    result: ({ timeSec, clamped }) =>
      `Playback is at ${formatClock(timeSec)}.${clamped ? ' That moment is outside what can be played, so it stopped at the nearest end.' : ''}`,
  }),
];

export const toolDefinitions = (): AgentToolDefinition[] => AGENT_TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));

/** Returns the model-facing result text; throws on failure. */
export async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = AGENT_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(args);
}
