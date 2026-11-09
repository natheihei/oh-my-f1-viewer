# Host reference

This is everything a consumer (a tile component, the shell or the agent) can read or change. It all comes from `src/host`, and
`tests/layers.test.ts` fails if a consumer imports from below it. [DESIGN.md](DESIGN.md) explains why the host is shaped this way.
This page lists what it offers.

The source is the reference: each write and query is defined in [src/host/index.ts](../src/host/index.ts) and
[src/host/layoutOps.ts](../src/host/layoutOps.ts) with its own description and argument schema. If this page and the code
disagree, the code is right and this page needs fixing.

There are three kinds of things:

| Kind | How | Changes anything? |
| --- | --- | --- |
| Live state | `useLive(select)`, `read()` | No |
| Queries | `host.catalog.*`, `host.session.feeds`, `host.data.sql`, `useSql` | No |
| Writes | `host.session.*`, `host.playback.*`, `host.audio.*`, `host.layout.*`, `host.suggestions.*`, `host.catalog.loadIndex` | Yes |

The host has no gates. Nothing checks who is calling or whether they should, so `host.playback.seek` goes anywhere, forward
included. Rules like spoiler protection belong to the caller. The agent's are in `src/agent/tools.ts`.

## Live state

```ts
const playing = useLive((s) => s.clock.playing); // re-renders only when this value changes
const now = read();                              // the same state, once, outside React
```

A selector must return a value or an existing reference. Building a new object on every call re-renders forever.

| Field | Type | What it holds |
| --- | --- | --- |
| `session` | `SessionInfo \| null` | The open session: `contentId`, `title`, `type`, `year`, `startMs`, `endMs`, `meetingKey`, `sessionKey`, `hasOnboards`, `series`, `status` (`'replay' \| 'live' \| 'upcoming'`) |
| `feeds` | `Channel[]` | The feeds the open session offers: `id` (`${contentId}:${channelId ?? 0}`), `kind` (`main`, `onboard`, `data`, `tracker`, `other`), `label` (a driver code like HAM, or the channel name), `title`, and for onboards `driverName`, `driverCode`, `team`, `number` |
| `streams` | `Record<feedId, StreamView>` | Each mounted stream's `status` and `error` |
| `audio` | `string \| null` | The audible feed, or null if everything is muted |
| `volume` | `number` | Master volume from 0 to 1. It carries over from one session to the next |
| `clock` | `ClockState` | `timeSec`, `playing`, `buffering`, `live`, `start`/`end` (the range you can seek in), `atLiveEdge`, `wallClockMs` |
| `layout` | `LayoutState` | `nodes` (tiles and groups with grid rects), `primaryId` (the largest node), `manual` (whether the mouse has moved something) |
| `countdown` | `Countdown \| null` | `title`, `startMs` and `session` while waiting for an upcoming session (see `host.session.open`) |
| `suggestions` | `SuggestionsView` | The tiles the agent suggested this turn, waiting in the strip: `items` (component specs), `highlight` (the key of an on-screen tile that the suggestion under the mouse duplicates) and `drop` (where a dragged suggestion would land, in grid cells) |
| `events` | `EventIndex` | F1 TV's events from `FIRST_SEASON` (2023) on, grouped by season and loaded at start, plus `state` (`idle`, `loading`, `ready`, `error`) and `error` |
| `schedule` | `ScheduleView` | Every meeting and session from 2023 on, refreshed each time the app starts, plus `state` and `reason` |
| `sessionData` | `SessionDataView` | Whether there's session data and, if not, why (see below) |

`tilesOf(layout)` flattens `layout.nodes` into its tiles, including those inside groups.

### `sessionData`

`sessionData.state` is one of:

- `idle`: no session is open.
- `unsupported`, with a `reason`, such as a session from before 2023.
- `loading`, with a `sessionKey` and `coverage`.
- `failed`, with a `reason`.
- `ready`. In this state it also holds:
  - `sessionKey`.
  - `coverage`: which `source` it came from (`archive` or `live`), each dataset's (`timing`, `telemetry`, `results`) state and reason,
    `missingFeeds`, the `gaps` a live capture missed, and `capturedFrom`.
  - `revision`: goes up each time what can be seen may have changed.
  - `playheadMs`: the frame on screen, in UTC milliseconds.
  - The roster and results as they stood at the playhead: `drivers`, `startingGrid` (races and sprints, from the grid on),
    `sessionResult` (only once the session has finished at the playhead), `championshipDrivers` and `championshipTeams`.

Types are in [shared/sessionData.ts](../shared/sessionData.ts). Field names follow OpenF1, except that times are UTC milliseconds.

## Queries

Queries read things that aren't part of the live state. They return promises, except `host.session.feeds`.

| Function | Arguments | Returns |
| --- | --- | --- |
| `host.catalog.seasons()` | none | The seasons F1 TV has |
| `host.catalog.events({ year })` | `year: integer` | That season's Grand Prix events, future ones included |
| `host.catalog.sessions({ pageId, year })` | `pageId: integer`, `year: integer` | One event's sessions, Formula 1 first |
| `host.catalog.live()` | none | What F1 TV has live now |
| `host.catalog.upcoming()` | none | Formula 1 sessions that haven't started, soonest first |
| `host.session.feeds()` | none | The open session's feeds (the same as `live.feeds`) |
| `host.data.sql({ sql, params? })` | `sql: string`, `params?: (string \| number \| null)[]` | The rows from a read-only query on the open session |

### Session SQL

`host.data.sql` runs one query. `useSql(sql, params)` runs it again whenever `sessionData.revision` changes and returns
`{ state: 'loading' }`, `{ state: 'failed', reason }` or `{ state: 'ready', ...rows }`.

The tables are `car_data`, `intervals`, `laps`, `location`, `overtakes`, `pit`, `position`, `race_control`, `stints` and `weather`. Each
holds only what the feed had revealed at the frame on screen, so a query can't see past the playhead. Only `SELECT` is allowed.
[SESSION_DATA.md](SESSION_DATA.md) covers the columns, where the data comes from, and when it loads.

## Writes

Each write takes one object argument, or none. The schema describes it, and TypeScript checks it, but nothing checks it at runtime. Feeds are named by their `id` from `live.feeds`.
Matching a name like "Hamilton" to an id is the caller's job.

### `host.session`

| Function | Arguments | Effect |
| --- | --- | --- |
| `open` | `contentId: integer`, `title?: string`, `fromStart?: boolean` | Replaces whatever is open with this replay or live session and puts its main feed on screen. `fromStart` starts a live session at the beginning instead of the live edge. For a session that hasn't started, it shows a countdown instead and opens the session once F1 TV has it live. Returns `{ session, feeds }`, where `feeds` is `null` while counting down |
| `close` | none | Closes the open session and clears the screen |

### `host.catalog`

| Function | Arguments | Effect |
| --- | --- | --- |
| `loadIndex` | none | Loads every event from `FIRST_SEASON` on into `live.events`, or retries a load that failed. Resolves to the index whether or not it loaded |

### `host.playback`

All of these act on every stream at once.

| Function | Arguments | Effect |
| --- | --- | --- |
| `play` | none | Resumes playback |
| `pause` | none | Pauses |
| `toggle` | none | Plays if paused, pauses if playing |
| `seek` | `time: number` | Moves to a time on the session clock (`clock.timeSec`) |
| `seekBy` | `seconds: number` | Moves by that many seconds. A negative number goes back |
| `seekToStart` | none | Goes to the very beginning |
| `goLive` | none | Returns to the live edge |

### `host.audio`

| Function | Arguments | Effect |
| --- | --- | --- |
| `set` | `feed: string \| null` | Makes that one feed audible, or mutes everything with `null` |
| `setVolume` | `volume: number` (0 to 1) | Sets the master volume. The audible feed stays the same |
| `changeVolumeBy` | `amount: number` | Raises the master volume, or lowers it with a negative number |
| `toggleMute` | none | Mutes the master volume or restores it. If no feed is audible, makes the default feed audible |

### `host.layout`

A *target* is a tile key, a group id or a group title. A video tile's key is its feed id.

| Function | Arguments | Effect |
| --- | --- | --- |
| `add` | `feeds: string[]` | Puts the feeds on screen as separate tiles. A feed already on screen is skipped |
| `remove` | `feeds: string[]` | Takes the feeds off screen, whether they're tiles or inside a group |
| `close` | `tile: string` | Takes one tile off screen. Returns whether a tile matched |
| `group` | `feeds: string[]`, `title?: string` | Shows the feeds side by side as one group. Returns the group id |
| `closeGroup` | `group: target` | Closes a group and its tiles. Returns their labels, or `null` if nothing matched |
| `ungroup` | `group: target` | Breaks up a group but keeps its tiles. Returns whether a group matched |
| `focus` | `target: target` | Makes the tile or group the largest thing on screen. Returns whether it matched |
| `reset` | none | Goes back to the default arrangement, discarding any moves and resizes |
| `move` | `tile: string`, `rect: { x, y, w, h }` | Moves or resizes a tile or group, in grid cells (24 × 24) |
| `swap` | `a: string`, `b: string` | Swaps the places of two tiles or groups |

`<Grid>` sends mouse moves, swaps and closes through `move`, `swap` and `close`, the same functions any other caller uses.

### `host.suggestions`

Suggested tiles wait in a strip for the user to add, drag onto the grid or dismiss. Suggestions belong to one turn: the user's next
message clears them, and so does opening or closing a session. A *key* is a suggestion's component key, which for a video is its
feed id.

| Function | Arguments | Effect |
| --- | --- | --- |
| `offer` | `feeds: string[]` | Adds the feeds to the strip, up to `MAX_SUGGESTED_STREAMS` (4) streams. A feed already suggested or added this turn is skipped. Fails once the user has dismissed the strip this turn. Returns `{ suggested, onScreen, repeated, overLimit }`, as labels |
| `add` | `key: string` | Adds the suggestion where auto-layout puts it, and takes it out of the strip. A suggestion that's already on screen only leaves the strip. Returns whether the key matched |
| `dragOver` | `key: string`, `x: number`, `y: number` | Shows where a suggestion dragged to that pointer position (client pixels) would land |
| `drop` | `key: string`, `x: number`, `y: number` | Drops a suggestion there, splitting the tile under the pointer or filling the gap. Returns whether it landed |
| `cancelDrag` | none | Stops showing where a drag would land |
| `highlight` | `key: string \| null` | Outlines the on-screen tile the suggestion duplicates, or clears the outline |
| `dismiss` | none | Clears the strip. Nothing joins it again until the user's next message |
| `newTurn` | none | Clears the strip for a new turn. Returns a sentence saying what the user did with the last suggestions, or `null` |

## Outside the protocol

These live on the host too, but they aren't ops: they have no schema, and the agent's tools aren't built from them.

- `host.account`: `status()`, `login(service)`, `logout(service)` and `onExpired(cb)`, for F1 TV and ChatGPT sign-ins. Only the shell uses
  them, for the user's `/` commands and to notice an expired sign-in.
- `host.agent`: the link to the agent loop in the main process (`status`, `send`, `cancel`, `onEvent`, `onToolCall`, `toolResult`). The shell's
  agent feed and `src/agent/bridge.ts` use it.

## Primitives

- `<Video feed={id} />` shows a feed. Mounting it is what asks for the stream, and unmounting gives it back. It's the one thing that
  isn't a write, because a stream lasts exactly as long as the tile showing it.
- `<PreviewScope>` marks the `<Video>`s inside it as previews: they show their feed without taking its audio. The suggestion strip
  uses it.
- `<Grid components={[...]} />` draws the layout, showing each tile with the component its spec names, along with where a dragged
  suggestion would land.
- `defineComponent({ name, View })` declares a component for tiles. `View` receives the tile's `props` and `label`, and may only use
  the host.

## The agent's view

The agent is a consumer like any other. `src/agent/tools.ts` exposes some ops as tools, with the agent's own names, wording, name
matching and gates (spoiler approval among them). The host doesn't know about any of that.

The agent can't put a feed on screen itself: it suggests tiles, and the user adds them. `src/agent/bridge.ts` sends it the event
index (`live.events`) with every message, so it can work out which weekend the user means without a tool. It also sends what
`host.suggestions.newTurn` reports. The tools today:

| Tool | Host function |
| --- | --- |
| `list_sessions`, `list_live`, `list_upcoming` | `host.catalog.sessions`, `.live`, `.upcoming` |
| `load_session`, `list_streams` | `host.session.open`, `.feeds` |
| `suggest_tiles` | `host.suggestions.offer` |
| `remove_streams`, `focus_stream`, `reset_layout` | `host.layout.remove`, `.focus`, `.reset` |
| `set_audio` | `host.audio.set` |
| `play`, `pause`, `seek_to_start`, `seek_back` | `host.playback.play`, `.pause`, `.seekToStart`, `.seekBy` (backwards only) |

Anything not listed, such as `host.data.sql`, `host.layout.add`, groups, seeking forward or volume, isn't offered to the agent at
the moment.
