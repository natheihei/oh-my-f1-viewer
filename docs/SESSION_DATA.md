# Session data

Everything about a session from 2023 onward, in a local SQLite database, read through the host. It follows
[OpenF1](https://openf1.org/docs)'s schema and logic, and OpenF1 is what it's checked against. Older seasons report `unsupported`.

**A database holding a whole race contains the result.** Consumers reach it as of the playhead unless they ask for the whole session by name
(`asOf: 'session'`), and nothing up there can write to it. The agent asks the spoiler gate before it does.

## What's exposed, and how

| Data | Exposed as | Filled |
| --- | --- | --- |
| Meetings, sessions | `useLive((s) => s.schedule)` | On every app start and sign-in. The last copy stays readable until then, or if that fails |
| Drivers | `useLive((s) => s.sessionData)` | When a session opens |
| Lap count | `useLive((s) => s.sessionData.lapCount)` | When a session opens |
| Circuit: outline, corners, pit loss | `useLive((s) => s.circuit)` | Each time a session opens, from MultiViewer. The last copy stays readable, with a `reason`, if that fails |
| `car_data`, `championship_drivers`, `championship_teams`, `drivers`, `intervals`, `lap_summary`, `laps`, `location`, `overtakes`, `pit`, `pit_lane`, `position`, `race_control`, `session_result`, `starting_grid`, `stints`, `track_status`, `weather` | `host.data.sql({ sql, params })`, `useSql(sql, params)` | When a session opens. A live session gets whatever is captured. `drivers` is also in `sessionData` |

Names match OpenF1, except that all times are UTC milliseconds, and two tables OpenF1 doesn't have: `track_status` is the first that
doesn't follow its naming, and `lap_summary` is our own (see below). `laps` also has one column of ours, `is_out`. Team radio is left out, on purpose. The calendar comes from F1's season indexes plus F1 TV's
upcoming list, not OpenF1's website API, so it lacks `circuit_type`, images and `is_cancelled`. Upcoming meetings also have no location or circuit
until they've happened.

`useSql` runs again as the playhead moves and as data arrives. Objects are frozen. `sessionData.datasets` says what the database holds and why anything is missing.

## The circuit

The circuit comes from MultiViewer's public API (`api.multiviewer.app/api/v1/circuits/{circuitKey}/{year}`), which needs no
sign-in. The main process fetches it, sending nothing but the circuit's key and the year, and checks the answer's shape before
keeping it: the outline must be there, and a corner or pit loss that doesn't read is left out or null. It's stored in `t_kv` under
`circuit:<key>`. When a session opens, the cached copy is published at once, then the fresh one.

The key is F1's own. The schedule's meeting has it once the meeting has happened; before that, it comes from the live feed's
`SessionInfo` (`Meeting.Circuit.Key`). Until it's known, the circuit is `loading`.

**Units, checked on Austin (session 11396, circuit 9).** The outline is in `location`'s own coordinates, tenths of a metre, with y up:
NOR's lap 20 sat a median 0.5 units (5 cm) from the outline, 1.7 at the 95th percentile and 3.7 at most, on an outline 18,100 by 10,500
units. The outline runs 54,280 units round, 5,428 m against the official 5.513 km, and a car's path round a lap measured 53,954 to 54,237.
Each corner's `distance` is exactly how far along the outline its point is from the outline's first point (all 20 corners matched to the
unit), so it's in tenths of a metre too: the last corner, at 52,753, is 5,275 m from the line. The first point is at the timing line: cars
start their laps there, give or take a few metres. The outline runs anticlockwise with y up, as Austin does, so the y axis isn't flipped.
`rotation` is 0 there, so which way it turns is untested: the charts turn anticlockwise with y up, as FastF1 does with the same field.

## Track status, `pit_lane`, lap count and `lap_summary`

- **`track_status`** (`date`, `status`) comes from F1's `TrackStatus` feed, one row per change. `status` keeps F1's own words: `AllClear`,
  `Yellow`, `SCDeployed`, `VSCDeployed`, `VSCEnding` and `Red`. `date` is when the message was sent, as the feed gives no other time.
- **`pit_lane`** (`driver_number`, `date`, `in_pit`) comes from `TimingData`'s `InPit`, one row each time a car enters the pit lane
  (`true`) or leaves it (`false`). F1 repeats the flag, so only changes are kept. A car is in the pit lane now when its latest row is true,
  which `pit` can't say: a `pit` row carries the time in the lane, so it's only sent once the car is out. A car's first row is where it stood
  when the feed first said, which before practice is often the garage. Not every trip is a stop: before a race's start cars go in and out
  on their laps to the grid, and under a red flag every car waits in the pit lane. In a cached 2025 race with a red flag on lap 34, it gave 20
  stops of 22 to 30 s, every car in the lane for about 20 minutes from lap 34, and 63 trips before the start.
- **`sessionData.lapCount`** comes from `LapCount`, stored as versions. `total` is the scheduled distance, in the feed's first message, so it
  isn't a spoiler. A shortened race shows its new distance only from when the feed said so. Practice and qualifying have no `LapCount`.
- **`lap_summary`** is a view over the other views, not a table, so it only knows what they show at the playhead. One row per driver per lap
  reached: `session_key`, `meeting_key`, `driver_number`, `lap_number`, `date_start`, `date_end`, `lap_duration`, `duration_sector_1` to `3`,
  `position`, `gap_to_leader`, `interval`, `stint_number`, `compound`, `tyre_age`, `is_pit_in_lap`, `is_pit_out_lap`, `track_status` and `is_out`.
  - A lap ends where the driver's next lap starts, or else at its start plus its time. The lap in progress has no `date_end`.
  - `position`, `gap_to_leader` and `interval` are the last values at or before `date_end`, so as the car crossed the line. The lap in
    progress, and a retired car's last lap, get the latest. Gaps can be text such as `+1 LAP`, as in `intervals`.
  - `tyre_age` is the laps on the set by the end of this lap, used ones included. `is_pit_in_lap` is a `pit` row on this lap, since its
    `lap_number` is the in-lap. `is_pit_out_lap` is the lap's own flag, or a stop on the lap before.
  - `track_status` is the worst status during the lap, counting the one it started under: `Red`, then `SCDeployed`, `VSCDeployed`,
    `VSCEnding`, `Yellow`, and `AllClear`. Null when there's no status yet. Lap 1 often has no start: it then runs back from its end by its time.
  - `is_out` is the lap a car retired on, from `laps`. See below.

## Championship

`championship_drivers` and `championship_teams` come from F1's `ChampionshipPrediction` feed, one row per driver or team, stored as versions.
`points_start` and `position_start` are the standings going into the session. `points_current` and `position_current` are F1's projection if
it finished in the current order, so they move as the race goes on, and at the end they're the standings after it. The processor drops the feed
outside races, as other sessions have been seen carrying wrong predictions. Sprints count as races: F1's season indexes give all 22 sprints from 2023
on the type `Race`, and the app maps F1 TV's sprint to `race` too. On sprints 11383 (2026), 9654 (2024) and 9204 (2023), opened in the app
on 2026-11-15, each had a row for every driver, and by the end the 8 that changed had gained 8 points down to 1 between them, as sprint points
go. A table can hold more drivers than the session's roster (23 against 22 on 11383): ones who raced earlier in the season. Each session's
rows are its own: SQL can't read across sessions.

## Retirements

A car is out from when `DriverRaceInfo` says `IsOut`, which marks the lap it's on in `laps` as `is_out`. That's a new version of the
lap, so it shows from the moment the feed said so, mid-lap, and not before: a retired car never finishes its lap, so waiting for its end
wouldn't work. `TimingData`'s `Retired` does the same, for archives without `IsOut`, but on session 11396 it was missing for one of the
three retirements, which only had `Stopped`. `Stopped` doesn't count, as a car can restart. Neither flag was seen to go back to false, in
the three cached races with 11 retirements between them, so once out a car stays out. A live snapshot marks a car already out on the lap
it gives.

On session 11396, the three cars marked are the three the result lists as DNF, each on its last lap, and at laps 20, 30 and 53 the
timing tower showed the same cars out as the broadcast. The charts use only this: `timing_tower` shows them as `OUT` at the bottom,
`track_map` leaves them off, `tyre_deg` names them on one `OUT` line under its grid, and `pit_window` leaves them off the ring.

On session 11396 at the end of the race, through the real worker in the app (`scripts/charts-check.mjs`, median of 5): `SELECT * FROM
lap_summary` took 27ms for 1,166 rows, one driver's laps 6ms, every driver's position and gap per lap 13ms, and everyone's last 5 laps 11ms.
With the timing tower (11ms), five such queries together take about 70ms. So it stays a view.

That needed one change: a versioned table now finds each row's newest version from its key's index, then reads only those rows. Reading every
version took 26ms on that race's 34,000 lap versions, and 7ms now. Before it, the same queries took 37, 24, 29 and 48ms, and the tower 28ms,
measured on the store directly. The tower is also cheaper for it, so it doesn't use `lap_summary`.

## `visible_from`

Each row stores when the feed revealed it, on the same clock as the playhead:

- **Archive:** the clock base plus the message's offset. The replay's playhead uses the same base (`computeFeedBaseUtc`), so the two always agree. It
  matches OpenF1's timestamps exactly: the median difference was 0ms, as were the 5th and 95th percentiles, on 6 sessions.
- **Live:** when the message arrived. The playhead is the video's wall clock less how far it runs ahead of the picture, below.

A row's own `date` can't serve, because a message often reports something earlier than when it was sent.

Telemetry is the exception. `car_data` and `location` are `shownAtDate`: a sample shows once the playhead reaches its own `date`, not its
`visible_from`. The feed sends them in a batch about once a second, each holding the last second's four samples, so gated on `visible_from`
the charts jumped once a second, behind the picture. A sample's `date` is never after the frame on screen, so the viewer is already
watching what it describes. It can show up to 1.9s before the feed sent it.

Rows that change as a session goes on (`laps`, `stints`, `pit`, `drivers`, the championship tables) are stored as versions, and a read takes the newest one the playhead has
reached. So a stint's `lap_end` can't reveal a stop that hasn't happened, and a lap's time doesn't show before it's known. The grid shows from the first message of
a race or sprint, and the result from when the session finalises.

## Completion and caching

Each dataset has its own mark in `t_ingest`, so a failed scrape can't force the timing to be fetched again:

| Dataset | Feeds | Complete when |
| --- | --- | --- |
| `timing` | `TIMING_FEEDS` | Every feed fetched, and the feed reports the session finished or its scheduled end is 3+ days past |
| `results` | formula1.com's result and grid pages | Timing is complete and the result page has rows, or the session has no page |
| `telemetry` | `CarData.z`, `Position.z` | The same as timing |

A complete dataset is skipped when the session opens again. Bump `INGEST_VERSION` when a processor or table changes, and each session is ingested again the next time it opens.
It's 5 since `pit_lane` was added. Changing a table's columns also takes a bump of `SCHEMA_VERSION` in `store.ts`, which drops the stored tables, since they're a cache.

`ArchiveStatus` can't be the test: it reads `Generating` in files that have been final for years. Neither can the feed alone, since some archives never report the end.

## How it's built

- **`electron/timingdb/worker.ts`** owns the database on its own thread, since SQLite and parsing whole archives block. It holds no credentials.
- **`index.ts`** does what needs the network or the token, in the main process.
- **`processors.ts`** turns messages into rows, **`ingest.ts`** fills the database and decides completion, and **`store.ts`** holds the two connections.
- **Consumers' SQL** runs on a read-only connection, against temporary views limited to the session and playhead. An authorizer refuses everything else, including the tables behind them.
  The store makes one view per stored table named in `SQL_TABLES`, from its definition, then each view in `DERIVED_VIEWS` (`schema.ts`), such as `lap_summary`, on top of those.
  Then it asks SQLite for every view and its columns, and that list reaches the renderer as `sessionData.tables`, through the `data:status` message.
  A test checks that it matches `SQL_TABLES`. Adding a derived view takes an entry in `DERIVED_VIEWS`, and its name in `SQL_TABLES` and `DERIVED_TABLES`.

A live capture also keeps its raw messages, because processors hold state in memory. Restarting mid-session rebuilds from them. Opening the session after it has finished replaces the capture
with the archive and drops them.

## Linking to the video

The database knows nothing about video. Three things connect them:

| Link | How | Where |
| --- | --- | --- |
| **Which session** | F1 TV's listing carries F1's own `meetingKey` and `sessionKey`, which are also the archive's and OpenF1's keys | `archiveQuery`, `resolveSessionPath` |
| **Which moment** | The video's position becomes a feed offset, then a UTC playhead, which is compared with `visible_from` | `timeMap.ts` |
| **Which driver** | An onboard feed's `Channel.number` is `driver_number` | No code needed yet: any consumer can join on it |

The moment is the hard one, because neither timeline starts at the race start. The video always plays, and the data waits until the frame
can be placed to within a second or so. MultiViewer's sync API (`api.multiviewer.app/api/v1/meetings/{meeting}/sessions/{session}`) gives two
anchors, some time after the session ends; the main process asks again every 5 minutes while a session is open without them:

- `session_start`: the replay's video second of lights out (or green).
- `session_start_pdt`: the live stream's frame time, its program date time, at that moment.

**A replay** is placed by `session_start`. The feed's `ExtrapolatedClock` shows the offset where the session clock starts, so
`feed offset = video seconds * 1000 + (clock start offset - session_start * 1000)`. Without it, `sessionData` is `waiting`. A replay's video has no
wall clock, and the scheduled start is only good to about a minute, so neither is used.

**Live**, rows are compared by `visible_from`, their arrival time, with the stream's wall clock less how far that runs ahead of the picture.
F1 TV's live video runs tens of seconds behind the feed, so rows wait for it. The lead is `session_start_pdt` less when the feed's `SessionData`
says the session started, or 7.6s (`LIVE_FRAME_LEAD_MS`) until MultiViewer publishes that. A lead outside 3-15s is refused: a race's
`session_start` is lights out, which isn't when its session status says it started.

| Session | Feed start | Frame time at the start | Lead | Source |
| --- | --- | --- | --- | --- |
| Las Vegas FP1 2026 | 00:30:00.102 | 00:30:07.654 | 7.55s | MultiViewer's `session_start_pdt`, after the session |
| Las Vegas FP2 2026 | 03:59:59.977 | 04:00:07.6-08.0 | 7.6-8.0s | The live picture: the Sphere's countdown and F1 TV's graphic reach 0:00 between the frames at +7.55s and +8.5s, and the session clock reads 59:56 at +12s |
| 9 practice and qualifying sessions, 2026 | The scheduled start | `session_start_pdt` | 7.45-7.74s | MultiViewer, assuming each started on time as FP1 and FP2 did |

MultiViewer's `live_timing_sync_delay`, 5.5s for every F1 session and set days ahead, isn't this lead, and isn't used. With no wall clock, or
before the video reaches when the capture began, `sessionData` is `waiting` too.

While it waits, nothing is visible and SQL at the playhead fails with the reason. `asOf: 'session'` still reads. Charts show `reason`, with
`detail` on hover.

All streams share one clock, kept in step by the sync engine, so one playhead serves every tile. The sync API's per-channel offsets (`channelDiffs`) aren't used. The link also runs the other way: `host.playback.seekToDate` turns a row's time into a video position, through
`videoTimeOf` in `timeMap.ts`. A curated replay inverts the map exactly. A live session moves by the difference from the frame on screen. The
agent's `seek_to` uses it. `scripts/seek-check.mjs` checked it on a replay with curated sync data; on Las Vegas FP2 live it landed within 0.5s of the frame asked for, 1 and 5 minutes back.

A session F1 TV lists without keys falls back to matching by name and type, which could find the wrong session. See "Known limits".

## Joining a live session late

There's no backfill: the database holds what was captured. The main process records when the capture began and any gaps, but `sessionData` doesn't show them yet.

Checked at 2026 Las Vegas FP1, joined about 30 minutes in. The snapshot is current state, not a log, except for two feeds:

| Feed | In the snapshot |
| --- | --- |
| `TimingData` | Each car's `NumberOfLaps`, last and best lap, sectors and speeds now. No lap before the current one |
| `TimingAppData` | Each car's whole stint list from the start |
| `RaceControlMessages` | Every message from before the session started |
| `PitLaneTimeCollection` | Only cars in the pit lane now |
| `LapCount` | Not sent in practice |

So the database starts with one lap per car that has set one, and stints and race control complete. It was a wet session in which 9 cars had set one
lap each, so it couldn't show a lap-based chart starting late. A race would. The raw `Subscribe` response is saved by a probe that isn't checked in.

## How it was checked

`scripts/openf1-compare.mjs` compares against OpenF1's API, reporting counts only. `scripts/data-check.mjs` runs the real app against the real archive and through a real opened session, muted, at its start.

| Table | Result, session 11396 |
| --- | --- |
| `laps`, `stints`, `pit`, `pit_lane`, `position`, `race_control`, `weather`, `overtakes`, `intervals`, `drivers`, championship, `session_result` | Same rows and values (`intervals`: 24,227 rows) |
| `laps.is_pit_out_lap` | The same 32 out laps. It wasn't compared before, and every car's lap 1 was wrongly marked until `INGEST_VERSION` 3 |
| `lap_summary` | For 5 drivers, every lap's end, position, gaps and pit-in flag agree with a recount from the raw tables. Each completed lap has positions 1 to 22 once. The last lap's order matches the published result for all 19 classified cars |
| `car_data`, `location` | Same rows and values, in a 1-minute sample for one car |
| `sessions`, `meetings` | All 123 of 2025's sessions present, with one meeting and one session's fields compared |
| `starting_grid` | 7 of 22 differ. The page we read is still the one OpenF1 scrapes, so its copy looks older |

On 4 older races with fewer feeds cached, `laps`, `stints`, `position`, `race_control` and `weather` matched too, as did `drivers` on the 3 of them the API's rate limit allowed. On those races, lap 1's
duration and first sector were 1ms apart: a rounding difference, not an error. The cut-short archive below is the exception.

That race took about 7 seconds to ingest in full, with 1.5 million telemetry rows, into a 69 MB database. Chart-sized queries took 2-30ms.

## Known limits

- **Live is checked on a practice session only.** At 2026 Las Vegas FP1 (session 11413, wet, joined about 30 minutes in), Subscribe returned no error
  and the capture reached `ready` from `live`. `SessionInfo`, `DriverList`, `TimingData`, `TimingAppData`, `RaceControlMessages`, `SessionData`,
  `PitLaneTimeCollection`, `WeatherData`, `TrackStatus` and `ExtrapolatedClock` came in the snapshot. `DriverRaceInfo`, `PitStop`,
  `PitStopSeries`, `ChampionshipPrediction` and `LapCount` never came, in the snapshot or in 4 minutes of updates, and look race-only. `laps`, `stints`,
  `pit_lane`, `position`, `race_control`, `weather` and `drivers` filled; `intervals` and `pit` stayed empty, as in any practice. A race is still needed
  for lap counts, pit stops and intervals. Restarting the app mid-session rebuilt the tables from the kept messages and, since this check, records the
  time it was closed in `coverage.gaps`.
- **Live data is placed by a measured lead until MultiViewer publishes the session's own.** The video's wall clock (`getPlayheadTimeAsDate`) runs
  7.6-8.0s ahead of the picture (see "Linking to the video"), and the playhead takes 7.6s off it. MultiViewer's exact lead hadn't been published
  5 minutes into FP2, and FP1's was there an hour after it ended, so live it's usually the default.
- **A replay waits for MultiViewer.** Its data stays hidden until MultiViewer publishes `session_start`, about an hour after FP1 ended at Las Vegas.
  FP2's still wasn't there an hour after it ended. A session it never publishes for has no data on screen, only through `asOf: 'session'`.
- **A replay waits for F1's archive too.** F1 lists a session in its season index before it publishes the files, with no `Path`: FP2 was listed
  that way an hour after it ended. The data is then `failed` with "F1 hasn't published this session's timing yet. It's checked again every 5
  minutes.", and the main process looks again every 5 minutes while the session is open (`archiveMissing` in `electron/timingdb/archive.ts`).
  A session not in the index at all is looked for again too. Still without a path 3 days after its scheduled end, it has nothing, for good.
- **A session watched live isn't used for its replay.** Opened as a replay, a session goes to the archive even when this profile captured it
  live. Before the archive is published, the capture is left as it is but not shown. Using it would take placing the replay's video on the
  capture's clock, which isn't built.
- **Joining live shows no data for the video's lag.** Every row from the snapshot is stamped with when it arrived, so for the first 40 to 45 seconds,
  how far the video runs behind the feed, nothing is visible. Charts say "Waiting for the video to reach the live data", and the hover says how long.
- **Live telemetry needs the F1 TV sign-in.** Checked live at 2026 Las Vegas FP1: without the token, Subscribe leaves `CarData.z` and `Position.z` out of
  its result with no error, and only the timing feeds come. With `Authorization: Bearer <token>` on the negotiate requests and the socket, both come in the
  snapshot and then about once a second, for all 22 cars. The capture now sends the token when signed in and subscribes to both, so `car_data` and
  `location` fill live and the telemetry dataset is `partial` from `live`. Signed out, it stays absent. The live rows weren't yet compared with the
  archive. A `track_map` drew the cars on that session, matching the broadcast's own map, so the four telemetry charts (`track_map`,
  `car_telemetry`, `speed_ribbon`, `pedal_barcode`) are no longer `replayOnly`.
- **Some archives are cut short.** F1's archive of the 2026 Mexico race (session 11404) ends about 2.2 hours in and never reports a finish, where OpenF1 has more rows from recording it live. A fresh
  download on 2026-11-09 was byte-identical to the cached copy in all 15 feeds checked, so this is F1's file and not a stale cache. It's still marked complete after 3 days, with nothing in `datasets` to say it's short.
  A scan of all 417 indexed sessions from 2023 to 2026 on 2026-11-09 found no others without a finish status, and 102 of 103 races agreed with OpenF1 on their last lap. It didn't look for holes mid-session.
- **48 sessions from early 2024 have no session data.** F1's season index leaves out the first nine rounds and pre-season testing, though all 48 archives exist and report a finish. So they aren't in the
  calendar, and from reading the code, looking one up by key finds nothing; opening one wasn't tried. OpenF1 hardcodes their paths in `MISSING_SESSIONS`, and a small table of them would fix it. Left as is for now, by choice. A further
  15 sessions missing from the index are ones OpenF1 marks as cancelled, which is correct.
- **The archive always replaces a live capture.** For a session like that one, a good capture would be swapped for a shorter archive.
- **Disk isn't managed.** About 70 MB per race adds up, and nothing removes old sessions.
- **No query timeout.** The agent now has SQL (`query_session`), and a runaway query would still block the worker, which runs SQLite
  synchronously. The timeout is still missing.
- **A session with no keys could get another session's data.** The lookup then searches by name and type from the newest meeting back. How often F1 TV omits keys wasn't measured.
- **The circuit is third-party and unofficial.** MultiViewer returns data dated 2021 whatever year is asked for, so a rebuilt
  pit lane or a circuit added since may be wrong or missing. An archive session whose meeting isn't in the schedule never learns
  its key, so its circuit stays `loading`.
- **Telemetry is coarse.** `car_data` comes about 3.7 times a second and `location` 3.9, at irregular intervals (median 0.26 s, up to
  1.4 s apart). All cars share each sample's `date`. The feed sends them 0 to 1.9 s after their `date` (median 0.4 s), in a batch about once a second,
  and they're shown at their `date` (see `visible_from`, above). At
  300 km/h a sample is every 20 m or so, so braking points are approximate.
- **`laps.date_start` isn't exactly the line.** By each car's positions, it comes 0.34 s after the car crosses the outline's first point
  (median over 4 drivers' laps 3 to 45), give or take 0.1 to 0.2 s from lap to lap, and once 1.35 s. A chart that needs a lap's ends exactly should
  find them from the positions instead.
- **`car_data.drs` isn't DRS in 2026.** It's null throughout session 11396, and session 11404 has codes such as 17, 49 and 151 that aren't
  DRS's (2026's cars have no DRS). 2025's session 9877 has the usual 0 to 14. `car_telemetry` shows DRS only when every code in its minute
  is one of DRS's own.
- **Odd values when stopped.** `brake` is 0 or 100, and 104 (nearly always with `throttle` 104) 47,595 times in session 11396, 46,565 of
  them at 0 km/h. Charts cap both at 100. `location` is exactly (0, 0) before a car first leaves the garage. A retired car keeps
  reporting where it stopped, or the garage, so `track_map` leaves out cars marked `is_out`.
- **Dropped with `useTiming`.** Track status, lap count, the session clock, `bestLap`, and the fastest-sector and new-tyre flags aren't exposed anywhere now. Nothing used them. `inPit` and `pitOut` came back as `pit_lane` and `laps.is_pit_out_lap`.
