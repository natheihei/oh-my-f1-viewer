# Development

How to drive the app while working on it, and the checks that run it. [README.md](../README.md) has how to install it and run
it from source.

## Commands in the app

| | |
|---|---|
| `Ctrl+K` | Show or hide the palette, with its history. `Cmd+K` works too. The chevron on its top edge folds it to its input row, see-through, and a click on that unfolds it. Click the key written at the end of the input row and press another to change it; Backspace there goes back to `Ctrl+K` |
| `Space` | Play or pause, when the palette isn't focused |
| `←` `→` | Back or forward 10s |
| `/login-f1tv` | Sign in to F1 TV (`/logout-f1tv` to sign out) |
| `/settings-agent` | Connect the agent's provider, and choose its model and thinking level |
| `/reset-onboarding` | Show the steps to get started again |
| `/version` | Show which release this is |
| `/whats-new` | Open this release's notes in the browser |
| `/build` | Enter build mode, where the agent builds or changes mods. Marked `! spoiler`: the agent looks ahead without asking |
| Drag a tile | Move it; drop it on another tile to swap them |
| Drag a tile's edge | Resize it |
| `/auto-layout` | Re-tile the grid, undoing moves and resizes |

`/build` and `/auto-layout` work on an open session, so the command list leaves them out until there is one.

Everything else goes to the agent in plain words. Before it looks ahead of where you are, by reading ahead or moving playback forward, the palette
shows a spoiler check: answer Allow once, Allow for this session or Don't allow. The timeline goes anywhere without asking.

## Checks

```bash
npm run check
```

Typecheck and unit tests. The scripts below run the real app in Electron, and all but the first three need both sign-ins:

A check that needs a sign-in runs an OMFV of its own, apart from any other on the machine, on a fresh profile with copies of
the F1 TV sign-in and, when it needs the agent, of the agent's sign-in and settings from the main profile. An agent sign-in the
run refreshed is written back, so the original stays valid ([scripts/isolated.mjs](../scripts/isolated.mjs)). On Hyprland the
check's window opens on workspace 3 without taking focus; elsewhere, macOS included, it opens as an ordinary window in front
([scripts/platform.mjs](../scripts/platform.mjs)).

```bash
node scripts/layout-check.mjs
```

```bash
node scripts/suggestions-check.mjs
```

```bash
node scripts/overflow-check.mjs /tmp/overflow-check
```

```bash
node scripts/drm-check.mjs
```

```bash
node scripts/journey.mjs
```

```bash
node scripts/seek-check.mjs
```

```bash
npm run build && node scripts/prod-check.mjs
```

This one runs the packaged app that `npm run dist` makes, as a release installs it: see [RELEASE.md](RELEASE.md#check-a-build).

```bash
npm run dist && node scripts/packaged-check.mjs /tmp/packaged-check
```

This one updates an AppImage from one release to the next, served from localhost: see [RELEASE.md](RELEASE.md#check-a-build).

```bash
npm run build && node scripts/update-check.mjs /tmp/update-check
```

This one needs only the F1 TV sign-in, and puts a mod in the mods folder of an OMFV of its own while it runs:

```bash
node scripts/mods-check.mjs /tmp/mods-check
```

This one needs only the F1 TV sign-in. It opens a replay race and adds suggestions one by one: each re-tiles the grid until a
tile is arranged by hand, and after that a new one goes into the biggest gap:

```bash
node scripts/auto-layout-add-check.mjs /tmp/auto-layout-add-check
```

This one runs [build mode](BUILD_MODE.md) with the real agent: it needs both sign-ins, and takes about a quarter of an
hour:

```bash
node scripts/build-check.mjs /tmp/build-check
```

This one asks the real agent for sessions with nothing open, each request in a fresh conversation, and records which session it
loads or what it asks:

```bash
node scripts/picking-check.mjs /tmp/picking-check
```

```bash
node scripts/stream-soak.mjs 10
```

```bash
node scripts/captions-check.mjs 1000010420
```

During a live session:

```bash
node scripts/live-check.mjs
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it fits together and [STATUS.md](STATUS.md) for what is
verified and what isn't.
