# Moments

Moments worth capturing for the landing page, found on 2026-11-17 by querying the timing data (and on 2026-11-18 the telemetry) of every 2025 and 2026 race and
sprint F1 TV lists as a replay: 56 sessions (30 from 2025, 26 from 2026). Each category has a ranked summary, then the details
are further down. Everything here is at least 10 laps from the end of its race, and none of it shows a finishing order. 2026 comes
first wherever it had a moment as good.

Car numbers change between seasons: in 2026 NOR is 1 and VER is 3; in 2025 NOR is 4 and VER is 1.

## Where the data is

| Profile | Sessions | Telemetry (`car_data`, `location`) |
| --- | --- | --- |
| Main, `~/.config/oh-my-f1-viewer/timing.sqlite` | 9850, 9877, 9928, 9947 (2025); 11307, 11369, 11396, 11404, 11412 (2026) | Complete for all nine |
| Scout, `~/.cache/omfv-shots/scout-profile/timing.sqlite` | All 56, the nine above included | Complete for all 56: `t_ingest` says `complete` for `timing`, `results` and `telemetry` on every one. 3.2 GB |

The scout profile was filled by one isolated OMFV (`startIsolatedApp` with `userData` set to it), calling
`window.omfv.data.open(query, false)` for each session with no video opened: timing and results on 2026-11-17, then each race
again, one at a time, on 2026-11-18 to add its telemetry (4–7 s a race). It was moved out of a scratchpad under `/tmp` to
`~/.cache/omfv-shots/scout-profile`, so it survives a reboot. Read it with `?immutable=1`, and only while no OMFV has it open.
The scripts that did the ranking are in `~/.cache/omfv-shots/scripts` (see the end).

What the telemetry has, checked on every race:

- Car data and positions cover every race from lights out to the flag, except **Monaco 2026** (11299): its positions stop about
  seven minutes after the start, while its car data is complete. No Monaco 2026 lap can be drawn on the circuit, so the Monaco
  ribbon below is 2025's.
- `104` in `throttle` or `brake` means no reading. Across all cars it's 0–33% of a race's samples (per race in the clock table
  at the end), and it comes in runs on some cars and not others. It's worst in **Hungary 2026** (the brake is missing on about a
  third of samples, so B4, B8, C5, F3 and P3/P4 draw poorly in the telemetry charts) and China 2026 (29%). Every telemetry pick
  below uses laps with no such sample for the cars in it.
- `brake` is on or off (0 or 100), so a lock-up doesn't show. A lift does: throttle under 95% off the brake, which the speed
  ribbon draws in half-strength green.
- Samples come about 3.8 times a second, so a brake point is known to about ±20 m at 300 km/h. Differences below are 40 m or
  more.

## Turning UTC into video time

Every `date` here is UTC milliseconds, on the same clock as the replay's playhead. From `src/data/timeMap.ts` (`buildTimeMap`,
`playheadOf`, `videoTimeOf`), when F1 TV's sync API has the race's lights-out, which it did for all 56:

```
video_s = (utc_ms − feedBaseUtc − clockStartOffsetMs) / 1000 + sessionStartSec
utc_ms  = feedBaseUtc + clockStartOffsetMs + (video_s − sessionStartSec) × 1000
```

- `feedBaseUtc`, `clockStartOffsetMs` and `scheduledStartOffsetMs` are in `t_ingest.detail` → `clock` for the `timing` row (per race
  in the table at the end). The app uses `clockStartOffsetMs`, or `scheduledStartOffsetMs` if it's missing.
- `sessionStartSec` is the video second of lights out, from F1 TV's sync API (`fetchSyncData` → `fetchSessionStart` in
  `electron/ipc.ts`). It isn't stored in the database: the main process sends it in `data:status` (`sessionStartSec`), and it is
  recorded per race in the table at the end, as fetched on 2026-11-17.
- The feed offset is clamped to `[0, durationMs]`. Without `sessionStartSec` the app places the frame by the stream's wall clock
  instead, which runs about 15 s ahead, and the formula above no longer holds.
- Check: `feedBaseUtc + clockStartOffsetMs` was within 2 s of race control's `SESSION STARTED` on 55 of the 56 races (13.7 s on
  the 2025 Miami sprint), and the lap 1 of B8 below lands on video 0:08:25, its `sessionStartSec` of 505.7.
- In a capture, `host.playback.seekToDate({ dateMs })` does this in the app. Rows show from their `visible_from`, so a lap's time
  and gap appear when the lap ends: seek a few seconds past the end of the range to have its last lap drawn.

Video times below are `h:mm:ss` into F1 TV's replay of the race.

## How to read the details

- **Gaps** are line crossings: how long after the first car the second crossed the line at the end of that lap, in seconds
  (`t_laps`, each car's next `date_start`). Negative means the second car is ahead.
- **Tyres** are compound and laps on the set: `S12` is a soft on its 12th lap, used laps included.
- A lap marked `[pit]` or with a status other than `AllClear` or `Yellow` was left out of the ranking.
- **In the pit lane** is `t_pit.date` minus `lane_duration` to `t_pit.date`: on the two stops checked against lap times
  (VER, Austin 2026, lap 13; PIA, Hungary 2026, lap 16), `date` is when the car left the pit lane. Treat the window as ±2 s.
- `t_overtakes` counts every change of order, within a lap too, so it shows more swaps than the line crossings.
- **Distances** in the telemetry picks are metres along the lap from the line: each brake or lift's start, placed on one
  reference lap's path from `location`, so they compare between laps and cars. Corner names next to them are from the distance
  and the speeds, not from a map, so treat them as likely rather than certain.
- **Top** is the lap's highest `speed`; **at the brake** is the speed when the brake comes on.

## Summary

### 1. Hero: a sustained close fight (HAM vs VER first)

| Rank | ID | Race · session | Laps | Drivers | Video | What |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | B1 | Canada 2026 · 11291 | 3–21 | HAM 44, VER 3 | 0:17:44–0:42:03 | 19 laps inside 0.92 s for P3: VER closes 0.84→0.39 s, passes on lap 9 (video 0:25:38), then HAM 0.38–0.78 s behind for 13 laps |
| 2 | B3 | Austria 2026 · 11315 | 4–11 | HAM 44, VER 3 | 0:12:05–0:21:47 | VER closes 1.87→0.56 s on HAM for P2 on same-age mediums; ends at HAM's stop |
| 3 | B2 | Mexico 2026 · 11404 | 47–56 | VER 3, HAM 44 | 1:52:14–2:06:43 | HAM 0.47–1.31 s behind VER for the lead after a standing restart. Late, and for the lead |
| 4 | B4 | Hungary 2026 · 11342 | 3–12 | VER 3, HAM 44 | 0:11:23–0:25:39 | HAM 0.38–0.78 s behind VER for P3, LEC about 1 s further back (F3) |

Re-ranked with telemetry: B2 moves above B4. In B2 HAM, in VER's tow, is 351 km/h at the top to VER's 342 on lap 48 (352 to 340
on lap 50) and brakes 59 m before him into turn 1 on lap 48 (SP3 below). B4 is in Hungary 2026, where the brake is missing on a
third of samples: only 4 of its 10 laps draw cleanly for both cars. In B1 HAM is faster at the top on most laps, ahead or behind,
by 12 km/h on average (328 to 316 on lap 3, 328 to 311 on lap 13); in B3 VER is about 9 km/h faster and brakes 43 m before HAM at
about 3540 m on lap 4.

Other pairs:

| Rank | ID | Race · session | Laps | Drivers | Video | What |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | B5 | Canada 2026 · 11291 | 2–29 | ANT 12, RUS 63 | 0:16:22–0:52:07 | For the lead, 28 laps mostly 0.2–0.6 s apart, lead changes at the line on laps 6, 22, 25 |
| 2 | B6 | Italy 2026 · 11361 | 12–27 | PIA 81, HAM 44 | 0:59:32–1:22:33 | P4 changes hands at the line five times in 15 laps, 0.2–1.0 s apart |
| 3 | B7 | Azerbaijan 2026 · 11377 | 7–30 | PIA 81, VER 3 | 0:19:56–1:03:05 | VER 0.3–1.16 s behind PIA for P2 for 24 laps, no pass |

Telemetry: B5's two cars are driven differently at about one corner a lap, brake points 40–90 m apart at turn 1, at about 600–700 m
and into the final chicane (about 3700 m). In B6 HAM reaches turn 1 20–53 km/h faster than PIA and brakes 44–62 m earlier on
laps 13, 25 and 26. In B7 VER, in PIA's tow, is 13 km/h faster at the top on average.

NOR vs PIA:

| Rank | ID | Race · session | Laps | Drivers | Video | What |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | B8 | Hungary 2026 · 11342 | 1–32 | PIA 81, NOR 1 | 0:08:25–0:54:24 | For the lead: NOR 0.6–1.3 s behind PIA on laps 1–15 and 19–32, both stop in between |
| 2 | B9 | Austria 2025 · 9955 | 4–19 | NOR 4, PIA 81 | 0:28:24–0:47:10 | 2025: PIA 0.25–1.0 s behind NOR for the lead |

### 2. "Go to when VER caught HAM": one car closing on another

| Rank | ID | Race · session | Laps | Drivers | Video | What |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | C3 | Italy 2026 · 11361 | 31–37 | VER 3 on HAM 44 | 1:27:22–1:37:24 | 5.2→0.52 s on fresh hards, past on lap 37 (video 1:36:25) for P4 |
| 2 | C1 | Miami 2026 · 11280 | 20–26 | VER 3 on HAM 44 | 0:43:43–0:54:43 | 3.75→0.77 s in 4 laps, VER past on lap 26 (video 0:54:35) for P4, mid-race |
| 3 | C2 | Canada 2026 · 11291 | 3–9 | VER 3 on HAM 44 | 0:17:44–0:26:48 | 0.84→0.39 s, past on lap 9 (video 0:25:38) for P3. The start of B1 |
| 4 | C4 | Singapore 2026 · 11388 | 41–46 | LEC 16 on HAM 44 | 1:15:25–1:25:12 | 7.68→0.47 s, past for P2 on lap 46 (video 1:24:08) |
| 5 | C5 | Hungary 2026 · 11342 | 41–46 | NOR 1 on ANT 12 | 1:05:55–1:14:25 | 5.12→0.34 s, past for the lead on lap 46 (video 1:13:17) |

Re-ranked with telemetry: C3 moves to the top, for the clearest difference between two traces of any catch. On lap 32 VER, on
4-lap hards and 5.2 s behind, reaches turn 1 at 323 km/h to HAM's 268 and brakes 84 m earlier, and he is 11–19 km/h faster at
the top on laps 32–33 (SP1 below). C1's traces differ only on the lap of the pass (lap 26: 336 km/h at the top to HAM's 319).

### 3. Back to the restart: safety cars and red flags

| Rank | ID | Race · session | Green at (video · UTC) | Lap | What |
| --- | --- | --- | --- | --- | --- |
| 1 | R1 | Malaysia 2026 · 11731 | 2:05:22 · 1791104416501 | 12 of 56 | VER and RUS pass the leader ANT seconds after the green, after stops for slicks under the safety car |
| 2 | R2 | Azerbaijan 2026 · 11377 | 1:16:21 · 1790424674061, then 1:24:00 · 1790425132881 | 35, 38 of 51 | Two restarts in eight laps, the top seven inside 1.4 s each time |
| 3 | R3 | Mexico 2026 · 11404 | 1:52:03 · 1793569616687 | 46 of 71 | Red flag, then a standing restart: VER, HAM 0.71 s, LEC 1.82 s |
| 4 | R4 | Miami 2026 · 11280 | 0:30:40 · 1777829133668 | 11 of 57 | LEC leads NOR by 0.77 s and ANT, top eight inside 3.5 s |
| 5 | R5 | China 2026 · 11245 | 0:32:57 · 1773559670374 | 13 of 56 | A mixed-up order, top eight inside 2.6 s |
| 6 | R6 | Japan 2026 · 11253 | 0:56:31 · 1774764084798 | 27 of 53 | ANT leads PIA by 0.98 s |

### 4. Tyre deg: laps falling off late in a stint

2026's tyres fall off little, so none of these is dramatic. Ranked by how well they'd read in `tyre_deg`, which shades each lap
against the car's own median on that set.

| Rank | ID | Race · session | Laps | Drivers | Video | What |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | D1 | Singapore 2026 · 11388 | 20–32 | VER, PIA, NOR | 0:40:07–1:01:25 | The top three on 30-lap softs fade together, then all pit on laps 32–33 |
| 2 | D5 | Barcelona 2026 · 11307 | 47–55 | HAM, NOR, LEC, PIA, GAS, COL | 1:13:02–1:25:09 | The clearest fade, seven of the top ten on hards, but late (lap 55 of 66) |
| 3 | D2 | Barcelona 2026 · 11307 | 22–32 | RUS, NOR, PIA, HAD, GAS | 0:37:52–0:53:06 | Mid-race on hards, 0.6–0.9 s off: mild |
| 4 | D4 | Netherlands 2026 · 11353 | 30–38 | ANT, NOR, HAM, PIA | 1:17:11–1:28:41 | The leaders on hards, but rain came and went in this race |
| 5 | D3 | Monaco 2026 · 11299 | 33–41 | GAS, NOR, ALB, SAI, LIN, HUL, OCO | 0:49:25–1:01:17 | The biggest numbers (1.5–3.9 s), likely traffic as much as wear |

### 5. Pit window, and front-runners in the pit lane

| Rank | ID | Race · session | In-lap | Driver | In the pit lane (video) | What |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | P1 | Barcelona 2026 · 11307 | 16 | LEC 16, P1 | 0:30:59–0:31:21 | Leads after everyone else has stopped, the field 4–27 s behind; rejoins P6 between VER and PIA |
| 2 | P2 | Mexico 2026 · 11404 | 27 | LEC 16 (P1) and VER 3 (P2) | 0:45:57–0:46:26 | Both in the pit lane at once; LEC's 8.7 s stop puts him out 1.6 s behind VER |
| 3 | P4, P4b | Hungary 2026 · 11342 | 16, 17 | PIA 81, then NOR 1, each from the lead | 0:31:18–0:31:40, 0:32:45–0:33:07 | The leaders pit on consecutive laps; NOR rejoins with five cars inside 1.7 s |
| 4 | P3 | Hungary 2026 · 11342 | 16 | LEC 16, P3 | 0:31:26–0:31:48 | Same lap as PIA, so two front-runners in the lane |
| 5 | P5 | Singapore 2026 · 11388 | 24 | LEC 16, P2 | 0:48:24–0:48:49 | Rejoins P4, 0.8 s ahead of HAM |

### 6. Follow Norris

| Rank | ID | Race · session | Laps | Video | What |
| --- | --- | --- | --- | --- | --- |
| 1 | N1 | Miami 2026 · 11280 | 29–43 | 0:57:50–1:20:57 | NOR 0.48–1.48 s behind the leader ANT for 15 laps |
| 2 | C5 | Hungary 2026 · 11342 | 41–46 | 1:05:55–1:14:25 | NOR on fresh hards catches ANT 5.12→0.34 s and passes for the lead |
| 3 | B8 | Hungary 2026 · 11342 | 1–32 | 0:08:25–0:54:24 | NOR on PIA's tail for the lead |
| 4 | N2 | Netherlands 2026 · 11353 | 48–54 | 1:40:15–1:49:19 | NOR stops from the lead, catches ANT 4.97→0.17 s, leads by lap 54 |
| 5 | N3 | Mexico 2026 · 11404 | 11–32 | 0:23:03–0:52:59 | NOR 0.74–1.3 s behind RUS for 22 laps |

### 7. HAM vs his team-mate LEC

| Rank | ID | Race · session | Laps | Video | What |
| --- | --- | --- | --- | --- | --- |
| 1 | F1 | China 2026 · 11245 | 19–42 | 0:41:30–1:20:22 | P2 to P4, the order between them changes at the line on six laps, 0.36–0.92 s apart most laps |
| 2 | C4 | Singapore 2026 · 11388 | 41–46 | 1:15:25–1:25:12 | LEC catches HAM 7.68→0.47 s and passes for P2 |
| 3 | F4 | Japan 2026 · 11253 | 35–42 | 1:07:51–1:20:22 | LEC closes 1.24→0.46 s and passes for P3 on lap 42 (at the cut) |
| 4 | F3 | Hungary 2026 · 11342 | 3–12 | 0:11:23–0:25:41 | LEC 0.55–1.05 s behind HAM for P4 |
| 5 | F2 | Netherlands 2026 · 11353 | 5–17 | 0:43:53–1:01:43 | HAM 0.37–1.3 s behind LEC for P5 |

Telemetry: F1's traces differ the most of the HAM–LEC picks. On lap 19 LEC brakes 62 m later than HAM from 305 km/h at about
4575 m (the hairpin at the end of the back straight), and HAM lifts for 2–3 s from 250 km/h at about 1950 m on laps 19, 20, 23 and
25 where LEC doesn't. China 2026 is missing readings on 29% of samples, so 19 of F1's 24 laps draw for both cars. In F4 LEC, behind,
is about 13 km/h faster at the top.

### 8. Speed ribbon: one lap on the circuit

`speed_ribbon` (one driver) draws the car's last lap, as long as its latest lap time, ending at the playhead: wider where faster
(1 px at 60 km/h, 6 px at 340), green on full throttle, half-strength green on a lift, red on the brake, with each corner's
slowest speed. So seek to a second after the lap ends. All of these are clean laps (no pit, `AllClear`, no missing reading,
no gap over 1.4 s in either table).

| Rank | ID | Race · session | Driver · lap | Seek to (video) | What |
| --- | --- | --- | --- | --- | --- |
| 1 | SR1 | Japan 2026 · 11253 | HAM 44 · lap 34 of 53 (P3) | 1:07:52 | Suzuka's figure of eight. Through the Esses (from about 1050 m) HAM never touches the brake: 13 s of part throttle between 168 and 228 km/h, one long half-green stretch. ANT, leading on lap 43 (SR1b, 1:21:43), brakes twice there |
| 2 | SR2 | Italy 2026 · 11361 | HAM 44 · lap 23 of 53 (P4) | 1:16:48 | Monza: the widest ribbon (343 km/h) and six short red zones. Before turn 1 the speed falls from 342 to 312 km/h on full throttle in 1.5 s, so the green narrows before the red |
| 3 | SR3 | Belgium 2026 · 11334 | LEC 16 · lap 23 of 44 (P1) | 0:55:09 | Spa: 341 km/h, seven brakes in 7 km, and no lift above 220 km/h but one of 1 s from 267 km/h at about 3730 m. HAM's lap 33 (P5) is SR3b, 1:13:42 |
| 4 | SR4 | Britain 2026 · 11326 | HAM 44 · lap 25 of 52 (P6) | 0:49:04 | Silverstone: a 1.8 s lift from 293 km/h at about 2950 m (Copse) and a short one at about 3800 m (Becketts), 0.82 s behind RUS |
| 5 | SR5 | United States 2026 · 11396 | HAM 44 · lap 42 of 56 (P5) | 1:20:19 | COTA: 344 km/h, the highest of these, and the first-sector esses on lifts of 1.7 s and 3.1 s from 254 and 241 km/h |
| 6 | SR6 | Monaco 2025 · 9979 | NOR 4 · lap 44 of 78 (P1) | 1:05:48 | The thinnest ribbon: 46 km/h at the hairpin, 12 brakes in 3.3 km, one lift from 223 km/h at about 2430 m (the tunnel). Monaco 2026 has no positions |

Two ribbons side by side, the same lap for two cars close together (or two `car_telemetry` tiles):

| Rank | ID | Race · session | Drivers · lap | Seek to (video) | What |
| --- | --- | --- | --- | --- | --- |
| 1 | SP2 | Japan 2026 · 11253 | HAM 44 and RUS 63 · lap 34 | 1:07:53 | RUS, 0.98 s behind for P3, reaches turn 1 at 335 km/h to HAM's 297 and brakes 91 m earlier. HAM's ribbon is SR1 |
| 2 | SP3 | Mexico 2026 · 11404 | VER 3 and HAM 44 · lap 48 of 71 | 1:56:05 | For the lead, HAM 0.47 s behind (B2): 351 km/h at the top to VER's 342, at the brake 341 to 325, and he brakes 59 m before VER into turn 1 |
| 3 | SP1 | Italy 2026 · 11361 | HAM 44 and VER 3 · lap 32 of 53 | 1:30:20 | VER on 4-lap hards, 5.2 s behind HAM's 29-lap mediums (C3): turn 1 at 323 km/h to 268, braking 84 m earlier, and a 5.1 s lift from 314 km/h at about 4450 m that HAM doesn't make |
| 4 | BT1 | Malaysia 2026 · 11731 | HAD 6 and HAM 44 · laps 36–42 of 56 | 2:45:39–2:57:31 | HAM 0.65–1.44 s behind HAD for P4, and 23 km/h faster at the top on average (343 to 309 on lap 40). HAD lifts for 3–4.6 s from about 250 km/h at about 3690 m every lap, where HAM stays flat; HAM brakes 41–58 m earlier into turn 1 on laps 40–42. Laps 37–38 have missing readings |

### 9. Pedal barcode: the same car, lap after lap

`pedal_barcode` (one driver) has six rows: the lap in progress on top and the five before it, brake in red and throttle in green
by distance from the line, a hairline at each corner, and each lap's time against the one before. Seek to just after the last
lap of the range: that lap is then the first full row, with the four before it underneath (the oldest lap of the range drops off).

| Rank | ID | Race · session | Driver · laps | Seek to (video) | What |
| --- | --- | --- | --- | --- | --- |
| 1 | PB1 | Britain 2026 · 11326 | HAM 44 · 6–11 of 52 | 0:26:25 | Laps 6–10 alike (94.65–95.01 s) in P2, 2.3–4.0 s behind LEC. Lap 11 is the lap ANT passes him: two brakes the others don't have, at about 2910 m (Copse, 282→244 km/h) and 3750 m (Becketts, 262→233), and 0.76 s slower |
| 2 | PB2 | Canada 2026 · 11291 | ANT 12 · 20–25 of 70 | 0:47:03 | Inside B5: lap 25 is the lap RUS retakes the lead. ANT brakes 71 m earlier at about 1760 m, lifts 2.2 s from 250 km/h just before, and the lap is 2.1 s slower |
| 3 | PB3 | Spain 2026 · 11369 | RUS 63 · 30–35 of 57 | 1:08:33 | Lap 35, the lap RUS passes LAW for P5: he arrives at about 1260 m at 336 km/h in LAW's tow (298–317 on laps 30–34), brakes 65–100 m earlier and holds it for 4.1 s, and the lap is 2.6 s slower |
| 4 | PB4 | Singapore 2026 · 11388 | VER 3 · 20–25 of 62 (P1) | 0:49:54 | The other kind: the leader driving every lap the same. Twelve brake zones whose starts move about 15 m on average across the six laps, and laps of 97.54–97.70 s |
| 5 | PB5 | Mexico 2026 · 11404 | LEC 16 · 12–17 of 71 (P1) | 0:32:23 | The same from the leader: six laps within 0.09 s (81.00–81.09). HAM's most even six are laps 14–19 of the same race in P3, within 0.15 s (PB4b, 0:35:12) |
| 6 | PB6 | Italy 2026 · 11361 | NOR 1 · 15–20 of 53 (P7) | 1:12:35 | NOR 0.2–0.6 s behind GAS: lap 20 is 1.8 s slower, with lifts of 2.6 s and 2.3 s from 326 and 321 km/h on the straights and 57 km/h at the bottom of turn 1 (72–84 on the laps before) |

## Details

Each block was generated from the scout profile's `timing.sqlite` with the queries at the end.

### 1. Battles

#### B1: HAM vs VER for P3, Canada 2026

- **Race:** 2026 Canadian Grand Prix · session 11291 · meeting 1285 · 70 laps
- **Drivers:** HAM (44) and VER (3) · **laps** 3–21
- **When:** UTC 1779653557389–1779655016539 (20:12:37–20:36:56), video 0:17:44–0:42:03
- **Gap of VER behind HAM** at each lap's end (s; negative = VER ahead), positions HAM/VER, tyres HAM/VER:
  L3 +0.84 (P3/P4, S6/S8) · L4 +0.75 (P3/P4, S7/S9) · L5 +0.54 (P3/P4, S8/S10) · L6 +0.73 (P3/P4, S9/S11) · L7 +0.39 (P3/P4, S10/S12) · L8 +0.39 (P3/P4, S11/S13) · L9 -0.92 (P4/P3, S12/S14) · L10 -0.78 (P4/P3, S13/S15) · L11 -0.72 (P4/P3, S14/S16) · L12 -0.55 (P4/P3, S15/S17) · L13 -0.53 (P4/P3, S16/S18) · L14 -0.53 (P4/P3, S17/S19) · L15 -0.61 (P4/P3, S18/S20) · L16 -0.59 (P4/P3, S19/S21) · L17 -0.50 (P4/P3, S20/S22) · L18 -0.69 (P4/P3, S21/S23) · L19 -0.66 (P4/P3, S22/S24) · L20 -0.38 (P4/P3, S23/S25) · L21 -0.47 (P4/P3, S24/S26)
- **VER passes HAM (t_overtakes, for P3):** UTC 1779654031158 (20:20:31), video 0:25:38
- **Why:** The longest close HAM–VER fight in either season: 19 laps inside 0.92 s, VER closing 0.84→0.39 s, passing on lap 9, then HAM 0.38–0.78 s behind for 13 more laps. Both on track the whole way (HAM's next lap, 22, loses 4 s; his stop is lap 31 under a VSC). Mid-race-ish: laps 9–21 of 70. Third place, not the lead, so it gives nothing away. RUS (P1/P2) drops out of the order on lap 30, so keep the frame before that

#### B3: VER closes on HAM for P2, Austria 2026

- **Race:** 2026 Austrian Grand Prix · session 11315 · meeting 1288 · 71 laps
- **Drivers:** HAM (44) and VER (3) · **laps** 4–11
- **When:** UTC 1782652020001–1782652601845 (13:07:00–13:16:41), video 0:12:05–0:21:47
- **Gap of VER behind HAM** at each lap's end (s; negative = VER ahead), positions HAM/VER, tyres HAM/VER:
  L4 +1.70 (P2/P3, M4/M4) · L5 +1.87 (P2/P3, M5/M5) · L6 +1.22 (P2/P3, M6/M6) · L7 +0.84 (P2/P3, M7/M7) · L8 +0.79 (P2/P3, M8/M8) · L9 +0.64 (P2/P3, M9/M9) · L10 +0.73 (P2/P3, M10/M10) · L11 +0.56 (P2/P3, M11/M11)
- **Why:** The cleanest 'closing' shape: VER takes 1.87→0.56 s out of HAM over 7 laps for P2, both on mediums the same age. Early (laps 4–11 of 71), and it ends when HAM pits on lap 12

#### B4: HAM sits behind VER for P3, Hungary 2026

- **Race:** 2026 Hungarian Grand Prix · session 11342 · meeting 1291 · 70 laps
- **Drivers:** VER (3) and HAM (44) · **laps** 3–12
- **When:** UTC 1785071176824–1785072033102 (13:06:16–13:20:33), video 0:11:23–0:25:39
- **Gap of HAM behind VER** at each lap's end (s; negative = HAM ahead), positions VER/HAM, tyres VER/HAM:
  L3 +0.38 (P3/P4, M3/S3) · L4 +0.55 (P3/P4, M4/S4) · L5 +0.62 (P3/P4, M5/S5) · L6 +0.54 (P3/P4, M6/S6) · L7 +0.64 (P3/P4, M7/S7) · L8 +0.45 (P3/P4, M8/S8) · L9 +0.78 (P3/P4, M9/S9) · L10 +0.56 (P3/P4, M10/S10) · L11 +0.55 (P3/P4, M11/S11) · L12 +0.67 (P3/P4, M12/S12)
- **Why:** HAM 0.38–0.78 s behind VER for P3 for 10 laps, both on softs. Ends when HAM pits on lap 13. Early (laps 3–12 of 70)

#### B2: VER leads HAM after the standing restart, Mexico 2026

- **Race:** 2026 Mexico City Grand Prix · session 11404 · meeting 1298 · 71 laps
- **Drivers:** VER (3) and HAM (44) · **laps** 47–56
- **When:** UTC 1793569627260–1793570496370 (21:47:07–22:01:36), video 1:52:14–2:06:43
- **Gap of HAM behind VER** at each lap's end (s; negative = HAM ahead), positions VER/HAM, tyres VER/HAM:
  L47 +0.71 (P1/P2, S5/S5) · L48 +0.47 (P1/P2, S6/S6) · L49 +0.90 (P1/P2, S7/S7) · L50 +0.67 (P1/P2, S8/S8) · L51 +1.19 (P1/P2, S9/S9) · L52 +1.31 (P1/P2, S10/S10) · L53 +1.26 (P1/P2, S11/S11) · L54 +1.22 (P1/P2, S12/S12) · L55 +1.23 (P1/P2, S13/S13) · L56 +1.25 (P1/P2, S14/S14)
- **Why:** HAM 0.47–1.31 s behind VER for the lead for 10 laps after the red flag and standing restart, both on 5-lap softs. Laps 47–50 are under local yellows. Strong, but late (laps 47–56 of 71) and for the lead, so closer to the result than B1. Mexico's archive ends at lap 57 (see SESSION_DATA.md), so nothing later can be checked

#### B5: ANT vs RUS for the lead, Canada 2026

- **Race:** 2026 Canadian Grand Prix · session 11291 · meeting 1285 · 70 laps
- **Drivers:** ANT (12) and RUS (63) · **laps** 2–29
- **When:** UTC 1779653475514–1779655619908 (20:11:15–20:46:59), video 0:16:22–0:52:07
- **Gap of RUS behind ANT** at each lap's end (s; negative = RUS ahead), positions ANT/RUS, tyres ANT/RUS:
  L2 +0.14 (P1/P2, S6/S5) · L3 +0.56 (P1/P2, S7/S6) · L4 +0.48 (P1/P2, S8/S7) · L5 +0.38 (P1/P2, S9/S8) · L6 -0.83 (P2/P1, S10/S9) · L7 -1.19 (P2/P1, S11/S10) · L8 -0.94 (P2/P1, S12/S11) · L9 -1.27 (P2/P1, S13/S12) · L10 -0.98 (P2/P1, S14/S13) · L11 -1.07 (P2/P1, S15/S14) · L12 -0.22 (P2/P1, S16/S15) · L13 -0.78 (P2/P1, S17/S16) · L14 -0.66 (P2/P1, S18/S17) · L15 -0.58 (P2/P1, S19/S18) · L16 -0.52 (P2/P1, S20/S19) · L17 -0.41 (P2/P1, S21/S20) · L18 -0.38 (P2/P1, S22/S21) · L19 -0.45 (P2/P1, S23/S22) · L20 -0.56 (P2/P1, S24/S23) · L21 -0.20 (P2/P1, S25/S24) · L22 +0.33 (P1/P2, S26/S25) · L23 +0.91 (P1/P2, S27/S26) · L24 +1.14 (P1/P2, S28/S27) · L25 -0.48 (P2/P1, S29/S28) · L26 -0.44 (P2/P1, S30/S29) · L27 -0.33 (P2/P1, S31/S30) · L28 -0.34 (P2/P1, S32/S31) · L29 -0.59 (P2/P1, S33/S32)
- **Why:** Mercedes team-mates for the lead: 28 laps inside 1.3 s, mostly 0.2–0.6 s, with lead changes on laps 6, 22 and 25 (and more swaps within laps in t_overtakes). RUS drops out of the order on lap 30: end the clip at lap 29

#### B6: PIA vs HAM for P4, five swaps, Italy 2026

- **Race:** 2026 Italian Grand Prix · session 11361 · meeting 1293 · 53 laps
- **Drivers:** PIA (81) and HAM (44) · **laps** 12–27
- **When:** UTC 1788702865469–1788704246327 (13:54:25–14:17:26), video 0:59:32–1:22:33
- **Gap of HAM behind PIA** at each lap's end (s; negative = HAM ahead), positions PIA/HAM, tyres PIA/HAM:
  L12 +1.09 (P3/P5, H9/M9) · L13 +0.20 (P4/P5, H10/M10) · L14 +0.58 (P4/P5, H11/M11) · L15 +0.34 (P4/P5, H12/M12) · L16 -0.26 (P5/P4, H13/M13) · L17 -0.27 (P5/P4, H14/M14) · L18 -0.27 (P5/P4, H15/M15) · L19 +0.59 (P4/P5, H16/M16) · L20 +0.97 (P4/P5, H17/M17) · L21 +0.91 (P4/P5, H18/M18) · L22 +0.96 (P4/P5, H19/M19) · L23 -0.71 (P5/P4, H20/M20) · L24 -0.63 (P5/P4, H21/M21) · L25 +0.60 (P4/P5, H22/M22) · L26 +1.00 (P4/P5, H23/M23) · L27 +0.87 (P4/P5, H24/M24)
- **Why:** PIA and HAM swap P4 at least five times in 15 laps (laps 16, 19, 23, 25 by line crossings; t_overtakes has more), gap 0.2–1.0 s. Mid-race (laps 12–27 of 53). Ends with a VSC on lap 28

#### B7: VER on PIA's gearbox for P2, Azerbaijan 2026

- **Race:** 2026 Azerbaijan Grand Prix · session 11377 · meeting 1295 · 51 laps
- **Drivers:** PIA (81) and VER (3) · **laps** 7–30
- **When:** UTC 1790421289425–1790423878755 (11:14:49–11:57:58), video 0:19:56–1:03:05
- **Gap of VER behind PIA** at each lap's end (s; negative = VER ahead), positions PIA/VER, tyres PIA/VER:
  L7 +0.72 (P2/P3, S7/M7) · L8 +0.47 (P2/P3, S8/M8) · L9 +0.55 (P2/P3, S9/M9) · L10 +0.40 (P2/P3, S10/M10) · L11 +0.30 (P2/P3, S11/M11) · L12 +0.70 (P2/P3, S12/M12) · L13 +0.64 (P2/P3, S13/M13) · L14 +0.76 (P2/P3, S14/M14) · L15 +0.85 (P2/P3, S15/M15) · L16 +0.88 (P2/P3, S16/M16) · L17 +0.53 (P2/P3, S17/M17) · L18 +0.48 (P2/P3, S18/M18) · L19 +1.00 (P2/P3, S19/M19) · L20 +1.02 (P2/P3, S20/M20) · L21 +0.95 (P2/P3, S21/M21) · L22 +1.02 (P2/P3, S22/M22) · L23 +0.69 (P2/P3, S23/M23) · L24 +0.85 (P2/P3, S24/M24) · L25 +0.76 (P2/P3, S25/M25) · L26 +1.16 (P2/P3, S26/M26) · L27 +1.06 (P2/P3, S27/M27) · L28 +1.13 (P2/P3, S28/M28) · L29 +0.86 (P2/P3, S29/M29) · L30 +1.10 (P2/P3, S30/M30)
- **Why:** VER 0.3–1.16 s behind PIA for P2 for 24 laps. Long but static: no pass

#### B8: NOR vs PIA for the lead, Hungary 2026

- **Race:** 2026 Hungarian Grand Prix · session 11342 · meeting 1291 · 70 laps
- **Drivers:** PIA (81) and NOR (1) · **laps** 1–32
- **When:** UTC 1785070998360–1785073757371 (13:03:18–13:49:17), video 0:08:25–0:54:24
- **Gap of NOR behind PIA** at each lap's end (s; negative = NOR ahead), positions PIA/NOR, tyres PIA/NOR:
  L1 +0.88 (P1/P2, M1/M1) · L2 +0.95 (P1/P2, M2/M2) · L3 +1.07 (P1/P2, M3/M3) · L4 +1.06 (P1/P2, M4/M4) · L5 +1.18 (P1/P2, M5/M5) · L6 +1.10 (P1/P2, M6/M6) · L7 +1.61 (P1/P2, M7/M7) · L8 +1.95 (P1/P2, M8/M8) · L9 +1.80 (P1/P2, M9/M9) · L10 +1.34 (P1/P2, M10/M10) · L11 +1.31 (P1/P2, M11/M11) · L12 +1.11 (P1/P2, M12/M12) · L13 +1.17 (P1/P2, M13/M13) · L14 +0.94 (P1/P2, M14/M14) · L15 +1.08 (P1/P2, M15/M15) · L16 -1.83 (P2/P1, M16/M16) [AllClear pit] · L17 -18.57 (P4/P1, H1/M17) [AllClear pit] · L18 +0.39 (P3/P4, H2/H1) [AllClear pit] · L19 +0.75 (P2/P3, H3/H2) · L20 +0.76 (P2/P3, H4/H3) · L21 +0.70 (P2/P3, H5/H4) · L22 +0.94 (P2/P3, H6/H5) · L23 +1.00 (P1/P2, H7/H6) · L24 +0.79 (P1/P2, H8/H7) · L25 +0.67 (P1/P2, H9/H8) · L26 +0.66 (P1/P2, H10/H9) · L27 +0.87 (P1/P2, H11/H10) · L28 +0.59 (P1/P2, H12/H11) · L29 +1.55 (P1/P2, H13/H12) · L30 +1.05 (P1/P2, H14/H13) · L31 +0.75 (P1/P2, H15/H14) · L32 +0.70 (P1/P2, H16/H15)
- **Why:** McLaren team-mates for the lead: NOR 0.6–1.3 s behind PIA for laps 1–15, both stop (PIA lap 16, NOR lap 17), and NOR is 0.6–1.0 s behind again on laps 19–32. ANT leads laps 19–22 before his stop

#### B9: PIA on NOR for the lead, Austria 2025

- **Race:** 2025 Austrian Grand Prix · session 9955 · meeting 1264 · 71 laps
- **Drivers:** NOR (4) and PIA (81) · **laps** 4–19
- **When:** UTC 1751203397918–1751204523602 (13:23:17–13:42:03), video 0:28:24–0:47:10
- **Gap of PIA behind NOR** at each lap's end (s; negative = PIA ahead), positions NOR/PIA, tyres NOR/PIA:
  L4 +0.58 (P1/P2, M4/M4) · L5 +0.86 (P1/P2, M5/M5) · L6 +0.54 (P1/P2, M6/M6) · L7 +0.83 (P1/P2, M7/M7) · L8 +0.92 (P1/P2, M8/M8) · L9 +0.69 (P1/P2, M9/M9) · L10 +0.74 (P1/P2, M10/M10) · L11 +0.86 (P1/P2, M11/M11) · L12 +1.00 (P1/P2, M12/M12) · L13 +0.90 (P1/P2, M13/M13) · L14 +0.25 (P1/P2, M14/M14) · L15 +0.76 (P1/P2, M15/M15) · L16 +0.66 (P1/P2, M16/M16) · L17 +0.93 (P1/P2, M17/M17) · L18 +0.88 (P1/P2, M18/M18) · L19 +0.59 (P1/P2, M19/M19)
- **Why:** 2025 fallback: PIA 0.25–1.0 s behind NOR for the lead for 16 laps

### 2. Catches

#### C1: VER catches and passes HAM, Miami 2026

- **Race:** 2026 Miami Grand Prix · session 11280 · meeting 1284 · 57 laps
- **Drivers:** HAM (44) and VER (3) · **laps** 20–26
- **When:** UTC 1777829916372–1777830576119 (17:38:36–17:49:36), video 0:43:43–0:54:43
- **Gap of VER behind HAM** at each lap's end (s; negative = VER ahead), positions HAM/VER, tyres HAM/VER:
  L20 +4.72 (P5/P8, M20/H14) · L21 +3.75 (P4/P6, M21/H15) · L22 +2.98 (P4/P5, M22/H16) · L23 +2.41 (P4/P5, M23/H17) · L24 +1.56 (P4/P5, M24/H18) · L25 +0.77 (P4/P5, M25/H19) · L26 -0.31 (P5/P4, M26/H20)
- **VER passes HAM (t_overtakes, for P4):** UTC 1777830568488 (17:49:28), video 0:54:35
- **Why:** The best 'go to when VER caught HAM': VER on hards takes 3.75→0.77 s out of HAM in 4 laps (laps 21–25), passes on lap 26 for P4, and HAM pits on lap 27. Mid-race (lap 26 of 57), both on track, clean laps throughout

#### C3: VER catches and passes HAM, Italy 2026

- **Race:** 2026 Italian Grand Prix · session 11361 · meeting 1293 · 53 laps
- **Drivers:** HAM (44) and VER (3) · **laps** 31–37
- **When:** UTC 1788704534859–1788705136922 (14:22:14–14:32:16), video 1:27:22–1:37:24
- **Gap of VER behind HAM** at each lap's end (s; negative = VER ahead), positions HAM/VER, tyres HAM/VER:
  L31 +5.84 (P3/P6, M28/H3) · L32 +5.22 (P3/P6, M29/H4) · L33 +4.26 (P3/P5, M30/H5) · L34 +3.58 (P3/P5, M31/H6) · L35 +1.34 (P4/P5, M32/H7) · L36 +0.52 (P4/P5, M33/H8) · L37 -1.17 (P5/P4, M34/H9)
- **VER passes HAM (t_overtakes, for P4):** UTC 1788705078484 (14:31:18), video 1:36:25
- **Why:** VER on fresh hards takes 5.2→0.52 s out of HAM (34-lap mediums) over laps 31–36 and passes on lap 37, for P4. Lap 37 of 53: still 16 from the end

#### C2: VER catches and passes HAM, Canada 2026

- **Race:** 2026 Canadian Grand Prix · session 11291 · meeting 1285 · 70 laps
- **Drivers:** HAM (44) and VER (3) · **laps** 3–9
- **When:** UTC 1779653557389–1779654101158 (20:12:37–20:21:41), video 0:17:44–0:26:48
- **Gap of VER behind HAM** at each lap's end (s; negative = VER ahead), positions HAM/VER, tyres HAM/VER:
  L3 +0.84 (P3/P4, S6/S8) · L4 +0.75 (P3/P4, S7/S9) · L5 +0.54 (P3/P4, S8/S10) · L6 +0.73 (P3/P4, S9/S11) · L7 +0.39 (P3/P4, S10/S12) · L8 +0.39 (P3/P4, S11/S13) · L9 -0.92 (P4/P3, S12/S14)
- **VER passes HAM (t_overtakes, for P3):** UTC 1779654031158 (20:20:31), video 0:25:38
- **Why:** Same shape as C1 in Canada, shorter: VER 0.84→0.39 s on laps 3–8, past on lap 9. Doubles as the start of B1

#### C4: LEC catches and passes HAM for P2, Singapore 2026

- **Race:** 2026 Singapore Grand Prix · session 11388 · meeting 1296 · 62 laps
- **Drivers:** HAM (44) and LEC (16) · **laps** 41–46
- **When:** UTC 1791724220202–1791724807080 (13:10:20–13:20:07), video 1:15:25–1:25:12
- **Gap of LEC behind HAM** at each lap's end (s; negative = LEC ahead), positions HAM/LEC, tyres HAM/LEC:
  L41 +7.68 (P2/P3, S26/S5) · L42 +5.36 (P2/P3, S27/S6) · L43 +3.63 (P2/P3, S28/S7) · L44 +1.75 (P2/P3, S29/S8) · L45 +0.47 (P2/P3, S30/S9) · L46 -1.42 (P3/P2, S31/S10)
- **LEC passes HAM (t_overtakes, for P2):** UTC 1791724743222 (13:19:03), video 1:24:08
- **Why:** Ferrari team-mates: LEC on fresh softs after a VSC stop takes 7.68→0.47 s out of HAM over laps 41–45 and passes for P2 on lap 46 (16 from the end of 62). Also fits category 7

#### C5: NOR catches and passes ANT for the lead, Hungary 2026

- **Race:** 2026 Hungarian Grand Prix · session 11342 · meeting 1291 · 70 laps
- **Drivers:** ANT (12) and NOR (1) · **laps** 41–46
- **When:** UTC 1785074448734–1785074958547 (14:00:48–14:09:18), video 1:05:55–1:14:25
- **Gap of NOR behind ANT** at each lap's end (s; negative = NOR ahead), positions ANT/NOR, tyres ANT/NOR:
  L41 +5.12 (P1/P3, H19/H2) · L42 +3.28 (P1/P2, H20/H3) · L43 +1.69 (P1/P2, H21/H4) · L44 +0.34 (P1/P2, H22/H5) · L45 +0.41 (P1/P2, H23/H6) · L46 -2.41 (P2/P1, H24/H7)
- **NOR passes ANT (t_overtakes, for the lead):** UTC 1785074891045 (14:08:11), video 1:13:17
- **Why:** NOR on fresh hards takes 5.12→0.34 s out of the leader ANT over laps 41–44 and passes for the lead on lap 46 (24 from the end of 70). A lead change, so a stronger hint of the result than C1

### 3. Restarts

#### R1: Safety car restart: VER and RUS pass ANT, Malaysia 2026

- **Race:** 2026 Bahrain Grand Prix in Malaysia · session 11731 · meeting 1308 · 56 laps
- **Safety car deployed (L9):** UTC 1791103935923 (08:52:15), video 1:57:22
- **SAFETY CAR IN THIS LAP:** UTC 1791104330000 (08:58:50), video 2:03:56
- **Green (AllClear), restart:** UTC 1791104416501 (09:00:16), video 2:05:22
- **VER passes ANT for the lead (t_overtakes):** UTC 1791104465956 (09:01:05), video 2:06:12
- **RUS passes ANT (t_overtakes):** UTC 1791104480352 (09:01:20), video 2:06:26
- **Order at the end of lap 12:** ANT +0.00, VER +0.25, RUS +0.47, HAD +1.34, LAW +1.88, OCO +2.54, LIN +2.97, SAI +3.21
- **Order at the end of lap 13:** VER +0.00, RUS +0.84, ANT +1.38, HAD +3.39, LAW +5.00, OCO +6.63, LIN +7.41, BOR +8.58
- **Order at the end of lap 14:** VER +0.00, RUS +1.09, ANT +1.95, HAD +4.09, LAW +7.12, OCO +8.91, LIN +10.54, PIA +12.20
- **Why:** The best restart: wet race, the field pits for slicks under the safety car, and at the green VER (0.25 s behind) passes ANT for the lead and RUS passes him for P2, both within seconds of the green. Lap 12 of 56. The race had a long delayed start and an early red flag, so the video's lights-out is 1:38:07 in (sessionStartSec 5887)

#### R2: Two safety car restarts in eight laps, Azerbaijan 2026

- **Race:** 2026 Azerbaijan Grand Prix · session 11377 · meeting 1295 · 51 laps
- **Safety car deployed (L31):** UTC 1790423885810 (11:58:05), video 1:03:12
- **SAFETY CAR IN THIS LAP:** UTC 1790424555000 (12:09:15), video 1:14:22
- **Green, first restart:** UTC 1790424674061 (12:11:14), video 1:16:21
- **Safety car again (L36):** UTC 1790424759911 (12:12:39), video 1:17:47
- **SAFETY CAR IN THIS LAP:** UTC 1790425026000 (12:17:06), video 1:22:13
- **Green, second restart:** UTC 1790425132881 (12:18:52), video 1:24:00
- **Order at the end of lap 35:** RUS +0.00, PIA +0.28, VER +0.45, HAD +0.79, LEC +0.96, HAM +1.15, GAS +1.25, ANT +1.40
- **Order at the end of lap 38:** RUS +0.00, VER +0.31, LEC +0.77, PIA +0.90, HAD +0.96, HAM +1.24, ANT +1.36, OCO +2.61
- **Order at the end of lap 39:** RUS +0.00, VER +0.34, PIA +2.38, HAD +2.58, LEC +3.12, HAM +3.74, ANT +4.42, OCO +5.09
- **Why:** Two restarts in eight laps with the top seven inside 1.4 s each time. The first lasts ~85 s before the second safety car. Second green at lap 38 of 51 (13 from the end)

#### R3: Red flag and standing restart, Mexico 2026

- **Race:** 2026 Mexico City Grand Prix · session 11404 · meeting 1298 · 71 laps
- **Safety car deployed (L44):** UTC 1793567046358 (21:04:06), video 1:09:13
- **Red flag:** UTC 1793567162336 (21:06:02), video 1:11:09
- **SESSION STARTED (resumption behind the safety car):** UTC 1793569500156 (21:45:00), video 1:50:07
- **STANDING START message:** UTC 1793569554000 (21:45:54), video 1:51:00
- **Green (AllClear):** UTC 1793569616687 (21:46:56), video 1:52:03
- **Leader crosses the line, end of lap 46:** UTC 1793569627260 (21:47:07), video 1:52:14
- **Order at the end of lap 47:** VER +0.00, HAM +0.71, LEC +1.82, ANT +2.17, NOR +2.61, RUS +3.15, LIN +3.86, PIA +4.42
- **Order at the end of lap 48:** VER +0.00, HAM +0.47, ANT +1.90, LEC +3.15, NOR +3.60, RUS +4.38, LIN +5.15, PIA +5.49
- **Order at the end of lap 50:** VER +0.00, HAM +0.67, ANT +2.01, LEC +4.08, NOR +4.52, RUS +5.97, LIN +7.24, PIA +7.98
- **Why:** A red flag, then a standing restart: VER, HAM 0.71 s, LEC 1.82 s, the top eight inside 4.4 s. The exact lights-out isn't in the data: the session restarts behind the safety car at 21:45:00 UTC, race control says STANDING START at 21:45:54, the track goes green at 21:46:56, and the leader crosses the line at 21:47:07. Check the frame on the video. Lap 46 of 71

#### R4: Safety car restart, LEC leads NOR, Miami 2026

- **Race:** 2026 Miami Grand Prix · session 11280 · meeting 1284 · 57 laps
- **Safety car deployed (L6):** UTC 1777828334823 (17:12:14), video 0:17:22
- **SAFETY CAR IN THIS LAP:** UTC 1777829047000 (17:24:07), video 0:29:14
- **Green, restart:** UTC 1777829133668 (17:25:33), video 0:30:40
- **Order at the end of lap 11:** LEC +0.00, NOR +0.77, ANT +1.07, RUS +1.67, PIA +2.12, HAM +2.46, COL +2.98, ALB +3.53
- **Order at the end of lap 12:** LEC +0.00, NOR +0.43, ANT +1.23, PIA +2.60, RUS +3.69, HAM +4.31, COL +5.25, ALB +5.74
- **Why:** LEC leads NOR by 0.77 s and ANT at the restart, the top eight inside 3.5 s; NOR 0.43 s behind a lap later. Early (lap 11 of 57)

#### R5: Safety car restart, China 2026

- **Race:** 2026 Chinese Grand Prix · session 11245 · meeting 1280 · 56 laps
- **Safety car deployed (L10):** UTC 1773559204548 (07:20:04), video 0:25:11
- **SAFETY CAR IN THIS LAP:** UTC 1773559571000 (07:26:11), video 0:31:18
- **Green, restart:** UTC 1773559670374 (07:27:50), video 0:32:57
- **Order at the end of lap 13:** ANT +0.00, COL +0.62, OCO +0.72, RUS +1.34, HAM +1.59, LIN +2.08, LEC +2.36, HUL +2.56
- **Order at the end of lap 14:** ANT +0.00, COL +1.19, HAM +1.64, OCO +2.33, RUS +3.06, LEC +3.25, LIN +3.94, BEA +4.22
- **Why:** Restart with a mixed-up order (COL and OCO P2/P3 on a different strategy), top eight inside 2.6 s. Lap 13 of 56

#### R6: Safety car restart, Japan 2026

- **Race:** 2026 Japanese Grand Prix · session 11253 · meeting 1281 · 53 laps
- **Safety car deployed (L22):** UTC 1774763291661 (05:48:11), video 0:43:18
- **SAFETY CAR IN THIS LAP:** UTC 1774764006000 (06:00:06), video 0:55:12
- **Green, restart:** UTC 1774764084798 (06:01:24), video 0:56:31
- **Order at the end of lap 27:** ANT +0.00, PIA +0.98, RUS +1.42, HAM +1.59, LEC +1.99, NOR +2.63, GAS +3.57, VER +3.71
- **Order at the end of lap 28:** ANT +0.00, PIA +1.58, HAM +2.05, RUS +2.89, LEC +3.54, NOR +4.17, GAS +5.54, VER +5.79
- **Why:** Restart with ANT leading PIA by 0.98 s, top eight inside 3.7 s. Lap 27 of 53

### 4. Tyre deg

#### D1: The top three fade on 30-lap softs, then pit, Singapore 2026

- **Race:** 2026 Singapore Grand Prix · session 11388 · meeting 1296 · 62 laps
- **Laps** 20–32 · UTC 1791722102119–1791723380286 (12:35:02–12:56:20), video 0:40:07–1:01:25
  - VER (3), P1 at lap 32, S20→S32: 97.58 97.68 97.70 97.57 97.61 97.54 97.62 97.93 97.47 97.66 97.95 99.91 103.90
  - NOR (1), P3 at lap 32, S20→S32: 98.00 97.88 98.35 98.22 98.08 97.88 98.31 98.39 98.34 98.47 98.74 99.52 104.75
  - PIA (81), P2 at lap 32, S20→S32: 98.05 97.89 98.39 98.37 98.74 98.09 98.13 98.21 98.67 98.45 98.81 99.96 99.01
- **Why:** The top three all on softs 30+ laps old, flat until lap 29 and then fading (VER +0.9 s, PIA +0.9, NOR +0.7 against their own set medians), then they pit on laps 32–33: deg and the pit window in one clip. Lap 31 is under a yellow (hatched in tyre_deg). Mid-race (lap 32 of 62)

#### D5: Seven of the top ten fade on hards, Barcelona 2026 (later)

- **Race:** 2026 Barcelona-Catalunya Grand Prix · session 11307 · meeting 1287 · 66 laps
- **Laps** 47–55 · UTC 1781446075469–1781446802253 (14:07:55–14:20:02), video 1:13:02–1:25:09
  - HAM (44), P1 at lap 55, H6→H14: 80.18 80.31 80.88 80.29 80.99 80.77 81.27 80.98 81.06
  - NOR (1), P4 at lap 55, H12→H20: 80.95 81.20 81.26 80.96 81.25 81.61 81.81 81.81 81.96
  - LEC (16), P6 at lap 55, H8→H16: 80.38 81.02 80.88 82.38 81.68 82.15 81.88 82.01 82.02
  - PIA (81), P7 at lap 55, H11→H19: 80.99 81.30 81.15 82.85 81.90 82.37 82.04 82.29 82.37
  - GAS (10), P9 at lap 55, H7→H15: 83.12 82.79 82.99 83.11 83.19 84.55 85.00 83.43 83.37
  - COL (43), P10 at lap 55, H13→H21: 83.32 83.80 86.13 83.74 83.53 83.78 85.14 83.87 83.93
- **Why:** The clearest fade: seven of the top ten on hards 0.6–1.3 s off their medians (LEC 80.4→82.0, PIA 81.0→82.4). Late, though: lap 55 of 66 is just inside the last-10 cut

#### D2: Leaders fade on hards mid-race, Barcelona 2026

- **Race:** 2026 Barcelona-Catalunya Grand Prix · session 11307 · meeting 1287 · 66 laps
- **Laps** 22–32 · UTC 1781443964749–1781444878896 (13:32:44–13:47:58), video 0:37:52–0:53:06
  - RUS (63), P1 at lap 32, H10→H20: 82.72 83.25 82.80 83.03 82.91 83.14 83.18 83.21 83.65 83.33 82.88
  - NOR (1), P3 at lap 32, H9→H19: 82.02 82.28 82.44 82.46 82.66 82.91 82.66 83.25 83.16 82.95 83.60
  - PIA (81), P6 at lap 32, H8→H18: 82.94 82.90 82.91 83.04 82.77 82.85 83.28 83.67 83.61 83.34 83.83
  - HAD (6), P8 at lap 32, H7→H17: 82.78 82.95 82.99 83.27 83.26 83.28 83.70 83.76 84.18 84.57 87.72
  - GAS (10), P10 at lap 32, H8→H18: 83.99 84.10 85.13 84.61 84.65 85.12 85.14 84.78 84.59 84.73 84.88
- **Why:** Mid-race on hards: RUS, NOR, PIA, HAD and GAS 0.6–0.9 s off their set medians by lap 30–32. Real but mild

#### D4: Leaders fade on hards, Netherlands 2026

- **Race:** 2026 Dutch Grand Prix · session 11353 · meeting 1292 · 72 laps
- **Laps** 30–38 · UTC 1787494325058–1787495014901 (14:12:05–14:23:34), video 1:17:11–1:28:41
  - ANT (12), P1 at lap 38, H9→H17: 76.47 76.08 76.44 76.60 76.40 76.84 77.47 77.14 76.41
  - NOR (1), P2 at lap 38, H9→H17: 76.22 76.32 76.40 76.82 76.47 76.65 78.05 76.69 76.33
  - HAM (44), P5 at lap 38, H5→H13: 76.01 75.67 75.57 75.92 77.95 77.42 76.43 75.97 76.10
  - PIA (81), P6 at lap 38, H12→H20: 76.73 76.95 76.90 77.50 79.31 79.20 77.96 77.75 77.34
- **Why:** ANT and NOR (P1/P2) and HAM and PIA on hards, 0.6–2 s off their medians. The weather feed shows rain on and off in this race, and laps 34–35 look like a weather or traffic spike rather than wear

#### D3: A pack of 40-lap mediums falls away, Monaco 2026

- **Race:** 2026 Monaco Grand Prix · session 11299 · meeting 1286 · 78 laps
- **Laps** 33–41 · UTC 1780839857836–1780840570005 (13:44:17–13:56:10), video 0:49:25–1:01:17
  - GAS (10), P5 at lap 41, M33→M41: 78.81 78.66 78.33 78.18 78.95 79.07 79.23 79.02 78.93
  - NOR (1), P6 at lap 41, M33→M41: 80.23 77.67 77.83 78.22 78.74 79.01 79.31 78.95 80.88
  - ALB (23), P10 at lap 41, M33→M41: 79.51 79.67 79.62 79.33 79.44 79.89 82.77 79.73 79.42
  - SAI (55), P11 at lap 41, M33→M41: 81.64 81.94 81.90 81.60 81.22 81.45 83.08 81.83 82.59
  - LIN (41), P12 at lap 41, M33→M41: 80.07 80.97 81.76 81.07 81.12 81.74 82.85 81.81 82.62
  - HUL (27), P13 at lap 41, H22→H30: 79.01 80.30 81.58 80.94 81.16 82.70 81.96 82.43 81.90
  - OCO (31), P14 at lap 41, H25→H33: 78.89 79.76 81.49 80.97 81.17 82.64 81.87 82.98 81.35
- **Why:** The biggest numbers (seven cars 1.5–3.9 s off their medians on 40-lap mediums at lap 39–41), but at Monaco some of that is cars stuck behind each other, not wear. Check the video before using it

### 5. Pit window and pit lane

#### P1: LEC pits from the lead, Barcelona 2026

- **Race:** 2026 Barcelona-Catalunya Grand Prix · session 11307 · meeting 1287 · 66 laps
- **Driver:** LEC (16) · in-lap 16, out-lap 17 · lane 22.249 s, stop time not in the feed
- **Run-up to the stop** (two laps before the in-lap to the end of the out-lap): UTC 1781443298833–1781443656745 (13:21:38–13:27:36), video 0:26:46–0:32:44
- **In the pit lane** (≈ pit `date` minus `lane_duration`, to `date`): UTC 1781443551962–1781443574211 (13:25:51–13:26:14), video 0:30:59–0:31:21
- **Order at the end of lap 15** (gap behind LEC): P1 LEC +0.0, P2 RUS +4.3, P3 HAM +5.9, P4 ANT +12.4, P5 NOR +13.6, P6 VER +16.9, P7 HAD +24.8, P8 PIA +26.7, P9 LIN +28.6
- **Rejoined:** P6 at the end of lap 17, between NOR -12.1, VER -8.3, PIA +1.6, LIN +10.2
- **Why:** The best pit window: LEC leads on 15-lap mediums after everyone else has stopped; RUS 4.3 s and HAM 5.9 s behind, ANT 12.4, NOR 13.6, VER 16.9, HAD 24.8. With a ~23 s loss he rejoins P6, between VER (8.3 s ahead) and PIA (1.6 s behind).

#### P2: VER and LEC pit together from P1 and P2, Mexico 2026

- **Race:** 2026 Mexico City Grand Prix · session 11404 · meeting 1298 · 71 laps
- **Driver:** LEC (16) · in-lap 27, out-lap 28 · lane 28.706 s, stop 8.7 s
- **Run-up to the stop** (two laps before the in-lap to the end of the out-lap): UTC 1793565404745–1793565759564 (20:36:44–20:42:39), video 0:41:51–0:47:46
- **In the pit lane** (≈ pit `date` minus `lane_duration`, to `date`): UTC 1793565650537–1793565679243 (20:40:50–20:41:19), video 0:45:57–0:46:26
- **Order at the end of lap 26** (gap behind LEC): P1 LEC +0.0, P2 VER +5.0, P3 HAM +7.6, P4 ANT +10.0, P5 RUS +13.4, P6 NOR +14.4, P7 PIA +27.4, P8 LIN +33.7, P9 COL +37.6
- **Rejoined:** P6 at the end of lap 28, between NOR -13.5, VER -1.6, LIN +6.7, COL +10.8
- **Why:** VER (P2) and LEC (P1) pit on the same lap and are in the pit lane together; LEC's stop is 8.7 s against VER's 2.3, so VER comes out 1.6 s ahead of him. The best 'show whoever's pitting'. Lap 27 of 71

#### P2b: VER's stop on the same lap, Mexico 2026

- **Race:** 2026 Mexico City Grand Prix · session 11404 · meeting 1298 · 71 laps
- **Driver:** VER (3) · in-lap 27, out-lap 28 · lane 22.466 s, stop 2.3 s
- **Run-up to the stop** (two laps before the in-lap to the end of the out-lap): UTC 1793565410035–1793565757982 (20:36:50–20:42:37), video 0:41:56–0:47:44
- **In the pit lane** (≈ pit `date` minus `lane_duration`, to `date`): UTC 1793565655162–1793565677628 (20:40:55–20:41:17), video 0:46:02–0:46:24
- **Order at the end of lap 26** (gap behind VER): P1 LEC -5.0, P2 VER +0.0, P3 HAM +2.7, P4 ANT +5.1, P5 RUS +8.5, P6 NOR +9.5, P7 PIA +22.5, P8 LIN +28.8, P9 COL +32.6, P10 HUL +37.5
- **Rejoined:** P5 at the end of lap 28, between RUS -13.0, NOR -11.9, LEC +1.6, LIN +8.3
- **Why:** The other half of P2

#### P4: PIA pits from the lead, Hungary 2026

- **Race:** 2026 Hungarian Grand Prix · session 11342 · meeting 1291 · 70 laps
- **Driver:** PIA (81) · in-lap 16, out-lap 17 · lane 21.7 s, stop time not in the feed
- **Run-up to the stop** (two laps before the in-lap to the end of the out-lap): UTC 1785072114001–1785072478665 (13:21:54–13:27:58), video 0:27:00–0:33:05
- **In the pit lane** (≈ pit `date` minus `lane_duration`, to `date`): UTC 1785072372152–1785072393852 (13:26:12–13:26:33), video 0:31:18–0:31:40
- **Order at the end of lap 15** (gap behind PIA): P1 PIA +0.0, P2 NOR +1.1, P3 LEC +7.3, P4 ANT +9.0, P5 HAD +18.4, P6 HAM +24.4, P7 LAW +24.6, P8 VER +25.0, P9 LIN +29.9
- **Rejoined:** P4 at the end of lap 17, between ANT -12.7, HAD -0.8, VER +1.4, HAM +2.1
- **Why:** The leader PIA pits, and NOR (P2, 1.1 s back) stays out a lap: P4b

#### P4b: NOR pits from the lead a lap later, Hungary 2026

- **Race:** 2026 Hungarian Grand Prix · session 11342 · meeting 1291 · 70 laps
- **Driver:** NOR (1) · in-lap 17, out-lap 18 · lane 22.1 s, stop time not in the feed
- **Run-up to the stop** (two laps before the in-lap to the end of the out-lap): UTC 1785072200805–1785072565418 (13:23:20–13:29:25), video 0:28:27–0:34:32
- **In the pit lane** (≈ pit `date` minus `lane_duration`, to `date`): UTC 1785072458440–1785072480540 (13:27:38–13:28:00), video 0:32:45–0:33:07
- **Order at the end of lap 16** (gap behind NOR): P1 NOR +0.0, P2 PIA +1.8, P3 ANT +8.2, P4 LEC +9.4, P5 HAD +18.5, P6 VER +22.9, P7 HAM +23.8, P8 LAW +26.8, P9 LIN +30.7
- **Rejoined:** P4 at the end of lap 18, between HAD -0.6, PIA -0.4, VER +0.6, HAM +1.1
- **Why:** NOR pits from the lead a lap after PIA and rejoins P4: 0.6 s behind HAD and 0.4 s behind PIA, with VER 0.6 s and HAM 1.1 s behind him, five cars inside 1.7 s

#### P3: LEC pits from P3 on the same lap as the leader, Hungary 2026

- **Race:** 2026 Hungarian Grand Prix · session 11342 · meeting 1291 · 70 laps
- **Driver:** LEC (16) · in-lap 16, out-lap 17 · lane 21.931 s, stop 2.4 s
- **Run-up to the stop** (two laps before the in-lap to the end of the out-lap): UTC 1785072120426–1785072486149 (13:22:00–13:28:06), video 0:27:07–0:33:12
- **In the pit lane** (≈ pit `date` minus `lane_duration`, to `date`): UTC 1785072379749–1785072401680 (13:26:19–13:26:41), video 0:31:26–0:31:48
- **Order at the end of lap 15** (gap behind LEC): P1 PIA -7.3, P2 NOR -6.3, P3 LEC +0.0, P4 ANT +1.7, P5 HAD +11.0, P6 HAM +17.0, P7 LAW +17.2, P8 VER +17.6, P9 LIN +22.6, P10 HUL +24.0, P11 RUS +24.4
- **Rejoined:** P7 at the end of lap 17, between VER -6.1, HAM -5.3, LAW +0.5, LIN +4.4
- **Why:** LEC pits from P3 on the same lap as the leader PIA (both in the pit lane at once) and rejoins P7, 0.5 s ahead of LAW and 5.3 s behind HAM

#### P5: LEC pits from P2, rejoins next to HAM, Singapore 2026

- **Race:** 2026 Singapore Grand Prix · session 11388 · meeting 1296 · 62 laps
- **Driver:** LEC (16) · in-lap 24, out-lap 25 · lane 24.641 s, stop 3.1 s
- **Run-up to the stop** (two laps before the in-lap to the end of the out-lap): UTC 1791722304138–1791722721480 (12:38:24–12:45:21), video 0:43:29–0:50:26
- **In the pit lane** (≈ pit `date` minus `lane_duration`, to `date`): UTC 1791722599513–1791722624154 (12:43:19–12:43:44), video 0:48:24–0:48:49
- **Order at the end of lap 23** (gap behind LEC): P1 VER -8.3, P2 LEC +0.0, P3 NOR +6.8, P4 PIA +8.8, P5 ANT +10.7, P6 HAM +25.1, P7 LAW +33.2, P8 HUL +35.9, P9 GAS +37.3, P10 BEA +39.0
- **Rejoined:** P4 at the end of lap 25, between NOR -17.7, PIA -14.7, HAM +0.8, ANT +3.3
- **Why:** LEC pits from P2 and rejoins P4, 0.8 s ahead of HAM

### 6. Norris

C5 and B8 are above.

#### N1: NOR hunts the leader ANT, Miami 2026

- **Race:** 2026 Miami Grand Prix · session 11280 · meeting 1284 · 57 laps
- **Drivers:** ANT (12) and NOR (1) · **laps** 29–43
- **When:** UTC 1777830763348–1777832149947 (17:52:43–18:15:49), video 0:57:50–1:20:57
- **Gap of NOR behind ANT** at each lap's end (s; negative = NOR ahead), positions ANT/NOR, tyres ANT/NOR:
  L29 +1.17 (P1/P2, H3/H2) · L30 +1.20 (P1/P2, H4/H3) · L31 +1.16 (P1/P2, H5/H4) · L32 +1.22 (P1/P2, H6/H5) · L33 +1.24 (P1/P2, H7/H6) · L34 +1.48 (P1/P2, H8/H7) · L35 +0.92 (P1/P2, H9/H8) · L36 +0.92 (P1/P2, H10/H9) · L37 +0.73 (P1/P2, H11/H10) · L38 +0.65 (P1/P2, H12/H11) · L39 +0.96 (P1/P2, H13/H12) · L40 +0.48 (P1/P2, H14/H13) · L41 +0.98 (P1/P2, H15/H14) · L42 +1.27 (P1/P2, H16/H15) · L43 +1.49 (P1/P2, H17/H16)
- **Why:** NOR hunting the leader ANT for 15 laps: 0.48–1.48 s, both on hards a lap apart, no pass. Mid-race (laps 29–43 of 57)

#### N2: NOR on fresh hards, closing on the leader ANT, Netherlands 2026

- **Race:** 2026 Dutch Grand Prix · session 11353 · meeting 1292 · 72 laps
- **Drivers:** ANT (12) and NOR (1) · **laps** 48–54
- **When:** UTC 1787495708340–1787496252499 (14:35:08–14:44:12), video 1:40:15–1:49:19
- **Gap of NOR behind ANT** at each lap's end (s; negative = NOR ahead), positions ANT/NOR, tyres ANT/NOR:
  L48 +4.97 (P2/P3, H8/H1) [AllClear pit] · L49 +3.30 (P2/P3, H9/H2) · L50 +1.70 (P2/P3, H10/H3) · L51 +0.45 (P2/P3, H11/H4) · L52 +0.30 (P2/P3, H12/H5) · L53 +0.17 (P2/P3, H13/H6) · L54 -1.25 (P3/P1, H14/H7)
- **NOR passes ANT (t_overtakes, for P2):** UTC 1787496183513 (14:43:03), video 1:48:10
- **Why:** NOR pits from the lead on lap 47, then on fresh hards takes 4.97→0.17 s out of ANT in 5 laps, passes him, and leads at the end of lap 54 (18 from the end of 72)

#### N3: NOR stalks RUS for 20 laps, Mexico 2026

- **Race:** 2026 Mexico City Grand Prix · session 11404 · meeting 1298 · 71 laps
- **Drivers:** RUS (63) and NOR (1) · **laps** 11–32
- **When:** UTC 1793564276714–1793566072938 (20:17:56–20:47:52), video 0:23:03–0:52:59
- **Gap of NOR behind RUS** at each lap's end (s; negative = NOR ahead), positions RUS/NOR, tyres RUS/NOR:
  L11 +1.29 (P5/P6, S14/S11) · L12 +0.92 (P5/P6, S15/S12) · L13 +0.80 (P5/P6, S16/S13) · L14 +0.74 (P5/P6, S17/S14) · L15 +0.78 (P5/P6, S18/S15) · L16 +0.91 (P5/P6, S19/S16) · L17 +1.01 (P5/P6, S20/S17) · L18 +1.04 (P5/P6, S21/S18) · L19 +0.98 (P5/P6, S22/S19) · L20 +0.77 (P5/P6, S23/S20) · L21 +0.85 (P5/P6, S24/S21) · L22 +0.87 (P5/P6, S25/S22) · L23 +0.95 (P5/P6, S26/S23) · L24 +1.05 (P5/P6, S27/S24) · L25 +1.12 (P5/P6, S28/S25) · L26 +0.99 (P5/P6, S29/S26) · L27 +0.89 (P5/P6, S30/S27) · L28 +1.06 (P3/P4, S31/S28) · L29 +1.09 (P2/P3, S32/S29) · L30 +0.79 (P2/P3, S33/S30) · L31 +0.82 (P2/P3, S34/S31) · L32 +0.93 (P2/P3, S35/S32)
- **Why:** NOR 0.74–1.3 s behind RUS for P6 for 22 laps. Long and steady; a quieter option

### 7. HAM vs LEC

C4 is above.

#### F1: HAM vs LEC, six swaps for P2 to P4, China 2026

- **Race:** 2026 Chinese Grand Prix · session 11245 · meeting 1280 · 56 laps
- **Drivers:** HAM (44) and LEC (16) · **laps** 19–42
- **When:** UTC 1773560183656–1773562515106 (07:36:23–08:15:15), video 0:41:30–1:20:22
- **Gap of LEC behind HAM** at each lap's end (s; negative = LEC ahead), positions HAM/LEC, tyres HAM/LEC:
  L19 +1.47 (P2/P3, H9/H9) · L20 +1.34 (P2/P3, H10/H10) · L21 +1.03 (P2/P3, H11/H11) · L22 +0.91 (P2/P3, H12/H12) · L23 +0.66 (P2/P3, H13/H13) · L24 -0.58 (P3/P2, H14/H14) · L25 -0.50 (P3/P2, H15/H15) · L26 +0.36 (P2/P3, H16/H16) · L27 -1.22 (P4/P2, H17/H17) · L28 -1.23 (P4/P2, H18/H18) · L29 -0.89 (P4/P3, H19/H19) · L30 -0.92 (P4/P3, H20/H20) · L31 -0.86 (P4/P3, H21/H21) · L32 -0.82 (P4/P3, H22/H22) · L33 -0.80 (P4/P3, H23/H23) · L34 -0.86 (P4/P3, H24/H24) · L35 +0.39 (P3/P4, H25/H25) · L36 +0.47 (P3/P4, H26/H26) · L37 +0.59 (P3/P4, H27/H27) · L38 +0.52 (P3/P4, H28/H28) · L39 -0.57 (P4/P3, H29/H29) · L40 +0.86 (P3/P4, H30/H30) · L41 +1.03 (P3/P4, H31/H31) · L42 +1.28 (P3/P4, H32/H32)
- **LEC passes HAM (t_overtakes), first swap:** UTC 1773560756431 (07:45:56), video 0:51:03
- **HAM back past LEC, last of that flurry:** UTC 1773561007736 (07:50:07), video 0:55:14
- **HAM passes LEC for P3:** UTC 1773561824554 (08:03:44), video 1:08:51
- **LEC passes HAM:** UTC 1773562213114 (08:10:13), video 1:15:20
- **HAM back past:** UTC 1773562235837 (08:10:35), video 1:15:42
- **Why:** The best HAM–LEC: P2 to P4 on hards, no stops, 0.36–0.92 s apart most laps, and the order between them changes at the line on laps 24, 26, 27, 35, 39 and 40 (t_overtakes has more within laps 24–26). Laps 19–42 of 56

#### F3: LEC follows HAM for P4, Hungary 2026

- **Race:** 2026 Hungarian Grand Prix · session 11342 · meeting 1291 · 70 laps
- **Drivers:** HAM (44) and LEC (16) · **laps** 3–12
- **When:** UTC 1785071177077–1785072034524 (13:06:17–13:20:34), video 0:11:23–0:25:41
- **Gap of LEC behind HAM** at each lap's end (s; negative = LEC ahead), positions HAM/LEC, tyres HAM/LEC:
  L3 +0.73 (P4/P5, S3/S6) · L4 +0.83 (P4/P5, S4/S7) · L5 +0.77 (P4/P5, S5/S8) · L6 +0.96 (P4/P5, S6/S9) · L7 +0.97 (P4/P5, S7/S10) · L8 +1.05 (P4/P5, S8/S11) · L9 +0.55 (P4/P5, S9/S12) · L10 +1.01 (P4/P5, S10/S13) · L11 +1.29 (P4/P5, S11/S14) · L12 +1.42 (P4/P5, S12/S15)
- **Why:** LEC 0.55–1.05 s behind HAM for P5 for 8 laps. Same race as B4: HAM, VER and LEC in one train

#### F2: HAM follows LEC for P5, Netherlands 2026

- **Race:** 2026 Dutch Grand Prix · session 11353 · meeting 1292 · 72 laps
- **Drivers:** LEC (16) and HAM (44) · **laps** 5–17
- **When:** UTC 1787492326259–1787493396530 (13:38:46–13:56:36), video 0:43:53–1:01:43
- **Gap of HAM behind LEC** at each lap's end (s; negative = HAM ahead), positions LEC/HAM, tyres LEC/HAM:
  L5 +0.37 (P5/P6, S3/S6) · L6 +0.49 (P5/P6, S4/S7) · L7 +0.87 (P5/P6, S5/S8) · L8 +0.85 (P5/P6, S6/S9) · L9 +0.88 (P5/P6, S7/S10) · L10 +1.22 (P5/P6, S8/S11) · L11 +0.83 (P5/P6, S9/S12) · L12 +0.99 (P5/P6, S10/S13) · L13 +1.00 (P5/P6, S11/S14) · L14 +0.89 (P5/P6, S12/S15) · L15 +0.94 (P5/P6, S13/S16) · L16 +1.30 (P5/P6, S14/S17) · L17 +1.20 (P4/P5, S15/S18)
- **Why:** HAM 0.37–1.3 s behind LEC for P6 for 13 laps on softs

#### F4: LEC closes on HAM for P3, Japan 2026

- **Race:** 2026 Japanese Grand Prix · session 11253 · meeting 1281 · 53 laps
- **Drivers:** HAM (44) and LEC (16) · **laps** 35–42
- **When:** UTC 1774764765182–1774765516216 (06:12:45–06:25:16), video 1:07:51–1:20:22
- **Gap of LEC behind HAM** at each lap's end (s; negative = LEC ahead), positions HAM/LEC, tyres HAM/LEC:
  L35 +1.17 (P3/P5, H13/H18) · L36 +1.24 (P3/P5, H14/H19) · L37 +1.11 (P3/P4, H15/H20) · L38 +0.72 (P3/P4, H16/H21) · L39 +0.62 (P3/P4, H17/H22) · L40 +0.47 (P3/P4, H18/H23) · L41 +0.46 (P3/P4, H19/H24) · L42 -0.90 (P4/P3, H20/H25)
- **Why:** LEC on older hards closes 1.24→0.46 s on HAM and passes him for P3 on lap 42 (11 from the end of 53: right at the cut)

### 8. Speed ribbon

#### SR1: HAM's lap of Suzuka, the Esses without a brake, Japan 2026

- **Race:** 2026 Japanese Grand Prix · session 11253 · 53 laps
- **Driver:** HAM (44), lap 34 (93.301 s), P3, 0.93 s behind PIA and 0.98 s ahead of RUS, hards on their 12th lap
- **When:** UTC 1774764671902–1774764765182 (06:11:11–06:12:45), video 1:06:18–1:07:51; seek to 1:07:52 (UTC 1774764766182), a second after the lap ends
- **Telemetry:** 7 brakes, top 328 km/h, slowest 71 km/h. From about 1050 m, 13.4 s with the throttle between 0 and 99% and no
  brake, 228 km/h falling to 168 and back. HAM's lap 33 is the same.
- **Compare (SR1b):** ANT, leading on lap 43 (92.538 s), brakes twice in the same stretch (about 16 s and 22 s into the lap).
  UTC 1774765502817–1774765595683 (06:25:02–06:26:35), video 1:20:09–1:21:42; seek to 1:21:43 (UTC 1774765596683), a second after the lap ends
- **Why:** Suzuka's figure of eight is the most recognisable shape here, and the Esses read at once as a long stretch of
  half-strength green. RUS's lap 34 next to it is SP2.

#### SR2: HAM at Monza, Italy 2026

- **Race:** 2026 Italian Grand Prix · session 11361 · 53 laps
- **Driver:** HAM (44), lap 23 (85.300 s), P4, 3.84 s behind VER, mediums on their 20th lap
- **When:** UTC 1788703815650–1788703900647 (14:10:15–14:11:40), video 1:15:22–1:16:47; seek to 1:16:48 (UTC 1788703901647), a second after the lap ends
- **Telemetry:** 6 brakes (turn 1 from 292 km/h to 81 with a dab inside it, the second chicane, a touch at Lesmo, Ascari,
  Parabolica, by distance), top 343, no lift above
  200 km/h. Approaching turn 1 the speed falls from 342 to 312 km/h in the last 1.5 s with the throttle at 99%.
- **Why:** The widest, simplest ribbon: long full-width straights and a few short red marks.

#### SR3: LEC leads at Spa, Belgium 2026

- **Race:** 2026 Belgian Grand Prix · session 11334 · 44 laps
- **Driver:** LEC (16), lap 23 (109.333 s), P1, hards on their 3rd lap
- **When:** UTC 1784468898573–1784469007758 (13:48:18–13:50:07), video 0:53:19–0:55:08; seek to 0:55:09 (UTC 1784469008758), a second after the lap ends
- **Telemetry:** 7 brakes, top 341 km/h, slowest 72. One lift above 220 km/h: 1.04 s from 267 at about 3730 m.
- **Also (SR3b):** HAM's lap 33 (109.454 s), P5, 3.7 s behind PIA. UTC 1784470011350–1784470120856 (14:06:51–14:08:40), video 1:11:52–1:13:41; seek to 1:13:42 (UTC 1784470121856), a second after the lap ends
- **Why:** Spa's long lap at full width. Leading on lap 23 of 44 gives no result away.

#### SR4: HAM at Silverstone, Britain 2026

- **Race:** 2026 British Grand Prix · session 11326 · 52 laps
- **Driver:** HAM (44), lap 25 (92.309 s), P6, 0.82 s behind RUS, hards on their 2nd lap
- **When:** UTC 1783262544549–1783262636727 (14:42:24–14:43:56), video 0:47:30–0:49:03; seek to 0:49:04 (UTC 1783262637727), a second after the lap ends
- **Telemetry:** 8 brakes, top 317 km/h, slowest 83. Lifts of 1.76 s from 293 km/h at about 2950 m and 0.6 s from 247 at about
  3810 m.
- **Why:** A lift you can see, at a famous corner. HAM's barcode on this circuit is PB1.

#### SR5: HAM at COTA, United States 2026

- **Race:** 2026 United States Grand Prix · session 11396 · 56 laps
- **Driver:** HAM (44), lap 42 (98.508 s), P5, 8.0 s behind LEC
- **When:** UTC 1792962813544–1792962911921 (21:13:33–21:15:11), video 1:18:40–1:20:18; seek to 1:20:19 (UTC 1792962912921), a second after the lap ends
- **Telemetry:** 9 brakes, top 344 km/h (the highest of these picks), slowest 74. Lifts of 1.68 s from 254 km/h at about 1215 m
  and 3.08 s from 241 at about 1385 m: the esses after turn 1.
- **Why:** The fastest top speed on a circuit people know. Lap 42 is 14 from the end.

#### SR6: NOR leads at Monaco, 2025

- **Race:** 2025 Monaco Grand Prix · session 9979 · 78 laps
- **Driver:** NOR (4), lap 44 (73.872 s), P1, hards on their 26th lap
- **When:** UTC 1748181566486–1748181640399 (13:59:26–14:00:40), video 1:04:33–1:05:47; seek to 1:05:48 (UTC 1748181641399), a second after the lap ends
- **Telemetry:** 12 brakes in 3.25 km, top 284 km/h, slowest 46 (the hairpin, at about 1150 m). One lift: 1.6 s from 223 km/h at
  about 2430 m.
- **Why:** The thinnest ribbon and the busiest red. Monaco 2026's positions stop seven minutes into the race.

#### SP2: RUS in HAM's tow at Suzuka, Japan 2026

- **Race:** 2026 Japanese Grand Prix · session 11253 · 53 laps
- **Drivers:** HAM (44) P3 and RUS (63) P4, lap 34. RUS is 0.50–0.98 s behind HAM on laps 28–36.
- **When:** HAM UTC 1774764671902–1774764765182 (06:11:11–06:12:45), video 1:06:18–1:07:51; seek to 1:07:52 (UTC 1774764766182), a second after the lap ends. RUS's lap ends 0.98 s later: seek to 1:07:53 (UTC 1774764767165).
- **Telemetry:** at turn 1 (about 610 m) RUS is at 335 km/h when he brakes and HAM at 297, and RUS brakes 91 m earlier; RUS's
  top is 339 to HAM's 328. On lap 33 RUS brakes 71 m earlier into turn 1. Only laps 33, 34 and 36 have every reading for both.
- **Why:** Two ribbons of the same lap whose red starts in visibly different places.

#### SP3: HAM in VER's tow for the lead, Mexico 2026

- **Race:** 2026 Mexico City Grand Prix · session 11404 · 71 laps
- **Drivers:** VER (3) P1 and HAM (44) P2, 0.47 s behind, lap 48, both on softs on their 6th lap
- **When:** UTC 1793569777986–1793569857786 (21:49:37–21:50:57), video 1:54:44–1:56:04; seek to 1:56:05 (UTC 1793569858786), a second after the lap ends
- **Telemetry:** at turn 1 (about 1000 m) HAM is at 341 km/h when he brakes and VER at 325, and HAM brakes 59 m earlier. Tops:
  HAM 351 to VER 342 on lap 48, 352 to 340 on lap 50. Laps 47, 48 and 56 VER lifts for about 1–1.3 s from 218 km/h at about
  2700 m; laps 50 and 54 HAM does instead.
- **Why:** The hero pair (B2), with traces that differ. 7 of B2's 10 laps have every reading for both.

#### SP1: VER on fresh hards against HAM, Italy 2026

- **Race:** 2026 Italian Grand Prix · session 11361 · 53 laps
- **Drivers:** HAM (44) P3 on 29-lap mediums and VER (3) P6 on 4-lap hards, 5.2 s behind, lap 32 (C3)
- **When:** HAM UTC 1788704620875–1788704706922 (14:23:40–14:25:06), video 1:28:48–1:30:14; seek to 1:30:15 (UTC 1788704707922), a second after the lap ends. VER's lap ends 5.2 s later: seek to 1:30:20 (UTC 1788704713141).
- **Telemetry:** at turn 1 (about 765 m) VER is at 323 km/h when he brakes and HAM at 268, and VER brakes 84 m earlier; VER lifts
  for 5.1 s from 314 km/h at about 4450 m; tops VER 334, HAM 323 (lap 33: 337 to 318).
- **Why:** The catch in C3 explained by the traces, five laps before the pass.

#### BT1: HAM stuck behind HAD, Malaysia 2026

- **Race:** 2026 Bahrain Grand Prix in Malaysia · session 11731 · 56 laps
- **Drivers:** HAD (6) P4 and HAM (44) P5, laps 36–42; HAM 1.24, 1.44, 1.05, 0.65, 1.16, 0.83, 0.83 s behind at each lap's end;
  HAD on softs, HAM on mediums
- **When:** UTC 1791106833185–1791107543519 (09:40:33–09:52:23), video 2:45:39–2:57:30; seek to 2:57:31 (UTC 1791107544519), a second after the lap ends
- **Telemetry:** on laps 36 and 39–42 (37 and 38 have missing readings) HAM is 23 km/h faster at the top on average (343 to 309
  on lap 40); HAD lifts for 3.0–4.6 s from 247–256 km/h at about 3690 m every lap, where HAM stays flat; on laps 40–42 HAM brakes
  41–58 m before HAD into turn 1 (about 460 m), arriving 47–50 km/h faster.
- **Why:** A new battle for HAM that only telemetry finds: two cars at the same pace, driven very differently. No pass on these
  laps.

### 9. Pedal barcode

#### PB1: ANT passes HAM, and HAM's lap changes, Britain 2026

- **Race:** 2026 British Grand Prix · session 11326 · 52 laps
- **Driver:** HAM (44), laps 6–11, on mediums (6th to 11th lap)
- **When:** UTC 1783260708357–1783261278241 (14:11:48–14:21:18), video 0:16:54–0:26:24; seek to 0:26:25 (UTC 1783261279241), a second after the lap ends
- **Laps:** 94.672 · 94.735 · 94.651 · 95.009 · 94.986 · 95.741. On laps 6–10 he's P2, 2.3–4.0 s behind LEC. ANT passes him for P2
  at UTC 1783261233449 (video 0:25:39), about halfway round lap 11; at its end HAM is 0.92 s behind ANT.
- **Telemetry:** laps 6–10 brake at the same seven places (about 745, 950, 1800, 2045, 3880, 4840 and 5360 m). Lap 11 adds two
  brakes, at about 2910 m (282→244 km/h) and 3750 m (262→233), and lifts at about 3600 m. Lap 12, behind ANT, still has light
  brakes at both.
- **Why:** The barcode's question, answered: five rows the same, and the sixth different where the fight was.

#### PB2: ANT's lap as RUS retakes the lead, Canada 2026

- **Race:** 2026 Canadian Grand Prix · session 11291 · 70 laps
- **Driver:** ANT (12), laps 20–25, softs (24th to 29th lap)
- **When:** UTC 1779654857634–1779655315222 (20:34:17–20:41:55), video 0:39:24–0:47:02; seek to 0:47:03 (UTC 1779655316222), a second after the lap ends
- **Laps:** 75.559 · 75.439 · 76.182 · 75.413 · 76.465 · 78.543. ANT leads laps 22–24; RUS passes him for the lead at UTC
  1779655273350 (video 0:46:20), and is 0.48 s ahead at the end of lap 25.
- **Telemetry:** on lap 25 ANT brakes at about 1760 m (1800–1845 m on the laps before), after a 2.2 s lift from 250 km/h at about
  1560 m, and at turn 1 at about 80 m (100–120 m before).
- **Why:** The lead fight in B5 from the inside of one car.

#### PB3: RUS passes LAW, Spain 2026

- **Race:** 2026 Spanish Grand Prix · session 11369 · 57 laps
- **Driver:** RUS (63), laps 30–35, hards
- **When:** UTC 1789307616126–1789308205849 (13:53:36–14:03:25), video 0:58:42–1:08:32; seek to 1:08:33 (UTC 1789308206849), a second after the lap ends
- **Laps:** 97.904 · 97.818 · 97.947 · 97.718 · 97.930 · 100.551. LAW is 4.8 s ahead after lap 30, 0.63 s after lap 34; RUS passes
  him for P5 at UTC 1789308135636 (video 1:07:22).
- **Telemetry:** the brake at about 1260 m comes on at 336 km/h and lasts 4.1 s; on laps 30–34 it's at 1325–1365 m from
  298–317 km/h for 2.0–2.7 s.
- **Why:** A different row for an obvious reason, with the pass on video.

#### PB4: VER, the same lap six times, Singapore 2026

- **Race:** 2026 Singapore Grand Prix · session 11388 · 62 laps
- **Driver:** VER (3), laps 20–25, P1, softs
- **When:** UTC 1791722102119–1791722687764 (12:35:02–12:44:47), video 0:40:07–0:49:53; seek to 0:49:54 (UTC 1791722688764), a second after the lap ends
- **Laps:** 97.582 · 97.684 · 97.704 · 97.574 · 97.605 · 97.543.
- **Telemetry:** 12 brake zones a lap; across the six laps each zone's start moves about 15 m on average, the sampling's own
  precision.
- **Why:** The barcode at its most regular, on the circuit with the most corners. Laps 21–26 are as even.

#### PB5: LEC leading, and HAM, Mexico 2026

- **Race:** 2026 Mexico City Grand Prix · session 11404 · 71 laps
- **Driver:** LEC (16), laps 12–17, P1, softs
- **When:** UTC 1793564349324–1793564835612 (20:19:09–20:27:15), video 0:24:16–0:32:22; seek to 0:32:23 (UTC 1793564836612), a second after the lap ends
- **Laps:** 81.002 · 81.072 · 81.005 · 81.027 · 81.035 · 81.088, within 0.09 s; each brake point moves about 22 m on average.
- **Also (PB4b):** HAM, laps 14–19 in P3, 81.212–81.366 s, brake points moving about 27 m on average. UTC 1793564517030–1793565004703 (20:21:57–20:30:04), video 0:27:03–0:35:11; seek to 0:35:12 (UTC 1793565005703), a second after the lap ends

#### PB6: NOR behind GAS, Italy 2026

- **Race:** 2026 Italian Grand Prix · session 11361 · 53 laps
- **Driver:** NOR (1), laps 15–20, P7, 0.22–0.61 s behind GAS, hards
- **When:** UTC 1788703125966–1788703647129 (13:58:45–14:07:27), video 1:03:53–1:12:34; seek to 1:12:35 (UTC 1788703648129), a second after the lap ends
- **Laps:** 86.201 · 86.262 · 86.549 · 86.456 · 86.990 · 88.809.
- **Telemetry:** lap 20 lifts for 2.6 s from 326 km/h at about 3530 m and 2.3 s from 321 at about 4730 m, which no earlier lap
  does, and turn 1's slowest speed is 57 km/h (72–84 before). On lap 21 GAS is no longer ahead.
- **Why:** A row that differs for no reason the timing shows; a weaker pick.

## Clocks, per race

From `t_ingest` (`timing` → `clock`), `sessionStartSec` from F1 TV's sync API, both fetched on 2026-11-17. All 56 ingested without a failure,
telemetry included (2026-11-18). Telemetry says where it's cached and the share of the race's `car_data` samples, all cars, with
no throttle or brake reading (`104`).

| Race | Session | Meeting | Laps | `feedBaseUtc` | `clockStartOffsetMs` | `scheduledStartOffsetMs` | `durationMs` | `sessionStartSec` | Telemetry |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2025 Australian Grand Prix | 9693 | 1254 | 58 | 1742094442618 | 4260386 | 3157382 | 10632748 | 1410.5 | scout; 17% no reading |
| 2025 Chinese GP - Sprint | 9993 | 1255 | 19 | 1742609911165 | 2713846 | 2488835 | 5051541 | 474.56 | scout; 0% no reading |
| 2025 Chinese Grand Prix | 9998 | 1255 | 56 | 1742709875834 | 3543164 | 3324166 | 9243467 | 526.24 | scout; 4% no reading |
| 2025 Japanese Grand Prix | 10006 | 1256 | 53 | 1743912460429 | 3368588 | 3139571 | 8495802 | 534.58 | scout; 0% no reading |
| 2025 Bahrain Grand Prix | 10014 | 1257 | 57 | 1744553294266 | 3335748 | 3105734 | 9913997 | 530.899489 | scout; 2% no reading |
| 2025 Saudi Arabian Grand Prix | 10022 | 1258 | 50 | 1745165218413 | 3417598 | 3181587 | 8490361 | 542.96 | scout; 10% no reading |
| 2025 Miami GP - Sprint | 10028 | 1259 | 19 | 1746285439746 | 4259267 | 2560254 | 7964200 | 1929.07 | scout; 6% no reading |
| 2025 Miami Grand Prix | 10033 | 1259 | 57 | 1746385586840 | 3436170 | 3213160 | 8957990 | 523.88 | scout; 11% no reading |
| 2025 Emilia-Romagna Grand Prix | 9987 | 1260 | 63 | 1747570053914 | 3361085 | 3146086 | 9001103 | 520.5 | scout; 4% no reading |
| 2025 Monaco Grand Prix | 9979 | 1261 | 78 | 1748174820385 | 3369621 | 3179615 | 9560014 | 496.66 | scout; 7% no reading |
| 2025 Spanish Grand Prix | 9971 | 1262 | 66 | 1748779444197 | 3553802 | 3355803 | 9494399 | 505.06 | scout; 4% no reading |
| 2025 Canadian Grand Prix | 9963 | 1263 | 70 | 1750007105054 | 3479956 | 3294946 | 10394423 | 492.16 | scout; 3% no reading |
| 2025 Austrian Grand Prix | 9955 | 1264 | 71 | 1751198812792 | 4269220 | 3187208 | 9680006 | 1388.58 | scout; 19% no reading |
| 2025 British Grand Prix | 9947 | 1277 | 52 | 1751807260612 | 3369393 | 3139388 | 9434243 | 531.36 | scout and main; 20% no reading |
| 2025 Belgian GP - F1 Sprint | 9934 | 1265 | 15 | 1753521392627 | 2839380 | 2607373 | 5945600 | 476.04 | scout; 1% no reading |
| 2025 Belgian Grand Prix | 9939 | 1265 | 44 | 1753617927969 | 8073033 | 3272031 | 13458265 | 5107.44 | scout; 0% no reading |
| 2025 Hungarian Grand Prix | 9928 | 1266 | 70 | 1754222718093 | 3468917 | 3281907 | 9412940 | 487.82 | scout and main; 1% no reading |
| 2025 Dutch Grand Prix | 9920 | 1267 | 72 | 1756642007012 | 3395989 | 3192988 | 10002761 | 508.52 | scout; 6% no reading |
| 2025 Italian Grand Prix | 9912 | 1268 | 53 | 1757246744912 | 3470127 | 3255088 | 8652942 | 522.38 | scout; 8% no reading |
| 2025 Azerbaijan Grand Prix | 9904 | 1269 | 51 | 1758449186082 | 3447931 | 3213918 | 9389504 | 541.08 | scout; 5% no reading |
| 2025 Singapore Grand Prix | 9896 | 1270 | 62 | 1759662514462 | 3298536 | 3085538 | 9642852 | 519.659999 | scout; 0% no reading |
| 2025 United States GP - Sprint | 9883 | 1271 | 19 | 1760804174305 | 2854704 | 2625695 | 5384618 | 473.12 | scout; 17% no reading |
| 2025 United States Grand Prix | 9888 | 1271 | 56 | 1760897215592 | 3404416 | 3184408 | 9289288 | 510.125999 | scout; 4% no reading |
| 2025 Mexico City Grand Prix | 9877 | 1272 | 71 | 1761505568774 | 3427231 | 3231226 | 9707743 | 503.36 | scout and main; 10% no reading |
| 2025 São Paulo GP - Sprint | 9864 | 1273 | 24 | 1762607702586 | 2898416 | 2697414 | 6870718 | 450.6 | scout; 10% no reading |
| 2025 São Paulo Grand Prix | 9869 | 1273 | 71 | 1762704379598 | 3416403 | 3220402 | 9158888 | 501.56 | scout; 11% no reading |
| 2025 Las Vegas Grand Prix | 9858 | 1274 | 50 | 1763867186850 | 3462163 | 3213150 | 8571060 | 556.16 | scout; 11% no reading |
| 2025 Qatar GP - Sprint | 9845 | 1275 | 19 | 1764422253824 | 2761179 | 2546176 | 4789631 | 464.48 | scout; 0% no reading |
| 2025 Qatar Grand Prix | 9850 | 1275 | 57 | 1764515085674 | 3522326 | 3314326 | 8985803 | 514.7 | scout and main; 6% no reading |
| 2025 Abu Dhabi Grand Prix | 9839 | 1276 | 58 | 1765109107062 | 3500946 | 3292938 | 9280200 | 503.6 | scout; 0% no reading |
| 2026 Australian Grand Prix | 11234 | 1279 | 58 | 1772938866622 | 3740389 | 3533378 | 9150589 | 513.84 | scout; 18% no reading |
| 2026 Chinese GP - Sprint | 11240 | 1280 | 19 | 1773454632373 | 2801631 | 2567627 | 5538776 | 483.5 | scout; 25% no reading |
| 2026 Chinese Grand Prix | 11245 | 1280 | 56 | 1773554855780 | 3384238 | 3144220 | 9209238 | 547.1 | scout; 29% no reading |
| 2026 Japanese Grand Prix | 11253 | 1281 | 53 | 1774757417367 | 3826643 | 2982633 | 9380542 | 550.38 | scout; 11% no reading |
| 2026 Miami GP - Sprint | 11275 | 1284 | 19 | 1777735179144 | 2651864 | 2420856 | 5082473 | 480.54 | scout; 10% no reading |
| 2026 Miami Grand Prix | 11280 | 1284 | 57 | 1777824400744 | 3442265 | 3199256 | 10134658 | 550.22 | scout; 16% no reading |
| 2026 Canadian GP - Sprint | 11286 | 1285 | 23 | 1779549531242 | 2664792 | 2468758 | 4710666 | 445.58 | scout; 1% no reading |
| 2026 Canadian Grand Prix | 11291 | 1285 | 70 | 1779649635473 | 3752531 | 3164527 | 9616088 | 895.1 | scout; 17% no reading |
| 2026 Monaco Grand Prix | 11299 | 1286 | 78 | 1780834072258 | 3319739 | 3127742 | 12485610 | 499.2 | scout; 18% no reading; positions only for the first 7 min |
| 2026 Barcelona-Catalunya Grand Prix | 11307 | 1287 | 66 | 1781438986764 | 3221262 | 3013236 | 9037857 | 515.38 | scout and main; 13% no reading |
| 2026 Austrian Grand Prix | 11315 | 1288 | 71 | 1782648372075 | 3427825 | 3227925 | 8938428 | 505.2 | scout; 12% no reading |
| 2026 British GP - Sprint | 11321 | 1289 | 17 | 1783160183553 | 2853456 | 2616447 | 5443173 | 486.34 | scout; 0% no reading |
| 2026 British Grand Prix | 11326 | 1289 | 52 | 1783256894492 | 3340526 | 3105508 | 9347017 | 541.42 | scout; 3% no reading |
| 2026 Belgian Grand Prix | 11334 | 1290 | 44 | 1784462876096 | 3356899 | 3123904 | 8769832 | 533.659999 | scout; 9% no reading |
| 2026 Hungarian Grand Prix | 11342 | 1291 | 70 | 1785067750341 | 3248664 | 3049659 | 9428181 | 505.7 | scout; 32% no reading |
| 2026 Dutch GP - Sprint | 11348 | 1292 | 24 | 1787390283610 | 2708388 | 2516390 | 5333729 | 434.08 | scout; 3% no reading |
| 2026 Dutch Grand Prix | 11353 | 1292 | 72 | 1787486802776 | 3406230 | 3197224 | 12125100 | 515.86 | scout; 10% no reading |
| 2026 Italian Grand Prix | 11361 | 1293 | 53 | 1788696395175 | 3415822 | 3204825 | 10519196 | 518.26 | scout; 7% no reading |
| 2026 Spanish Grand Prix | 11369 | 1294 | 57 | 1789301150439 | 3494571 | 3249561 | 9718179 | 551.62 | scout and main; 10% no reading |
| 2026 Azerbaijan Grand Prix | 11377 | 1295 | 51 | 1790417217464 | 3413540 | 3182536 | 11099905 | 538.14 | scout; 12% no reading |
| 2026 Bahrain Grand Prix in Malaysia | 11731 | 1308 | 56 | 1791094019414 | 8761582 | 3180586 | 15538186 | 5887.481 | scout; 5% no reading |
| 2026 Singapore GP - Sprint | 11383 | 1296 | 21 | 1791620255057 | 4735951 | 2544943 | 7837077 | 2440.62 | scout; 26% no reading |
| 2026 Singapore Grand Prix | 11388 | 1296 | 62 | 1791716855580 | 3365431 | 3144420 | 9637994 | 526.46 | scout; 8% no reading |
| 2026 United States Grand Prix | 11396 | 1297 | 56 | 1792955214966 | 3415037 | 3185034 | 9572831 | 537.08 | scout and main; 5% no reading |
| 2026 Mexico City Grand Prix | 11404 | 1298 | 71 | 1793562603011 | 803000 | 596989 | 7917050 | 512.9 | scout and main; 11% no reading |
| 2026 São Paulo Grand Prix | 11412 | 1299 | 71 | 1794154177287 | 3224717 | 3022713 | 9600617 | 503.498 | scout and main; 6% no reading |

## Redoing it

Open a database read-only, e.g. `sqlite3 "file:$HOME/.config/oh-my-f1-viewer/timing.sqlite?immutable=1"`. Session 11291 stands in
for any race below. The tables are the stored ones (`t_*`), not the app's views: versioned tables (`t_laps`, `t_pit`,
`t_stints`, `t_drivers`) hold several rows per key, and the newest `visible_from` is the final one.

To fill a fresh profile, run an isolated OMFV and, for each race from `host.catalog.events({ year })` and
`host.catalog.sessions({ pageId, year })` of type `race` or `sprint`, call `window.omfv.data.open({ year, sessionName: title,
sessionType: 'race', meetingKey, sessionKey }, false)` and wait for a `data:status` with that session `ready` and
`coverage.datasets.telemetry` `complete`, then `window.omfv.data.close()`. It took 2–4 s a race without telemetry and 4–7 s with it,
and the database grew to 3.2 GB.

Clock, per race:

```sql
SELECT session_key, json_extract(detail, '$.clock') FROM t_ingest WHERE dataset = 'timing';
```

Gaps between two cars at each line crossing, and their positions (B and C details):

```sql
WITH laps AS (
  SELECT driver_number AS d, lap_number AS l, date_start, lap_duration
  FROM t_laps t
  WHERE session_key = 11291
    AND visible_from = (SELECT MAX(visible_from) FROM t_laps u
                        WHERE u.session_key = t.session_key AND u.driver_number = t.driver_number AND u.lap_number = t.lap_number)
),
crossing AS (  -- when each car finished lap l: the start of its next lap, else start + duration
  SELECT a.d, a.l, COALESCE(b.date_start, a.date_start + CAST(a.lap_duration * 1000 AS INTEGER)) AS t
  FROM laps a LEFT JOIN laps b ON b.d = a.d AND b.l = a.l + 1
),
ranked AS (SELECT d, l, t, RANK() OVER (PARTITION BY l ORDER BY t) AS pos FROM crossing WHERE t IS NOT NULL)
SELECT x.l AS lap, x.pos AS ham_pos, y.pos AS ver_pos, ROUND((y.t - x.t) / 1000.0, 2) AS ver_behind_ham_s, x.t AS ham_crossing_utc
FROM ranked x JOIN ranked y ON y.l = x.l
WHERE x.d = 44 AND y.d = 3
ORDER BY x.l;
```

Battles: cars next to each other within 1 s at the line, neither on an in- or out-lap, no safety car, VSC or red during the
leader's lap, from lap 3 to 10 laps from the end. Runs of consecutive laps per pair were then ranked by length and mean gap:

```sql
-- the laps and crossing CTEs as above, then:
crossing2 AS (
  SELECT c.*, l.date_start, l.is_pit_out_lap OR EXISTS (SELECT 1 FROM t_pit p WHERE p.session_key = 11291 AND p.driver_number = c.d
                                                        AND p.lap_number IN (c.l, c.l - 1)) AS pitty
  FROM crossing c JOIN laps l USING (d, l)          -- add is_pit_out_lap to the laps CTE
),
ranked AS (SELECT *, RANK() OVER (PARTITION BY l ORDER BY t) AS pos FROM crossing2 WHERE t IS NOT NULL),
neutral AS (
  SELECT r.l, EXISTS (SELECT 1 FROM t_track_status s WHERE s.session_key = 11291 AND s.date BETWEEN r.date_start AND r.t
                      AND s.status IN ('SCDeployed', 'VSCDeployed', 'VSCEnding', 'Red')) AS n
  FROM ranked r WHERE r.pos = 1
)
SELECT a.l AS lap, a.pos, a.d AS ahead, b.d AS behind, ROUND((b.t - a.t) / 1000.0, 2) AS gap_s
FROM ranked a JOIN ranked b ON b.l = a.l AND b.pos = a.pos + 1 JOIN neutral USING (l)
WHERE b.t - a.t < 1000 AND NOT a.pitty AND NOT b.pitty AND NOT n
  AND a.l BETWEEN 3 AND (SELECT MAX(total_laps) FROM t_lap_count WHERE session_key = 11291) - 10
ORDER BY a.d, b.d, a.l;
```

Catches were the same gaps for every ordered pair: a window of 4 to 15 clean laps where the gap starts at 2.5 s or more, ends at
1 s or less, and never grows by 0.4 s from one lap to the next, ranked by how much was taken. A pass is the first later lap
where the gap turns negative with neither car pitting, checked against `t_overtakes`:

```sql
SELECT date, overtaking_driver_number, overtaken_driver_number, position FROM t_overtakes
WHERE session_key = 11280 AND overtaking_driver_number = 3 AND overtaken_driver_number = 44;
```

Restarts: each `SCDeployed` or `Red` and the next `AllClear`, with race control's messages around them:

```sql
SELECT date, status FROM t_track_status WHERE session_key = 11291 ORDER BY date;
SELECT date, lap_number, category, flag, message FROM t_race_control
WHERE session_key = 11291 AND (category = 'SafetyCar' OR flag = 'RED' OR message LIKE '%START%' OR message LIKE '%RESUME%')
ORDER BY date;
```

Pit stops, newest version of each (the pit lane is about `date - lane_duration * 1000` to `date`):

```sql
SELECT driver_number, lap_number AS in_lap, date, lane_duration, stop_duration FROM t_pit t
WHERE session_key = 11291
  AND visible_from = (SELECT MAX(visible_from) FROM t_pit u
                      WHERE u.session_key = t.session_key AND u.driver_number = t.driver_number AND u.lap_number = t.lap_number)
ORDER BY date;
```

The pit window then used the order and gaps at the end of the lap before the in-lap (the gap query), and the loss as in-lap plus
out-lap minus two of the driver's median clean laps around it.

Tyre deg, as `tyre_deg` draws it: for each car at each lap, its last three clean laps (no pit, not lap 1, `AllClear` or `Yellow`)
against the median of its clean laps on the same set so far, from the newest `t_stints` row (`lap_start`, `lap_end`, `compound`,
`tyre_age_at_start`). Laps counted with 0.6 s or more over the median, among the top ten, ranked the laps. Rain from `t_weather.rainfall`.

Telemetry for one car over one lap (the window from the lap's `date_start` to the next lap's), as the charts read it:

```sql
SELECT date, speed, throttle, brake, n_gear FROM t_car_data
WHERE session_key = 11253 AND driver_number = 44 AND date BETWEEN 1774764671902 AND 1774764765182 ORDER BY date;
SELECT date, x, y FROM t_location
WHERE session_key = 11253 AND driver_number = 44 AND date BETWEEN 1774764671902 AND 1774764765182 AND (x != 0 OR y != 0) ORDER BY date;
```

A brake starts where `brake` goes from 0 to 100 (and lasts 200 ms or more), a lift where `throttle` drops under 95 with the brake
off above 80 km/h (500 ms or more). Each start was placed on the circuit by interpolating `location` at its time, then projected
onto one reference lap's path (`x`, `y` are tenths of a metre) for its distance from the line. Brake points of two laps or cars
were paired within 120 m and called different at 40 m or more (45 m for the barcode, where the five other laps also had to agree
within 60 m).

The scripts are in `~/.cache/omfv-shots/scripts`: `analyze.py`, `rank.py`, `deg3.py` and `picks.py` for the timing picks;
`tele.py`, `tele_scan.py` (fastest clean lap per driver, and six-lap windows where the newest lap differs), `metronome.py`
(the most even six laps), `pair_tele.py` and `battle_tele.py` (two cars' traces lap by lap), `bc_detail.py` and `newtimes.py`
for the telemetry picks; `scout.mjs` and `scout-tele.mjs` filled the profile. Run the Python ones with `python3 -I` against
`~/.cache/omfv-shots/scout-profile/timing.sqlite`.
