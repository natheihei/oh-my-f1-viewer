# Host reference

This is everything a consumer (a tile component, the shell or the agent) can read or change. It all comes from `src/host`, and
`tests/layers.test.ts` fails if a consumer imports from below it. [DESIGN.md](DESIGN.md) explains why the host is shaped this way.
This page lists what it offers.

The source is the reference: each write and query is defined in [src/host/index.ts](../src/host/index.ts),
[src/host/layoutOps.ts](../src/host/layoutOps.ts), [src/host/suggestions.ts](../src/host/suggestions.ts) and
[src/host/components.ts](../src/host/components.ts) with its own description and argument schema. If this page and the code
disagree, the code is right and this page needs fixing.

There are three kinds of things:

| Kind | How | Changes anything? |
| --- | --- | --- |
| Live state | `useLive(select)`, `read()` | No |
| Queries | `host.catalog.*`, `host.session.feeds`, `host.data.sql`, `useSql` | No |
| Writes | `host.session.*`, `host.playback.*`, `host.audio.*`, `host.layout.*`, `host.suggestions.*`, `host.components.*`, `host.catalog.loadIndex` | Yes |

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
| `components` | `ComponentInfo[]` | Every component a tile can show, without its code: `name`, `title`, `description`, `args` (its props' schema, as plain JSON), `sessions` (the session types it applies to, or `null` for any), `needs` (the datasets it reads) and `size` (a hint in grid cells, or `null`). It only changes when something registers |

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
| `host.data.sql({ sql, params?, asOf? })` | `sql: string`, `params?: (string \| number \| null)[]`, `asOf?: 'playhead' \| 'session'` | The rows from a read-only query on the open session |

### Session SQL

`host.data.sql` runs one query. `useSql(sql, params)` runs it again whenever `sessionData.revision` changes and returns
`{ state: 'loading' }`, `{ state: 'failed', reason }` or `{ state: 'ready', ...rows }`.

The tables are `car_data`, `intervals`, `laps`, `location`, `overtakes`, `pit`, `position`, `race_control`, `stints` and `weather`. By default
(`asOf: 'playhead'`) each holds only what the feed had revealed at the frame on screen, so a query can't see past the playhead. `asOf: 'session'`
sees everything the session holds, results included, so a caller that shows what it reads to the user must ask first. `useSql` always reads as
of the playhead. Only `SELECT` is allowed. The table and column definitions are in [shared/sessionTables.ts](../shared/sessionTables.ts).
[SESSION_DATA.md](SESSION_DATA.md) covers the columns, where the data comes from, and when it loads.

## Writes

Each write takes one object argument, or none. The schema describes it, and TypeScript checks it, but nothing checks it at runtime.
The exception is a component's props: `host.layout.add` and `host.suggestions.offer` check them against the component's `args`, and
throw if they don't fit. Feeds are named by their `id` from `live.feeds`. Matching a name like "Hamilton" to an id is the caller's job.

A *component item* is `{ type, props }`: a component's `name` from `live.components`, and props that fit its `args`. The host turns it
into a tile with the component's own key and label, and throws on a type that isn't registered.

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
| `seekToDate` | `dateMs: number` | Moves to a moment on the session data clock, in UTC milliseconds like every `date` column, kept within the seekable range. Fails when the video can't be matched to the data yet (no time map, or a live stream with no wall clock). Returns `{ timeSec, clamped }`: where it landed on the session clock, and whether it had to stop short |
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

A *target* is a tile key, a group id or a group title. A video tile's key is its feed id, and its label is the feed's label.

| Function | Arguments | Effect |
| --- | --- | --- |
| `add` | `items: { type, props }[]` | Puts the components on screen as separate tiles. One whose key is already on screen is skipped |
| `remove` | `keys: string[]` | Takes the tiles with those keys off screen, whether they stand alone or are inside a group. Returns the labels of those that were on screen |
| `close` | `tile: string` | Takes one tile off screen. Returns whether a tile matched |
| `group` | `feeds: string[]`, `title?: string` | Shows the feeds side by side as one group. Returns the group id |
| `closeGroup` | `group: target` | Closes a group and its tiles. Returns their labels, or `null` if nothing matched |
| `ungroup` | `group: target` | Breaks up a group but keeps its tiles. Returns whether a group matched |
| `focus` | `target: target` | Makes the tile or group the largest thing on screen. Returns whether it matched |
| `reset` | none | Goes back to the default arrangement, discarding any moves and resizes |
| `move` | `tile: string`, `rect: { x, y, w, h }` | Moves or resizes a tile or group, in grid cells (24 × 24) |
| `swap` | `a: string`, `b: string` | Swaps the places of two tiles or groups |

`<Grid>` sends mouse moves, swaps and closes through `move`, `swap` and `close`, the same functions any other caller uses.

### `host.components`

The app registers its components once at start, from `src/main.tsx`. The host keeps their definitions, draws tiles with them, and
lists what's safe to share in `live.components`.

| Function | Arguments | Effect |
| --- | --- | --- |
| `register` | `components: ComponentDefinition[]` | Makes the components available to tiles. One with a name that's already registered replaces it |

### `host.suggestions`

Suggested tiles wait in a strip for the user to add, drag onto the grid or dismiss. Suggestions belong to one turn: the user's next
message clears them, and so does opening or closing a session. A *key* is a suggestion's component key, which for a video is its
feed id.

| Function | Arguments | Effect |
| --- | --- | --- |
| `offer` | `items: { type, props }[]` | Adds the components to the strip. Videos stop at `MAX_SUGGESTED_STREAMS` (4), since each preview is a real stream; other components don't count. One already suggested or added this turn is skipped. Fails once the user has dismissed the strip this turn. Returns `{ suggested, onScreen, repeated, overLimit }`, as labels |
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
- `<Grid />` draws the layout, showing each tile with the registered component its spec names, along with where a dragged
  suggestion would land.
- `<ComponentView spec={spec} fallback={...} />` draws one spec with its registered component, or `fallback` if none is registered.
  The suggestion strip uses it for previews.
- `defineComponent({ name, title, description, args, spec, sessions?, needs?, size?, View })` declares a component for tiles.
  `args` is a TypeBox object schema for its props, which must stay JSON-safe. `spec(props)` returns the tile's unique `key` and
  title-bar `label`. `sessions` lists the session types it applies to, `needs` the datasets it reads, and `size` is a hint in grid
  cells that nothing uses yet. `View` receives the tile's `props` and `label`, and may only use the host.

## The agent's view

The agent is a consumer like any other. `src/agent/tools.ts` exposes some ops as tools, with the agent's own names, wording, name
matching and gates (spoiler approval among them). The host doesn't know about any of that.

The agent can't put a feed on screen itself: it suggests tiles, and the user adds them. `src/agent/bridge.ts` sends it the event
index (`live.events`) with every message, so it can work out which weekend the user means without a tool. It also sends what
`host.suggestions.newTurn` reports, and the tiles on screen, a chart by its label and component name.

Every registered component but `video` is a chart. The bridge lists them at the end of the system prompt, one line each: name, title,
how many drivers it takes, session types and description. With none registered, the list is left out. `suggest_tiles` takes charts
by name, each with the drivers it's about, which the agent matches to car numbers through the session's roster, or the onboard feeds
without one. A chart's props carry only those numbers, and a chart given none picks its own. The agent never sees what a chart shows,
and a refusal only ever depends on the session type, missing data, an unknown name or the driver count, never on how the session is
going. The tools today:

| Tool | Host function |
| --- | --- |
| `list_sessions`, `list_live`, `list_upcoming` | `host.catalog.sessions`, `.live`, `.upcoming` |
| `load_session`, `list_streams` | `host.session.open`, `.feeds` |
| `suggest_tiles` | `host.suggestions.offer`, for streams and charts |
| `remove_tiles` | `host.layout.remove`, for streams and charts |
| `set_audio` | `host.audio.set` |
| `set_volume` | `host.audio.setVolume`, as a percentage |
| `play`, `pause`, `seek_to_start` | `host.playback.play`, `.pause`, `.seekToStart` |
| `seek_to` | `host.playback.seekToDate`. Asks the spoiler gate first when the moment is later than the playhead |
| `query_session` | `host.data.sql`. Asks the spoiler gate first for `asOf: 'session'`. At most 200 rows go back to the model |

`app_state` also carries the master volume next to the audible feed, so the agent never calls a feed audible at volume 0. It carries the
playhead in UTC milliseconds and the roster as driver code and number too, so the agent can write a query and pass a `date` straight to `seek_to`. Anything not listed, such as `host.layout.add`, `focus` and `reset`, groups, `seekBy`, `goLive`, `changeVolumeBy` or `toggleMute`, isn't
offered to the agent at the moment.
