# Build mode

The app's agent normally drives viewing: it finds sessions, suggests tiles and seeks. In build mode it writes mods instead. The viewer
types `/build`, asks for a controller that can go back and forward laps, and the agent builds it.

Agreed and built on 2026-11-11. [STATUS.md](STATUS.md) says what's verified. [MODS.md](MODS.md) describes mods themselves, and
[SPOILER_PREVENTION.md](SPOILER_PREVENTION.md) the rules build mode changes.

## The idea

A mod is already a real component: the app compiles it on every save and reloads it while the session plays. So build mode needs no
editor and no separate preview. The draft is the real component, on the open session, and the viewer tries it by using it.

- **The agent chooses what to do.** It creates, edits or deletes folders under `mods/` as the request needs. The viewer never picks
  "add", "edit" or "remove".
- **The app shows what changed.** It watches the folder and shows the result. The agent doesn't have to announce its work.
- **A build is one transaction.** The viewer ends it with **Save** or **Undo all**.

## Entering and leaving

- `/build` enters build mode, and what the viewer types next goes to the build agent. In the palette's command list it reads "Enter
  build mode", with red text beside it:
  "! spoiler the agent looks ahead without asking". That text is the viewer's consent to what [Spoilers](#spoilers) describes, and there's no check on entry.
- Entering pauses playback, so the race doesn't run on unwatched while the viewer builds. Leaving doesn't start it again.
- While build mode is on, the palette is yellow: its frame, its prompt, and the tag's text and outlines.
- `/build <request>` also works, entering and sending the request in one line. The command list doesn't mention it.
- While building, a tag beside the input reads `build · 2 changes`, with **Undo all** and **Save** next to it. With no changes yet it's
  a plain `build ×`, and clicking it leaves. The palette stays open, since the tag is the only way out.
- **Save** keeps every change and leaves build mode. **Undo all** puts the mods folder back as it was on entry and leaves build mode.
- Leaving either way offers to go back to the playhead the viewer entered at, since trying a controller moves it: a line in the
  palette such as "back to 0:42:10". It's an offer, and the playhead doesn't move by itself.
- Quitting the app mid-build undoes anything unsaved on the next start, without asking.

The other `/` commands take no arguments. `/build` is the only one that accepts text after it, and the only one with a warning
beside it.

## What the viewer sees

The app compares the mods folder with how it stood on entry. That one comparison drives everything on screen:

| Change | What happens |
| --- | --- |
| A new mod | Its component appears in the suggestion strip as a live preview, marked "draft". Enter adds it, and dragging places it |
| A new mod, once added to the grid | Its tile has a dashed outline and "draft" in a corner |
| An edited mod with a tile on screen | The tile reloads in place, with a dashed outline and "edited" in a corner |
| An edited mod with no tile | It appears in the strip, like a new one |
| A deleted mod | Its tiles leave the screen, as they do today |

The tag's count is the number of mods that differ. The agent's file writes show as lines in the palette's history ("wrote
lap_stepper/main.tsx · loaded", or "· didn't load"), without version numbers.

The comparison follows the folder, not the agent: a file saved by hand during a build counts and shows the same way. The outlines and
marks go when the build ends.

This keeps the rule that the agent suggests tiles and the viewer adds them.

### Props for a draft

- A draft previews with the props the agent suggested it with, or with none, `{}`. A mod declares the props it needs, as the app's
  charts do (see [COMPONENTS.md](COMPONENTS.md)), and never picks a driver itself, so one that needs a driver has no preview until the
  agent suggests it with one. (Before #77 every mod had to draw with `{}`, and one about a pair picked "the closest pair at the
  playhead".)
- When the viewer named drivers ("a duel for Hamilton and Norris"), the agent passes them through `suggest_tiles` in the mod's props,
  `driver_a` and `driver_b` here, and the draft previews with them for the rest of the build. When they didn't, it asks whose.
- A tile that's on screen keeps its props across an edit. If the mod's new `args` no longer accept them, it falls back to `{}`.

### Trying it

The draft is live, in the strip and on the grid. Its buttons act on the real session: the lap stepper seeks the real playback. It reads
the open session at the playhead, like any tile, so there are no fixtures.

A draft's preview in the strip is wider than a suggestion's, and the mouse inside it belongs to the component. Every preview takes
its shape from the component's `size.aspect`: the card's width is fixed and its height follows, between 98 and 179 pixels for a draft, which is
260 wide, and 78 and 137 for a suggestion, which is 182 wide (`src/shell/stripShape.ts`). The build agent is told to declare `size` on what it builds, to draw no
heading of its own, and to keep what matters most visible in a small tile. A component can still outgrow its tile. Its name underneath is
what adds it, by a click or Enter, or drags it onto the grid.

## Undo all and Save

The main process owns the mods folder, so it keeps the snapshot:

1. **On entry** it copies `mods/` to `mods-snapshot/files` beside it in the app's data folder, and writes a marker file,
   `mods-snapshot/complete`, last. It skips what the app regenerates: `.types`, `tsconfig.json`, `mod.error` and `mod.log`. A snapshot
   with no marker is a copy that didn't finish, and is ignored and cleared away.
2. **Save** deletes the snapshot.
3. **Undo all** removes every file the snapshot doesn't have, copies the snapshot's files back, removes the folders the build made, and
   deletes the snapshot, marker last. The mods folder itself stays in place, so the watcher keeps watching it: it sees the changes, and
   reloads or unregisters as it does for any save. A restore that's interrupted runs again on the next start.
4. **On start**, before the watcher starts and before anything is read, a marker means a build didn't finish, and main runs the same
   Undo all.

Quitting, crashing and Undo all share that one path. Anything else that wrote to `mods/` during the build is undone too, such as an
edit made by hand.

## The build agent

Build mode runs as its own agent session, not the viewing one with different tools. Moving between the two changes the tools and the
instructions, and a separate session keeps what the build read out of the viewing conversation.

- **It starts without the viewing conversation.** It gets the usual app state: the session, the playhead and what's on screen, and with
  it what the build has changed so far and every mod there is. That's enough for "make the chart I'm looking at show 12 laps".
- **Its instructions are its own**, `shared/buildPrompt.ts`: how to work, and the mod guide in `shared/modGuide.ts`, which is what a
  mod is, a complete example, the host in brief and the rules for a component. The app writes the same guide into the mods folder
  as `AGENTS.md`. [COMPONENTS.md](COMPONENTS.md) is where those rules are decided.
  The chart and table lists follow them, as for the viewing agent. The event list doesn't: it can't find or open a session.
- **It gets file tools for the mods folder.** They run in the main process and reach nothing outside the folder:

  | Tool | What it does |
  | --- | --- |
  | `read`, `ls`, `grep`, `find` | Reads and searches the folder: mods, their `mod.error` and `mod.log`, and the types under `.types` |
  | `write`, `edit` | Writes inside a mod's folder, then waits for the app to load the save and says whether it did, with the error if not. `edit` takes several changes to one file in one call |
  | `delete_path` | Deletes a file in a mod, or a whole mod by its folder name |
  | `mod_status` | Whether the latest save loaded, and the last lines of the mod's log |
  | `look_at` | A picture of the mod's component as it shows now |

  They refuse the app's own files (`tsconfig.json`, `.types`, `mod.error`, `mod.log`) and anything that isn't in a mod's folder.
  `read`, `write`, `edit`, `ls` and `find` are pi's own tools, wrapped. Each takes `operations` that pi calls with the absolute path
  it resolved, after it strips a leading `@` and expands `~`, and the check runs there, on the path really touched. pi has no such
  check of its own. `find` doesn't run fd: it walks the folder itself, so it can be checked the same way. `grep` is ours, with pi's
  parameters and output, so the app needs no ripgrep. It walks the folder like `find`, and pi's `find` resolves its path, so it
  reads paths the way the others do. Its pattern is a JavaScript regular expression. `bash` stays off.
- **It keeps some viewing tools:** `list_streams`, `remove_tiles`, `play`, `pause`, `suggest_tiles`, `query_session` and `seek_to`. The
  last two don't ask the spoiler gate. `suggest_tiles` takes any component name here, since the mod may have been written this turn.
- **It can see a picture of a draft**, in the strip or on the grid, to check how it looks. `look_at` captures that part of the window.
  The viewing agent never sees what a chart shows. The build agent may, since it can already read the whole session.
- **It gets more rounds.** A build turn may take 60 rounds of tool calls, where a viewing turn stops at 10.
- **On exit, the viewing agent gets one line**, such as "Built lap_stepper, edited lap_form." The app writes it from the folder
  comparison. The model doesn't, so the line can't carry anything the build read. It arrives in the `app_state` of the viewer's next
  message, once. Undo all sends nothing.
- **Each build is stored** as its own `.jsonl` under `pi-agent/build-sessions`, apart from the viewing conversations in
  `pi-agent/sessions`, for reviewing what the build agent did.

## Spoilers

**Build mode has no spoiler check.** The build agent can read the whole session, which it needs: early in a replay there's no data at
the playhead to test a query against.

What protects the viewer instead:

- **Consent on entry:** the red text on `/build`.
- **Nothing crosses back.** The viewing session never sees the build conversation, only the line the app writes. Leaving build mode
  ends the build conversation, and the next build starts a new one.
- **The prompt.** The build agent is told not to say what it read, as the viewing agent is after an approved read ahead.

What this doesn't cover:

- What the build agent says to the viewer during the build. Only the prompt stops it.
- Race data the agent writes into a mod's source. The prompt tells it not to: a component queries for itself, since the same mod runs on
  other sessions.

## Components that look ahead

A component sometimes needs the future. The lap stepper has to know when the next lap starts, and that lap hasn't happened at the
playhead.

The mod's author decides whether a component warns the viewer:

- **`looksAhead: true` in `defineComponent`** says the component reads or acts on what the viewer hasn't watched.
- **The grid then stands a warning in for the tile**: a red `! spoiler`, "This tile looks ahead of where you are." and an
  **Allow** button. The component's view isn't drawn until the viewer allows it, so none of its queries run before that.
- **`useSql(sql, params, { asOf: 'session' })`** reads the whole session. It doesn't ask anything itself.
- **Nothing enforces the flag.** A component that reads the whole session without it is drawn at once. The build agent's
  instructions say to set it on any component that uses `asOf: 'session'` or could take the viewer past the playhead.
- **Approval belongs to the tile.** It lasts until the tile is destroyed, and another tile of the same mod asks again. It survives a
  hot reload, since the tile is the same tile, so a draft is approved once per build. The app starts with an empty layout, so no
  approval outlasts a restart.
- **The strip preview asks too.** Allowing it there carries over to the tile it becomes.
- **An approved tile says so quietly**: its title reads "Lap stepper · looks ahead", in the title's grey.

An earlier version of this design had `useSql` ask whenever it was given `asOf: 'session'`. The flag replaced it: whether a tile
needs the warning is the author's call, and a tile can act on the future without a query that says so.

A component that acts on the future does it as the agent does: it finds the moment with `useSql` and calls
`host.playback.seekToDate`. The host gets no new writes for this.

`host.data.sql` reads the whole session the same way. See [MODS.md](MODS.md).

## Options we looked at

The mockups are at https://claude.ai/artifact/H4MXaDgaGVvmen5w97ij9v. Boards 4 and 5 show what's described here.

| Option | Why not |
| --- | --- |
| A workbench sheet over the layout | The viewer picks a mod and an operation, and the sheet hides the video a controller acts on |
| The draft as a tile in the grid | The layout moves while the viewer watches, and the agent would add tiles itself |
| A floating draft above the grid | A new kind of surface. It's the next step if strip previews turn out too small |

## Checking it

`node scripts/build-check.mjs <screenshot-dir>` runs these in the real app, on a replay race, through the real palette with the real
agent, like `scripts/mods-check.mjs` and `scripts/seek-check.mjs`. It needs F1 TV signed in, the agent set up and an empty mods folder, which it leaves
empty. Cases 5, 15, 17 and 20 matter most: a broken build would get them wrong without anyone noticing.

It runs in three parts: a build that's saved, a build that's undone, and a build the app is killed in. How it runs a few of the cases:

- **7:** a layout never holds the same component with the same props twice, so it closes the tile and adds the mod again.
- **10:** it breaks the mod's source itself, checks the tile, then asks for an unrelated change. The agent has to fix the break to get
  its own save to load.
- **11 and 12:** it asks for "a new mod called duel", since for a plain battle chart the agent suggests the app's own gap chart.
- **18:** it leaves a snapshot with no marker on disk and starts the app, without timing a kill to land inside the copy.
- **19 and 22:** it checks that no spoiler check showed and that the saved source holds no timestamps or tables of numbers. Whether the
  agent's replies gave anything away is read from its output by a person.

The unit tests cover the snapshot (`electron/mods/snapshot.test.ts`), the build conversation and its file tools
(`electron/agent/agent.test.ts`), drafts and approvals (`src/host/build.test.ts`), the build agent's tools (`src/agent/tools.test.ts`)
and `/build` itself (`src/shell/commands.test.ts`).

**Entering**

1. Typing `/b` lists `/build` with the red "! spoiler the agent looks ahead without asking" beside it.
2. `/build a controller that can go back and forward laps` shows the `build ×` tag with no spoiler check. The layout is untouched
   and playback pauses.

**A new mod**

3. The palette shows the write and "loaded", with no version number, and the tag becomes `build · 1 change`.
4. The stepper appears in the strip marked "draft", without the agent calling `suggest_tiles`.
5. The agent set `looksAhead` on it, and the preview shows the look-ahead warning. After Allow, clicking "lap ›" moves the real playback to the start of the next lap, by the
   session database.
6. Enter adds it to the grid already approved, and its title reads "Lap stepper · looks ahead" in grey.
7. A second tile of the same mod asks again.

**An edit**

8. "Show the lap number bigger" reloads the tile in place, in the same position and still approved.
9. Editing a mod that's on screen (lap form to 12 laps) gives it the dashed outline and "edited", and the tag counts 2 changes.
10. A save that doesn't compile keeps the last good version on screen, and the agent fixes it from `mod.error` unasked.

**Props**

11. "A battle chart for Hamilton and Norris" previews with those two drivers.
12. The same request with no drivers named still draws something with `{}`.

**A delete**

13. "Remove the lap stepper" takes its tile off screen, and the tag counts the change.

**Leaving**

14. Save: the tag goes, the mods stay on disk, the snapshot folder is gone and the tiles stay.
15. Undo all: the new mod's folder and tiles are gone, the edited mod is back to its old code on screen, and a deleted one is back.
16. Either way the palette offers "back to 0:42:10", and clicking it returns the playhead there. Not clicking leaves it alone.
17. Quit mid-build and restart: the mods folder matches how it stood on entry, with no prompt.
18. Kill the app during the snapshot copy: the next start ignores the half copy and leaves `mods/` alone.

**Spoilers**

19. During a build at 0:00 of a replay, the agent reads the whole session with no check, and its replies don't mention results.
20. After leaving, the viewing agent's next request, read from the session's `.jsonl`, holds only the app's one line.
21. After leaving, "go to lap 30" in view mode asks "The agent wants to look ahead of where you are." again.
22. The saved mod's source has no race data written into it. This is a read of the file, not of the screen.

**The picture**

23. After "make the buttons red", the build session's `.jsonl` shows it took a picture of the draft, and the screen matches.

## Where it lives

| Piece | File |
| --- | --- |
| The snapshot: taking it, restoring it and what differs | `electron/mods/snapshot.ts` |
| Begin, Save, Undo all, the check on start, and waiting for a save to load | `electron/mods/index.ts` |
| The build conversation beside the viewing one | `electron/agent/agent.ts` |
| The build agent's file tools | `electron/agent/extensions/modFiles.ts` |
| Its instructions | `shared/buildPrompt.ts`, `shared/modGuide.ts` |
| Its viewing tools, without the gate | `src/agent/tools.ts` |
| Which agent a message goes to, and the line for the viewing agent | `src/agent/bridge.ts` |
| The picture of a draft | `pictureOf` in `electron/ipc.ts` |
| Build state in the host: `live.build` and `host.build` | `src/host/build.ts`, `src/data/build.ts` |
| Drafts in the strip | `src/host/suggestions.ts`, `src/shell/SuggestionStrip.tsx` |
| `asOf: 'session'` | `src/host/useSql.ts` |
| `looksAhead` | `src/host/components.ts` |
| Approval per tile | `src/host/lookAhead.ts` |
| The warning, the outline and the title's "looks ahead" | `src/host/Grid.tsx`, `src/layout/Stage.tsx`, `src/layout/GridSurface.tsx` |
| `/build` and its red text | `src/shell/commands.ts`, `src/shell/CommandPalette.tsx` |
| Entering, leaving and the offer to go back | `src/shell/buildMode.ts` |
| The tag, Undo all and Save | `src/shell/CommandPalette.tsx` |
