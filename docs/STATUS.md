# Status

What has actually been verified, and what hasn't. Last updated 2026-11-21.

## Verified on real sessions

On Linux with an RTX 4080, against real F1 TV streams and the real agent:

- The full journey: blank start, sign-ins, clarifying "2026 Brazil", loading "2025 Mexico", adding Hamilton and a Norris/Leclerc
  group, then closing the group. That was before groups were taken out (#101). `scripts/journey.mjs` passed in full again
  (2026-11-16), rewritten for the strip and the spoiler check: clarifying the next weekend, loading "2025 Mexico
  race" (a weekend alone now gets "which session?"), the palette hiding, the agent suggesting HAM, NOR, LEC and a NOR · LEC gap chart
  and all four added from the strip and in sync (0.074s), closing the battle with Hamilton's `<video>` kept, pause, sound to Hamilton,
  ten minutes ahead after Allow once, 30 s back, resume, and "who won" answered with nothing after Don't allow.
- Four streams in sync, with the widest spread seen once settled under 0.07s, on the 2024 Mexico, 2025 Saudi Arabia, 2025 Mexico and 2026 Mexico races. None of these replays use DRM.
- Components that show video, on the 2026 São Paulo race at lap 12 with `scripts/battle-check.mjs` (2026-11-15). The battle started on
  the closest fight with both onboards playing and listed six fights; the same onboard played in a video tile of its own at the same
  time, as a second stream. Clicking a picture made it the one heard without raising the volume from 0, and the battle's title bar and
  the picture said so. Picking another fight kept the sound with the driver who stayed in it, and closing the battle moved the sound to the other video of the same feed. The chase showed the car ahead and the gap,
  marked OT within a second. Many streams at once haven't been soaked: each picture is its own stream, so this costs bandwidth.
- Pause, timeline seek, keyboard controls, and closing the main feed while the clock keeps running.
- The timeline's volume control setting each stream's level by mouse and keyboard, including in the production build. This was read
  back from the video elements, not checked by ear.
- Session data lining up with video at lights out on the 2026 Mexico race: not started 60s before, started 60s after, and hidden again on seeking back. The map itself was checked the same way on 2024 Mexico
  and 2025 Saudi Arabia through the old timing path it came from.
- The agent seeking by what happened, on the 2025 Mexico race with `scripts/seek-check.mjs` (2026-11-09): "go to lap 30" and "back to lap 5" each
  landed at the start of that lap by the session database, "go to when VER catches up to HAM" went to a moment it found in `overtakes`, and
  a lap that doesn't exist moved nothing. Its replies said only where it jumped. The model's first query for a lap used a column `laps` doesn't have, both runs, and it corrected itself.
- The agent refusing to skip forward or name a winner when asked directly. That was before it could seek forward through the spoiler gate.
- The spoiler check, on the same race with `scripts/seek-check.mjs` (2026-11-09), which clicks the answers in the real palette. Answering
  No to "go to lap 30" left the video at 0:00 with nothing read ahead, and the agent said it couldn't look. Yes (once) then covered both the
  read ahead and the forward seek of that turn with one check, and a backward seek didn't ask. The 50s timeout, the session approval and the
  live edge are covered by unit tests only.
- Forgetting a read-ahead turn, on the same race with `scripts/seek-check.mjs` (2026-11-10). After an approved read ahead, the next request
  carried only that turn's message, with its `<app_note>`, and the agent's reply, and OpenAI accepted the cut-down history on every later turn.
  A refused turn stayed whole. Compaction is covered by tests against a fake model only.
- The production build, including its content security policy.
- The countdown displaying and ticking. Its automatic start hasn't run: see below.
- castLabs Electron 45.2.1 (Chromium 156), on 2026-11-15, in an isolated instance on the 2026 São Paulo race at lap 30: the F1 TV
  sign-in decrypted, the castLabs CDM loaded, and F1 LIVE with three onboards and the tower settled at 0.05s spread within 60s, as on
  Electron 42. That replay isn't encrypted, so Widevine was checked with Shaka's public Widevine demo stream in the same window, which
  decrypted and played. F1 TV's own Widevine streams on Electron 45 wait for the next live session.
- Every season's world feed from 2021 on, opened directly and through the agent. 2021 races start with it as the main feed, and from 2022
  to 2026 it plays as a tile, within 0.05s of the other streams. 2018-2020 aren't a focus, though a 2019 race played the same way.

## Verified on a live race

On the 2026 São Paulo Grand Prix, opened through the agent:

- Widevine DRM: all four streams encrypted, with licenses returning 200 through the proxy.
- Joining 8-10s behind the live edge, with four streams at 0.04s spread.
- A three-minute DVR seek, returning to live, and pause and resume. Right after returning to live, streams were still settling, at 0.59s
  spread 12s later and being corrected.
- Live timing reaching the app and being held back, through the old `useTiming` path, since replaced: about 680 records held, against about 660 expected for 50s of video lag.

On the 2026 Las Vegas Grand Prix (2026-11-22 UTC, session 11420), joined around lap 20 of 50 under a safety car, with `scripts/live-check.mjs`
and by hand in isolated instances, on castLabs Electron 45.2.1 with the agent:

- **`scripts/live-check.mjs`, all 25 checks.** The agent opened the session, typed `race`. The world feed, requested with no `channelId`,
  and three onboards played under DRM, 8.3-8.5s behind the live edge and within 0.04s of each other, 0.32s 12s after a three-minute DVR seek
  and 0.34s 12s after returning to live. 4,890 rows were held against about 5,285 expected for 58s of video lag.
- **The capture on a race.** `intervals`, `pit`, `pit_lane`, `laps`, `stints`, `position`, `race_control`, `weather`, `car_data` and
  `location` filled, and the lap count read 24/50 as the broadcast did. `DriverRaceInfo`, `ChampionshipPrediction` and `LapCount`, which a
  practice never sends, came in the snapshot and kept coming. `PitStop` and `PitStopSeries` never came: see "Known limits" in
  [SESSION_DATA.md](SESSION_DATA.md).
- **The lead on a race.** As the lap count went from 24 to 25, the broadcast's own counter changed 7.5s of stream wall clock after the
  feed's time for it, so the 7.6s default holds on a race. The app's count changed 2.4s after the picture's: the feed's message took 2.2s
  to arrive, and data is placed by when it arrived. It was never ahead. MultiViewer's lead stayed unpublished, as expected for a race.
- **Restarting mid-race.** Closed for 27s and opened again on the same profile: the tables rebuilt from the kept messages, the data was
  ready 2.5s after opening, and `coverage.gaps` recorded the 27.2s.
- **Every chart on live race data.** All 15 drew without an error, on the tiles a race offers. The tower's order and retirements
  matched the broadcast's tower. Joined under the safety car, `tyre_deg` said "Waiting for lap times" and `sector_table` marked those laps
  as not counted, with nothing for the laps before joining.
- **The agent.** Asked for the gap between the top two, it read `position` and suggested `gap_evolution` with both onboards. Asked who
  pitted last and for how long, it gave the pit-lane time and said the stationary time isn't available. "Go back 2 minutes." seeked, and
  `go_live`, unanswered, left playback where it was and said so.
- **Rewinding to before the capture.** The first run found the data still `ready`, showing what the live edge had, while SQL at the
  playhead was refused: the waiting state was only published when its countdown happened to change apart from the playhead's second.
  It's now published at once, and a rewind of 11 minutes showed "Waiting for the video to reach the live data" at once.

## Verified on a live practice

On 2026 Las Vegas FP1 (2026-11-20), wet, joined about 30 minutes in, with `scripts/live-check.mjs` and by hand in isolated instances, on castLabs
Electron 42.11.18:

- Opening it through the agent, DRM on F1 LIVE and two onboards, joining 8.2-8.5s behind the live edge, a three-minute DVR seek, returning to live,
  and pause and resume. Three video tiles held 0.045-0.06s spread after the seek and after returning to live, sampled every 3s for 30s.
- The capture into the database, from `live`, and held back to the video: 3,679 rows held against about 3,900 expected for 47s of video lag, and
  rewinding hid what the video hadn't reached. See "Known limits" in [SESSION_DATA.md](SESSION_DATA.md) for the feeds and tables.
- Car telemetry live, with the F1 TV sign-in on the socket, and a track map drawing the cars as the broadcast's own map did.
- Restarting the app mid-session: the tables rebuilt from the kept messages, and the time it was closed was recorded as a gap.
- Listing upcoming sessions during a live one.

On 2026 Las Vegas FP2 (2026-11-20), joined at the start, with `scripts/live-check.mjs`: F1 LIVE and three onboards under DRM within 0.05s of each
other, through a three-minute DVR seek and returning to live, and 4,052 rows held against about 4,500 expected for 49.6s of video lag. The check
that rewinding hides rows found `position` empty both ways, three minutes into a practice before anyone had set a lap. The live stream's frame
time was measured against the picture: see "Linking to the video" in [SESSION_DATA.md](SESSION_DATA.md). Run again 35 minutes in, after the
data waited for the video, all 25 checks passed: the data waited, saying why, and lined up 17.6s after the streams were ready; a rewind before the
capture waited again, and a read at the playhead was refused; back at the live edge it lined up at once; and 4,498 rows were held against about
4,284 expected for 57.6s behind arrival.

Also on FP2, in an isolated instance with the agent:

- **Waiting for the video.** Joining, a timing tower read "Waiting for the video to reach the live data" for about 50s, its hover counting
  down, then drew with the playhead 7.5s behind the stream's wall clock, in the broadcast's order. Rewinding before the capture waited again.
  Reopening with the capture kept reached `ready` in 6s.
- **Every chart on live data.** All 15 drew without an error, added by hand since each is offered for races only. The tower's order matched
  the broadcast's. Its gaps are empty, as a practice has no intervals.
- **The agent seeking on a live session.** Asked for when race control deleted a lap, it queried `race_control` and seeked to it.
  `seekToDate` landed within 0.5s of the frame asked for, 1 and 5 minutes back.
- **The agent opening the live session** said it was "already open" and "paused" at FP1. It was handed off to a new conversation that saw
  only an open session, at a clock that hadn't ticked. The handoff now says this message opened it, playback reads "starting" until a stream
  is ready, and on FP2 it replied that the session is open.
- **Asking for a race-only chart.** Asked "Add the timing tower." in practice, it said it "isn't currently available in the tile list" after
  trying it as a stream, or "can't add the timing tower with the available controls" without trying. Its component list left the tower out,
  so it didn't know it existed. It's now told the components that don't fit and why, and replied "The timing tower isn't offered in practice
  sessions; it's available for races and sprints." Named as a stream, `suggest_tiles` now says which component it is and why it isn't offered.
- **Moving on the live timeline.** "Go back 2 minutes." queried the playhead and seeked back. "Back to live." had no tool to do it: the
  agent tried to read ahead for the latest time, which the spoiler check refused. `go_live` now does it, asking the spoiler check as a
  forward seek when behind the edge. On FP2 it asked, and after Allow once playback was at the edge, 8.7s behind.
- **Answering from live data.** Asked who had the fastest lap, it read `laps` at the playhead, checked `race_control` for deleted laps, and
  answered Leclerc by 0.096s from Hamilton, which the table agreed with. Deletion messages have no driver or lap number in F1's feed, only
  in their text.
- **Through the end of the session.** Sampled every 30s from 04:43Z to 05:11Z, through a red flag ("SESSION ABORTED" at 04:49Z), the
  restart, the chequered flag at 05:00Z and 11 minutes after it: the stream stayed live and playing at the edge, 8.7s behind, with the data
  `ready` and following race control and track status throughout. Its frames ran 43.7-43.9s behind real time, so the data was held that long.

FP2 as a replay, 55 minutes after it ended, in an isolated instance with the agent and a fresh profile:

- **Finding and playing it.** Asked "Open Las Vegas FP2 from the start.", the agent listed the season and loaded it from the start: a
  1:42:43 replay under DRM. Leclerc's and Hamilton's onboards, suggested and added, held within 0.07s of F1 LIVE after a seek to 50:00.
- **No data yet, and saying why.** F1's index listed FP2 with no archive path, so every feed failed as "Invalid archive path" and the data
  read "The timing archive couldn't be downloaded.", for as long as it was open. The agent said only that the data "failed to load". Now the
  data says F1 hasn't published the timing yet and is checked again every 5 minutes, the main process looked again 5 minutes later, at 06:05:33Z, and the
  agent's state line carries the reason: it replied "F1 hasn't published this session's timing data. The viewer checks again every five
  minutes." MultiViewer hadn't published FP2's `session_start` or `session_start_pdt` by 06:00Z, so once the archive comes, the data will
  still wait for it.

## Verified on a live qualifying

On 2026 Las Vegas qualifying (2026-11-21 UTC, session 11416), joined late in Q1 and watched through Q2, in an isolated instance on castLabs
Electron with the agent:

- **Joining, DRM and sync.** F1 LIVE and two onboards under DRM, 8.3-8.4s behind the live edge and within 0.04s of each other. A ten-minute DVR
  seek and back, and a two-minute one through the agent's `seek_to`.
- **The capture.** `drivers`, `laps`, `position`, `stints`, `race_control`, `weather`, `car_data` and `location` filled; `intervals` stayed
  empty, as in practice. Joined between laps, every car's row from the snapshot had no lap time, so nothing was timed until a car finished a
  lap after joining. An out lap's duration counts the wait in the garage since the lap before (10 to 16 minutes across Q1 and Q2).
- **The tower against the broadcast.** With Q2's first laps in, the order and the lap times matched F1's own tower. One lap showed on the
  broadcast before the tower moved that car up: how long before wasn't measured.
- **Every chart on live data.** All 15 drew without an error, added by hand since each is offered for races only. The ones that need a race
  say so in their own words: the tower has no gap or interval and shows the last lap, not the best; `sector_table` found no lap both drivers
  had started.
- **The agent.** It opened the session from "open the live session", answered who was fastest in this part by reading `race_control` for
  when Q2 began and `laps` after it, suggested an onboard and went back two minutes in one turn, and `go_live`, unanswered for 50s, left
  playback where it was and said so.
- **`@` while the data waits.** A bare `@` listed only the tiles for the first 50s after joining, and whenever the video was behind when the
  capture began: the roster was only published once the data was `ready`. `waiting` now holds the roster too, and codes, team tags and the
  agent's `app_state` read it. Checked ten minutes behind the capture: 22 drivers and 11 teams listed.

## Verified for finding a session

With nothing open, the real agent at medium reasoning, with the event list in its prompt, on 2026-11-15, each request in a fresh
conversation (`scripts/picking-check.mjs`, which records the session the agent loads instead of playing it). Three runs each:

- "last race" and "latest quali": loaded the 2026 São Paulo race and qualifying, every time, without asking.
- "2026" alone: asked which event and session every time.
- "2025 Mexico": asked which session every time.

Once each: "next race" loaded Las Vegas, which hasn't started, "last sprint" Singapore's sprint, "2025 Mexico race" that race, and
"the race before Brazil" Mexico City's. "Vegas" alone asked which session.

## Verified for session data

The SQLite session data ([SESSION_DATA.md](SESSION_DATA.md)), on the real archive through the real app:

- Ingesting a whole race in about 7 seconds, then skipping that on the next open.
- Its tables matching OpenF1 row for row, on the same clock. Telemetry was sampled, and 7 of 22 `starting_grid` positions differ, where OpenF1's copy looks older than the page.
- Opening through the host: results hidden at the start of a replay, reads following the playhead, and direct table reads refused.
- Retired cars on the 2026 United States race (session 11396), with `scripts/charts-check.mjs` (2026-11-09): at laps 20, 30 and 53 the timing
  tower marked the same cars `OUT` as the broadcast's tower, and the track map, pace and pit window left them out.

Live capture ran on a live practice and a live race: see "Verified on a live practice" and "Verified on a live race".

## Verified for layout

On Linux, in the real app at 1600 by 900, over the 2026 São Paulo race replay (2026-11-12):

- Each of the 14 charts alone at its declared least size drew in full, except field pace, which was compact at 267 wide and had its
  least width raised to 300. The other least sizes were adjusted from what those captures showed.
- Auto-layout over arrangements from a video with the timing tower to six tiles, three videos, and charts with no video: the
  main feed took the main place, the tower sat beside it, wide charts went below, and no chart was below its least size.

`src/components/charts.test.ts` runs the built-in charts through nine arrangements at that window size on every test run.
Other window sizes were only simulated: at 1280 by 640 some charts go below their least size from four tiles up.

## Verified for mods

On Linux, in the real app, over replay races (2026-11-09):

- A mod's life, with `scripts/mods-check.mjs` on the 2026 United States race at lap 25: a new folder loaded and drew, a save while
  playing replaced the tile's drawing while the session, tile and clock carried on, a broken save kept the last good version and wrote
  `mod.error` with the file and line, a mod that threw showed the error in its tile with the rest of the app still playing and its
  console and error in `mod.log`, a fixed save drew again, and deleting the folder took the tile off.
- The production build loading a mod under its content security policy, with no errors.
- A tile marking content cut off below it, with `scripts/overflow-check.mjs` (2026-11-11): a list mod showed "more ▾" with a faded
  bottom edge when resized below its `size.min`, when its scroll area was squeezed to 40px, and with 40 rows at its `size.min`, even
  scrolled part-way; no mark when it fit or was scrolled to the end; and the same in the suggestion strip. Superseded on 2026-11-12,
  when the host stopped looking inside a component.
- The mark checking only the tile's frame, with `scripts/overflow-check.mjs` (2026-11-12): a table mod whose content ran past its
  400px tile was marked "more ▾", "more ▸" or "more ▾▸" by which way it ran, and not marked when it fit or in a 1200px tile; the same
  in the suggestion strip. A list scrolling 40 rows of its own wasn't marked, nor with its scroll area squeezed to 16px.

## Verified for installed components and forks

On Linux, in the real app, over the 2026 São Paulo race at lap 20, with `scripts/fork-check.mjs`, with the real agent on a ChatGPT
sign-in (gpt-6.1-terra) and with `--no-agent` (2026-11-17):

- Asked in build mode to "add a column with how many pit stops each car has made to" the tower's tile, pointed at with `@`, the build
  agent called `fork_component` first, made `timing_tower_pit_stops` labelled "Timing · pits", added a `PIT` column to it (a count
  from the `pit` table joined into the tower's query), looked at it and suggested it. Its reply said the change is in a fork, the
  original stays unchanged, and the fork is in the strip to replace it. The count drew on screen.
- On start, the app copied all 16 of its own components into `mods/.installed/builtin`, each the source the app runs, and
  `live.components` marked each `installed`.
- In build mode, a fork of `timing_tower` made by `forkComponent`, the code behind the build agent's `fork_component`, loaded as a
  local component, showed in the strip as a draft, and counted as added. The installed source and the tower's tile stayed as they were.
  Added beside the original, the fork's tile had a key of its own and read "Timing · pits" where the original's read "Timing".
- `electron/mods/installed.test.ts` forks every installed component and compiles each fork as a mod.

## Verified for agent setup

In the real app on a fresh profile (2026-11-11): `/settings-agent` listed OpenAI and Anthropic, an Anthropic key typed into the key
window connected it with Claude Sonnet 5.5 at medium, choosing Claude Haiku 5.5 at high saved both, closing printed the model line,
OpenAI showed the switch note while Anthropic was connected, and Remove left the agent needing setup again. The key was fake, so no
request was sent.

GPT-6.1 Terra at medium on a ChatGPT plan, the recommended OpenAI model, on the real profile (2026-11-11): "2025 mexico city grand prix
race" called `list_sessions` then `load_session` and opened the race in 8.3s, and "Hamilton" suggested his onboard with `suggest_tiles` in
4.1s. The stored session shows every reply came from `gpt-6.1-terra`.

**Onboarding** (2026-11-16), in isolated instances. On an empty profile it opened on the F1 TV step, the agent step offered
"Sign in with ChatGPT" and Other providers, and Skip for now left fix blocks in the palette for F1 TV and the agent; Dismiss turned one
into a line naming `/login-f1tv`. On a profile with both signed in it didn't show at start, and `/reset-onboarding` brought it back
with both steps done and "Open a session" open. No sign-in was completed from onboarding or a fix block. Since 2026-11-21 it
has two steps and no "Open a session": the landing page follows it.

**Landing page** (2026-11-21), in an isolated instance signed in to F1 TV with no agent, by `landing-check.mjs`. After Skip for
now the tape showed 6 sessions coming up and 421 finished, back to 2023, opened on the line at now with no row open (nothing
was live), and left F1 TV's shows out. Clicking the last finished race wrote "2026 São Paulo race" in the input and opened its
suffixes; two of them made it "…, jump to 30 seconds before lights out, with onboards of the top 3 on the grid"; the arrow keys
moved to the session before and back, and left typed text alone. Tonight's race sent as its row wrote it, with the real model,
opened its countdown in place of the page. On a new profile signed out of F1 TV there was no landing page, only the fix blocks:
F1's archive answers 401 without the sign-in, so there's no calendar until one is made, and signing in refreshes it. The calendar
also stayed `loading` there, since its first refresh finished before the window had loaded and the renderer missed it; nothing
reads that state yet. Not checked: a row starting open while a session is live, onboarding finishing by its second step and
handing over, and what the agent does with each suffix.

**The rename to oh-my-f1-viewer** (2026-11-16). The first start on the default profile copied the real `~/.config/f1a`:
mods, conversations, settings, the 538 MB timing database, the caches and the DRM module. `scripts/login.mjs` then signed in to F1
TV and the agent again under the new name; the agent kept the copied model and thinking. In isolated instances with those logins
copied in:
- `drm-check`: four DRM streams ready and within 0.039s, pause, seek, the clock without the main feed, and data lined up with lights
  out. Its stream lookup used `channelId`, which streams no longer have, so it had printed no drift since components could show
  video: it uses `feed` now.
- `mods-check`, `seek-check` and `overflow-check` passed in full. `seek-check` failed "playback moved" once, when the model picked a
  moment 3.8s ahead, and passed on the next run.
- `picking-check`, three runs each, the same as on the commit before the rename: "2025 Mexico" asked which session every time, and
  "2025 Mexico race" opened it every time.
- `build-check` passed 115 of 116. Case 6 expects a new mod's title in the grey of any title, but build mode now marks that tile in
  yellow with a black title. It checks the yellow header now: see Build mode below.
- `journey` failed 8 checks, the same 8 as on the commit before the rename: it predates battle tiles and the spoiler check. It now
  asks for "2025 Mexico race", since the pick agent asks about a bare event. It was rewritten for the strip and passes: see above.
- `layout-check` and `suggestions-check` failed the same 3 and 4 checks as on the commit before the rename (edge and corner resizing,
  closing a tile). Onboarding covered layout-check's tiles, and a preview's width couldn't be resized: both pass now, see Build mode below.
- The build agent, driven through `window.omfv` without a session, called the app OMFV and wrote a mod importing `'omfv'` and
  `'omfv/kit'`, which loaded over `omfv-mod:`. The production build, from `dist/` with its CSP, is titled oh-my-f1-viewer, loads
  the favicon and imports a copied mod with nothing refused. Onboarding shows the logo's mark.

Its second pass (2026-11-16), in isolated instances: the card held 390px through every step, opened or closed, on an empty
profile, one signed in to F1 TV, and one with both; "Open a session" lit the palette with its example. With main's sign-in
handlers swapped for ones that never finish, F1 TV's step kept a disabled "Waiting for F1 TV…" button, and a device code
showed set apart with Copy code and Cancel. Copy wasn't pressed, and a step finishing by itself to hand on wasn't seen.

## Verified for build mode

On Linux, in the real app with the real agent, over the 2026 United States race, with `scripts/build-check.mjs` (2026-11-11). It runs
the cases in [BUILD_MODE.md](BUILD_MODE.md), "Checking it", and every one passed:

- **Entering:** `/b` listed `/build` with its spoiler alert in red. `/build a controller that can go back and forward laps`
  showed the tag with no spoiler check, paused playback, turned the palette's frame and prompt yellow, and left the layout alone.
- **A new mod:** the agent wrote `lap_controller`, the palette said "wrote lap_controller/main.tsx · loaded", and it appeared in the
  strip marked draft without the agent suggesting it. The agent had set `looksAhead` on it unasked, so its preview asked before looking ahead. Once allowed, Next landed 0.0s from the
  start of the next lap by the session database, and Previous went back. Enter added it already approved, with "· looks ahead" in its
  title in the title's grey. Closing the tile and adding the mod again asked again.
- **Edits:** "show the lap number bigger" reloaded the same tile in the same place, still approved. Changing lap form, which was on
  screen, gave its tile the dashed outline and "edited", and the tag read 2 changes. After the script broke the controller's source, the
  tile kept running the last good version, and the agent fixed the break while making an unrelated change.
- **Props:** asked for a mod for Hamilton and Norris, the agent wrote it and suggested it with those two, and the strip previewed it
  with their car numbers. With no props it drew too.
- **A delete, and Undo all:** the agent removed a mod, edited another and added a third. Undo all brought the first back, put the
  second's old code back on disk and on screen, and removed the third with its tile. The snapshot folder was gone afterwards.
- **Save:** the mods stayed, the tiles stayed, the marks went, and the palette said what was built. The offer to go back returned
  playback to where build mode was entered, and not taking it left playback alone.
- **Quitting:** killing the app mid-build and starting it again put the mods folder back with no prompt. A snapshot with no marker was
  ignored and cleared.
- **Spoilers:** no spoiler check showed in any build, and the build agent read the whole session. After Save, the viewing agent's next
  request held the app's one line and nothing else of the build, and "go to lap 40" asked again. The saved sources held no race data.
  The agent's replies said nothing about the race in the runs read.
- **The picture:** asked to make the buttons red and check, the agent called `look_at`, and the buttons on screen were red.

What the script doesn't do: for case 18 it puts a half snapshot on disk, without killing the app inside a copy. The last run was all three parts on the final code, 89 checks. Earlier runs found
one bug, since fixed: a draft suggested with drivers was dropped when its key matched the draft with no props. The agent names and
builds things a little differently each run.

A second script, not in the repo, built a list of race control penalties the same way: the agent declared `size` and drew no heading,
the strip preview took the list's tall shape (260 by 179), and the newest message showed there, in the tile, and in a tile 2 rows high.
The same mod with a 62px heading of its own still hid its message at 2 rows: see issue 44.

The mark on a draft or edited tile has since changed from the dashed outline to the frame and lit title bar of a tile pointed at with
`@`, in yellow where that one is white. `scripts/build-mark-check.mjs` checked it without the agent, over the 2026 São Paulo race (2026-11-16): lap form, edited on disk
during a build, got the yellow 2px frame and lit bar and "edited", and the other tiles stayed as they were. Pointing at the tower lit it
white and dimmed the rest, lap form included, and pointing at lap form turned it white. `build-check.mjs` cases 6 and 9 now check the
lit header and the frame. Its part a, 73 checks through case 19, passed over the 2026 United States race on 2026-11-16; parts b and c haven't run since.

Resizing a preview's width by hand had stopped working when the strip's cards got a flex basis (b22d0e0): the card's own width was
ignored, so only the height followed the grip. A hand-picked size now takes the card out of the flex sizing, and
`scripts/suggestions-check.mjs` passes again (2026-11-16).

## Verified for the agent on pi-durable

On Linux, in the desktop app on the main profile, on a ChatGPT plan with GPT-6.1 Terra (2026-11-16):

- **Viewing**, over the 2025 Mexico City race: a turn opened the session with `list_sessions`, `load_session` and `suggest_tiles`, and
  its reply streamed.
- **Reading ahead.** `scripts/seek-check.mjs` passed in full: the spoiler check before a peek, Don't allow and Allow once, seeking by
  lap and by what happened, and a lap that doesn't exist. After a read-ahead turn the conversation had its `omfv.forget` entry, the
  stored tool results stayed, and the next turns worked on the cut-down history.
- **Build mode.** `scripts/build-check.mjs` passed in full, over the 2026 United States race, once it followed two earlier changes
  to the app: the "not drawing" note names a tile by its id, and `/build` needs a session open.
- **Compaction**, with the threshold lowered to a few thousand tokens, in the desktop app: three to five
  summaries were made over five turns, each turn carried on, the agent could say what had been asked so far, and no summary held
  what a read-ahead turn had read. A summary does hold the playhead from app state, which is what the viewer is looking at.
  These runs found one fault, since fixed: a summary placed in the middle of a read-ahead turn was taken for the turn's start, and
  the turn wasn't cut down when it ended.
- **The key window**, on a profile of its own: a key typed there is stored, readable only by the user, and connects the provider. The
  renderer never sees it, Cancel changes nothing, and disconnecting removes it. This ran while the credential was still in
  `pi-agent/auth.json`, before it moved to the encrypted `omfv-credentials.json`.

**After the files of pi-coding-agent's conventions went** (no `SYSTEM.md`, mods `AGENTS.md` or `tsconfig.json`), the credential moved
to `omfv-credentials.json`, the settings to `omfv-settings.json` and each conversation to a SQLite database, on the main profile
(2026-11-16):

- **A ChatGPT sign-in from `/settings-agent`** stored the encrypted credential, and every turn below used it.
- **`scripts/seek-check.mjs`** passed in full again, and its viewing conversation was stored as `<time>_view.sqlite`, with the
  `omfv.forget` entries of its read-ahead turns. `node devscripts/conversation.mjs` prints it.
- **The settings** are shared by every build on the profile: the checks, each on a Vite port of its own, found the agent set up from
  the file. The volume saved in one launch came back after a reload, and a change made just before quitting was written.
- **`scripts/build-check.mjs`** passed in full, all 99 checks, in an OMFV of its own with the agent's login and settings copied in,
  which is how every check that needs the agent now runs. The main profile's login and mods were left as they were.

**A ChatGPT sign-in by a person** (2026-11-16), on a profile of its own with no login in it: "Sign in with ChatGPT" opened
OpenAI's page in the default browser, the callback came back, the provider showed as "OpenAI (ChatGPT subscription)" with GPT-6.1
Terra at medium, and a real turn replied on the new login.

## Verified on macOS

On a MacBook Air (Apple silicon), running from source with Node 26 from Homebrew (2026-11-19):

- Install, build, typecheck and unit tests. One unit test is flaky on macOS: "finds new mods and drops removed ones" in
  `electron/mods/mods.test.ts` timed out in 1 of 3 full runs and passes alone, likely the folder watcher starting late under load.
- The castLabs CDM downloads and is ready. Signing in to F1 TV, connecting ChatGPT, playing a race and talking to the agent all
  work, by hand. Most replays don't use DRM. A live session does, and F1 TV refuses the castLabs build's development VMP
  signature on macOS, so the checkout's Electron has to be VMP-signed first: see Known issues.
- Ctrl+K toggles the palette, and clicking the key on it changes it (`scripts/layout-check.mjs`). macOS gets the app, Edit and Window menus for Cmd+C, Cmd+V,
  Cmd+A and Cmd+Q, which haven't been tried by hand.
- `scripts/layout-check.mjs`, `scripts/suggestions-check.mjs` and `scripts/overflow-check.mjs` pass, and so does
  `scripts/mods-check.mjs` on the 2026 United States race at lap 25. The checks' windows open in front and take focus.
- Build mode, with `scripts/build-check.mjs` on the 2026 United States race, three runs. The first passed in full, though its case 23
  passed with the picture failing: `look_at` timed out on most tries, since Chromium records a tab at the screen's size and
  `src/host/picture.ts` waited for a frame at the window's. It now takes the first frame with the element's shape, and case 23 also
  checks the turn's note. The second run found a new mod's first save reported as "not a mod yet": macOS's watcher told of the save
  after `settled` had stopped waiting, which now looks for the folder itself. The third passed every case but 25: the edit's
  result left out that the tile needed a driver, though the agent still fixed the tile in that turn, having been refused by
  `edit_tile`. Case 25 passed in the first run, so it comes and goes, and why isn't known.

**The released Mac app on a live race** (2026-11-21), release `20261121.1` from `/Applications`, signed with the Developer ID and
VMP-signed, on the 2026 Las Vegas Grand Prix from lap 34, with `scripts/packaged-live-check.mjs`, five runs, each on a profile of
its own with the screen locked:

- **The sign-ins.** The copied F1 TV and ChatGPT logins decrypted with no keychain prompt. The keychain entry's partition list
  reads `teamid:3X53S423SA`.
- **DRM under the hardened runtime.** The agent opened the live race from "Open the session that is live now.", and F1 LIVE, two
  onboards it suggested and the world feed all played encrypted, up to 1920x1080, within 0.05s of each other with three streams and
  0.24s with four, 15s after the fourth was added.
- **The timeline.** Three minutes back by the arrow keys and back by the timeline's live button, with the streams within 0.05s
  after each in four runs; in one, an onboard was still `syncing` 12s after the seek, 0.41s off. Pause and resume by Space.
- **The capture on a race.** `source` was `live` with no gaps, and `intervals`, `laps`, `position`, `stints`, `race_control`,
  `weather`, `car_data` and `location` filled. `pit` stayed empty: no run was open through a pit stop.
- **Charts on live race data.** The timing tower, track map and a gap chart, suggested by the agent and added from the strip, drew.
  The tower's order matched the broadcast's in the one frame compared, with gaps, intervals, last laps and tyres. A car that had
  retired before the app joined was listed last with no `OUT`, where two others were marked.
- **The agent.** `go_live` asked the spoiler check and went to the edge after Allow once. "Go back 2 minutes." worked in 2 runs of
  5: see Known issues.

**After the chequered flag**, with the session still live on F1 TV and the timing feed gone quiet: nothing arrived after the
snapshot at joining, in runs of several minutes.

- **Build mode on a live session**, in the released app with `scripts/packaged-live-extra.mjs`: `/build` opened over the DRM
  video, the build agent wrote a mod and called `look_at`, which returned its picture ("looked at look_test").
- **Restarting mid-session**, same script: closed for 42s and started on the same profile, the capture kept its start, the
  tables were rebuilt with the first run's rows, and the time closed was a gap. With the feed quiet this only had the two
  snapshots to rebuild from.
- **From source**, `scripts/live-check.mjs` passed 22 of 25, once the keychain prompt was answered (see Known issues): F1 LIVE and
  three onboards under DRM, 8.4s behind the edge and within 0.05s of each other, through a three-minute DVR seek, back to live,
  and pause and resume; rewinding before the capture made the data wait, and it was ready again at the edge. The three that
  failed need a feed that's flowing: no rows came in 8s, so none were held back, and the data was already ready when the check
  looked for it waiting.

## Verified for packaging

On Omarchy (Arch, x64, Hyprland), 2026-11-20, with `npm run dist` named as release `20261119.1`:

- `scripts/packaged-check.mjs` passes on `release/linux-unpacked`, which is what the `.pacman` package installs, and on the AppImage:
  the app loads from `app.asar` and says it's release 20261119.1, the copied F1 TV and ChatGPT logins decrypt, the build agent's
  files are copied, `lap_form` compiles with the unpacked esbuild, the Widevine CDM is there, and the 2025 Mexico qualifying replay
  plays. The window opens on workspace 3 without focus, with the class `oh-my-f1-viewer`.
- The `.pacman` package's metadata, launcher entry and install script were read, and its dependencies all exist in Arch's
  repositories. It hasn't been installed with `pacman -U`.

The Release app action has since made `20261120.1` and `20261120.2`, and the macOS `.dmg` installs and opens: see
[Verified for updates](#verified-for-updates). Playing a live session in the installed Mac app, with DRM, is under
[Verified on macOS](#verified-on-macos).

## Verified for updates

On Omarchy, 2026-11-20, with `scripts/update-check.mjs`: an AppImage of release `20261120.1`, fed from localhost, found
`20261120.2` at its first check a minute after start, downloaded it, and the palette said it was ready. Closing the window put
`omfv-20261120.2.0-linux-x86_64.AppImage` in the first one's place, and starting that said `Updated to OMFV 20261120.2.`

On a MacBook Air (Apple silicon), 2026-11-20, by hand, from GitHub: on a Mac with no OMFV profile or keychain entry, the `.dmg`
of release `20261120.1`, made by the Release app action and signed with OMFV's certificate, was installed and opened. Then the
action released the same commit as `20261120.2`. After a real quit and start (closing the window had left it running in the
dock, which closing it no longer does), the
app found `20261120.2` a minute in, downloaded it, and recorded it to install. Quitting had Squirrel.Mac put it in
`/Applications` ("Installation completed successfully" in its log), the new app passed `codesign --verify --deep --strict`, and
its start recorded `20261120.2` as the release that ran last. That start asked for the keychain password: see Known issues.
The palette's messages weren't checked by eye.

Not verified: an AppImage updating itself from GitHub.

## Not verified

- **Windows.** On 2026-11-21, `release/win-unpacked` was built from Linux with castLabs' Windows Electron and VMP-signed
  through EVS (`verify-pkg` passes), without Wine, so with no icon and no installer. Not verified: that it runs, signs in,
  decrypts the sign-ins, plays a live session or compiles a mod, nor the installer the action builds on `windows-latest`, nor an
  update from one release to the next.
- **The window icon.** Hyprland shows none, so it hasn't been seen.
- **Fixing a sign-in from onboarding or a fix block.** Neither has completed an F1 TV or ChatGPT sign-in in the real app, F1 TV
  ending a sign-in hasn't been seen, and no turn has failed for a rejected connection or a usage limit, so sending the message again
  after the fix hasn't run.

- **The agent on an API key, or on Anthropic.** No real turn has run on an OpenAI or Anthropic key. Connecting through an OpenAI key from
  the panel hasn't run either. A ChatGPT sign-in from the panel has (above).

- **Forking a fork, and other requests.** One request has been seen (above). Forking a local mod, a second change to a fork already
  made, and installed components other than the tower haven't been asked of the real agent.

- **Mods on Windows,** and the app's own agent putting a mod on screen. `scripts/mods-check.mjs` adds it through the host.

- **Build mode on Windows, or in the production build from source.** On a live session with DRM video on screen, `look_at` worked
  in the released Mac app: see Verified on macOS.
- **A build that runs long enough to compact.** The build conversation isn't collapsed, so nothing depends on it, but it hasn't run.
- **Dragging a draft from the strip onto the grid.** Enter and the host's add are checked. The drag is the same code as any suggestion's.
- **Resizing a draft's preview in the strip.** Resizing a suggestion is checked by `scripts/suggestions-check.mjs`. A draft uses the same
  grips, which sit above its content.

- **The agent using `suggest_tiles`.** The strip, keys, drag and drop, resizing a preview, and Esc are covered by `scripts/suggestions-check.mjs` in the real
  app. On the 2025 Mexico City race, a previewed onboard played muted in the strip, and adding it handed the same `<video>` to its tile,
  still playing and ready, with the audio left on the main feed. That was before each holder got its own video (2026-11-15): the handoff
  is now a new holder taking over a video let go in the same render, covered by unit tests, and not yet run in the real strip. The real agent hasn't been asked for a stream since it lost `add_streams`.

- The archive replacing a live capture once it's published, and the tables compared with OpenF1 after it (`scripts/openf1-compare.mjs`).

- **A replay waiting for MultiViewer's anchor.** Unit-tested only: no replay without one was at hand. The live waiting is verified.
- **The countdown starting a session by itself.** The display is verified, and a unit test covers firing only for its own session and not
  another in the same event. A real run hasn't reached its start time yet. `scripts/countdown-check.mjs` does this on a session due soon.

## Known issues

- **The Mac app asked for the keychain password after every update.** The sign-ins' keychain entry is partitioned by the hash of
  the build that made it, since OMFV's own certificate has no Team ID, so each new release was a stranger to it. Seen on
  20261120.1 to 20261120.2: the entry's partition list named only `cdhash:` of the first. Releases are now signed with a
  Developer ID and notarized, which should end it and Gatekeeper's **Open Anyway**. On `20261121.1` the entry's partition list
  shows `teamid:` and Widevine loads under the hardened runtime (see Verified on macOS). Not verified: that a `.dmg` opens
  without asking, or that one Developer ID release updates to the next without the keychain asking. See
  [RELEASE.md](RELEASE.md#sign-the-mac-build).

- **A run from source on a Mac with a release installed waits for the keychain, with no window.** Both use the keychain entry
  `oh-my-f1-viewer Safe Storage`. Once a Developer ID release has made it, only that app may read it, so the checkout's Electron
  gets macOS's keychain prompt, and the app opens no window until it's answered: `restoreSessionOnStartup` is awaited before the
  window is made. Seen on 2026-11-21 with the screen locked, where every check that copies a sign-in timed out waiting for the
  window. A profile with no sign-in in it opens at once. Allow on the prompt lets that one launch in: the entry's access list
  still named only the release afterwards.

- **The agent refuses to go back on a live session to before the capture.** Asked "Go back 2 minutes." a few minutes after
  joining the 2026 Las Vegas race, in 3 runs of 5 it queried the session and replied that it "can't jump back two minutes: timing
  data doesn't go back that far", without seeking. The video goes back that far, and the timeline does it. When it did seek, it
  went 2:47 back in one run, to "the nearest available moment". Its only way to move was `seek_to` with a date from a row, and
  before the capture there's no row. `seek_to` now takes a `delta` in seconds, alone to move from the frame on screen with no
  data, or added to a `date`. Fixed, and checked from source on macOS after the race, on the same live session, with
  `scripts/move-check.mjs`, two runs: "Go back 2 minutes.", "Back another minute." and "Skip ahead 30 seconds." were each one
  `seek_to` with `delta` alone and no query, with the data `waiting` throughout, and landed to the second; a five-minute jump
  refused at the spoiler check moved nothing; and back at the edge, "20 seconds before the most recent race control message"
  was that row's `date` with `delta: -20`.

- **A live session doesn't play on macOS from source without VMP signing.** Seen on 2026 Las Vegas qualifying (2026-11-20): "F1 TV: Widevine license generation
  failed (DEVELOPMENT_CERTIFICATE_NOT_ALLOWED)". F1 TV's licence server refuses the development VMP signature of castLabs'
  Electron, so every DRM stream fails; unencrypted replays play. Signing it through castLabs' EVS fixes a run from source: after
  `npm run vmp:sign`, the same session's main feed and an onboard got their licences, with 200 through the proxy. Packaging
  VMP-signs the Mac app the same way, and release `20261121.1` plays a live race: see Verified on macOS. See [RELEASE.md](RELEASE.md#vmp-sign-the-app).

- **The agent's reply sometimes arrives twice in one line,** as two different wordings run together. Seen in 2 of 3 runs of "2026" at medium
  reasoning: the model seems to send two text messages in one turn, and the palette joins them into one entry. Not looked into yet.

- **48 sessions from early 2024 have no session data.** F1's season index leaves out pre-season testing and the first nine race weekends, so the lookup can't find them, and they aren't in the
  calendar. This comes from reading the code, and wasn't confirmed by opening one. Their archives exist, and OpenF1 hardcodes the paths in `MISSING_SESSIONS`. Left as is for now, by choice. See [SESSION_DATA.md](SESSION_DATA.md).
- **Intermittent CDN stalls.** Sometimes requests to `ott-video-fer-cf.formula1.com` get no response for 10s or more, in clusters
  lasting minutes, and adding streams stops everything. While it happens the app's side is healthy: request hooks take about 1ms
  and the main process isn't blocked. HTTP/2 and QUIC were tested and aren't the cause. It was heaviest after starting many
  sessions in quick succession, which suggests CDN throttling, but that isn't proven. Three mitigations are in: streams start one at a
  time, wait out a hang (20s stall limit, 6 attempts), and re-resolve as a last resort. After them, `scripts/stream-soak.mjs` got 10
  of 10 cycles ready (median 4.3s, worst 6.3s). Since stalls come in clusters, that doesn't prove they're gone, and the mitigations
  haven't been seen working during an actual stall.
- **Per-channel offsets aren't applied.** So a data feed or F1 LIVE tile can sit a fraction of a second off the playhead. The sync API gives offsets per channel (0.4s for DATA and TRACKER, 0.08s for F1 LIVE, 0 for
  onboards). F1 OpenViewer fetches them and never uses them. `diff` and `diffV2` have opposite signs on F1 LIVE, so what they mean
  needs confirming by eye first. The sync engine already has an `offsetSec` input for them.
- **No data while behind the join point of a live session.** A capture only has what arrived since the app connected, so watching a
  live race from its start shows nothing until the video catches up with that moment. Nothing displays session data yet.
- **Tall windows waste space.** Tiles are sized without regard to 16:9, so a nearly square window shows large black bars.

## Deferred, by design

- Race-state tools for the agent.
- More charts.
- Finding moments in the commentary. The captions are researched in [CAPTIONS.md](CAPTIONS.md), and the app doesn't use them yet.
- Saved layouts, pop-out windows and translations.
- Updates for the pacman package, through the AUR ([issue 181](https://github.com/natheihei/oh-my-f1-viewer/issues/181)).
