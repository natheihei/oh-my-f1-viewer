/**
 * The tools the agent can call. These are not user commands: `/` commands are a separate, much
 * smaller set (see src/shell/commands.ts), and users never invoke these directly.
 *
 * There is deliberately no forward seek and no race-state tool yet. Both wait for a spoiler
 * approval flow, so the agent can never jump past what the viewer has seen.
 */

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const none = { type: 'object', properties: {}, additionalProperties: false } as const;

const streamRefs = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Stream references: a driver code (HAM), surname (Hamilton), car number (44), or channel name (world feed, F1 Live, data, tracker).',
} as const;

export const AGENT_TOOLS: AgentToolDefinition[] = [
  {
    name: 'list_events',
    description:
      'List the Grand Prix events of a season, including future ones, with their pageId. Event names are official, e.g. Brazil is the São Paulo Grand Prix and Mexico is the Mexico City Grand Prix.',
    parameters: {
      type: 'object',
      properties: { year: { type: 'integer', description: 'Season, e.g. 2025' } },
      required: ['year'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_sessions',
    description:
      'List all sessions of one event: practice, qualifying, sprint, race, and shows, each with its status: replay, live, or upcoming.',
    parameters: {
      type: 'object',
      properties: {
        pageId: { type: 'integer', description: 'Event pageId from list_events' },
        year: { type: 'integer', description: 'Season of the event' },
      },
      required: ['pageId', 'year'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_live',
    description: 'List what F1 TV has live right now.',
    parameters: none,
  },
  {
    name: 'list_upcoming',
    description: 'List the next sessions that have not started yet, across events, with UTC start times.',
    parameters: none,
  },
  {
    name: 'load_session',
    description:
      'Open a replay or live session and start the main broadcast. Replaces whatever is open. Only call this once the user has identified one specific session; ask them if it is ambiguous. Upcoming sessions use wait_for_session.',
    parameters: {
      type: 'object',
      properties: {
        contentId: { type: 'integer', description: 'contentId from list_sessions or list_live' },
        title: { type: 'string', description: 'Session title to show the user' },
        fromStart: {
          type: 'boolean',
          description:
            'For a live session: true starts at the beginning of the broadcast, otherwise it joins at the live edge. Replays always start at the beginning.',
        },
      },
      required: ['contentId', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_session',
    description:
      'Show a countdown to one upcoming session, once the user has chosen it. It starts by itself when F1 TV goes live.',
    parameters: {
      type: 'object',
      properties: {
        contentId: { type: 'integer', description: 'contentId of the session, from list_sessions or list_upcoming' },
      },
      required: ['contentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_streams',
    description: 'List every stream the open session offers, and which are on screen.',
    parameters: none,
  },
  {
    name: 'add_streams',
    description:
      'Put streams on screen as individual tiles. To show drivers battling, use create_group instead.',
    parameters: {
      type: 'object',
      properties: { streams: streamRefs },
      required: ['streams'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_streams',
    description: 'Take streams off screen, whether they are individual tiles or inside a group.',
    parameters: {
      type: 'object',
      properties: { streams: streamRefs },
      required: ['streams'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_group',
    description:
      'Show streams side by side as one group, for a battle or comparison. Adds any stream that is not on screen and moves those that are.',
    parameters: {
      type: 'object',
      properties: {
        streams: streamRefs,
        title: { type: 'string', description: 'Short label, e.g. "NOR / LEC"' },
      },
      required: ['streams'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_group',
    description: 'Close a group and take all its streams off screen.',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group id or title, or any stream inside it' },
      },
      required: ['group'],
      additionalProperties: false,
    },
  },
  {
    name: 'ungroup',
    description: 'Dissolve a group but keep its streams on screen as individual tiles.',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group id or title, or any stream inside it' },
      },
      required: ['group'],
      additionalProperties: false,
    },
  },
  {
    name: 'focus_stream',
    description:
      'Make a stream or group the largest thing on screen, for requests like "make Hamilton bigger".',
    parameters: {
      type: 'object',
      properties: {
        stream: { type: 'string', description: 'A stream reference or group title' },
      },
      required: ['stream'],
      additionalProperties: false,
    },
  },
  {
    name: 'reset_layout',
    description:
      'Re-tile everything into the default arrangement with the main feed largest, discarding manual moves and resizes.',
    parameters: none,
  },
  {
    name: 'set_audio',
    description: 'Choose which single stream is audible, or mute everything with "none".',
    parameters: {
      type: 'object',
      properties: { stream: { type: 'string', description: 'A stream reference, or "none"' } },
      required: ['stream'],
      additionalProperties: false,
    },
  },
  {
    name: 'play',
    description: 'Resume playback of all streams.',
    parameters: none,
  },
  {
    name: 'pause',
    description: 'Pause playback of all streams.',
    parameters: none,
  },
  {
    name: 'seek_to_start',
    description: 'Go back to the very beginning of the open session. It can never skip anything forward.',
    parameters: none,
  },
  {
    name: 'seek_back',
    description:
      'Rewind every stream by some seconds. Going forward is not possible: the viewer does that on the timeline, so it cannot spoil anything.',
    parameters: {
      type: 'object',
      properties: { seconds: { type: 'integer', minimum: 1 } },
      required: ['seconds'],
      additionalProperties: false,
    },
  },
];

export const SYSTEM_PROMPT = `You run f1a, a multi-view Formula 1 viewer. The user talks to you through a small command palette over the video, usually in very few words. You change what is on screen by calling tools.

How to behave:
- Act, then confirm in a few words. One short line is the norm: "Hamilton added." Never use markdown.
- A bare year and place picks a session. If that weekend is over, it means the race, so load it: "2025 Mexico" loads the 2025 Mexico City Grand Prix. If the weekend is in progress or has not happened, always ask which session and wait for the answer, listing what is available compactly, including any upcoming session. Compare event dates to the current time in app_state. A named session, like "2026 Brazil quali", is never ambiguous.
- Only start a countdown once the user has chosen that specific upcoming session.
- A driver name alone means show their onboard.
- "Battle between X and Y", or two drivers together, means create_group. "Done with X and Y" means close_group.
- Resolve nicknames and misspellings yourself: Norris, Noris, Lando, NOR are all the same driver. Lec is Leclerc. Max is Verstappen.
- Any event uses list_events then list_sessions, which shows its past, live, and upcoming sessions. For "what's next" with no event named, use list_upcoming. For an upcoming session, offer wait_for_session.
- If F1 TV has it live now, load_session it straight away. It joins at the live edge, unless the user asks for the start, or to watch from the beginning, which is fromStart true. For a session already open, that request is seek_to_start.
- Do not guess content ids: always get them from a list tool in this conversation.

Spoilers:
- Never reveal or hint at results, winners, retirements, incidents, or championship outcomes, even if you remember them. The user may not have watched yet.
- You cannot move playback forward. If asked to, say the timeline does that.

The message from the app includes an <app_state> block describing what is open and on screen right now. Trust it over your memory of earlier turns.`;
