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
  the cut. It doesn't drop rows quietly, and it doesn't shrink type until it can't be read. A chart says how large it draws in a given
  tile with `ChartCanvas`'s `extent`, and the canvas runs past the tile by that much. (2026-11-12; built 2026-11-13 with the timing
  tower. Pit stops still draws its own "N earlier" note, and moves to this when it's polished.)
- **Columns aren't dropped to fit either.** A table too wide for its tile keeps every column and runs past the right edge, where the
  host marks it "more ▸". A column that vanishes as the tile narrows reads as data that isn't there. (2026-11-13)

### Colour

- **Dark and square.** Black behind a chart, ink `#e7e7e7` for what's read, dim `#8a8a8a` for what's secondary, `#2c2c2c` for lines,
  the app's monospace font. No rounded corners, shadows or gradients. `colors()` in the kit reads the tokens from `src/styles.css`.
- **Red and yellow are taken.** Red means an error, a spoiler warning or a live session. Yellow marks build mode. Neither is used for
  emphasis, which is shown with ink and weight.
- **Tyre colours are for tyres, team colours for drivers.**
- **Pedals have their own colours, and brake is the one red that isn't an alert.** Throttle green and brake red, as every
  broadcast and telemetry screen draws them, toned down (`throttle`, `brake`) so the red reads as data, not as the red that
  warns or as a soft tyre. (2026-11-13. Violet was tried first, to keep red for alerts, and read as foreign.)
- **Flag colours are for flags, toned down the same way.** A flag is drawn as a small flag, never as the colour of text or a bar:
  green and red take the pedals' `throttle` and `brake`, and yellow and blue their own toned `flag-yellow` and `flag-blue`, so
  none reads as an alert, build mode or a tyre. (2026-11-13, with race control.)

### Spoilers

- **It shows only what has happened at the playhead** unless it declares `looksAhead`, and it never has race data written into its
  source. See [SPOILER_PREVENTION.md](SPOILER_PREVENTION.md) and [BUILD_MODE.md](BUILD_MODE.md).

## Charts

Components drawn on a canvas with the kit, `src/components/charts/kit`.

- **Every chart is for races to start with: `sessions: ['race', 'sprint']`.** The agent is only offered what fits the open session,
  so a chart reaches qualifying or practice once it's been made to make sense there. (2026-11-12)
- **A chart that needs car telemetry sets `replayOnly`.** The feed has no telemetry while a session is live. (2026-11-12)
- **Missing data is drawn as missing.** A value the feed hasn't sent is a gap or a dash, never a guess.
- **A crowded chart labels what answers its question, and names the rest under the pointer.** Codes that land on each other read as
  none. A mark without a label is named, with its value, when the pointer is on it: `ChartCanvas` passes the pointer to the chart
  with `onPointer`, the chart keeps it in what it draws from, and its `draw` names the mark under it. (2026-11-13, with the pit window.)

Per-chart decisions go under a heading for that chart as each one is polished.

### Timing tower

Polished 2026-11-13.

- **Who you're watching is lifted.** A car whose onboard is in a tile gets a raised row and a bold code, so the tower and the videos
  read as one screen.
- **A car within range of the one ahead is marked.** An interval under the season's DRS or Overtake line (`spec.chaseAid`) is ink
  and bold, the rest dim. A lapped interval is never in range.
- **Type doesn't go below 11px**, the app's smallest, and is 12px only where the tile is tall enough for a 21px row and wide enough for
  every column at that size. Rows run from 16 to 22px.
- **Every column, always.** Position, team bar, code, places gained (a race with a grid only), gap, interval, last lap and tyre.
  Below its least size the tower runs past the tile instead. Only the thumbnail in the suggestion strip, under 150px high, leaves the
  interval, last lap and places out, and fits its box.
- **Quieter chrome, stronger data.** Column heads are the hint grey (`mute`), not `faint`; row rules are `quiet`, under `line`;
  position is in ink, since it's read first.
- **Missing data is drawn as missing.** An interval the feed hasn't sent is a faint dash. A compound it hasn't named is left blank,
  not "?".
- **Size.** Least 315 by 376: a full grid of 22 at 16px rows and 11px type with every column. Fit 396 by 508: 22px rows, 12px
  type, the widest spacing. The shape asked for is that fit's, 0.78. Both are computed from the draw constants, so they move with
  them, and `scripts/tower-check.mjs` shows it at both and below in the real app.

### Race control

Polished 2026-11-13.

- **A list of elements, not a canvas.** A race has a couple of hundred messages, and every one stays reachable: the list scrolls
  with the app's hairline track. A canvas could only run past the tile for the host's mark, which doesn't reach them. The
  pointer on a line shows the messages it stands for, as sent.
- **Fewer words, read from F1's wording.** The feed fills its structured columns only for flags. Deleted laps, the stewards'
  cases, penalties, the red flag and the restart order are plain text, so `raceControlMessages.ts` reads them with a pattern for
  each: "ALB lap 34 deleted · T1 limits" for "CAR 23 (ALB) TIME 1:18.737 DELETED - TRACK LIMITS AT TURN 1 LAP 34 14:50:00". A
  message no pattern knows is shown as sent, less car numbers and clock times. The patterns are tested on real messages from São
  Paulo and Mexico City 2026.
- **Sentence case,** with capitals left for driver codes, turns and sectors, so those stand out.
- **One line per stewards' case.** Noted, under investigation and the decision are one case, known by its incident time and the
  cars in it. Its line moves up as it changes and shows its stages under it, "noted › investigating › 5s penalty".
- **A run of yellows and their clears is one line,** "Double yellow S2 · yellow S1 · cleared", until every sector is clear. A
  clear with no yellow before it is its own line.
- **What is in force, pinned on top:** a red flag, a safety car or a VSC, the sectors under yellow, grip, the season's aid
  (Overtake or DRS) and how many cases are open. Grip and the aid are shown only once a message has said them. A red flag holds
  until the session starts again.
- **A red flag, a safety car and a VSC stand out:** their flag, in ink and bold, wherever they are in the list. The red flag comes
  as plain text, with no flag, and is read from it. One ending is half yellow, half green.
- **Each lap once, as a heading,** not a tag on every message.
- **Blue flags are quiet:** one faint line per run, with the codes. They are most of the messages and the least read.
- **Type is 11px.** The newest message is in ink, the rest dim.
- **Size.** Least 320 by 160: the line on top and four one-line messages. Fit 520 wide, past which lines only get emptier. The
  shape asked for is tall, 0.8, for the rail beside the video.

### Car telemetry

Polished 2026-11-13.

- **104 is no reading.** The feed sends 104 for throttle and brake together when it has no reading, and the revs freeze with
  it. Throttle, brake and revs show a dash, never a full bar. Speed and gear stay, as the feed still sends them.
- **The aid in the DRS slot.** 2026's cars have no DRS, and the feed's channel for it is empty. Where it's empty, the slot shows the
  season's aid (`spec.chaseAid`, Overtake from 2026) as a chip lit while the interval to the car ahead is under its line, with
  the interval beside it. A lapped car or the leader has no interval, and no chip. A DRS channel, in earlier seasons, is shown
  as before.
- **One lap of speed, with a scale.** The trace is as long as the car's last lap time, between 60 and 120 seconds, so each corner
  is in it once, drawn 2px wide. Rules at 100, 200 and 300 km/h are labelled at the left. A dot marks where the line is now, and each corner's
  low point has its speed and gear.
- **Pedals as segments.** Throttle and brake are stacks of 4px segments lit from the bottom, in the pedal colours, so a part
  throttle reads as a count. The feed sends brake as off or on, so its stack is all lit or none.
- **Sized to sit under its onboard.** Fit 480 by 200 and shape 2.4, a strip under a video of the same width: past that, a taller
  tile only stretched the trace and the bars. Least 300 by 150, where the readouts, the chip and a trace with its rules still
  read. `scripts/telemetry-check.mjs` shows it in the real app.

### Pit window

Polished 2026-11-13.

- **Only the cars around the stop get a code:** the driver, the leader, the cars either side of where they'd rejoin, and any car in
  the clear-air zone ahead of it. The rest are dots, named under the pointer. Before, every car had a code and they landed on each
  other wherever the field bunched.
- **The cars either side are said plainly,** "Car ahead COL 5.3 s" and "Car behind NOR 6.1 s · lapping", with whether each is
  racing them, laps down on them ("lapped"), or a lap up ("a lap up" ahead, "lapping" behind). "Ahead of NOR −6.1" said none of that.
- **The margin either side is the window:** seconds short of the place ahead, and seconds spare before losing the place they'd
  rejoin in, in race order.
- **The stop under a safety car and a virtual one,** from MultiViewer's shorter pit losses: a tick across the ring for each, and
  the positions in the panel. The ticks are only labelled where the label stays clear of the answer and of OUT.
- **A thicker ring and larger dots:** 5px ring and pit-loss arc, 5px cars, 7px for the driver and the rejoin marker.
- **Type doesn't go below 11px,** codes round the ring, panel keys and the line over the answer included.
- **The panel sits right under the ring,** not at the foot of a tall tile, in pairs that read across: pit loss and tyre, the cars
  either side, the margins, then SC and VSC. "Rejoins" left the panel, since the middle of the ring says it, and "clear air" or
  "traffic" moved under the answer. In a tile wide enough for both the panel goes beside the ring, one row to a line.
- **Size.** Least 308 by 400: a 96px ring with room for its labels and the panel under it. Beside it, 470 by 280. Fit 578 by 508:
  the ring stops growing at 150px. The shape asked for is the panel-under form's largest, 0.76. Below its least it stops shrinking
  and runs past the tile for the host to mark, where it used to draw a bare ring with no answer. Only a thumbnail under 150px high
  fits its box. All of these are computed from the draw constants, and `scripts/pit-window-check.mjs` shows it at its fit, least
  and below in the real app.
- **Pit loss is still MultiViewer's.** In São Paulo 2026 the race's own green-flag stops cost about 25 s against its 21.8 s, so the
  rejoin reads optimistic there. Measuring it from the race was proposed and not taken for now.

### Pedal barcode

Added 2026-11-13, from direction A of the `car_telemetry` proposals.

- **Its question: is he driving every lap the same, and where did this one differ.** One car, a row per lap, the lap in progress on
  top and six in all. `car_telemetry` is the numbers right now and `speed_trace` two drivers' speed on one lap; this gives up both for
  the comparison between laps.
- **x is distance from the line,** from the car's positions projected onto the circuit's outline, so each turn sits in one column
  on every lap, whatever the lap's time. By time, a slow corner pushed everything after it right. A lap without positions is placed
  by time instead, scaled to the last completed lap's. The turn numbers along the top are the circuit's corners, at their own
  distances, left out where they'd crowd. (Distance, the guides and the delta were picked from the pedal barcode proposals,
  2026-11-13.)
- **A hairline at each turn, down through every row,** cut dark through the cells, so a brake point reads against its corner.
- **Each lap against the one before,** "−0.158", in ink when faster and grey when slower. Consistency is the question, so the
  difference is the number to read. The oldest row has no lap before it, and keeps its time.
- **Red is braking, green is throttle, darker for less,** in the pedal colours. The feed sends the brake only as on or off, so
  it's one flat colour. The throttle runs from 15% of its colour with the pedal up to full, so coasting still differs from no reading.
- **104 is no reading.** The feed sends 104 for throttle or brake, nearly always both, when it has none, while the revs freeze. That
  cell is drawn `quiet`, like a gap of more than 2 s, never as full throttle or full brake.
- **The playhead is a mark in the team's colour** on the lap in progress. Lap numbers at the left, the current lap in ink.
- **With no driver named, the leader at the playhead,** whose code is drawn at the top left in the team's colour, since the title bar
  then says only "Pedals".
- **Size.** Least 300 by 150: six 16px rows, the turn row and the 92px label column. Fit 640 by 200: 26px rows, and about two pixels a
  sample across a 75 s lap; wider only stretches the cells. Below the least size it's compact: the cells alone, which shrink to fit.
- **Queries.** The completed laps' pedals and positions are read once per lap, keyed on their starts; only the lap in progress
  follows the playhead.

### Pit windows

Added 2026-11-13, from direction B of the pit window proposals.

- **Its own component, not a form of `pit_window`.** `pit_window` plays out one driver's stop and needs that driver;
  `pit_windows` takes no props and answers who in the field could stop now, and for how much. One name drawing two charts
  would leave the agent unable to tell them apart. Each description points at the other, and at `pit_stops` for stops
  already made.
- **The same stop as the ring.** Each row is `pitWindowModel` run for that car, so the two charts never disagree about a
  rejoin, a gap or clear air.
- **Running order.** Sorting by the cheapest stop was tried and left out: rows that move every lap are hard to follow.
- **Sized like the timing tower.** The same type, rows, spacing and least-size rule, and every column always. Least 312 by
  376, fit 403 by 508. Below its least size the table runs past the tile for the host's "more" mark.
- **Who you're watching is lifted,** as in the tower: a car whose onboard is in a tile. With no props there is no chosen
  driver.
- **The pit loss follows the track status.** Under a safety car or a VSC every row uses MultiViewer's loss for it, and the
  REJOIN head says what a stop adds, "+21.8" or, in ink, "+14.2 SC". A loss MultiViewer doesn't give is missing, not
  the green-flag one.
- **The margin either side.** SHORT is the seconds short of rejoining ahead of the next car up, SPARE the seconds before
  the next car behind gets by as well. Under a second is in ink and bold: a good or bad stop decides it.
- **A car in the pits reads PIT,** on its in-lap or while its out-lap runs, with the rest of its row blank: it has no stop
  left to play out.
- **Lapped cars are left as the ring has them.** A car ahead on the road within 2 s is traffic whatever lap it is on.
  Marking a lap up or down, with blue flags as not traffic, was proposed and not picked.

### Speed ribbon

Added 2026-11-13, from direction B of the `car_telemetry` proposals.

- **Its question: where on the track one driver is fast, and where they brake.** Its neighbours answer others: `track_map` where
  every car is, `speed_trace` how two drivers' laps compare against distance, `car_telemetry` one car's pedals and revs over time,
  `pedal_barcode` whether every lap is driven the same.
- **One lap, on the circuit.** The car's positions over a window as long as its latest lap time, kept within 60 and 120 seconds,
  drawn on the faint outline turned by the circuit's `rotation`, as the track map is. Each position takes the speed and pedals of the
  latest `car_data` sample at or before it. Positions more than 2 s apart break the ribbon.
- **Width is speed, colour is the pedal.** 1px at 60 km/h and below, 6px from 340 km/h. Green (`throttle`) flat out, the same
  green at half strength on a lift (under 95% throttle and off the brake: a lift, a coast, a part-throttle exit), and red (`brake`)
  on the brake, over the rest in a black casing so a brake zone stays its own mark for a viewer who can't tell red from green. A
  throttle or brake of 104 is the feed having no reading, drawn as neither braking nor lifting. (2026-11-13. It was the team colour
  with the brake in red, and McLaren's orange and Ferrari's red couldn't be told from the brake.) The team colour is left for the
  driver's code.
- **Each corner's slowest speed,** in ink just outside the track: the lowest speed after each braking zone, once the car is 10 km/h
  faster again, so a zone it's still in has none yet. These are placed before the turn numbers, which give way where they'd touch.
- **The pedals now in the readout:** speed, gear, a BRAKE chip lit in the brake colour while braking, and throttle in per cent. While
  the feed sends 104 the chip is unlit and the throttle a dash.
- **The readout holds still.** Each number sits right-aligned in a slot as wide as its widest value, so nothing after it moves
  when the speed goes from two digits to three, or the throttle from 99% to 100%.
- **The timing line,** a bar across the track at the outline's first point, as the track map draws it, so the lap's start reads.
- **The leader when no driver is named,** and then the readout names them, since the title bar can't.
- **Turn numbers just outside the track,** in the hint grey, left out where they would touch the readout, a corner speed or another
  number. (Corner speeds, lifts, the pedals in the readout and the timing line were picked from the speed ribbon proposals,
  2026-11-13.)
- **Size.** Least 300 by 220: the readout's row over a circuit large enough for its turn numbers to sit apart. Fit 560 by 400, where
  a circuit stops gaining detail. `scripts/ribbon-check.mjs` shows it at both and below in the real app.

### Race trace

Removed 2026-11-13.

- **Every driver's gap to the leader, one line each, was taken out.** Twenty-odd lines in team colours, many of them alike, tangled
  in any tile beside a video. A pit stop's 20 to 40 second dive was the loudest mark on it, and the codes at the line ends were pushed
  away from their lines or left off. Proposals to polish it (11px labels tied to their lines, the interval beside each code, faded
  history, quieter pit laps, labelling only the battles) and three other directions (battles in words, small multiples of the gap
  ahead, the field on a ruler with trails) were drawn from São Paulo 2026, and none was good enough to keep. A battle between two
  drivers is `gap_evolution`'s question.
- A saved layout with a `race_trace` tile draws nothing in it, as for a mod's component that is gone.

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
| A chart drawing past its tile | `src/components/charts/kit/ChartCanvas.tsx` (`extent`) |
| The pointer over a chart, for naming what's under it | `src/components/charts/kit/ChartCanvas.tsx` (`onPointer`) |
| The timing tower in the real app, fitted and squeezed | `scripts/tower-check.mjs` |
| Reading race control's messages | `src/components/charts/raceControlMessages.ts` |
| Car telemetry in the real app, beside its onboard and squeezed | `scripts/telemetry-check.mjs` |
| The pedal barcode in the real app, fitted, at its least size and squeezed | `scripts/pedal-check.mjs` |
| Pit windows in the real app, fitted and squeezed | `scripts/pit-windows-check.mjs` |
| The speed ribbon in the real app, fitted and squeezed | `scripts/ribbon-check.mjs` |
| Colour and size tokens | `src/styles.css` |
