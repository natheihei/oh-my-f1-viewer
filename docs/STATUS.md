# Status

What has actually been verified, and what hasn't. Last updated 2026-11-08.

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
- The agent refusing to skip forward or name a winner when asked directly.
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

## Verified for session data

The SQLite session data ([SESSION_DATA.md](SESSION_DATA.md)), on the real archive through the real app:

- Ingesting a whole race in about 7 seconds, then skipping that on the next open.
- Its tables matching OpenF1 row for row, on the same clock. Telemetry was sampled, and 7 of 22 `starting_grid` positions differ, where OpenF1's copy looks older than the page.
- Opening through the host: results hidden at the start of a replay, reads following the playhead, and direct table reads refused.

Live capture has only run in unit tests. See "Not verified".

## Not verified

- Capturing a live session into the database, and the extra feeds it subscribes to. Check at the next live session.

- **How accurately live data lines up with the picture.** Rows are hidden until the video's wall clock reaches their arrival time.
  On replays with a wall clock it ran about 15s ahead of lights out, so if live behaves the same, data would be up to 15s early. Nothing
  on screen shows it yet, and checking needs a lights-out or lap change to compare against.
- **The world feed on a live race.** It's now requested with no `channelId`, as F1 TV's play link says, and the license request is built
  from that. Only replays have run this way, and none of the sampled replays use DRM. Check it on the next live session.
- **Rewinding live data.** Unit-tested, but it hasn't run on a live session. `scripts/live-check.mjs` now covers it, and that script's new data checks haven't run either.
- **The countdown starting a session by itself.** The display is verified, and a unit test covers firing only for its own session and not
  another in the same event. A real run hasn't reached its start time yet. `scripts/countdown-check.mjs` does this on a session due soon.

## Known issues

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

- Race-state tools and forward seek for the agent, which wait on spoiler approval.
- Charts and agent-created dynamic views. How pitwall.info draws its charts is researched in [PITWALL.md](PITWALL.md).
- Finding moments in the commentary. The captions are researched in [CAPTIONS.md](CAPTIONS.md), and the app doesn't use them yet.
- Windows and macOS, including the VMP signing they need.
- Saved layouts, pop-out windows, translations and auto-update.
