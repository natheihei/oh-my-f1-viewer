# How pitwall.info draws its charts

Research for materializing timing into a local database, the direction agreed on 2026-11-08. pitwall.info is the reference for charts that
update as the stream proceeds and still reach back to lap 1. The app doesn't use any of this yet. Read on 2026-11-08 from the site's bundle
(`index-CUqdQXVV.js`, `player.worker-CNavSnjs.js`) and by running the 2026 São Paulo race as a replay.

**No session was live**, so `/api/live/status` said `idle`. The replay behaviour was observed. The live path comes from reading the client
code, and the server is out of view. Minified names such as `ZR` belong to this build and will change when the site redeploys.

## Stack

| Layer | What they use |
| --- | --- |
| UI | React, one 1.2 MB bundle with hashed asset names (looks like Vite) |
| Charts | Hand-written Canvas 2D: no uPlot, D3, ECharts, Recharts or Plotly. 94 canvases on the Race page |
| Off the main thread | A `SharedWorker`, falling back to a `Worker`, fetches data and rebuilds state |
| Several tabs | `navigator.locks` picks a leader that holds the socket, and `BroadcastChannel` shares its feed with the others |
| Hosting | Behind Cloudflare, with sign-in by Discord, Google or email |
| Weather | RainViewer, NOAA, EUMETSAT, NASA GIBS |

No WASM, DuckDB, SQLite or Parquet appears in the bundle. All state is plain JavaScript objects.

## Where the data comes from

```
OpenF1 MQTT -> Pitwall relay -> wss://<host>/live/signalrcore -> browser
```

The browser never calls OpenF1: `openf1.org` appears in the bundle only as a credit link.

- `/live/status` reports `source: "openf1"` and `mqtt: "connected"`.
- The client speaks F1's SignalR format, including `Position.z` and `CarData.z`.
- That the relay translates OpenF1 into SignalR is an inference from those two facts.
- The bundle's default URL is still `wss://livetiming.formula1.com/signalrcore`, so the same client can read a relay, a recording or F1's own
  feed. `?liveurl=` accepts a local `ws:` server, and `?livesim` runs a simulated session.

Baked replays are served from `/v2/data/s/<session id>/`, for example `2026/sao-paulo/race`. Their manifest says `dataSource: "openf1"`.

| File | Contents |
| --- | --- |
| `manifest.json` | Drivers, lap start times, track status, segment and keyframe lists |
| `laps.json` | The lap table, about 800 KB for a race |
| `track.json`, `radio.json` | Circuit and team radio |
| `kf/<n>.json` | Full state every 60s |
| `seg/<n>.json` | State changes and position samples: 10s per segment when baked, 2s by default live |

## Reaching back to lap 1

1. **Catch up.** The client fetches `/live/hist/<session key>/index.json`, then its numbered `.txt` chunks, four at a time. The chunks are
   recorded SignalR frames, and they go through the same `handleFeed()` as live messages. This path 404s once a session has ended.
2. **Join.** It subscribes with `{history: {since: liveFrom}}`, or `{history: true}` when there are no chunks. Reconnects ask for `since` too,
   and a gap that can't be filled is recorded in `manifest.liveGaps`. This argument looks like the relay's own extension.
3. **Store.** Messages become 2-second segments and 60-second keyframes (`bC`), in the same format as a baked replay.
4. **Derive.** For each new segment, `kickBuild()` replays its snapshots into a deriver (`aC`), which adds one row per driver per lap, then
   publishes the result as `player.laps`. Lap and sector times are filled into a row slightly after the lap ends.
5. **Draw.** Each panel receives `onSnapshot`, filters to rows at or before the playhead (`Ut`), skips the redraw if nothing changed, and
   otherwise redraws in full.

A lap row holds `lap`, `tEnd`, `position`, `lap_time`, `s1`-`s3`, `in_pit`, `pit_out`, `pit_related`, `sc`, `compound`, `tyre_new`, `tyre_age`,
`stint`, `gap_ahead`, `gap_trend`, `top_speed`, `throttle95`, `baseline`, `lamp`, `sf_pct`, `pedal`, `traffic` and `traffic_ratio`.

Replays use the same panels and the same row shape, but load `laps.json` instead of deriving it. The whole race is in memory, and only the
playhead filter keeps later laps off the chart. In the replay, the x-axis spanned all laps from the start while the lines grew.

## Race Trace

The panel (`ZR`) is about 60 lines once minified:

```js
leaderEnd[lap] = min(tEnd of every driver on that lap)
gap = (driver.tEnd - leaderEnd[lap]) / 1000
```

- **Redraw check:** the cache key is `rowCount:selectionA:selectionB:WxH`, so a chart costs nothing until a lap completes.
- **Axes:** x runs from lap 1 to `totalLaps`. y runs from the leader to a rounded maximum, and drivers beyond it get a `↓` label.
- **Marks:** safety car laps are passed to the axis helper from the row's `sc` flag, and selected drivers are drawn last and thicker.

Gap Evolution (`JR`) reads the same table in the same way. The other lap-based panels, such as the Position Chart, weren't read but appear to
as well. Panels share one interface: `mount`, `onSnapshot`, `onFrame`, `onSeek`, `onResize`, `setVisible`, `dispose`.

## What this means for the app

- **The log is the hard part, not the chart.** Our feed subscribes with `Subscribe [feeds]` (`electron/vendor/f1ov/liveConnection.js`), which
  returns a snapshot. As far as we know that is current state and not a log, so a client that joins mid-race has no lap 1. This hasn't been
  tested against our feed.
- **Filling that gap.** Recording from app launch misses anything before it opened. Backfilling needs OpenF1 or another archive. OpenF1's
  real-time access is believed to be a paid tier, so check its current terms.
- **The design maps onto SQLite.** The deriver becomes a `laps` table filled incrementally, and `tEnd <= playhead` becomes the view that
  protects spoilers. The cache key's row count becomes the cheap check for when a chart re-queries.
- **Their spoiler boundary is weaker than ours needs to be.** They hold the whole race in page memory, and that is safe only because a human
  looks at the chart. The agent can query, so the limit has to be in the views.
- **Canvas needs no chart library.** The shared axis, line and label helpers are small, and each panel fits the mod shape in `DESIGN.md`.

## Still unknown

- The relay's live path: its chunk contents and how late its messages arrive. Our own socket was captured at 2026 Las Vegas FP1: see
  [SESSION_DATA.md](SESSION_DATA.md).
- What the relay does to OpenF1's data, and whether its `.z` topics are F1's own or rebuilt.
- What F1's `Subscribe` returns for a client joining mid-race. At a practice it was current state except stints and race control, which hold the
  whole session: see "Joining a live session late" in [SESSION_DATA.md](SESSION_DATA.md). A race should confirm it with lap counts and pits.
