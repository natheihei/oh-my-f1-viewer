/**
 * The agent's tools, each built from the host function it calls. A tool with no arguments of its own
 * takes the function's schema, and one with its own must type-check against the function's through
 * `adapt`. Only what's specific to the agent lives here: names, wording, name matching and gates.
 * These are not user commands: `/` commands are a separate, much smaller set in src/shell/commands.ts.
 *
 * There is deliberately no forward seek and no race-state tool yet. Both wait for a spoiler approval
 * gate here, so the agent can never jump past what the viewer has seen. See docs/DESIGN.md.
 *
 * Results are short and go back to the model. Nothing returned here may reveal how a session turned
 * out, only what exists and what is on screen.
 */
import Type, { type Static, type TObject } from 'typebox';
import type { AgentToolDefinition, Channel } from '../../shared/api';
import { FIRST_SEASON, host, MAX_SUGGESTED_STREAMS, read, tilesOf, type Op } from '../host';
import { normalize, resolveChannel } from './matching';

export interface AgentTool extends AgentToolDefinition {
  run(args: Record<string, unknown>): Promise<string>;
}

/** Refuses a call by throwing. Gets the host arguments, and what the model actually sent. */
type Gate<A, M> = (args: A, modelArgs: M) => void;

interface Exposure<A, R, S extends TObject> {
  name: string;
  /** Model-facing wording, if the host's description isn't the right one. */
  description?: string;
  /** Model-facing arguments, if they differ from the host's. */
  args?: S;
  adapt?: (modelArgs: Static<S>) => A;
  gate?: Gate<A, Static<S>>[];
  result?: (out: Awaited<R>, modelArgs: Static<S>) => string;
  /** What to tell the model to do about an error from the host. */
  hints?: [RegExp, string][];
}

function expose<A, R, S extends TObject = TObject>(op: Op<A, R>, options: Exposure<A, R, S>): AgentTool {
  const { name, description, args, adapt, gate = [], result, hints = [] } = options;
  return {
    name,
    description: description ?? op.info.description,
    // Plain JSON, since definitions cross IPC.
    parameters: JSON.parse(JSON.stringify(args ?? op.info.args)),
    async run(modelArgs) {
      const model = modelArgs as Static<S>;
      const hostArgs = adapt ? adapt(model) : (modelArgs as A);
      for (const check of gate) check(hostArgs, model);
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

const somethingPlaying = (): void => {
  if (read().clock.end <= 0) throw new Error('Nothing is playing yet, so there is nothing to rewind.');
};

const rewindOnly = ({ seconds }: { seconds: number }): void => {
  if (!(seconds < 0)) throw new Error('seconds must be positive.');
};

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

const idsOf = (feeds: Channel[]) => feeds.map((f) => f.id);
const labelsOf = (feeds: Channel[]) => feeds.map((f) => f.label).join(', ');
const missingNote = (missing: string[]) => (missing.length ? ` Not found: ${missing.join(', ')}. Use list_streams to see the options.` : '');
const onScreen = (id: string) => tilesOf(read().layout).some((t) => t.component.key === id);

function isoDate(ms: number | null): string | null {
  return ms ? new Date(ms).toISOString().slice(0, 16) + 'Z' : null;
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
    description: `Suggest streams as tiles, in a strip under the conversation: the user adds the ones they want, or dismisses them. This is the only way to put anything on screen. It returns at once, before the user answers. Calling it again in the same turn adds to the strip. At most ${MAX_SUGGESTED_STREAMS} streams wait in the strip at a time.`,
    args: Type.Object({ streams: StreamRefs }, { additionalProperties: false }),
    adapt: ({ streams }) => ({ feeds: idsOf(matchAll(streams).feeds) }),
    gate: [
      sessionOpen,
      ({ feeds }, { streams }) => {
        if (feeds.length === 0) throw new Error(`No matching streams.${missingNote(matchAll(streams).missing)}`);
      },
    ],
    result: ({ suggested, onScreen, repeated, overLimit }, { streams }) => {
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
    name: 'remove_streams',
    description: 'Take streams off screen.',
    args: Type.Object({ streams: StreamRefs }, { additionalProperties: false }),
    adapt: ({ streams }) => ({ feeds: idsOf(matchAll(streams).feeds) }),
    gate: [sessionOpen],
    result: (_, { streams }) => {
      const { feeds, missing } = matchAll(streams);
      return `Removed: ${labelsOf(feeds) || 'nothing'}.${missingNote(missing)}`;
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
      const { audio, feeds } = read();
      return audio == null ? 'All streams muted.' : `Audio is now ${feeds.find((f) => f.id === audio)?.label}.`;
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
  expose(host.playback.seekBy, {
    name: 'seek_back',
    description: 'Rewind every stream by some seconds. Going forward is not possible: the viewer does that on the timeline, so it cannot spoil anything.',
    args: Type.Object({ seconds: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
    adapt: ({ seconds }) => ({ seconds: -seconds }),
    gate: [sessionOpen, somethingPlaying, rewindOnly],
    result: (_, { seconds }) => `Back ${seconds}s.`,
  }),
];

export const toolDefinitions = (): AgentToolDefinition[] => AGENT_TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));

/** Returns the model-facing result text; throws on failure. */
export async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = AGENT_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(args);
}
