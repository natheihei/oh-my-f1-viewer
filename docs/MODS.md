# Mods

A mod is a plugin: a folder, outside the app's source, that adds something to the app. The app watches the folder, compiles what's in
it and reloads it on every save, while the session and the streams keep playing. Anyone can write one: you in an editor, or a coding
agent in a shell. Agreed on 2026-11-09 and built the same day. [STATUS.md](STATUS.md) says what's verified.

This is Herdr's mod system adapted to f1a. [DESIGN.md](DESIGN.md) explains why components use only the host, which is what lets one
come from a mod.

- **Mod:** a plugin, one folder the app loads and reloads. For now it defines one component.
- **Component:** something a tile can show, from the app or from a mod, such as a chart or a controller that jumps between laps.
- **Tile:** one component placed on the grid.

## What a mod is

A mod's component is like the app's own. It declares itself with `defineComponent`, reads the host and nothing below it, and runs in
the same renderer. There's no sandbox: a mod is trusted like anything else the user chooses to run.

```
~/.config/f1a/mods/            the app's data folder: ~/Library/Application Support/f1a on macOS, %APPDATA%\f1a on Windows
  tsconfig.json                written by the app on every start, so editors and tsc find the types
  .types/                      written by the app on every start: declarations for f1a and f1a/kit
  <name>/
    main.tsx                   the mod (required; main.ts, main.jsx or main.js also work). It may import other files in its folder
    mod.error                  written by the app while the latest save doesn't load, and removed once one does
    mod.log                    written by the app: the mod's last 300 lines of console output and render errors
```

The folder's name is the mod's: lower-case letters, digits, `_` and `-`, starting with a letter. While a mod defines one component, the
component's name must match it, and can't be the name of one of the app's own components.
[examples/mods/lap_form](../examples/mods/lap_form/main.tsx) is a complete one. In short:

```tsx
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useSql } from 'f1a';
import { ChartCanvas, ChartFrame, text, type Box } from 'f1a/kit';

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
| `f1a` | The host, the same `src/host` the app's components use: `useLive`, `read`, `useSql`, `host`, `defineComponent`, `Video` and the rest. [HOST.md](HOST.md) lists it |
| `f1a/kit` | The kit the app's charts are drawn with, and optional for a mod: `ChartFrame`, `ChartCanvas`, `colors`, `tyreColour`, `useDriverStyles`, scales and drawing helpers |
| `react`, `react/jsx-runtime` | The app's own React |
| `typebox` | The app's own TypeBox, for `args` |
| `./anything` | Other files in the mod's folder |

They're the app's own copies, shared with the mod, so hooks and schemas work across the boundary. Anything else, a package or a file
outside the folder, fails to compile.

A component can act as well as draw: `host` has the same writes the app uses, such as `host.playback.seekToDate`. `useSql` reads as of
the playhead, like every chart. A controller that jumps to the next lap needs more, because that lap hasn't happened yet:
`useSql(sql, params, { asOf: 'session' })` reads the whole session. A component that does that, or that can take the viewer past
where they are, should say so with `looksAhead: true` in `defineComponent`. The grid then shows a warning in place of each tile of it,
with an Allow button, and draws the component only once the viewer allows that tile. Such a component should seek with what it reads
and show nothing from it. The flag is the author's to set and nothing enforces it: a mod that reads the whole session without it and
shows the result can spoil the race for the viewer.

## How the app loads mods

The main process owns the folder, and the renderer imports what main hands it.

1. **Watching.** Main watches `mods/` and everything under it. A folder that gets a `main` file becomes a mod, and a save in it starts
   a build after 120ms of quiet, since editors and agents often write a temp file and rename it, or save several files at once. Files
   the app writes (`mod.error`, `mod.log`, `tsconfig.json`, `.types`) and anything hidden or in `node_modules` don't start one.
2. **Compiling.** esbuild bundles the mod into one ES module with an inline source map. The shared modules are left out and read at
   run time from `globalThis.__f1aShared`, which `src/main.tsx` fills, and `console` inside the mod writes to its log as well as the
   app's.
3. **Serving.** Main serves the latest build from memory at `f1a-mod://mods/<name>/main.js?v=<version>`. The production build's
   content security policy allows `f1a-mod:` for scripts.
4. **Loading.** Main sends the renderer every mod's status (`mods:changed`). For each new version, the renderer imports it, checks its
   default export (a name matching the folder, a title, a description, a TypeBox object for `args`, `spec` and `View`) and calls
   `host.components.register`, which replaces the last version by name. Tiles showing it redraw with the new code, and their state
   starts over. The renderer reports back, so main knows the version that's running.
5. **Removing.** A deleted folder unregisters its component through `host.components.unregister`, which takes its tiles off screen.

A save that doesn't compile, or whose export doesn't check out, keeps the last good version running and writes the reason to
`mod.error`. Every tile has an error boundary: a component that throws while drawing shows "This tile stopped" with the error in its
tile, the rest of the app carries on, and a mod's error goes to `mod.log`. The next version gets a fresh try.

`live.mods` lists every mod with its `state` (`loading`, `ready` or `failed`), `version`, `url` and `error`. The components of the
ones that loaded are in `live.components`, like any other.

## Getting a mod's component on screen

Whatever puts a component on screen works for a mod's. For now that's the app's own agent, which reads
`live.components` and can suggest it, or `host.layout.add` from code.

The app's agent can also write mods: `/build a controller that can go back and forward laps` puts it in build mode, where it works in
this folder and everything it changes can be undone as one. See [BUILD_MODE.md](BUILD_MODE.md).

## Types

`npm run build:electron` also runs `build:types`, which writes declarations for the host and the kit to `dist-types`. On every start
the app copies them to `mods/.types` and writes `mods/tsconfig.json`, which points `f1a` and `f1a/kit` at them and every package at
the app's own `node_modules`. `tsc -p ~/.config/f1a/mods` then type-checks every mod without the app running, and editors find the
same types.

## Checking it

`node scripts/mods-check.mjs <screenshot-dir>` runs a mod through its life in the real app, over a replay race: written into the
folder, put on screen, saved again while playing, saved broken, made to throw, fixed and removed. `electron/mods/mods.test.ts` covers
compiling, imports, errors, logs and waiting for a save.

## Where it lives

| Piece | File |
| --- | --- |
| Watching, compiling, serving, `mod.error`, `mod.log` and the types | `electron/mods/index.ts` |
| The `f1a-mod` scheme and starting it | `electron/main.ts` |
| The bridge to main | `src/data/mods.ts` |
| Importing, checking, registering and `live.mods` | `src/host/mods.ts` |
| The modules a mod shares with the app | `src/main.tsx` |
| The error boundary on every tile | `src/host/Grid.tsx` |
| Status and log types | `shared/mods.ts` |
| An example | `examples/mods/lap_form/main.tsx` |
