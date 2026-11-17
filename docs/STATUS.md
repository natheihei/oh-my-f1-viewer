# Status

What has actually been verified, and what hasn't. Last updated 2026-11-16.

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

Live capture has only run in unit tests. See "Not verified".

## Verified for layout

On Linux, in the real app at 1600 by 900, over the 2026 São Paulo race replay (2026-11-12):

- Each of the 14 charts alone at its declared least size drew in full, except field pace, which was compact at 267 wide and had its
  least width raised to 300. The other least sizes were adjusted from what those captures showed.
- Auto-layout over arrangements from a video with the timing tower to six tiles, three videos, and charts with no video: the
  main feed took the main place, the tower sat beside it, wide charts went below, and no chart was below its least size.

`src/components/charts/charts.test.ts` runs the built-in charts through nine arrangements at that window size on every test run.
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
with both steps done and "Open a session" open. No sign-in was completed from onboarding or a fix block.

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

## Not verified

- **The window icon.** Hyprland shows none, so it hasn't been seen.
- **Fixing a sign-in from onboarding or a fix block.** Neither has completed an F1 TV or ChatGPT sign-in in the real app, F1 TV
  ending a sign-in hasn't been seen, and no turn has failed for a rejected connection or a usage limit, so sending the message again
  after the fix hasn't run.

- **The agent on an API key, or on Anthropic.** No real turn has run on an OpenAI or Anthropic key. Connecting through an OpenAI key from
  the panel hasn't run either. A ChatGPT sign-in from the panel has (above).

- **Mods on macOS and Windows,** and the app's own agent putting a mod on screen. `scripts/mods-check.mjs` adds it through the host.

- **Build mode on a live session, on macOS or Windows, or in the production build.** `look_at` records the window, which hasn't been
  tried with DRM video on screen.
- **A build that runs long enough to compact.** The build conversation isn't collapsed, so nothing depends on it, but it hasn't run.
- **Dragging a draft from the strip onto the grid.** Enter and the host's add are checked. The drag is the same code as any suggestion's.
- **Resizing a draft's preview in the strip.** Resizing a suggestion is checked by `scripts/suggestions-check.mjs`. A draft uses the same
  grips, which sit above its content.

- **The agent using `suggest_tiles`.** The strip, keys, drag and drop, resizing a preview, and Esc are covered by `scripts/suggestions-check.mjs` in the real
  app. On the 2025 Mexico City race, a previewed onboard played muted in the strip, and adding it handed the same `<video>` to its tile,
  still playing and ready, with the audio left on the main feed. That was before each holder got its own video (2026-11-15): the handoff
  is now a new holder taking over a video let go in the same render, covered by unit tests, and not yet run in the real strip. The real agent hasn't been asked for a stream since it lost `add_streams`.

- Capturing a live session into the database, and the extra feeds it subscribes to. Check at the next live session.

- **How accurately live data lines up with the picture.** Rows are hidden until the video's wall clock reaches their arrival time.
  On replays with a wall clock it ran about 15s ahead of lights out, so if live behaves the same, data would be up to 15s early. Nothing
  on screen shows it yet, and checking needs a lights-out or lap change to compare against.
- **The world feed on a live race.** It's now requested with no `channelId`, as F1 TV's play link says, and the license request is built
  from that. Only replays have run this way, and none of the sampled replays use DRM. Check it on the next live session.
- **The agent seeking to a moment on a live session, or a replay placed by the wall clock.** `scripts/seek-check.mjs` has only run on a replay
  with curated sync data. The other two paths are unit-tested.
- **Rewinding live data.** Unit-tested, but it hasn't run on a live session. `scripts/live-check.mjs` now covers it, and that script's new data checks haven't run either.
- **The countdown starting a session by itself.** The display is verified, and a unit test covers firing only for its own session and not
  another in the same event. A real run hasn't reached its start time yet. `scripts/countdown-check.mjs` does this on a session due soon.

## Known issues

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
- More charts. How pitwall.info draws its charts is researched in [PITWALL.md](PITWALL.md).
- Finding moments in the commentary. The captions are researched in [CAPTIONS.md](CAPTIONS.md), and the app doesn't use them yet.
- Windows and macOS, including the VMP signing they need.
- Saved layouts, pop-out windows, translations and auto-update.
