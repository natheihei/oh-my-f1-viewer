# Components: the conventions

How a component should look and behave in a tile: the choices we've made, and why. It covers every component, from the app or from a
mod. [DESIGN.md](DESIGN.md) covers how a component is wired to the host, and [MODS.md](MODS.md) how one is loaded.

> **Changing this file?** The rules here that a mod's author must follow are restated, without their reasons, in
> `shared/modGuide.ts`. That text is the build agent's instructions and the `AGENTS.md` the app writes into the mods folder. It isn't
> generated from this file: when a rule here is added or changed, adopt it there by hand, in the same change.

Each rule has the date it was decided. One marked **not built yet** is agreed but the app doesn't do it, so it isn't in the mod guide.

## Every component

### One component per question

- **A component answers one question the viewer might have**, and no two answer the same one. The agent picks from one line per
  component and never sees what any of them draws, so two that overlap make it guess. (2026-11-12, when the catalog went from 17
  to 14.)
- **The description says which question, and when to pick it over its neighbours.** "The one chart for a battle or a chase" tells the
  agent more than a list of what's drawn.
- **Limits are declared, not described.** `sessions`, `needs` and `replayOnly` are fields the app enforces. A description doesn't
  repeat them, because a sentence like "works in live sessions" reads as "not in replays". (2026-11-12)

### What it draws in

- **No title of its own.** The tile's title bar shows the spec's label. The first thing in the view is content.
- **It works with no props.** That is how it's first seen, in the suggestion strip. Every arg is optional, and with no drivers given
  it picks from the data at the playhead.

### Size

- **It declares its `size`: a shape and a least size.** `aspect` is the shape it reads best in, width over height. `min` is the least
  room its content reads in, as `{ width, height }` in pixels, not counting the tile's title bar.
- **The least size is in pixels, not grid cells.** What a component needs is set by its type and marks, which don't scale with the
  window. A share of the window is too much on a large monitor and too little on a laptop. (2026-11-12. It was a pair of cells
  before, and five charts asked for more width than the rail beside a video ever has.)
- **The least size is where it still draws in full and reads.** For a chart that is never below 300 by 150,
  where the kit switches a chart to its compact, marks-only form. It is found by looking at the component at that size in the app, not
  guessed.
- **It asks for no more than it needs.** A least size much over 480 by 400 can't be met beside a video in a 1600-wide window, and
  `charts.test.ts` fails a built-in chart that asks for more.
- **`fit` says where content stops growing,** in pixels, or the fixed shape it keeps, like a video's 16:9. The tile is shrunk to it
  and the room it leaves stays empty.

### Where auto-layout puts it

- **The main tile is assigned, never inferred.** `host.layout.setMain` gives one tile the main place, top left and as large as the
  others allow, and `layout.main` holds its key. Nothing about a component makes it the main tile: not being a video, and not being
  added first. (2026-11-12)
- **Opening a session assigns it to the main feed, and nothing else assigns it for now.** When that tile is closed no other is
  promoted.
- **A tile that isn't the main one is laid out by its own `size` and `fit`,** a video included: the video tile declares a 16:9 shape
  and a least size of 320 by 180 like any other component.
- **With no main tile, tiles share the grid:** the wide ones in rows of equal size, the tall ones in a rail at the right.
- **The rest go beside it or below it by shape.** Tall components take the rail beside the main tile, wide ones the band below it.
  Within each they keep the order they were added in, unless ordering by shape fits better. (2026-11-12. Before, the order added
  alone decided, so a tall timing tower could land in the wide band.)
- **Least sizes come before the main tile's size.** The main tile gets smaller before any other tile goes below its least size, so
  adding charts shrinks the video. When there are too many for that, the shortfall is shared, and the host's "more" mark covers a
  tile that is cut. (2026-11-12)
- **Then the main tile is as large as it can be, shapes are as asked, and the grid is as full as it can be,** in that order of weight.
- **A tile isn't stretched past what it can use,** so a capped one, like the timing tower, leaves room empty. It isn't given to a
  neighbour that would then be the wrong shape.
- **Adding a tile moves nothing if a gap fits it.** A new tile goes into an empty gap that meets its least size, closest to its shape.
  Everything is arranged again only when there is no such gap, or when a tile is removed.
- **A hand-arranged layout is left alone,** and dragging a tile below its least size is allowed. The viewer's choice wins.

### Overflow

- **The component adapts, and the host marks only what it can't.** A component fits itself to its tile as far as it can: it scrolls
  a list, shortens a label, draws a compact form. When it can't go smaller, it lets its content run past the tile. The host checks
  only that, the frame it draws the component in, and never looks inside: content past the bottom gets a faded bottom edge, past
  the right a faded right edge, and one chip in the bottom right corner names the ways, "more ▾", "more ▸" or "more ▾▸".
  (2026-11-12. From 2026-11-11 the host searched the component for any clipped element, which made it guess at the component's
  intent: a list scrolling on purpose, a label cut with "…". Dividing the work this way means it doesn't have to.)
- **A component never draws its own "more" note or count of what's hidden.** A second form of the same message is what the host's
  mark exists to prevent. (2026-11-12)
- **A list of elements scrolls:** `overflowY: 'auto'`, `flex: 1`, `minHeight: 0`. It has handled its overflow, so the host doesn't
  mark it. Its scrollbar shows there's more: a hairline track the whole length of the area, always drawn, and a brighter thumb for
  what's in view. (2026-11-13. The thumb alone was 3px of faint grey, which nobody saw.)
- **A component doesn't hide its own overflow** with `overflow: hidden` on content the viewer would want to reach. The host can't
  see past it, so the cut goes unmarked.
- **A canvas of rows shrinks to a floor, then stops.** Rows get smaller with the tile down to the smallest size that still reads, 16px
  for a row of text. Below that the component stops shrinking and lets its rows run past the bottom of the tile, where the host marks
  the cut. It doesn't drop rows quietly, and it doesn't shrink type until it can't be read. (2026-11-12, **not built yet**: a chart's
  canvas always matches its tile today, so the host can't see what a chart leaves out. Comes with the timing tower's polish. Pit stops
  draws its own "N earlier" note and moves to this then.)

### Colour

- **Dark and square.** Black behind a chart, ink `#e7e7e7` for what's read, dim `#8a8a8a` for what's secondary, `#2c2c2c` for lines,
  the app's monospace font. No rounded corners, shadows or gradients. `colors()` in the kit reads the tokens from `src/styles.css`.
- **Red and yellow are taken.** Red means an error, a spoiler warning or a live session. Yellow marks build mode. Neither is used for
  emphasis, which is shown with ink and weight.
- **Tyre colours are for tyres, team colours for drivers.**

### Spoilers

- **It shows only what has happened at the playhead** unless it declares `looksAhead`, and it never has race data written into its
  source. See [SPOILER_PREVENTION.md](SPOILER_PREVENTION.md) and [BUILD_MODE.md](BUILD_MODE.md).

## Charts

Components drawn on a canvas with the kit, `src/components/charts/kit`.

- **A chart that needs car telemetry sets `replayOnly`.** The feed has no telemetry while a session is live. (2026-11-12)
- **Missing data is drawn as missing.** A value the feed hasn't sent is a gap or a dash, never a guess.

Per-chart decisions go under a heading for that chart as each one is polished.

## Where it lives

| Piece | File |
| --- | --- |
| The rules as a mod's author reads them | `shared/modGuide.ts` |
| The build agent's prompt, which includes them | `shared/buildPrompt.ts` |
| Writing `AGENTS.md` into the mods folder | `electron/mods/index.ts` |
| The host's overflow check and mark | `src/host/overflow.ts`, `src/host/Grid.tsx` |
| The size declaration | `src/host/components.ts` |
| Auto-layout: what is tried and how it is scored | `src/layout/solve.ts` |
| The layout tree and what a node asks of the solver | `src/layout/model.ts` |
| Every built-in chart at its least size in common arrangements | `src/components/charts/charts.test.ts` |
| Colour and size tokens | `src/styles.css` |
