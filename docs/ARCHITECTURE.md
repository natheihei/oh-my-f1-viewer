# Architecture

```
┌ Renderer ─────────────────────────────────────────────────────┐
│ Shell       palette · timeline · countdown · / commands       │
│ Agent       runs tool calls against the layers below          │
│ Components  registry of what a tile can show: video for now   │
│ Layout      layout tree → solver → GridStack placeholders     │
│ Data        session · clock · synced streams · timing         │
└─────────────┬─────────────────────────────────────────────────┘
              │ typed IPC (shared/api.ts). Tokens never cross it.
┌ Main ───────┴─────────────────────────────────────────────────┐
│ F1 TV sign-in, catalog, playback · license proxy · Widevine   │
│ timing archive + live socket · agent loop (pi-ai)             │
└───────────────────────────────────────────────────────────────┘
```

Layers only depend downward, and `tests/layers.test.ts` fails if that stops being true. The layout knows nothing about video:
a tile just names a component, so charts can be added by registering one in `src/components/registry.ts`.

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
- **Timing** (`timing/`) exposes the race state at the frame on screen, never later.

### Aligning timing to video

Neither timeline starts at the race start: replay video has a lead-in (lights out at 512.9s for the 2026 Mexico race), and the
feed starts 13-60 minutes before lights out. In order of preference (`timeMap.ts`):

1. The curated `session_start` from the sync API, anchored to where the feed's session clock starts running.
2. The stream's wall clock.
3. The scheduled start, within about a minute.

This differs from F1 OpenViewer, which puts the wall clock first. Measured against curated lights-out it ran about 15s ahead
(14.73s on 2024 Mexico, 14.99s on 2023 Mexico), which would show events before they happen on screen.

Live timing is buffered until the video reaches it, because F1 TV's live video runs tens of seconds behind the feed. F1
OpenViewer applies records on arrival, and lists this as a known limitation.

## Layout layer (`src/layout`)

`model.ts` holds the tree and all changes to it as pure functions. It allows one level of nesting: the root holds tiles and
groups, and groups hold tiles.

Components don't live in the grid. `Stage.tsx` keeps a flat list of hosts, one per tile, under transparent GridStack placeholders,
and each host follows its placeholder every frame. This is what makes GridStack safe: moving a node into a nested grid removes and
re-adds it in the DOM, which would stop a `<video>`, but placeholders hold nothing, so `GridSurface.tsx` just rebuilds them when the
tree changes.

- Auto-layout is broadcast-first: the primary node is largest, with the rest in a rail and then a band below it.
- A full grid has no empty cells to drag into, so dropping a tile on another swaps them.
- After a mouse edit the layout stays as arranged, and new tiles go in the largest free space, or re-tile if there is none.

## Commands and agent tools are separate

- **`/` commands** (`src/shell/commands.ts`) are for the user: account actions.
- **Agent tools** (`shared/tools.ts`) are for the model, and run in `src/agent/executor.ts`. Users never invoke them.

Both call the same services underneath, but neither can call the other.

## Agent

`electron/agent/agent.ts` is a short tool loop on [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai), using OpenAI's
Sign in with ChatGPT plan usage. Tools run in the renderer because it owns layout and playback, so each call goes over IPC.

- **Why not `codex app-server`.** It keeps built-in tools even with every feature flag off. In testing it still offered
  `apply_patch`, sub-agents and image generation, and tried to read `/etc/hostname` with `view_image`. With pi-ai, the model can
  only call what we define.
- **Spoilers.** There is deliberately no forward seek and no race-state tool until there is a spoiler approval flow. Tool results
  and `app_state` hold nothing about how a session turned out. Timing data exists in the data layer, but the agent can't read it.
- **Model.** `gpt-6-luna` by default, the fastest tested. Override with `F1A_MODEL`.

## Sign-in

- **F1 TV** uses an in-app window on F1's real page and reads its `login-session` cookie, as F1 OpenViewer does. An external browser
  can't hand that session back.
- **ChatGPT** uses your real browser, with pi-ai running the local callback on port 1455.
- Credentials are encrypted with the OS keyring. Chromium doesn't detect a keyring outside GNOME and KDE, so `main.ts` sets
  `--password-store=gnome-libsecret`. Without it, tokens would silently be stored in plain text on Hyprland.

## Upcoming sessions

F1 TV only lists an event's sessions shortly before they run, and F1 OpenViewer has no schedule at all. So times come from OpenF1,
and F1 TV's live-now list decides when playback can actually start.
