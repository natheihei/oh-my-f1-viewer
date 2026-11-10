# Session data

Everything about a session from 2023 onward, in a local SQLite database, read through the host. It follows
[OpenF1](https://openf1.org/docs)'s schema and logic, and OpenF1 is what it's checked against. Older seasons report `unsupported`.

**A database holding a whole race contains the result.** Consumers reach it as of the playhead unless they ask for the whole session by name
(`asOf: 'session'`), and nothing up there can write to it. The agent asks the spoiler gate before it does.

## What's exposed, and how

| Data | Exposed as | Filled |
| --- | --- | --- |
| Meetings, sessions | `useLive((s) => s.schedule)` | On every app start and sign-in. The last copy stays readable until then, or if that fails |
| Drivers, championship, starting grid, session result | `useLive((s) => s.sessionData)` | When a session opens |
| Lap count | `useLive((s) => s.sessionData.lapCount)` | When a session opens |
| Circuit: outline, corners, pit loss | `useLive((s) => s.circuit)` | Each time a session opens, from MultiViewer. The last copy stays readable, with a `reason`, if that fails |
| `car_data`, `intervals`, `lap_summary`, `laps`, `location`, `overtakes`, `pit`, `position`, `race_control`, `stints`, `track_status`, `weather` | `host.data.sql({ sql, params })`, `useSql(sql, params)` | When a session opens. A live session gets whatever is captured |

Names match OpenF1, except that all times are UTC milliseconds, and two tables OpenF1 doesn't have: `track_status` is the first that
doesn't follow its naming, and `lap_summary` is our own (see below). Team radio is left out, on purpose. The calendar comes from F1's season indexes plus F1 TV's
upcoming list, not OpenF1's website API, so it lacks `circuit_type`, images and `is_cancelled`. Upcoming meetings also have no location or circuit
until they've happened.

`useSql` runs again as the playhead moves and as data arrives. Objects are frozen. `sessionData.coverage` says what the database holds and why anything is missing.

## The circuit

The circuit comes from MultiViewer's public API (`api.multiviewer.app/api/v1/circuits/{circuitKey}/{year}`), which needs no
sign-in. The main process fetches it, sending nothing but the circuit's key and the year, and checks the answer's shape before
keeping it: the outline must be there, and a corner or pit loss that doesn't read is left out or null. It's stored in `t_kv` under
`circuit:<key>`. When a session opens, the cached copy is published at once, then the fresh one.

The key is F1's own. The schedule's meeting has it once the meeting has happened; before that, it comes from the live feed's
`SessionInfo` (`Meeting.Circuit.Key`). Until it's known, the circuit is `loading`.

## Track status, lap count and `lap_summary`

- **`track_status`** (`date`, `status`) comes from F1's `TrackStatus` feed, one row per change. `status` keeps F1's own words: `AllClear`,
  `Yellow`, `SCDeployed`, `VSCDeployed`, `VSCEnding` and `Red`. `date` is when the message was sent, as the feed gives no other time.
- **`sessionData.lapCount`** comes from `LapCount`, stored as versions. `total` is the scheduled distance, in the feed's first message, so it
  isn't a spoiler. A shortened race shows its new distance only from when the feed said so. Practice and qualifying have no `LapCount`.
- **`lap_summary`** is a view over the other views, not a table, so it only knows what they show at the playhead. One row per driver per lap
  reached: `session_key`, `meeting_key`, `driver_number`, `lap_number`, `date_start`, `date_end`, `lap_duration`, `duration_sector_1` to `3`,
  `position`, `gap_to_leader`, `interval`, `stint_number`, `compound`, `tyre_age`, `is_pit_in_lap`, `is_pit_out_lap` and `track_status`.
  - A lap ends where the driver's next lap starts, or else at its start plus its time. The lap in progress has no `date_end`.
  - `position`, `gap_to_leader` and `interval` are the last values at or before `date_end`, so as the car crossed the line. The lap in
    progress, and a retired car's last lap, get the latest. Gaps can be text such as `+1 LAP`, as in `intervals`.
  - `tyre_age` is the laps on the set by the end of this lap, used ones included. `is_pit_in_lap` is a `pit` row on this lap, since its
    `lap_number` is the in-lap. `is_pit_out_lap` is the lap's own flag, or a stop on the lap before.
  - `track_status` is the worst status during the lap, counting the one it started under: `Red`, then `SCDeployed`, `VSCDeployed`,
    `VSCEnding`, `Yellow`, and `AllClear`. Null when there's no status yet. Lap 1 often has no start: it then runs back from its end by its time.

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
- **Live:** when the message arrived. The playhead is the video's wall clock.

A row's own `date` can't serve, because a message often reports something earlier than when it was sent.

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
It's 3 since `TrackStatus` and `LapCount` were added, and `PitOut: false` stopped marking every car's first lap as an out lap.

`ArchiveStatus` can't be the test: it reads `Generating` in files that have been final for years. Neither can the feed alone, since some archives never report the end.

## How it's built

- **`electron/timingdb/worker.ts`** owns the database on its own thread, since SQLite and parsing whole archives block. It holds no credentials.
- **`index.ts`** does what needs the network or the token, in the main process.
- **`processors.ts`** turns messages into rows, **`ingest.ts`** fills the database and decides completion, and **`store.ts`** holds the two connections.
- **Consumers' SQL** runs on a read-only connection, against temporary views limited to the session and playhead. An authorizer refuses everything else, including the tables behind them.

A live capture also keeps its raw messages, because processors hold state in memory. Restarting mid-session rebuilds from them. Opening the session after it has finished replaces the capture
with the archive and drops them.

## Linking to the video

The database knows nothing about video. Three things connect them:

| Link | How | Where |
| --- | --- | --- |
| **Which session** | F1 TV's listing carries F1's own `meetingKey` and `sessionKey`, which are also the archive's and OpenF1's keys | `archiveQuery`, `resolveSessionPath` |
| **Which moment** | The video's position becomes a feed offset, then a UTC playhead, which is compared with `visible_from` | `timeMap.ts` |
| **Which driver** | An onboard feed's `Channel.number` is `driver_number` | No code needed yet: any consumer can join on it |

The moment is the hard one, because neither timeline starts at the race start. For a replay, in order of preference:

1. **Curated:** F1 TV's sync API gives `session_start`, the video second of lights out (or green). The feed's `ExtrapolatedClock` shows the offset where the session clock starts. So
   `feed offset = video seconds * 1000 + (clock start offset - session_start * 1000)`.
2. **Wall clock:** the stream's frame time minus the feed's base. It runs about 15s ahead of curated, so data could show up to that early. It's only used when the sync API has nothing.
3. **Scheduled start:** an estimate within about a minute, when the stream has no wall clock either.

A live session compares `visible_from`, its arrival time, with the stream's wall clock. F1 TV's live video runs tens of seconds behind the feed, so rows wait for it. With no wall clock at all, everything is visible, which risks spoilers.

All streams share one clock, kept in step by the sync engine, so one playhead serves every tile. The sync API's per-channel offsets (`channelDiffs`) aren't used. The link also runs the other way: `host.playback.seekToDate` turns a row's time into a video position, through
`videoTimeOf` in `timeMap.ts`. A replay placed by the lead-in inverts the map exactly. One placed by the wall clock, and a live session, move by
the difference from the frame on screen. The agent's `seek_to` uses it. `scripts/seek-check.mjs` checked it on a replay with curated sync data; the wall-clock and live paths are unit-tested only.

A session F1 TV lists without keys falls back to matching by name and type, which could find the wrong session. See "Known limits".

## Joining a live session late

There's no backfill: the database holds what was captured, and `coverage` lists `capturedFrom` and any `gaps`. The snapshot on joining gives the lap in progress, finished stints, race control and pit
history. There's no lap-by-lap history from before, as a snapshot doesn't hold it.

## How it was checked

`scripts/openf1-compare.mjs` compares against OpenF1's API, reporting counts only. `scripts/data-check.mjs` runs the real app against the real archive and through a real opened session, muted, at its start.

| Table | Result, session 11396 |
| --- | --- |
| `laps`, `stints`, `pit`, `position`, `race_control`, `weather`, `overtakes`, `intervals`, `drivers`, championship, `session_result` | Same rows and values (`intervals`: 24,227 rows) |
| `laps.is_pit_out_lap` | The same 32 out laps. It wasn't compared before, and every car's lap 1 was wrongly marked until `INGEST_VERSION` 3 |
| `lap_summary` | For 5 drivers, every lap's end, position, gaps and pit-in flag agree with a recount from the raw tables. Each completed lap has positions 1 to 22 once. The last lap's order matches the published result for all 19 classified cars |
| `car_data`, `location` | Same rows and values, in a 1-minute sample for one car |
| `sessions`, `meetings` | All 123 of 2025's sessions present, with one meeting and one session's fields compared |
| `starting_grid` | 7 of 22 differ. The page we read is still the one OpenF1 scrapes, so its copy looks older |

On 4 older races with fewer feeds cached, `laps`, `stints`, `position`, `race_control` and `weather` matched too, as did `drivers` on the 3 of them the API's rate limit allowed. On those races, lap 1's
duration and first sector were 1ms apart: a rounding difference, not an error. The cut-short archive below is the exception.

That race took about 7 seconds to ingest in full, with 1.5 million telemetry rows, into a 69 MB database. Chart-sized queries took 2-30ms.

## Known limits

- **Live is untested.** No session was on while this was built, so the capture has only run in unit tests. It subscribes to more feeds than before, and any of them being refused
  would show up only on a live session. Check at the next one.
- **`TrackStatus` and `LapCount` are untested live.** They're in the same subscription as the other feeds, so they'd be refused or missing
  the same way. Check at the next live session.
- **No live telemetry.** `CarData.z` and `Position.z` likely need the token on the socket, which isn't sent.
- **Some archives are cut short.** F1's archive of the 2026 Mexico race (session 11404) ends about 2.2 hours in and never reports a finish, where OpenF1 has more rows from recording it live. A fresh
  download on 2026-11-09 was byte-identical to the cached copy in all 15 feeds checked, so this is F1's file and not a stale cache. It's still marked complete after 3 days, with nothing in `coverage` to say it's short.
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
- **Dropped with `useTiming`.** Track status, lap count, the session clock, `inPit`, `pitOut`, `retired`, `bestLap`, and the fastest-sector and new-tyre flags aren't exposed anywhere now. Nothing used them.
