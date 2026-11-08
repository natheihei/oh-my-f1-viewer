# Status

What has actually been verified, and what hasn't. Last updated 2026-11-08.

## Verified on real sessions

On Linux with an RTX 4080, against real F1 TV streams and the real agent:

- The full journey: blank start, sign-ins, clarifying "2026 Brazil", loading "2025 Mexico", adding Hamilton and a Norris/Leclerc
  group, then closing the group.
- Four streams in sync, with the widest spread seen once settled under 0.07s, on the 2024 Mexico, 2025 Saudi Arabia, 2025 Mexico and 2026 Mexico races. None of these replays use DRM.
- Pause, timeline seek, keyboard controls, and closing the main feed while the clock keeps running.
- Timing lining up with video at lights out on the 2026 Mexico, 2024 Mexico and 2025 Saudi Arabia races.
- The agent refusing to skip forward or name a winner when asked directly.
- The production build, including its content security policy.
- The countdown displaying and ticking. Its automatic start hasn't run: see below.

## Verified on a live race

On the 2026 São Paulo Grand Prix, opened through the agent:

- Widevine DRM: all four streams encrypted, with licenses returning 200 through the proxy.
- Joining 8-10s behind the live edge, with four streams at 0.04s spread.
- A three-minute DVR seek, returning to live, and pause and resume. Right after returning to live, streams were still settling, at 0.59s
  spread 12s later and being corrected.
- Live timing reaching the app and being held back: about 680 records held, against about 660 expected for 50s of video lag.

## Not verified

- **How accurately live timing lines up with the picture.** Records are held until the video's wall clock reaches their arrival time.
  On replays with a wall clock it ran about 15s ahead of lights out, so if live behaves the same, timing would be up to 15s early. Nothing
  on screen shows timing yet, and checking needs a lights-out or lap change to compare against.
- **Rewinding live timing.** Unit-tested and exercised during the DVR seek, but its result wasn't compared with the picture.
- **The countdown starting a session by itself.** The display is verified, but the race had already started when this was tested.

## Known issues

- **Intermittent CDN stalls.** Sometimes requests to `ott-video-fer-cf.formula1.com` get no response for 10s or more, in clusters
  lasting minutes, and adding streams stops everything. While it happens the app's side is healthy: request hooks take about 1ms
  and the main process isn't blocked. HTTP/2 and QUIC were tested and aren't the cause. It was heaviest after starting many
  sessions in quick succession, which suggests CDN throttling, but that isn't proven. Three mitigations are in: streams start one at a
  time, wait out a hang (20s stall limit, 6 attempts), and re-resolve as a last resort. After them, `scripts/stream-soak.mjs` got 10
  of 10 cycles ready (median 4.3s, worst 6.3s). Since stalls come in clusters, that doesn't prove they're gone, and the mitigations
  haven't been seen working during an actual stall.
- **Per-channel offsets aren't applied.** The sync API gives offsets per channel (0.4s for DATA and TRACKER, 0.08s for F1 LIVE, 0 for
  onboards). F1 OpenViewer fetches them and never uses them. `diff` and `diffV2` have opposite signs on F1 LIVE, so what they mean
  needs confirming by eye first. The sync engine already has an `offsetSec` input for them.
- **Mouse edits inside groups** are only lightly tested. Dragging a tile between a group and the top level isn't supported: ask the
  agent instead.
- **No upcoming sessions during a live session, on a fresh install.** OpenF1 closes its free API while any session is live, so the agent
  says the schedule is unavailable. A copy saved from any earlier successful request is used instead when there is one.
- **Tall windows waste space.** Tiles are sized without regard to 16:9, so a nearly square window shows large black bars.

## Deferred, by design

- Race-state tools and forward seek for the agent, which wait on spoiler approval.
- Charts and agent-created dynamic views.
- Windows and macOS, including the VMP signing they need.
- Saved layouts, pop-out windows, translations and auto-update.
