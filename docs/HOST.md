# Host reference

This is everything a consumer (a tile component, whether the app's or a [mod](MODS.md)'s, the shell or the agent) can read or change. It all comes from `src/host`, and
`tests/layers.test.ts` fails if a consumer imports from below it. [DESIGN.md](DESIGN.md) explains why the host is shaped this way.
This page lists what it offers.

The source is the reference: each write and query is defined in [src/host/index.ts](../src/host/index.ts),
[src/host/layoutOps.ts](../src/host/layoutOps.ts), [src/host/suggestions.ts](../src/host/suggestions.ts),
[src/host/components.ts](../src/host/components.ts), [src/host/health.ts](../src/host/health.ts) and [src/host/backgrounds.ts](../src/host/backgrounds.ts) with its own description and argument schema. If this page and the code
disagree, the code is right and this page needs fixing.

There are three kinds of things:

| Kind | How | Changes anything? |
| --- | --- | --- |
| Live state | `useLive(select)`, `read()` | No |
| Queries | `host.catalog.*`, `host.session.feeds`, `host.health.settled`, `host.health.errors`, `host.data.sql`, `useSql`, `useSqlWindow` | No |
| Writes | `host.session.*`, `host.playback.*`, `host.audio.*`, `host.layout.*`, `host.suggestions.*`, `host.build.*`, `host.health.attach`, `host.health.detach`, `host.health.takeAttached`, `host.components.*`, `host.backgrounds.*`, `host.appearance.*`, `host.catalog.loadIndex` | Yes |

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
| `streams` | `Record<videoId, StreamView>` | Every video playing: `id`, `feed`, `tile` (the tile it's in, or null in a preview), `quiet` (a preview's, never heard), `status` and `error`. A feed shown in two places is two videos, each its own stream, in the order they started |
| `audio` | `string \| null` | The one video heard, by its id, or null if none is |
| `volume` | `number` | Master volume from 0 to 1. It carries over from one session to the next, and the shell saves it across restarts |
| `clock` | `ClockState` | `timeSec`, `playing`, `buffering`, `live`, `start`/`end` (the range you can seek in), `atLiveEdge`, `wallClockMs` |
| `headers` | `Record<tileId, TileHeader>` | What each tile's component says its title bar shows, where it says: `label`, `drivers`, `status` (`load`, `sync` or `error`) and `audio` (`on` or `muted`). See `useTileHeader` below |
| `layout` | `LayoutState` | `tiles` (each tile's `id`, `component` spec and grid rect, in the order they were added), `manual` (whether the mouse has moved something), `main` (the id of the tile with the main place in auto-layout, or null) |
| `pointed` | `string \| null` | The tile the viewer is pointing at from the prompt, by id, which the grid puts in the spotlight: a tile row selected in the mention picker, or a tile's tag under the mouse. See `host.layout.point` |
| `countdown` | `Countdown \| null` | `title`, `startMs` and `session` while waiting for an upcoming session (see `host.session.open`) |
| `suggestions` | `SuggestionsView` | The tiles the agent suggested this turn, waiting in the strip: `items` (component specs), `highlight` (the key of an on-screen tile that the suggestion under the mouse duplicates) and `drop` (where a dragged suggestion would land, in grid cells) |
| `events` | `EventIndex` | F1 TV's events from `FIRST_SEASON` (2023) on, grouped by season and loaded at start, plus `state` (`idle`, `loading`, `ready`, `error`) and `error` |
| `schedule` | `ScheduleView` | Every meeting and session from 2023 on, refreshed each time the app starts, plus `state` and `reason` |
| `sessionData` | `SessionDataView` | Whether there's session data and, if not, why (see below) |
| `circuit` | `CircuitView` | The open session's circuit: outline, corners and pit loss (see below) |
| `components` | `ComponentInfo[]` | Every component a tile can show, including those from mods that loaded, without its code: `name`, `origin` (`installed`, the app's own, read-only and forked to change, or `local`, a mod), `title`, `description`, `args` (its props' schema, as plain JSON), `sessions` (the session types it applies to, or `null` for any), `needs` (the datasets it reads) and `size` (its shape and its least room in pixels, or `null`). It only changes when something registers or unregisters |
| `mods` | `ModStatus[]` | Every mod in the mods folder: `name`, `state` (`loading`, `ready` or `failed`), `version`, `url` and `error`. See [MODS.md](MODS.md) |
| `build` | `BuildView` | Build mode: `active`, `changes` (each mod that differs from how the folder stood on entry, as `{ name, change }` with `added`, `edited` or `deleted`) `enteredAtSec` (the session clock on entry, or null with no session) and `offer` (build mode offered to the viewer from view mode and not yet answered: the offering agent's `reason`, for the viewer, and `note`, for the build agent, and `tiles` whose errors go along, maybe none; or null). See [BUILD_MODE.md](BUILD_MODE.md) |
| `health` | `PlaceHealth[]` | Each place a component shows, a tile or a preview in the strip: its `scope`, `where` (`tile` or `strip`), `type`, `label` and `state`. `drawn` means it didn't throw. `needs_props` lists the required props it lacks in `missing`, and those its args no longer accept in `dropped`. `error` has the `message` it threw. `waiting` looks ahead and isn't drawn until the viewer allows it. A place that isn't drawing has `since`, the moment it first stood this way (`clockSec`, and `playheadMs` in UTC ms), kept while it fails the same way. It's null otherwise, and with no session open |
| `attached` | `Attachment[]` | Tiles' errors the viewer attached to their next message from a tile's button, in the order attached, until a message takes them: `scope` (the tile) and `report`, an `ErrorReport` of how it stood then: `place` (from `health`), the tile's `props`, and `log`, its mod's log relative to the mods folder, or null for the app's own components. A tile that closes goes from it |
| `agentBusy` | `boolean` | Whether the agent is working on a message: from when one is sent until its turn ends or is stopped. A message sent while it's busy stops that turn and starts one with it |
| `spec` | `Spec` | What differs by season, Grand Prix or session, for the open session, or the defaults when none is open: `chaseAid` (`label`, `within`), the aid a car gets within `within` seconds of the one ahead, DRS until 2025 and Overtake ("OT") from 2026. From [src/data/spec.ts](../src/data/spec.ts) |
| `background` | `BackgroundView` | What fills the gaps between tiles: `style` (a name from `backgrounds`, or `'off'`), `params` (every registered style's settings, defaults filled in, kept while another style shows) and `unavailable` (why the style showing draws nothing right now, like "Needs an open session", or null). The shell saves it across restarts |
| `backgrounds` | `BackgroundInfo[]` | Every registered background, without its code: `name`, `title` and `params` (its settings' schema, as plain JSON). It only changes when something registers |

`tilesOf(layout)` is `layout.tiles`.

A component on screen is a *tile*, and a tile is named by its *id*, such as `tile-3`. The id stays the same through moves, resizes, a
re-tile, new props and a mod reload, until the tile is taken off screen. A component added again after that gets a new tile and a new
id. Ids are only unique while the app runs: they start again at `tile-1` on every load, so nothing should save one. A component's
*key*, made from its type and props, only keeps the same thing from going on screen twice. It changes with the props, so it never
names a tile. `live.health` and look-ahead approvals name tiles by id too.

### `sessionData`

`sessionData.state` is one of:

- `idle`: no session is open.
- `unsupported`, with a `reason`, such as a session from before 2023.
- `loading`, with a `sessionKey` and `datasets` (null until known).
- `failed`, with a `reason`.
- `ready`. In this state it also holds:
  - `sessionKey`.
  - `datasets`: each dataset's (`timing`, `telemetry`, `results`) `state` (`absent`, `loading`, `partial`, `complete` or `failed`)
    and `reason`.
  - `revision`: goes up each time what can be seen may have changed.
  - `playheadMs`: the frame on screen, in UTC milliseconds. It moves ten times a second while playing, without a new `revision`.
  - `drivers`: the roster as it stood at the playhead. The grid, the result and the championship are in SQL, below.
  - `lapCount`: `{ current, total }`, the leader's lap and the scheduled distance, as of the playhead. `null` in a session
    without them, such as practice or qualifying.
  - `tables`: every table SQL can read, as `{ name, columns, about? }`, in the order of `SQL_TABLES`. It's the same for every
    session, and stays the same object across revisions.

Types are in [shared/sessionData.ts](../shared/sessionData.ts). Field names follow OpenF1, except that times are UTC milliseconds.

### `circuit`

The open session's circuit, from [MultiViewer](https://multiviewer.app)'s public API. It's refreshed each time a session
opens: the cached copy shows at once if there is one, then the fresh one replaces it. If the fetch fails, the last copy stays
with a `reason`. It doesn't depend on the playhead, since a circuit can't spoil a race. `circuit.state` is one of:

- `idle`: no session is open.
- `loading`: the circuit's key isn't known yet, or it's being fetched with no cached copy. The key comes from the schedule's
  meeting, or for a meeting that hasn't happened yet, from the live feed's `SessionInfo`.
- `failed`, with a `reason`: the fetch failed and there's no cached copy.
- `ready`. In this state it also holds:
  - `circuitKey`: F1's own key, as the schedule's `circuit_key`.
  - `name`, and `refreshedAt`, when it was last fetched.
  - `outline`: `{ x, y }`, the track as one closed line, in the same units as `location`: tenths of a metre, with y up. Its first
    point is at the timing line.
  - `corners`: `{ number, x, y, angle, distance }`, where `distance` is how far along the outline it is from its first point, in the
    same units.
  - `rotation`: degrees to turn the outline by, anticlockwise with y up, so it reads the usual way up.
  - `pitLoss`: `{ normal, safetyCar, virtualSafetyCar }`, the seconds a stop costs, or null where MultiViewer has none.
  - `reason`: null, or why the copy is stale.

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
| `host.health.settled()` | none | `live.health`, once every place has drawn with its component's latest code, or after a second |
| `host.health.errors({ tiles })` | `tiles: string[]` | An `ErrorReport` for each of those tiles that isn't drawing now, as `live.attached` holds one |
| `host.data.sql({ sql, params?, asOf? })` | `sql: string`, `params?: (string \| number \| null)[]`, `asOf?: 'playhead' \| 'session'` | The rows from a read-only query on the open session |

### Session SQL

`host.data.sql` runs one query. `useSql(sql, params)` runs it again whenever `sessionData.revision` changes, about once a second
while playing, and whenever `params` change: a query passed `playheadMs` runs ten times a second. It returns `{ state: 'loading' }`, `{ state: 'failed', reason }` or `{ state: 'ready', ...rows }`. When a run
returns the same rows as the last, it keeps returning the previous object, so a chart can redraw only when its data changes.

`useSqlWindow(sql, params, { from, to })` is for a window of dates that moves with the playhead, such as a car's last lap of
telemetry. `?1` is `from` and `?2` is `to`, and `params` follow from `?3`. The query reads rows dated after `?1` up to `?2`, with a
`date` column, in date order. It reads the whole window on every revision and whenever the query or `params` change, and
otherwise only the rows after its last read, dropping those dated `from` or before. A playhead that goes back, or a window that
starts earlier, reads the whole window again. With `to` the playhead, it never reads past the frame. On a 90 second window ten
times a second, it reads a sample or two instead of 340 rows.

`useSql(sql, params, { asOf: 'session' })` reads the whole session, for a component that needs the future, such as a control that
jumps to the next lap. It asks the viewer nothing. A component that should warn them declares `looksAhead: true` in `defineComponent`:
the grid then shows a warning in place of the tile and draws the component only once the viewer allows it. Approval belongs to the
tile: it lasts until the tile is gone, survives the component reloading, and another tile of the same component asks again.
[BUILD_MODE.md](BUILD_MODE.md) has the details.

The tables are `car_data`, `championship_drivers`, `championship_teams`, `drivers`, `intervals`, `lap_summary`, `laps`, `location`,
`overtakes`, `pit`, `pit_lane`, `position`, `race_control`, `session_result`, `starting_grid`, `stints`, `track_status` and `weather`. `drivers` is the same roster as `sessionData.drivers`. By default (`asOf: 'playhead'`) each holds only what the feed had revealed at the frame on screen (`car_data` and `location`: each sample whose `date` the frame has reached), so a query
can't see past the playhead. `asOf: 'session'` sees everything the session holds, results included, so a caller that shows what it reads to
the user must ask first. `useSql` reads as of the playhead unless it asks for the session, as above. Only `SELECT` is allowed. The tables and their columns, as SQLite
reports them, are in `sessionData.tables`. The stored tables are defined in [shared/sessionTables.ts](../shared/sessionTables.ts), and the
views built from them, such as `lap_summary`, in [electron/timingdb/schema.ts](../electron/timingdb/schema.ts).
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
| `set` | `video: string \| null` | Makes that one video heard, by its id from `live.streams`, or none with `null`. Fails for a preview's video, or one that isn't playing |
| `setVolume` | `volume: number` (0 to 1) | Sets the master volume. The heard video stays the same |
| `changeVolumeBy` | `amount: number` | Raises the master volume, or lowers it with a negative number |
| `toggleMute` | none | Mutes the master volume or restores it. If no video is heard, makes the default one heard: the main feed's oldest, else the oldest |

When the heard video stops, the sound moves to the first of: the video that takes it over (a preview becoming its tile, or a
component drawn again, keeps its video and id); another video of the same feed; a video its tile started in the same moment, the same
`slot` first, so a tile switching pictures keeps the sound; the main feed's oldest video; none.

### `host.layout`

Every function that acts on a tile on screen takes its id. A video tile's label is its feed's label.

| Function | Arguments | Effect |
| --- | --- | --- |
| `add` | `items: { type, props }[]` | Puts the components on screen as separate tiles. Returns the id of the tile showing each, in order. One whose key is already on screen isn't added again, and the id of the tile showing it is returned |
| `remove` | `tiles: string[]` | Takes those tiles off screen. Returns the labels of those that were on screen |
| `setProps` | `tile: string`, `props` | Gives the tile new props, in place of its old ones, checked against its component's `args`. It keeps its id, its place and the main place, and its label follows the props. Throws if another tile already shows the same component with those props. Returns `{ label }`, or null if the tile isn't on screen |
| `autoLayout` | none | Re-tiles the grid in the order tiles were added, discarding any moves and resizes. `/auto-layout` runs it |
| `setMain` | `tile: string \| null` | Gives a tile the main place in auto-layout, top left and as large as the others allow, or with `null` takes it away. Returns whether the tile is on screen. `layout.main` holds its id. Opening a session gives it to the main feed's tile, and nothing else assigns it |
| `move` | `tile: string`, `rect: { x, y, w, h }` | Moves or resizes a tile, in grid cells (24 × 24) |
| `swap` | `a: string`, `b: string` | Swaps the places of two tiles |
| `point` | `tile: string \| null` | Puts the tile in the spotlight, as the viewer points at it from the prompt: the others dim, and it's framed with its title bar lit. `null` ends it. Returns whether the tile is on screen. `pointed` holds its id. The suggestion strip's `highlight` wins over it. The agent isn't given it |

`<Grid>` sends mouse moves, swaps and closes through `move`, `swap` and `remove`, the same functions any other caller uses.

### `host.components`

The app registers its components once at start, from `src/main.tsx`, and each [mod](MODS.md) registers its component again on every save. The host
keeps their definitions, draws tiles with them, and lists what's safe to share in `live.components`.

| Function | Arguments | Effect |
| --- | --- | --- |
| `register` | `components: ComponentDefinition[]`, `origin?: 'installed' \| 'local'` | Makes the components available to tiles. One with a name that's already registered replaces it, and its tiles redraw with the new one. `origin` says where they come from, `local` (a mod) unless said: `src/main.tsx` registers the app's own as `installed` |
| `unregister` | `names: string[]` | Makes the components unavailable and takes their tiles off screen. Returns the names that were registered. A mod's folder being deleted does this |

### `host.backgrounds` and `host.appearance`

The app registers its backgrounds once at start, from `src/main.tsx`, like components. `<Backdrop />` paints the one showing, and the
shell's `/settings-background` panel changes it.

| Function | Arguments | Effect |
| --- | --- | --- |
| `backgrounds.register` | `backgrounds: BackgroundDefinition[]` | Makes the backgrounds available. One with a name that's already registered replaces it |
| `appearance.setBackground` | `style: string`, `params?: Record<string, number \| boolean>` | Shows that style, or `'off'` for none, and changes some of its settings. Settings are checked against the style's schema: numbers are clamped to their range and snapped to their step, and anything else that doesn't fit is ignored. Throws on a style that isn't registered |

### `host.build`

Build mode's snapshot of the mods folder, which the main process keeps. See [BUILD_MODE.md](BUILD_MODE.md).

| Function | Arguments | Effect |
| --- | --- | --- |
| `build.begin` | none | Takes the snapshot and turns build mode on. Does nothing new if it's already on |
| `build.save` | none | Drops the snapshot, keeping every change. Resolves to what changed in the app's words, like "Built lap_stepper.", or null |
| `build.undo` | none | Puts the mods folder back as it stood on entry. Resolves to how many mods that undid |
| `build.offer` | `reason: string`, `note: string`, `tiles?: string[]` | Offers the viewer build mode, to fix those tiles in their component's code or to build or change a component: it waits in `live.build.offer`, replacing any offer before it. Throws while build mode is on, and for a tile that isn't on screen. Whoever takes it up enters build mode and gives the build agent the tiles as they stand and the note: the shell does, from the palette |
| `build.dismissOffer` | none | Withdraws the offer, if there is one. `build.begin` withdraws it too |

### `host.health`

Whether what's on screen is drawing, and attaching what isn't to the viewer's next message. The report itself is `live.health`, and
its type, `PlaceHealth`, is in [shared/health.ts](../shared/health.ts) with the wording the build agent reads it in, and `errorBlock`,
how an agent reads an `ErrorReport`.

| Function | Arguments | Effect |
| --- | --- | --- |
| `health.settled` | none | A query. Resolves to `live.health` once every place has drawn with its component's latest code, or after a second: a mod that just loaded takes a moment to draw |
| `health.errors` | `tiles: string[]` | A query. An `ErrorReport` for each of those tiles that isn't drawing now |
| `health.attach` | `scope: string` | Attaches a tile's error to the viewer's next message: it joins `live.attached` as the tile stands now, replacing what was attached for it before, in its place. Returns whether it was attached: only a tile that isn't drawing can be, a preview never. It works whatever the agent is doing. It's what a tile's "Attach error to agent" does |
| `health.detach` | `scope: string` | Takes a tile off `live.attached`. Returns whether it was there |
| `health.takeAttached` | none | Takes everything on `live.attached`, oldest first, to send with a message, and leaves it empty |

The host doesn't send anything itself. The shell's palette shows `live.attached` as a tray above its input, and the viewer's next
message takes them (`sendToAgent` in `src/shell/agentFeed.ts`): each is an `<error>` block of JSON (`errorBlock`) after `app_state` and
before the viewer's words, which may be none. Anything else that speaks to an agent can do the same.

### `host.suggestions`

Suggested tiles wait in a strip for the user to add, drag onto the grid or dismiss. Suggestions belong to one turn: the user's next
message clears them, and so does opening or closing a session. Build mode's drafts are the exception: the strip holds a preview with
the props the agent suggested it with, or none, for each mod the build added or changed that has no tile on screen, and they stay from turn to turn. A *key* is a suggestion's component key, which for a video is its
feed id.

| Function | Arguments | Effect |
| --- | --- | --- |
| `offer` | `items: { type, props }[]` | Adds the components to the strip, with no limit on how many: each preview's videos are real streams, so many cost bandwidth. One already suggested or added this turn is skipped. Fails once the user has dismissed the strip this turn. Returns `{ suggested, onScreen, repeated }`, as labels |
| `add` | `key: string` | Adds the suggestion where auto-layout puts it, and takes it out of the strip. A suggestion that's already on screen only leaves the strip. Returns whether the key matched |
| `dragOver` | `key: string`, `x: number`, `y: number` | Shows where a suggestion dragged to that pointer position (client pixels) would land |
| `drop` | `key: string`, `x: number`, `y: number` | Drops a suggestion there, splitting the tile under the pointer or filling the gap. Returns whether it landed |
| `cancelDrag` | none | Stops showing where a drag would land |
| `highlight` | `key: string \| null` | Puts the on-screen tile the suggestion duplicates in the spotlight, as `host.layout.point` does, or ends it |
| `dismiss` | none | Clears the strip. Nothing joins it again until the user's next message |
| `newTurn` | none | Clears the strip for a new turn. Returns a sentence saying what the user did with the last suggestions, or `null` |

## Outside the protocol

These live on the host too, but they aren't ops: they have no schema, and the agent's tools aren't built from them.

- `host.account`: `status()`, `login(service)`, `logout(service)` and `onExpired(cb)`, for F1 TV sign-in, and `status()` also says whether
  the agent is set up. Only the shell uses them, for the user's `/` commands and to notice an expired sign-in.
- `host.agent`: the link to the agent loop in the main process (`status`, `send`, `cancel`, `onEvent`, `onToolCall`, `toolResult`), and its
  setup (`providers`, `connect`, `cancelConnect`, `onConnect`, `disconnect`, `choose`). The shell's agent feed, `/settings-agent` and
  `src/agent/bridge.ts` use it. `send` keeps `live.agentBusy` as messages go through it (`src/host/agentTurn.ts`).
- `host.savedState`: small UI state kept across restarts in the profile's settings file (`load()`, `get(key)`, `set(key, value)`).
  `src/main.tsx` loads it once before the first render, and only the shell restores and saves through it (`src/shell/uiState.ts`).
- `startMods(shared)`: starts loading mods, with the modules they share with the app. `src/main.tsx` calls it once, after registering
  the app's own components.
- `startHealth()`: answers the main process when it asks for `host.health.settled()`, which it does for the build agent. `src/main.tsx`
  calls it once.
- `startPictures()`: answers the main process when it asks for a picture of a component, for the build agent's `look_at`. It takes
  it with Element Capture, restricted to the tile or draft, so nothing drawn over it is in it (`src/host/picture.ts`). `src/main.tsx`
  calls it once.

## Primitives

- `useStream(feed, { slot })` holds one video of a feed while the component is drawn, and gives it back after: it's the one thing that
  isn't a write, because a video lasts exactly as long as what shows it. Each call is its own video and stream, so a feed can show in
  several places, playing independently (sharing one is a later optimisation). A null feed holds nothing, and that picture is empty. It
  returns a `Stream`: `id`, `feed`, `label`, `status`, `error`, `heard` (`on`, `muted` or null) and `quiet`. `slot` names which picture
  it is in a component with more than one, for where the sound goes when a heard picture switches feed.
- `<Video stream={stream} />` draws a video: it fills its box, letterboxes the picture, shows the feed's name and status until it's
  ready, and stays shown through seeks. Hovering shows a speaker mark, and a click makes it the video heard, bringing the volume back
  from 0. The heard one keeps its mark when its tile has more than one picture. `<Video feed={id} />` holds one and draws it.
- `streamSlots(...streams)` turns a component's videos into the title bar's slots: the worst status and the sound. Spread it into
  `useTileHeader`.
- `useTileHeader({ label, drivers, status, audio })` says what the tile's title bar shows, for as long as the component is drawn. Each
  field left out comes from the spec, so a component whose content changes as the viewer uses it, like the battle showing whichever
  fight was picked, names what it shows itself. The host draws the bar; build mode's mark and looking ahead stay the host's.
- `useTileState(key, initial)` is `useState` kept with the tile: a component drawn again, as when its mod is saved, gets back what it
  had. It goes when the tile leaves the grid. `useTilePlace()` says which tile or preview a component is drawn in.
- `<PreviewScope>` marks the videos inside it as previews: they show their feed and are never heard. The suggestion strip
  uses it.
- `<Grid />` draws the layout, showing each tile with the registered component its spec names, along with where a dragged
  suggestion would land. Every tile has an error boundary: a component that throws while drawing shows the error in its own tile, and
  a new version of the component gets a fresh try. A tile whose props lack one its component requires shows what it needs instead
  of drawing. Both are in `live.health`.
- `<Backdrop />` paints the background `live.background` names, on a canvas under the grid, so it shows only in the gaps. It paints
  when something changes, and every frame only while the background animates with its settings. With reduced motion it paints still
  frames.
- `defineBackground({ name, title, params, animated, followsPointer?, useData?, unavailable?, prepare?, draw })` declares a background.
  `params` is a TypeBox object schema whose settings each carry a `title` and `default`: a number with `minimum`, `maximum`, `step` and
  an optional `unit` (`'%'` shows 0 to 1 as a percentage), a boolean, or a union of literals; `shownWhen` names another setting it
  only applies with. `useData(params)` is a hook for what it needs from the host, `prepare` makes what it keeps between frames, and
  `draw(ctx, frame, params, state, data)` paints one frame in CSS pixels.
- `<ComponentView spec={spec} scope={...} fallback={...} />` draws one spec with its registered component, or `fallback` if none is
  registered. `scope` names the place it draws in, a tile's id or a preview's scope: with one, it reports to `live.health`. The
  suggestion strip uses it for previews.
- `defineComponent({ name, title, description, args, spec, sessions?, needs?, size?, View })` declares a component for tiles.
  `args` is a TypeBox object schema for its props, which must stay JSON-safe. `spec(props)` returns the tile's unique `key` and
  title-bar `label`, and `drivers` when the tile is about some: then `label` is the name alone ("Gap"), the title bar draws each
  driver as a code after it, and the tile's text label, which the agent and the strip read, is `labelText` of the two ("Gap NOR ·
  PIA"). `sessions` lists the session types it applies to, `needs` the datasets it reads, and `size` is its
  shape (`aspect`, width over height) and the least room its content reads in (`min`, in pixels). The layout arranges tiles by it, and the strip shapes its preview by it. See [COMPONENTS.md](COMPONENTS.md). `View` receives the tile's `props` and `label`, and may only use the host.
- Driver props are named for what they hold, so the agent can fill them in: `driver`, `driver_a` and `driver_b`, `drivers` (those to
  highlight) and `drivers_to_display` (those to draw), or any name starting `driver_` or `drivers_`. `Driver(description)`,
  `DriverList(description, max?)`, `Highlighted(max?)` and `Displayed()` are their schemas, `isDriverProp(name)` and
  `isDriverList(name)` tell them by name, and `keyPart(value)` writes one for a key. See [COMPONENTS.md](COMPONENTS.md).

### Driver codes

A driver's code is drawn one way wherever it appears: in a title bar, a table, a chart's heading or a line of text. Everything takes
a car number and finds the code and team colour in the roster. How the code looks is a variant the caller picks, not a place: see
[COMPONENTS.md](COMPONENTS.md#driver-codes). From [src/host/drivers.tsx](../src/host/drivers.tsx) and [src/host/codes.ts](../src/host/codes.ts):

- `CodeLook` is `{ variant?, strong?, tone? }`. `variant` is `bar` (the default: a short bar in the team colour, then the code) or
  `plain` (the code alone, where the team colour is drawn already). `strong` sets it bold. `tone` is `ink` (the default), `dim`,
  `mute`, or `inherit` to take the colour of the text around it.
- `<DriverCode number={44} variant="bar" />` draws one code in React, and `driverCodeElement(number, look)` as a DOM element for
  chrome built without React.
- `Part` is a piece of text or `{ driver }`: text with drivers in it, as a parser finds them. `<Parts parts={...} look={...} />`
  draws it, and `partsText(parts)` writes it out as text.
- `codeOf(number)`, `labelText(name, drivers)`, `useDriverStyles()`, `driverStyles(roster)` and `styleOf(styles, number)` give the
  code, a tile's text label, and each driver's code, team colour and dash.
- `CODE_BAR` and `CODE_WEIGHT` are the bar's size and the weights, which the kit's `drawCode` and `drawParts` draw on a canvas with.

## The agent's view

The agent is a consumer like any other. `src/agent/tools.ts` exposes some ops as tools, with the agent's own names, wording, name
matching and gates (spoiler approval among them). The host doesn't know about any of that.

The agent can't put a feed on screen itself: it suggests tiles, and the user adds them. `src/agent/bridge.ts` sends it the event
index (`live.events`) with every message, so it can work out which weekend the user means without a tool. It also sends what
`host.suggestions.newTurn` reports, and the tiles on screen, each by its title, component name and props, and the feeds it shows.

The bridge lists every registered component but `video`, which `suggest_tiles` takes as `streams`, at the end of the system prompt, one line each: name, title,
session types, description and props, each marked required or optional. With none registered, the list is left out. Once session data is ready, the
tables `query_session` can read follow, from `sessionData.tables`: one line each with its columns, and `about` where a table has one.
Before that the list is left out, and the tool refuses anyway. `suggest_tiles` takes components
by name, each with its props. A driver prop (`driver`, `driver_a`, `drivers`, `drivers_to_display` and any name starting `driver_` or
`drivers_`) takes codes, names or numbers, which the agent matches to car numbers through the session's roster, or the onboard feeds
without one. A required prop left out is refused, with a note to ask the user whose; a component never picks its own. `edit_tile` changes
the props of one component on screen in place, only those it names, null taking one away. `remove_tiles` and `edit_tile` name tiles by the
ids `app_state` lists, as in `on screen: tile-1 F1 LIVE (stream); tile-4 Pit 44 (pit_window, props {"driver":44}); tile-5 Battle NOR · VER (battle, shows Lando Norris, Max Verstappen)`, and refuse
anything else, labels included. A tile's title is what its component says, from `live.headers`. The agent never sees what a component shows, and a
refusal only ever depends on the session type, missing data, an unknown name or the props, never on how the session is going. The tools today:

| Tool | Host function |
| --- | --- |
| `list_sessions`, `list_live`, `list_upcoming` | `host.catalog.sessions`, `.live`, `.upcoming` |
| `load_session`, `list_streams` | `host.session.open`, `.feeds` |
| `suggest_tiles` | `host.suggestions.offer`, for streams and components |
| `remove_tiles` | `host.layout.remove`, for any tile |
| `edit_tile` | `host.layout.setProps`, for one component that isn't video |
| `offer_build` | `host.build.offer`, with `error_tiles` for `tiles`. The viewing agent's only: for a tile whose fix is in its component's code, or something the viewer asks for that no component does |
| `set_audio` | `host.audio.set`. It takes a stream name, and picks the video: the one already heard if it shows that feed, else the one in the main tile, else the oldest. It refuses a feed no tile shows |
| `set_volume` | `host.audio.setVolume`, as a percentage |
| `play`, `pause`, `seek_to_start` | `host.playback.play`, `.pause`, `.seekToStart` |
| `seek_to` | `host.playback.seekToDate`. Asks the spoiler gate first when the moment is later than the playhead |
| `query_session` | `host.data.sql`. Asks the spoiler gate first for `asOf: 'session'`. At most 200 rows go back to the model |

`app_state` also carries the master volume next to the heard video and its tile, so the agent never calls a feed audible at volume 0. It carries the
playhead in UTC milliseconds and the roster as driver code and number too, so the agent can write a query and pass a `date` straight to `seek_to`. Anything not listed, such as `host.layout.add` and `autoLayout`, `seekBy`, `goLive`, `changeVolumeBy` or `toggleMute`, isn't
offered to the agent at the moment.

With no session open, as on a countdown, messages go to the picking agent, which has only `list_sessions`, `list_live`, `list_upcoming`
and `load_session` (`PICKING_TOOLS` in `src/agent/tools.ts`). The rest act on an open session, and are the viewing agent's, which keeps
these to switch sessions. A call to one of them anyway, from an older turn, still reaches its gate, which refuses it. See
[ARCHITECTURE.md](ARCHITECTURE.md#agent) for how a message moves from one agent to the other.

While build mode is on, messages go to a second agent with its own prompt (`shared/buildPrompt.ts`) and conversation. From this list it
has `list_streams`, `remove_tiles`, `edit_tile`, `play`, `pause`, `suggest_tiles`, `query_session` and `seek_to`, and the last two don't
ask the spoiler gate. Its file tools run in the main process, and it's told what on screen isn't drawing, from `live.health`: see
[BUILD_MODE.md](BUILD_MODE.md).
