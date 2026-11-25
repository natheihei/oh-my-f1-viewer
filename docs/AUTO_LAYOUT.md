# Auto-layout

How OMFV decides where every tile goes: when it re-tiles, what the solver tries, how it scores an arrangement, how tiles that
belong together are kept together, and what a hand-arranged layout does instead. The rules a component author needs, such as
what `size` and `fit` mean, are in [COMPONENTS.md](COMPONENTS.md). This is how those rules are carried out.

The grouping here, from "Tiles that belong together" on, is an experiment (2026-11-21). Its weights are first guesses, checked
on sixteen made-up sets of tiles and a few runs of the real app, not on what a real agent suggests.

| File | What it holds |
| --- | --- |
| `src/layout/solve.ts` | The solver. Pure, in grid cells, and knows nothing of components: a tile comes in as a `Slot` |
| `src/layout/model.ts` | The layout as pure functions: turning tiles into slots, what belongs together, adding, removing, gaps, drops |
| `src/layout/store.ts` | The live layout, and the timer that holds a re-tile back while the window is resized |
| `src/host/suggestions.ts` | Where a tile gets its batch: one `offer` is one batch |

## When the grid is re-tiled

The grid is 24 columns by 24 rows. A layout is either *auto*, where the solver placed every tile, or *manual*, once the viewer
has moved, resized, swapped or dropped one (`LayoutState.manual`).

| What happens | Auto layout | Manual layout |
| --- | --- | --- |
| A tile is added | Re-tiled with it | It goes into a gap: see "A hand-arranged layout". Re-tiled only when no gap is big enough |
| A tile is removed | Re-tiled without it | Nothing else moves |
| The main tile is assigned or taken away | Re-tiled | Kept until the next re-tile |
| `/auto-layout` | Re-tiled | Re-tiled, and it is an auto layout again |
| The grid is measured for the first time | Re-tiled, now that tiles can be fitted to their content | The cell size is kept, nothing moves |
| The window is resized | Re-tiled once the size has held still: see "Resizing the window" | Tiles scale with the grid, nothing moves |

A tile that can't be added, because re-tiling would leave some tile under 3 cells either way, is refused with `NoRoomError` and
nothing changes.

## What the solver is given

One `Slot` for each tile, in the order the tiles were added, the grid, and which slot is the main one, if any.

| Field | From | What it means |
| --- | --- | --- |
| `aspect` | The component's `size.aspect`, else its `fit.aspect`, else 16:9 | The shape it reads best in, as width over height on screen |
| `min` | `size.min`, in pixels, turned into whole cells with the title bar added | The least cells it reads in. Zero when it declares none |
| `fit(room)` | `fit` | The cells it uses of a rectangle: all of it, unless its content stops growing (`width`, `height`) or keeps a shape (`aspect`) |
| `capped` | `fit.width` or `fit.height` is set | Its content stops growing, so it isn't counted when sizes are evened out |
| `group` | `groupOf` in the model | What it belongs with: see "Tiles that belong together" |
| `kind` | The component's name | What it is. Groups made of the same kinds are laid out alike |
| `least` | Only blocks set it | The least cells it may be given, when that is more than 3 either way |

Shapes are judged as they look on screen, so the grid carries a cell's size in pixels and the title bar's height (22px). Before
the grid is measured the solver reasons with a 1600 by 900 window.

## The shape of every arrangement

Every arrangement the solver tries has the same skeleton.

- **With a main tile:** the main tile is top left. The rest go in a *rail* to its right, a *band* below it, or both. The corner
  below the rail and right of the band goes to one of them, and both ways are tried.
- **With no main tile:** the wide tiles share the grid in rows, and the tall ones go in a rail at the right.

A rail is one or more columns, each a stack of tiles. A band is one or more rows, each a line of tiles. They take as many lines
as suit their tiles, so a wall of tiles still makes a grid.

Inside one line, the cells are shared out by `shareWithin`: each tile asks for the length its shape wants at the line's
thickness, never less than its least size, and never more than `fit` says it can use. What a tile can't use goes to the others
in proportion, and when none can use it, it stays empty. A line where some tile would get under 3 cells is not a candidate.

## What is tried

The solver tries every arrangement of that kind and keeps the cheapest. For n tiles other than the main one:

1. **Which tiles go to the rail.** The tiles are sorted tallest shape first. The rail takes the first k of them and the band the
   rest, for every k from n down to 0. So a tall timing tower goes to the rail before a wide gap chart does.
2. **In what order, within each.** The order added, the order by shape, and that reversed. The order added is tried first, so
   it wins a tie.
3. **How big the main tile is.** Widths of 8, 10, 12, 14, 16 and 18 columns when there is a rail, and heights of 10, 12, 14, 16
   and 18 rows when there is a band. The main tile is then fitted to its picture, and the rail and band start where it ends, so
   a 16:9 picture leaves no seam.
4. **Who gets the corner.** The rail or the band.
5. **How many lines each strip has.** From one up to its thickness divided by 3. With a main tile each strip picks its own
   best, since a tile's cost depends only on its own box, and a strip that comes up again is worked out once.

With no main tile, step 3 is the rail's width instead (4, 5, 6, 7, 8, 10 or 12 columns), and the rail's columns and the body's
rows, up to four each, are tried together.

That is a few thousand arrangements at most. When none gives every tile 3 cells either way, `arrange` returns null: a tile
being added is refused, and `solve` falls back to a plain grid of equal cells, which is only ever for a grid that shrank under
tiles already there.

## How an arrangement is scored

Lower is better. Each term is a share of something, times a weight (`COST` in `solve.ts`).

| Term | Weight | What it measures |
| --- | --- | --- |
| Deficit | 40 | For each tile, how far it is under its least width and height, as a share of each |
| Shape | 1 | How far each tile's shape on screen is from the one it asked for, as the log of the ratio, averaged over the tiles other than the main one |
| Main | 5 | The main tile's share of the grid, taken off the cost |
| Empty | 3 | The share of the grid no tile covers |
| Uneven | 3 | With no main tile only: the gap between the largest and smallest tile that can grow, as a share of the grid |
| Apart | 4 | How far apart the groups' tiles are: see below |
| Unalike | 0.5 | How many groups don't line up with the first of their kind: see below |

So a tile under its least size outweighs everything, and the main tile shrinks before that happens. After that the main tile
is as large as it can be, tiles apart from their group cost about as much as the main tile's size, and shape, empty cells and
groups lining up decide between what's left.

## Tiles that belong together

`groupOf` in the model gives each tile what it belongs with.

1. **Its driver.** A tile is about a driver when its title names exactly one, as an onboard, a telemetry chart or a pit window
   does. When two or more tiles on screen are about the same driver, they are a group, however each got there. A place is its
   own driver: P1's onboard and P1's telemetry are a group, and stay one through an overtake, apart from whoever holds P1 now.
2. **Failing that, its batch.** One `suggest_tiles` call is one `host.suggestions.offer`, and every tile added from it, by click
   or by drop, keeps that batch as `Tile.group`.
3. **Otherwise nothing.** A tile put on screen any other way, about no one driver, is on its own.

A battle suggested as two onboards and a gap chart is one batch. When a telemetry chart for one of the two drivers is added
later, that driver's onboard goes with it, and the other onboard and the gap chart stay a batch of two. A chart that names two
drivers belongs to neither.

A group of one is no group, and the main tile is in none.

### Groups as blocks

With no groups the solver runs exactly as above. With groups, `arrange` solves several times and keeps the cheapest.

1. **Every tile on its own,** as if there were no groups.
2. **Every group as one block.** Each group becomes one slot, the block, and the same solver places blocks and single tiles.
   The block's tiles are then laid out inside the box it got.
3. **All but the oldest group as blocks,** then all but the two oldest, down to the newest alone. When there are too many
   groups to hold each as a block, or a block costs the others too much room, the newest keep theirs.

All of these are scored tile by tile with the same terms, so they compare fairly.

A block is its tiles in a row, in a column, in two rows when it has four tiles or more, or in three when it has five or more.
Each way round is tried. As a slot:

- **Its shape** is what its tiles make between them: a row is as wide as its tiles side by side, and rows stack at one width.
- **Its least size** is its tiles' least sizes added along the line and the largest across it.
- **Its floor** (`least`) is 3 cells for each tile along each line, so a block is never placed where a tile inside would get less.
- **Its fit** is the box its tiles use when laid out in the room offered.

Inside its box a block's tiles share the cells as a line of the rail or band does. Where that would leave one under 3 cells
they take equal cells instead.

### Groups of the same kind, laid out alike

Two groups made of the same components, such as an onboard, telemetry and pedals for each of two drivers, are one *kind* of
group.

- **The same way round.** Every group of a kind is a row, or every one a column. With more than three kinds on screen, all
  groups go the same way round, to keep the number of tries down.
- **The same order inside.** Each group's tiles take the order the oldest group of that kind has, so they compare tile for tile.
- **In line, at one size.** The *unalike* term counts each group that isn't at the size of the first of its kind, give or take
  a cell of rounding, and in its row or its column. It counts whether or not the groups were placed as blocks.

The weight is small on purpose. At 1 it lined up two pairs at the cost of 38% of the grid left empty, so at 0.5 groups line up
only when that is nearly free.

### Newest first

Groups come before single tiles, the newest first. A group is as new as the last tile added to it, so adding to an old group
brings it forward. Single tiles follow in the order they were added. This is the "order added" the solver tries first, so it
holds unless ordering by shape fits better.

When there is no room for another tile, the refusal names the group that has gone longest without a new tile.

### Tiles apart

The *apart* term is what makes the tries above comparable. For each group, take the smallest rectangle that holds all its
tiles. Every cell of another tile inside it counts, as a share of the grid. Empty cells don't. A group in one block scores
zero, and two tiles in opposite corners score most of the grid.

## A hand-arranged layout

Once the viewer has arranged tiles by hand, the solver is kept out of the way.

- **A new tile goes into a gap.** The biggest empty rectangle of at least 3 cells either way. When the tile belongs with tiles
  on screen and a gap beside one of them is at least 36 cells, it takes the biggest of those instead. It keeps the top-left
  corner and takes what its content uses.
- **With no gap of 36 cells,** the grid is re-tiled, and it is an auto layout again.
- **A dropped suggestion** splits the tile under the pointer across its longer side as it looks on screen, or fills the gap
  there. Neither half, and no gap, may be under 3 cells. A drop makes the layout manual.
- **Dropping a tile on another** swaps their places.
- **Dragging a tile's edge** is GridStack's own resize. It grows a tile into empty cells or by pushing others down, so in an
  auto layout, which has no empty cells, an edge can be dragged inwards but not outwards.

## Resizing the window

The grid reports its cell size whenever its box changes, which a window drag does every frame.

- **The first measurement** lays tiles out at once: nothing can be fitted to its content before it.
- **After that** the tiles keep their cells while the size keeps changing, so they scale with the grid and the solver doesn't
  run. When the size has held still for 150 ms (`RESIZE_SETTLE_MS`), the layout is re-tiled if the new size puts tiles
  elsewhere than the old size did, and otherwise nothing moves.
- **The solver's last four answers are kept** (`solved` in the model), keyed by the tiles, the cell size and the main tile. A
  resize asks again for the layout the tiles are already in, and that costs nothing.

A video is letterboxed in its old cells for the length of a drag, and takes its shape again when the resize settles.

## What it costs

Measured in the test runner, for the last tile added. Treat them as rough.

| Tiles | Solver on `main` | With groups |
| --- | --- | --- |
| A main tile and two to six others | 1 to 5 ms | 3 to 25 ms |
| Twelve tiles in five driver groups | 10 to 25 ms | 100 to 170 ms |

The cost grows with the number of groups, not the number of tiles: each group dropped from the blocks is another round of
solves, each with every way round. It is paid once for each tile added or closed, and no longer during a window drag.

## Known limits

- **A block is a rectangle.** One driver with five tiles of mixed shapes rarely fits a row, a column or two rows well, so those
  tiles are placed on their own and can end up apart.
- **Lining groups up can cost room.** Two drivers with three tiles each can leave a fifth of the grid empty beside a smaller
  main tile, depending on the window's shape.
- **Newest first moves older tiles.** Each new group pushes earlier groups and single tiles along.
- **A suggestion already on screen doesn't join its batch.** Only a shared driver pulls it to the new tiles.
- **Many groups are slow to add to.** See above. Stopping at the first round that beats tiles on their own, or blocking only
  the newest few groups, would cap it.

## Checking it

- `src/layout/solve.test.ts`, `model.test.ts` and `store.test.ts` cover the solver, grouping, gaps and the resize timer.
- `node scripts/group-layout-check.mjs <dir>` runs the real app on a replay race: two drivers' tiles clicked in turn about, a
  batch of charts, and a window drag. See [DEVELOPMENT.md](DEVELOPMENT.md).
- `node scripts/auto-layout-add-check.mjs <dir>` adds suggestions one by one, in an auto layout and then a manual one.
