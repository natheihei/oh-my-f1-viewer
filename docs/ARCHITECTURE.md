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
│ session database + live socket · circuit · agent (pi)         │
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
- **Primitives:** `useStream(feed)` holds a video of a feed and `<Video stream />` draws it, and `<Grid>` draws the layout. Holding a video
  is what asks for the stream, the one thing that isn't a write function, because a video's life follows what shows it. Any component can
  hold videos, as many as it likes: `video` is one component among the rest, and `battle` holds two. A component says what its title bar
  shows with `useTileHeader`, and keeps what the viewer picks in it with `useTileState`.

## Charts (`src/components/charts`)

A component is a spec that takes props and draws in a tile; nothing about charts is special. Charts are the components drawn on a
canvas with the kit: one file each, holding the `defineComponent` declaration (the description the agent reads, `args`,
`sessions`, `needs`, `size`), its SQL, a pure function from rows to a drawable model, and the drawing. They draw on Canvas 2D by hand,
with no chart library. They may only import from the host, and from the kit beside them:

- **`kit/ChartFrame`** wraps every chart. It shows a short message instead of the chart while session data isn't ready, a dataset in
  `needs` is absent or failed, something else in `waits` isn't there (such as the circuit, through `circuitMessage`), the query
  failed, or there are no rows yet, and it holds the chart's error boundary. Messages say what's missing, never anything about the race.
- **`kit/ChartCanvas`** sizes a canvas to its tile at the screen's pixel ratio and calls the chart's `draw(ctx, model, box)` only when the
  model or size changes. Below 300 × 150 the box is `compact`, and charts drop axes and labels, so the suggestion strip's preview reads as
  a thumbnail. `extent` lets a chart draw past its tile, and `onPointer` hands it the pointer, to name what's under it.
- **Helpers:** linear scales and ticks, axis labels with grid lines only where a value is labelled, polylines, end labels pushed apart,
  text, gap and lap time parsing, tyre age, driver colours from the roster (a team's second driver dashed) and tyre colours from the theme.
  For lap-based charts (`kit/laps.ts`): neutralised laps, the clean-lap rule, tyre age, medians, and where the lap axis ends.
  The accent red is never used inside a chart: it would read as a team or a soft tyre.

**Telemetry charts** (`track_map`, `car_telemetry`, `pedal_barcode`, `speed_ribbon`) read `location` and `car_data`, about 1.5 million rows a race,
and need `telemetry`, which a live session doesn't have. Their geometry is in `kit/track.ts`: the outline turned and fitted to a tile,
its length, and a position projected onto it as distance along the lap.
- **Bound every telemetry query by `date` on both sides.** The key is `(session_key, date, driver_number)`, so a `date` range is an
  index range and a driver filter alone is a scan. Pass `sessionData.playheadMs` as a parameter and use `date > ? - window AND date <= ?`:
  a row is never revealed before its `date`, and without the upper bound the range runs on through every row after the playhead (13ms
  instead of 0.3ms at lap 20).
- **Re-query only when the answer can change.** `useSql` runs again on every revision, about once a second, so parameters tied to the
  playhead give a new query each time. That's right for the map and the live telemetry, which move every second. `pedal_barcode` keys its
  completed laps on their starts, so those parameters only change when a lap is completed.

To add one: write the file, keep the rows-to-model function pure and test it, and list the component in `src/components/registry.ts`.
Keep the model's reference until its rows change (`useSql` already does for its result), so the canvas redraws only then.
`scripts/charts-check.mjs` puts the charts on screen over a real replay and saves screenshots.

## Data layer (`src/data`)

`session.ts` is the only source of "now". Upper layers acquire streams, read the clock, and issue play, pause and seek. They
never touch a stream's time.

- **Streams** (`stream.ts`) own their `<video>` and Shaka player outside React, so nothing in the UI can restart one. There's one per
  holder, named by a video id, so a feed shown in two tiles is two streams, synced to the clock on their own: two of a feed can sit up
  to the sync threshold apart. One let go is kept for a moment, and a new holder of the same feed in that moment takes it over, so a
  preview becoming its tile, or a component drawn again, carries on playing.
- **Sound** belongs to one video, not a feed, so moving it between two videos of a feed never jumps. Clicking a picture makes it the
  one heard. When the heard video stops, the sound moves as `HOST.md` says under `host.audio`.
- **Clock.** A reference stream drives it: the main feed when available, otherwise another stream. With no streams at all an
  internal timer takes over, so closing the main feed doesn't stop time.
- **Startup.** Streams start one at a time and wait out CDN hangs (see STATUS.md).
- **Sync** (`syncEngine.ts`) runs every 200ms: seek on 0.5s of drift or more, nudge playback rate on smaller drift, and hold
  everyone while the reference stalls. The decisions are pure and unit-tested.
- **Reveal.** A new stream reports `resolving`, `loading` and `syncing` before `ready`, and its tile shows that status instead
  of the picture until it is within 0.25s of the clock.
- **Session data** (`sessionData.ts`) is the session database from this side: the calendar, the roster and lap count, and SQL over the rest, all as of the frame on screen, never later. Its `state`
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

`model.ts` holds the layout and all changes to it as pure functions: a flat list of tiles, each with an id, a component and a grid
rect. The id names the tile while it's on screen, through moves and new props. (Groups of tiles were taken out in #101: nothing used
them.)

Components don't live in the grid. `Stage.tsx` keeps a flat list of hosts, one per tile, under transparent GridStack placeholders,
and each host follows its placeholder every frame. This is what makes GridStack safe: rebuilding its items removes and re-adds them
in the DOM, which would stop a `<video>`, but placeholders hold nothing, so `GridSurface.tsx` just rebuilds them when the layout
changes.

- Auto-layout is broadcast-first: the main tile is top left, and the rest go in a rail beside it or a band below it. The main
  tile is assigned with `host.layout.setMain`, which opening a session does for the main feed. With none assigned, tiles share the grid. Which goes where follows each component's declared shape and least size, and `src/layout/solve.ts` picks the arrangement that
  keeps tiles at their least size with the main tile as large as that allows. See [COMPONENTS.md](COMPONENTS.md).
- Each tile has a title bar drawn by the grid, with its label, state slots and a close button. A label that names drivers draws
  each as a driver code, from the roster, and is drawn again when the roster changes. A component may replace the label and drivers
  with its own, from `useTileHeader`. The slots say which tile carries the sound and when a stream is loading or catching up, both as
  the component reports them, and when a tile may look ahead, so nothing floats over the content. Only the title bar drags
  and only the edges resize: everything else on the grid lets the mouse through to the component underneath.
- A tile draws a hairline on its right and bottom edges only, so neighbours share one seam. Tiles are black on a slightly lifted
  ground, which is what separates them where there's no neighbour.
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

`electron/agent/agent.ts` runs a conversation on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable), pi's
harness without its terminal agent, on the provider, model and thinking level chosen in `/settings-agent`. Models and sign-ins are
pi-ai's. It lives in main because it holds the credentials. Tools run in the renderer because it owns layout and playback, so their
definitions come with each message and each call goes over IPC. With no session open the viewing agent is shown only what finds and
opens one: `list_sessions`, `list_live`, `list_upcoming` and `load_session`. When a call opens or closes a session, its result
carries the new set, and the model has it from the next request in the same turn, so "2025 Mexico race with Norris" can open the race
and suggest his onboard in one turn.

Each conversation is a Harness of its own with three extensions: the prompt, as one section holding the app's words and then the
reference; the renderer's tools, replaced by installing the extension again; and the rules, which are hooks. The cap on tool rounds
per message is the conversation's `maxTurns`. Nothing of pi's own is in the prompt, and the model can only call what the app defines.

Everything the agent keeps is under `<userData>/pi-agent`:

- `auth.json` holds the connected provider's credential, in the shape pi-ai gives it (`credentialFile.ts`). `settings.json` is written
  only if missing, so it can be edited, and `/settings-agent` saves the provider, model and thinking level there. It's read at every
  message (`settingsFile.ts`).
- `sessions` holds one `.jsonl` per conversation, for reviewing what the agent did: its prompts, `app_state`, tool calls and
  results, and token use (`transcript.ts`). The lines are the ones pi's own sessions had. It's a record only: the conversation
  itself is in memory, in pi-durable's `MemoryStorage`, so a new conversation or a restart starts empty. The files hold whatever
  the agent read, including race data, stay on this machine, and aren't pruned.
- `build-sessions` holds the same for build mode's own agent, one `.jsonl` per build. See [BUILD_MODE.md](BUILD_MODE.md).
- The build agent's file tools reach only the mods folder. Nothing in that folder is loaded as configuration or run in main.

`src/agent/tools.ts` builds each tool from the host function it calls, with one `expose` entry. A tool with no arguments of its own takes the
function's schema, and one with its own must type-check against the function's through `adapt`, so a host change that breaks a tool fails
to compile. Only what's specific to the agent lives there: names, model-facing wording, matching names like "Hamilton" to feeds, and gates
that refuse a call.

- **Why not `codex app-server`.** It keeps built-in tools even with every feature flag off. In testing it still offered
  `apply_patch`, sub-agents and image generation, and tried to read `/etc/hostname` with `view_image`. With pi, no tool exists
  turned off, the model can only call what we define.
- **Spoilers.** The agent can seek to a moment (`seek_to`) and query the session's SQL (`query_session`). Reading past the playhead and
  seeking forward ask `spoilerGate` (`src/agent/spoilerGate.ts`) first, on every call, in the agent's tools, not the host. The gate shows the
  viewer a spoiler check. With approval the agent may answer from what it read, for that turn only. Other tool results, the `seek_to` result
  and `app_state` hold nothing about how a session turned out: `app_state` adds only the playhead and the roster. There is still no race-state
  tool. See [SPOILER_PREVENTION.md](SPOILER_PREVENTION.md).
- **Providers and models.** `electron/agent/supported.ts` lists what `/settings-agent` offers: OpenAI, through a ChatGPT plan or an
  API key, and Anthropic through an API key, each with its models and a recommended model and thinking level. Anything else in pi's
  catalog is left out. Its comment says how to see everything pi offers. GPT-6 Luna and GPT-6.1 Terra have run the app's tools on a
  ChatGPT plan. Nothing has run on an API key yet.
- **One provider at a time.** Connecting another provider removes the first only once the new one succeeds, so a cancelled or failed
  connection changes nothing. Switching provider starts a new conversation. A new model or thinking level applies from the next
  message, in the same conversation.
- **Only credentials stored through the panel count.** Keys in the environment, like `ANTHROPIC_API_KEY`, are never used.
- **History.** Compaction summarizes old turns when the context nears the model's limit. A turn that read past the playhead is cut
  down to the viewer's message and the agent's words as soon as it ends: one more entry says how each of the turn's entries reads
  from then on, so later requests and summaries see the cut-down turn, and the stored entries stay as they were. A summary made
  while a turn is still using what it read ahead is made by the app, from the turn cut down the same way.

## Sign-in

- **F1 TV** uses an in-app window on F1's real page and reads its `login-session` cookie, as F1 OpenViewer does. An external browser
  can't hand that session back.
- **The agent's provider** is connected in `/settings-agent`. A ChatGPT sign-in uses your real browser, with pi running the local
  callback on port 1455. An API key is typed into its own small sandboxed window (`electron/agent/keyWindow.ts`), not the app's
  renderer, because mods run there with no sandbox and could read it. The key goes straight to main, and the renderer never sees it.
  pi keeps credentials in a plain `auth.json`, readable only by your user, in `agentDir`.
- F1 TV credentials are encrypted with the OS keyring. Chromium doesn't detect a keyring outside GNOME and KDE, so `main.ts` sets
  `--password-store=gnome-libsecret`. Without it, tokens would silently be stored in plain text on Hyprland.

## What sessions exist

F1 TV is the only source for what exists and when, past, live and future (`electron/f1tv/catalog.ts`). It keeps sessions in two
places on an event page, and the catalog combines them:

- An `interactive_schedule` section, on events from 2024 on, holds the whole weekend, including sessions that haven't happened. Each
  has a `contentId` ahead of time, and its state in `contentSubtype`: `LIVE_EVENT` for upcoming, `LIVE` and `REPLAY`.
- Replay trays exist back to 2018, and also carry support series and earlier years of the same Grand Prix.

Countdowns wait for their `contentId` to appear in F1 TV's live list. Matching on the event would also fire for a pre-race show going
on air first, and the live list's `sessionKey` can be empty.
