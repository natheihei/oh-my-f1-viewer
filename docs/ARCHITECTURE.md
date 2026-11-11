# Architecture

```
┌ Renderer ─────────────────────────────────────────────────────┐
│ Components  what a tile can show, from the app or from mods   │
│ Shell       palette · timeline · countdown · / commands       │
│ Agent       tools built on the host · gates                   │
│ ── Host ──  the only thing the three above may use            │
│ Data        session · clock · synced streams · session data   │
│ Layout      layout tree → solver → GridStack placeholders     │
└─────────────┬─────────────────────────────────────────────────┘
              │ typed IPC (shared/api.ts). Tokens never cross it.
┌ Main ───────┴─────────────────────────────────────────────────┐
│ F1 TV sign-in, catalog, playback · license proxy · Widevine   │
│ session database + live socket · circuit · agent loop (pi-ai) │
│ mods: watch, compile, serve                                   │
└───────────────────────────────────────────────────────────────┘
```

`tests/layers.test.ts` fails if anything reaches around the host, or if anything but the data layer talks to the main process. The layout knows
nothing about video: a tile just names a component, so charts can be added by defining one and listing it in `src/components/registry.ts`,
or from outside the app in a [mod](MODS.md).

[DESIGN.md](DESIGN.md) has the direction this is heading in, and why.

## Host (`src/host`)

Everything a component, the shell or the agent can do goes through here. [HOST.md](HOST.md) lists every read and write:

- **Reads:** `useLive(selector)` re-renders only when the selected value changes, and `read()` gives the same state once, outside React. `useSql` and `host.data.sql` read the session's
  time series, and can't write.
- **Writes and queries:** typed functions such as `host.playback.seekBy({ seconds: -10 })`. Each declares its description and argument schema, and
  none of them checks who's calling. Policy, such as spoiler approval, belongs to the caller.
- **Primitives:** `<Video feed={id} />` shows a feed, and `<Grid>` draws the layout. Mounting a `<Video>` is what asks for the stream, the one
  thing that isn't a write function, because a stream's life follows the tile showing it.

## Charts (`src/components/charts`)

Charts are components like video: one file each, holding the `defineComponent` declaration (the description the agent reads, `args`,
`sessions`, `needs`, `size`), its SQL, a pure function from rows to a drawable model, and the drawing. They draw on Canvas 2D by hand,
with no chart library, for the reasons in [PITWALL.md](PITWALL.md). They may only import from the host, and from the kit beside them:

- **`kit/ChartFrame`** wraps every chart. It shows a short message instead of the chart while session data isn't ready, a dataset in
  `needs` is absent or failed, something else in `waits` isn't there (such as the circuit, through `circuitMessage`), the query
  failed, or there are no rows yet, and it holds the chart's error boundary. Messages say what's missing, never anything about the race.
- **`kit/ChartCanvas`** sizes a canvas to its tile at the screen's pixel ratio and calls the chart's `draw(ctx, model, box)` only when the
  model or size changes. Below 300 × 150 the box is `compact`, and charts drop axes and labels, so the suggestion strip's preview reads as
  a thumbnail.
- **Helpers:** linear scales and ticks, axis labels with grid lines only where a value is labelled, polylines, end labels pushed apart,
  text, gap and lap time parsing, tyre age, driver colours from the roster (a team's second driver dashed) and tyre colours from the theme.
  For lap-based charts (`kit/laps.ts`): the lap axis to the race distance with safety car, VSC and red flag laps shaded, the clean-lap
  rule, racing pace, and medians.
  The accent red is never used inside a chart: it would read as a team or a soft tyre.

**Telemetry charts** (`track_map`, `speed_trace`, `telemetry_live`) read `location` and `car_data`, about 1.5 million rows a race,
and need `telemetry`, which a live session doesn't have. Their geometry is in `kit/track.ts`: the outline turned and fitted to a tile,
a car's line crossings from its positions, distance along a lap, and the time difference between two laps.
- **Bound every telemetry query by `date` on both sides.** The key is `(session_key, date, driver_number)`, so a `date` range is an
  index range and a driver filter alone is a scan. Pass `sessionData.playheadMs` as a parameter and use `date > ? - window AND date <= ?`:
  a row is never revealed before its `date`, and without the upper bound the range runs on through every row after the playhead (13ms
  instead of 0.3ms at lap 20).
- **Re-query only when the answer can change.** `useSql` runs again on every revision, about once a second, so parameters tied to the
  playhead give a new query each time. That's right for the map and the live telemetry, which move every second. `speed_trace` keys its
  samples on the laps it picked, so its parameters only change when a lap is completed.

To add one: write the file, keep the rows-to-model function pure and test it, and list the component in `src/components/registry.ts`.
Keep the model's reference until its rows change (`useSql` already does for its result), so the canvas redraws only then.
`scripts/charts-check.mjs` puts the charts on screen over a real replay and saves screenshots.

## Data layer (`src/data`)

`session.ts` is the only source of "now". Upper layers acquire streams, read the clock, and issue play, pause and seek. They
never touch a stream's time.

- **Streams** (`stream.ts`) own their `<video>` and Shaka player outside React, so nothing in the UI can restart one.
- **Clock.** A reference stream drives it: the main feed when available, otherwise another stream. With no streams at all an
  internal timer takes over, so closing the main feed doesn't stop time.
- **Startup.** Streams start one at a time and wait out CDN hangs (see STATUS.md).
- **Sync** (`syncEngine.ts`) runs every 200ms: seek on 0.5s of drift or more, nudge playback rate on smaller drift, and hold
  everyone while the reference stalls. The decisions are pure and unit-tested.
- **Reveal.** A new stream reports `resolving`, `loading` and `syncing` before `ready`, and its tile shows that status instead
  of the picture until it is within 0.25s of the clock.
- **Session data** (`sessionData.ts`) is the session database from this side: the calendar, the roster and results, and SQL over the time series, all as of the frame on screen, never later. Its `state`
  says whether there's data and, if not, why. The database itself lives in `electron/timingdb`, on a worker thread. See [SESSION_DATA.md](SESSION_DATA.md).

### Aligning data to video

Neither timeline starts at the race start: replay video has a lead-in (lights out at 512.9s for the 2026 Mexico race), and the
feed starts 13-60 minutes before lights out. In order of preference (`timeMap.ts`):

1. The curated `session_start` from the sync API, anchored to where the feed's session clock starts running.
2. The stream's wall clock.
3. The scheduled start, within about a minute.

This differs from F1 OpenViewer, which puts the wall clock first. Measured against curated lights-out it ran about 15s ahead
(14.73s on 2024 Mexico, 14.99s on 2023 Mexico), which would show events before they happen on screen.

Live data is held until the video reaches it, because F1 TV's live video runs tens of seconds behind the feed (about 45s
when measured). F1 OpenViewer applies records on arrival, and lists this as a known limitation. Each row stores when it arrived, so rewinding
the video just changes which rows show.

Live streams sit 8s behind the edge. Closer than that starves their buffers: at 2.2s back, onboards drifted over a second and stayed
at low quality.

## Layout layer (`src/layout`)

`model.ts` holds the tree and all changes to it as pure functions. It allows one level of nesting: the root holds tiles and
groups, and groups hold tiles. Nothing offers groups at the moment, to the agent or the mouse, so every tile sits at the root.

Components don't live in the grid. `Stage.tsx` keeps a flat list of hosts, one per tile, under transparent GridStack placeholders,
and each host follows its placeholder every frame. This is what makes GridStack safe: moving a node into a nested grid removes and
re-adds it in the DOM, which would stop a `<video>`, but placeholders hold nothing, so `GridSurface.tsx` just rebuilds them when the
tree changes.

- Auto-layout is broadcast-first: the primary node is largest, with the rest in a rail and then a band below it.
- Each tile has a title bar drawn by the grid, with its label and a close button. Only the title bar drags and only the edges resize:
  everything else on the grid lets the mouse through to the component underneath.
- A full grid has no empty cells to drag into, so dropping a tile on another swaps them.
- After a mouse edit the layout stays as arranged, and new tiles go in the largest free space, or re-tile if there is none.

## Commands and agent tools are separate

- **`/` commands** (`src/shell/commands.ts`) are for the user: account actions.
- **Agent tools** (`src/agent/tools.ts`) are for the model. Users never invoke them.

Both use the host, but neither can call the other.

## UI state across restarts

Small UI state that should survive a restart, so far only the master volume, is kept by the shell, above the host. The host holds it
while the app runs. `src/shell/uiState.ts` saves it to `localStorage`. At start, before the first render, the shell gives it back to
the host through the host's ordinary writes (`src/shell/persistVolume.ts`). The host doesn't know any of this happens.

## Agent

`electron/agent/agent.ts` is a short tool loop on [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai), using OpenAI's
Sign in with ChatGPT plan usage. It lives in main because it holds the credentials. Tools run in the renderer because it owns layout and
playback, so their definitions come with each message and each call goes over IPC.

`src/agent/tools.ts` builds each tool from the host function it calls, with one `expose` entry. A tool with no arguments of its own takes the
function's schema, and one with its own must type-check against the function's through `adapt`, so a host change that breaks a tool fails
to compile. Only what's specific to the agent lives there: names, model-facing wording, matching names like "Hamilton" to feeds, and gates
that refuse a call.

- **Why not `codex app-server`.** It keeps built-in tools even with every feature flag off. In testing it still offered
  `apply_patch`, sub-agents and image generation, and tried to read `/etc/hostname` with `view_image`. With pi-ai, the model can
  only call what we define.
- **Spoilers.** The agent can seek to a moment (`seek_to`) and query the session's SQL (`query_session`). Reading past the playhead and
  seeking forward ask `spoilerGate` (`src/agent/spoilerGate.ts`) first, on every call, in the agent's tools, not the host. The gate approves
  everything for now and will become a prompt to the user. The agent reads ahead only to find a moment to jump to, and is told never to say
  what it found. Other tool results, the `seek_to` result and `app_state` hold nothing about how a session turned out: `app_state` adds only
  the playhead and the roster. There is still no race-state tool. See [DESIGN.md](DESIGN.md).
- **Model.** `gpt-6-luna` by default, the fastest tested. Override with `F1A_MODEL`.

## Sign-in

- **F1 TV** uses an in-app window on F1's real page and reads its `login-session` cookie, as F1 OpenViewer does. An external browser
  can't hand that session back.
- **ChatGPT** uses your real browser, with pi-ai running the local callback on port 1455.
- Credentials are encrypted with the OS keyring. Chromium doesn't detect a keyring outside GNOME and KDE, so `main.ts` sets
  `--password-store=gnome-libsecret`. Without it, tokens would silently be stored in plain text on Hyprland.

## What sessions exist

F1 TV is the only source for what exists and when, past, live and future (`electron/f1tv/catalog.ts`). It keeps sessions in two
places on an event page, and the catalog combines them:

- An `interactive_schedule` section, on events from 2024 on, holds the whole weekend, including sessions that haven't happened. Each
  has a `contentId` ahead of time, and its state in `contentSubtype`: `LIVE_EVENT` for upcoming, `LIVE` and `REPLAY`.
- Replay trays exist back to 2018, and also carry support series and earlier years of the same Grand Prix.

Countdowns wait for their `contentId` to appear in F1 TV's live list. Matching on the event would also fire for a pre-race show going
on air first, and the live list's `sessionKey` can be empty.
