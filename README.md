<p align="center"><img src="icons/omfv-logo-framed.svg" alt="omfv, oh-my-f1-viewer" width="460"></p>

# oh-my-f1-viewer

**OMFV** is an agent-driven, multi-view F1 TV player. Instead of menus, you tell an agent what you want to watch:

```
> 2025 Mexico
2025 Mexico City Grand Prix loaded.
> Hamilton. Also battle between Norris and Leclerc.
Hamilton, Norris and Leclerc added.
> Done with Norris and Leclerc.
Removed: NOR, LEC.
```

Every stream, and the session data, stays locked to one session clock. Needs an F1 TV subscription, and a ChatGPT plan or an OpenAI or Anthropic API key for the agent.

## Install it

Each release on GitHub has a `.pacman` package for Omarchy and Arch, an AppImage for other Linux, and a `.dmg` for macOS on
Apple silicon. See [docs/RELEASE.md](docs/RELEASE.md#install-it) for how to install each, and how releases are made.

## Run it from source

Runs on Linux and macOS, from source: it needs [Node.js](https://nodejs.org) (`brew install node` on macOS).

```bash
npm install --allow-git=all
```

```bash
node node_modules/electron/install.js
```

```bash
npm run dev
```

The first two commands install the dependencies and the castLabs Electron build with Widevine. The app then opens to
onboarding: sign in to F1 TV, connect the agent's model, then open a session. `/reset-onboarding` shows it again. After
that, when a sign-in needs doing again, the palette says so with a button that fixes it.

## Using it

| | |
|---|---|
| `Ctrl+Shift+P` | Show or hide the palette, with its history |
| `Space` | Play or pause, when the palette isn't focused |
| `←` `→` | Back or forward 10s |
| `/login-f1tv` | Sign in to F1 TV (`/logout-f1tv` to sign out) |
| `/settings-agent` | Connect the agent's provider, and choose its model and thinking level |
| `/reset-onboarding` | Show the steps to get started again |
| `/version` | Show which release this is |
| `/build` | Enter build mode, where the agent builds or changes mods. Marked `! spoiler`: the agent looks ahead without asking |
| Drag a tile | Move it; drop it on another tile to swap them |
| Drag a tile's edge | Resize it |
| `/auto-layout` | Re-tile the grid, undoing moves and resizes |

`/build` and `/auto-layout` work on an open session, so the command list leaves them out until there is one.

Everything else goes to the agent in plain words. Before it looks ahead of where you are, by reading ahead or moving playback forward, the palette
shows a spoiler check: answer Allow once, Allow for this session or Don't allow. The timeline goes anywhere without asking.

### Mods

A [mod](docs/MODS.md) is a plugin: a folder in the app's profile, `~/.config/oh-my-f1-viewer/mods` on Linux and
`~/Library/Application Support/oh-my-f1-viewer/mods` on macOS, that the app reloads on every save. For now it can add a component
for tiles to show, such as a chart or a controller that jumps between laps. Write one yourself or have a coding agent write it, then
ask the agent above to show it.

The app's own agent writes them too. `/build` puts it in
[build mode](docs/BUILD_MODE.md), where you ask for something like a controller that can go back and forward laps: what it builds shows up as a working draft to try, and Save keeps it or Undo all puts everything
back.

## Development

```bash
npm run check
```

Typecheck and unit tests. The scripts below run the real app in Electron, and all but the first three need both sign-ins:

A check that needs a sign-in runs an OMFV of its own, apart from any other on the machine, on a fresh profile with copies of
the F1 TV sign-in and, when it needs the agent, of the agent's sign-in and settings from the main profile. An agent sign-in the
run refreshed is written back, so the original stays valid ([scripts/isolated.mjs](scripts/isolated.mjs)). On Hyprland the
check's window opens on workspace 3 without taking focus; elsewhere, macOS included, it opens as an ordinary window in front
([scripts/platform.mjs](scripts/platform.mjs)).

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

This one runs the packaged app that `npm run dist` makes, as a release installs it: see [docs/RELEASE.md](docs/RELEASE.md#check-a-build).

```bash
npm run dist && node scripts/packaged-check.mjs /tmp/packaged-check
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

This one runs [build mode](docs/BUILD_MODE.md) with the real agent: it needs both sign-ins, and takes about a quarter of an
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

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together and [docs/STATUS.md](docs/STATUS.md) for what is
verified and what isn't.

## Credits and legal

OMFV is unofficial and not affiliated with, endorsed by or connected to Formula 1, F1 TV or the Formula One group of
companies. F1, Formula 1 and F1 TV are their trademarks.

An active F1 TV subscription is required. OMFV does not bypass anything: you sign in with your own account, and F1 TV
enforces its own access and regional rules.

Parts of the F1 TV sign-in, playback and replay code come from [F1 OpenViewer](https://github.com/npanu420/F1OpenViewer)
(MIT), kept in `electron/vendor/f1ov` and `src/data/vendor`.
