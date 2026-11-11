# Status

What has actually been verified, and what hasn't. Last updated 2026-11-09.

## Verified on real sessions

On Linux with an RTX 4080, against real F1 TV streams and the real agent:

- The full journey: blank start, sign-ins, clarifying "2026 Brazil", loading "2025 Mexico", adding Hamilton and a Norris/Leclerc
  group, then closing the group. That was before groups were taken out of the agent's tools.
- Four streams in sync, with the widest spread seen once settled under 0.07s, on the 2024 Mexico, 2025 Saudi Arabia, 2025 Mexico and 2026 Mexico races. None of these replays use DRM.
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

Three fresh conversations per request, against the real agent at medium reasoning, with the event list in its prompt:

- "2026" and "2025" alone: asked which event every time. At low reasoning it picked the weekend nearest today's date, São Paulo, in most
  runs, with either wording of the prompt.
- "2025 Mexico": asked which session every time.

## Verified for session data

The SQLite session data ([SESSION_DATA.md](SESSION_DATA.md)), on the real archive through the real app:

- Ingesting a whole race in about 7 seconds, then skipping that on the next open.
- Its tables matching OpenF1 row for row, on the same clock. Telemetry was sampled, and 7 of 22 `starting_grid` positions differ, where OpenF1's copy looks older than the page.
- Opening through the host: results hidden at the start of a replay, reads following the playhead, and direct table reads refused.
- Retired cars on the 2026 United States race (session 11396), with `scripts/charts-check.mjs` (2026-11-09): at laps 20, 30 and 53 the timing
  tower marked the same cars `OUT` as the broadcast's tower, and the track map, pace and pit window left them out.

Live capture has only run in unit tests. See "Not verified".

## Verified for mods

On Linux, in the real app, over replay races (2026-11-09):

- A mod's life, with `scripts/mods-check.mjs` on the 2026 United States race at lap 25: a new folder loaded and drew, a save while
  playing replaced the tile's drawing while the session, tile and clock carried on, a broken save kept the last good version and wrote
  `mod.error` with the file and line, a mod that threw showed the error in its tile with the rest of the app still playing and its
  console and error in `mod.log`, a fixed save drew again, and deleting the folder took the tile off.
- The production build loading a mod under its content security policy, with no errors.
- The example mod and the one in MODS.md type-checking with `tsc -p` against the written `tsconfig.json`.

## Verified for agent setup

In the real app on a fresh profile (2026-11-11): `/settings-agent` listed OpenAI and Anthropic, an Anthropic key typed into the key
window connected it with Claude Sonnet 5.5 at medium, choosing Claude Haiku 5.5 at high saved both, closing printed the model line,
OpenAI showed the switch note while Anthropic was connected, and Remove left the agent needing setup again. The key was fake, so no
request was sent.

GPT-6.1 Terra at medium on a ChatGPT plan, the recommended OpenAI model, on the real profile (2026-11-11): "2025 mexico city grand prix
race" called `list_sessions` then `load_session` and opened the race in 8.3s, and "Hamilton" suggested his onboard with `suggest_tiles` in
4.1s. The stored session shows every reply came from `gpt-6.1-terra`.

## Not verified

- **The agent on an API key, or on Anthropic.** No real turn has run on an OpenAI or Anthropic key. Connecting through an OpenAI key or a
  ChatGPT sign-in from the panel hasn't run either: the ChatGPT flow is the same pi call as before, now started from the panel.

- **Mods on macOS and Windows,** and the app's own agent putting a mod on screen. `scripts/mods-check.mjs` adds it through the host.

- **The agent using `suggest_tiles`.** The strip, keys, drag and drop, and Esc are covered by `scripts/suggestions-check.mjs` in the real
  app. On the 2025 Mexico City race, a previewed onboard played muted in the strip, and adding it handed the same `<video>` to its tile,
  still playing and ready, with the audio left on the main feed. The real agent hasn't been asked for a stream since it lost `add_streams`.

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
- **Groups aren't offered** to the agent or the mouse for now. The layout model still supports them, and mouse edits inside them are
  only lightly tested.
- **No data while behind the join point of a live session.** A capture only has what arrived since the app connected, so watching a
  live race from its start shows nothing until the video catches up with that moment. Nothing displays session data yet.
- **Tall windows waste space.** Tiles are sized without regard to 16:9, so a nearly square window shows large black bars.

## Deferred, by design

- Race-state tools for the agent.
- Charts and agent-created dynamic views. How pitwall.info draws its charts is researched in [PITWALL.md](PITWALL.md).
- Finding moments in the commentary. The captions are researched in [CAPTIONS.md](CAPTIONS.md), and the app doesn't use them yet.
- Windows and macOS, including the VMP signing they need.
- Saved layouts, pop-out windows, translations and auto-update.
