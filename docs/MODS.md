# Mods

A mod is a plugin: a folder, outside the app's source, that adds something to the app. The app watches the folder, compiles what's in
it and reloads it on every save, while the session and the streams keep playing. Anyone can write one: you in an editor, or a coding
agent in a shell. Agreed on 2026-11-09 and built the same day. [STATUS.md](STATUS.md) says what's verified.

This is Herdr's mod system adapted to OMFV. [DESIGN.md](DESIGN.md) explains why components use only the host, which is what lets one
come from a mod.

- **Mod:** a plugin, one folder the app loads and reloads. For now it defines one component.
- **Component:** something a tile can show, from the app or from a mod, such as a chart or a controller that jumps between laps.
- **Installed and local:** an installed component comes with the app (or, later, from a package installed from elsewhere) and can't
  be changed. A local one is a mod, the user's own. Changing an installed one means forking it: copying it into a new mod.
- **Tile:** one component placed on the grid.

## What a mod is

A mod's component is like the app's own. It declares itself with `defineComponent`, reads the host and nothing below it, and runs in
the same renderer. There's no sandbox: a mod is trusted like anything else the user chooses to run.

```
~/.config/oh-my-f1-viewer/mods/   the app's data folder: ~/Library/Application Support/oh-my-f1-viewer on macOS, %APPDATA%\oh-my-f1-viewer on Windows
  .types/                         written by the app on every start: declarations for omfv and omfv/kit, for the build agent
  .installed/builtin/<name>/      written by the app on every start, read-only: the source of each installed component, to read and fork
  <name>/
    main.tsx                      the mod (required; main.ts, main.jsx or main.js also work). It may import other files in its folder
    mod.error                     written by the app while the latest save doesn't load, and removed once one does
    mod.log                       written by the app: the mod's last 300 lines of console output and render errors
```

The folder's name is the mod's: lower-case letters, digits, `_` and `-`, starting with a letter. While a mod defines one component, the
component's name must match it, and can't be the name of an installed component.
[examples/mods/lap_form](../examples/mods/lap_form/main.tsx) is a complete one. In short:

```tsx
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useSql } from 'omfv';
import { ChartCanvas, ChartFrame, text, type Box } from 'omfv/kit';

const SQL = 'SELECT COUNT(*) AS laps FROM laps';

function draw(ctx: CanvasRenderingContext2D, laps: number, box: Box) {
  text(ctx, `${laps} laps so far`, 8, box.height / 2, { size: 13 });
}

function LapCount() {
  const view = useSql(SQL); // as of the playhead, like every chart
  const laps = useMemo(() => (view.state === 'ready' ? Number(view.rows[0]?.laps) : 0), [view]);
  return (
    <ChartFrame needs={['timing']} views={[view]}>
      {() => <ChartCanvas model={laps} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'lap_count', // the folder's name
  title: 'Lap count',
  description: 'How many laps have been timed so far.',
  args: Type.Object({}),
  needs: ['timing'],
  spec: () => ({ key: 'lap_count', label: 'Lap count' }),
  View: LapCount,
});
```

A mod may import:

| Module | What it is |
| --- | --- |
| `omfv` | The host, the same `src/host` the app's components use: `useLive`, `read`, `useSql`, `host`, `defineComponent`, `Video` and the rest. [HOST.md](HOST.md) lists it |
| `omfv/kit` | The kit the app's charts are drawn with, and optional for a mod: `ChartFrame`, `ChartCanvas`, `colors`, `tyreColour`, `useDriverStyles`, `drawCode` and `drawParts` for driver codes, scales and drawing helpers |
| `react`, `react/jsx-runtime` | The app's own React |
| `typebox` | The app's own TypeBox, for `args` |
| `./anything` | Other files in the mod's folder |

They're the app's own copies, shared with the mod, so hooks and schemas work across the boundary. Anything else, a package or a file
outside the folder, fails to compile.

A component can act as well as draw: `host` has the same writes the app uses, such as `host.playback.seekToDate`. `useSql` reads as of
the playhead, like every chart. A controller that jumps to the next lap needs more, because that lap hasn't happened yet:
`useSql(sql, params, { asOf: 'session' })` reads the whole session. A component that does that, or that can take the viewer past
the playhead, should say so with `looksAhead: true` in `defineComponent`. The grid then shows a warning in place of each tile of it, a red `! spoiler`
and "This tile looks ahead of where you are.", with an Allow button, and draws the component only once the viewer allows that tile. Such a component should seek with what it reads
and show nothing from it. The flag is the author's to set and nothing enforces it: a mod that reads the whole session without it and
shows the result can spoil the race for the viewer.

A component that fits only some session types lists them in `sessions`, such as `sessions: ['race', 'sprint']`. Left out, it fits every
session; an empty list fits none, so the agent is never offered it. A component that can't work on a live session says `replayOnly: true`. Car telemetry (`car_data` and `location`) fills live too when F1 TV is signed in. The agent is
only offered the components that fit the open session, and can't suggest one that doesn't. The build agent sees them all, and the grid
draws any of them.

## Installed and local

Agreed on 2026-11-17. Every component can be changed, but not in place: an installed one is forked into a local one.

- **Installed** components come with the app: the app's own, in `src/components/<name>/`, compiled into it and registered at start as
  `origin: 'installed'`. Each is a folder shaped like a mod's, importing only what a mod may, so its source runs unchanged as a mod's.
  On every start the app copies those folders, without their tests, to `mods/.installed/builtin/<name>/`, read-only, replacing what was
  there. They are there to read, as working examples, and to fork. Nothing builds them from there, and the build agent's tools refuse to
  write there. An update to the app updates them, with nothing to merge: no copy of them is ever edited. Components installed from
  elsewhere, such as a package from GitHub, would be other packages beside `builtin`.
- **Local** components are mods, the folders in the mods folder: the user's, and the build agent's to edit. `origin: 'local'`.
- **A fork** is a mod copied from a component, to change it. `Mods.fork(component, name, title)` copies the folder from `.installed`, or
  from another mod, into `mods/<name>/`. In every source file it renames each string that is the old name or starts a key with it
  (`'timing_tower'`, `` `timing_tower:${drivers}` ``), so the fork's name matches its folder and its tiles' keys differ from the
  original's. It sets the title in `defineComponent`, and the label `spec` gives its tiles, wherever a title bar shows that label, to
  a new one (the title, unless it's given another), so a fork's tile can be told from the original's on screen. It puts a line at the
  top of `main` saying what it was forked from and when. It
  copies into a hidden folder first and renames that into place, so the watcher builds the fork once, whole. The fork is a new mod like
  any other: in build mode it shows in the strip as a draft, and the installed component and its tiles stay as they are. The viewer
  adds the fork, or swaps it for the original's tile.
- **Updates.** An installed component updates with the app. A fork doesn't: it's the user's from the moment it's made. The line at its
  top says what it came from, so a later fix to the original can be found and carried over by hand, or by the build agent.

Why not edit an installed component in place: a tile names its component, so an edit under the same name would swap the code under
every tile of it, and the app would have to keep the original to reset to, and merge its own updates into the user's edits. A fork
keeps both side by side, and the original stays the app's to update.

## How the app loads mods

The main process owns the folder, and the renderer imports what main hands it.

1. **Watching.** Main watches `mods/` and everything under it. A folder that gets a `main` file becomes a mod, and a save in it starts
   a build after 120ms of quiet, since editors and agents often write a temp file and rename it, or save several files at once. Files
   the app writes (`mod.error`, `mod.log`, `.types`) and anything hidden or in `node_modules` don't start one.
2. **Compiling.** esbuild bundles the mod into one ES module with an inline source map. The shared modules are left out and read at
   run time from `globalThis.__omfvShared`, which `src/main.tsx` fills, and `console` inside the mod writes to its log as well as the
   app's.
3. **Serving.** Main serves the latest build from memory at `omfv-mod://mods/<name>/main.js?v=<version>`. The production build's
   content security policy allows `omfv-mod:` for scripts.
4. **Loading.** Main sends the renderer every mod's status (`mods:changed`). For each new version, the renderer imports it, checks its
   default export (a name matching the folder, a title, a description, a TypeBox object for `args`, `spec` and `View`) and calls
   `host.components.register`, which replaces the last version by name. Tiles showing it redraw with the new code, and their state
   starts over. The renderer reports back, so main knows the version that's running.
5. **Removing.** A deleted folder unregisters its component through `host.components.unregister`, which takes its tiles off screen.

A save that doesn't compile, or whose export doesn't check out, keeps the last good version running and writes the reason to
`mod.error`. Every tile has an error boundary: a component that throws while drawing shows "This tile stopped" with the error in its
tile, the rest of the app carries on, and a mod's error goes to `mod.log`. The next version gets a fresh try. A tile whose props
no longer fit its mod's `args` shows what it needs instead of drawing. Both are in `live.health`.

`live.mods` lists every mod with its `state` (`loading`, `ready` or `failed`), `version`, `url` and `error`. The components of the
ones that loaded are in `live.components`, like any other.

## Getting a mod's component on screen

Whatever puts a component on screen works for a mod's. For now that's the app's own agent, which reads
`live.components` and can suggest it, or `host.layout.add` from code.

The app's agent can also write mods: `/build` puts it in build mode, where it works in
this folder and everything it changes can be undone as one. See [BUILD_MODE.md](BUILD_MODE.md).

## Types

`npm run build:electron` also runs `build:types`, which writes declarations for the host and the kit to `dist-types`. On every start
the app copies them to `mods/.types`, where the build agent reads them. The guide the build agent gets in its prompt is
`shared/modGuide.ts`. The rules in it are decided, with their reasons, in [COMPONENTS.md](COMPONENTS.md), and adopted into the
guide by hand.

The app writes nothing for a coding agent or an editor working in the folder from outside: no `AGENTS.md`, no `tsconfig.json`.
That's for when outside agents are supported (issue 33).

## Checking it

`node scripts/mods-check.mjs <screenshot-dir>` runs a mod through its life in the real app, over a replay race: written into the
folder, put on screen, saved again while playing, saved broken, made to throw, fixed and removed. `electron/mods/mods.test.ts` covers
compiling, imports, errors, logs and waiting for a save.

## Where it lives

| Piece | File |
| --- | --- |
| Watching, compiling, serving, `mod.error`, `mod.log` and the types | `electron/mods/index.ts` |
| Copying the installed sources to `.installed`, and forking | `electron/mods/index.ts` |
| The installed components, each a folder like a mod's | `src/components/<name>/main.tsx`, listed in `src/components/registry.ts` |
| Every installed component forked and compiled as a mod | `electron/mods/installed.test.ts` |
| A fork made by the build agent from a tile, in the real app | `scripts/fork-check.mjs` |
| The `omfv-mod` scheme and starting it | `electron/main.ts` |
| The bridge to main | `src/data/mods.ts` |
| Importing, checking, registering and `live.mods` | `src/host/mods.ts` |
| The modules a mod shares with the app | `src/main.tsx` |
| The error boundary on every tile | `src/host/Grid.tsx` |
| Status and log types | `shared/mods.ts` |
| The guide in the build agent's prompt | `shared/modGuide.ts` |
| An example | `examples/mods/lap_form/main.tsx` |
