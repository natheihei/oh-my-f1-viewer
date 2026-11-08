# Commentary captions

Research for a future feature that finds moments in the commentary, with the agent reading ahead in the script. The app doesn't use
captions yet. `scripts/captions-check.mjs` is the only code. Measured 2026-11-08 by reading each session's real tracks.

**Captions contain the race.** Never quote them, or name what they describe, for a race the user might not have seen. Reports and test
output should stay counts only, and any reading ahead by the agent has to go through the spoiler approval flow.

## What each season has

| Seasons | Delivery | Tracks | Text |
| --- | --- | --- | --- |
| 2025-2026 | DASH, TTML in fMP4 (`stpp`), 5.76s segments | F1 LIVE: eng, spa. INTERNATIONAL (2026): eng, fra | 2026 is mixed case in short fragments. 2025 is all caps in longer lines, with coarser timing |
| 2022-2024 | HLS, WebVTT (`.vtt`), 3.84s or 5.76s segments | F1 LIVE: eng. INTERNATIONAL: eng, fra, spa | All caps, almost no punctuation |
| 2021 | HLS, WebVTT, 5.76s or 6s segments | INTERNATIONAL: eng, fra, spa | All caps, almost no punctuation |
| 2018-2020 | HLS, no subtitle tracks | Three `CLOSED-CAPTIONS` tracks embedded in the video | Not read. Getting them means downloading and demuxing video, so assume no script for these seasons |

One to three sessions were checked per season, not all of them. The tracks are unencrypted, even on Widevine live streams. There are no speaker labels.

## Reaching them

1. **Pick the feed.** `contentVideo(contentId).metadata.additionalStreams`, taking the entry with `default: true`. That's F1 LIVE from 2022
   and INTERNATIONAL before. Send its `channelId` only if its `playbackUrl` contains one: INTERNATIONAL's never does, and asking for it by
   number returns HTTP 404 on every season from 2018 to 2024. `channelIdForPlay` applies this rule in the app.
2. **Get the manifest.** `contentPlay(contentId, channelId, platform)` returns a signed URL in `resultObj.url`. Every platform returns the
   same kind of manifest for a session.
3. **Find the track.**
   - DASH: the `AdaptationSet` with `codecs="stpp"` and the wanted `lang`. Expand its `SegmentTemplate` and `SegmentTimeline`, resolve `media`
     against the manifest's directory, and add the manifest's query string.
   - HLS: the `#EXT-X-MEDIA` line with `TYPE=SUBTITLES` and the wanted `LANGUAGE`. Its `URI` resolves against the master playlist, and each
     segment against that playlist. No query string needs adding.
4. **Parse the segments.**
   - DASH: each segment holds one TTML document in its `mdat`, with `<p begin end>` cues.
   - HLS: plain WebVTT.

Only the signed URL is needed: plain Node `fetch` works, with no cookies or tokens in headers. Getting the URL needs an F1 TV sign-in.
How long a signed URL lasts wasn't tested, which matters for a long read-ahead on a live race.

## Timestamps

- **DASH replay:** `ttp:timeBase="media"`, so a cue's time is `video.currentTime`.
- **DASH live:** cue times look like `498378:54:12.122`, which is Unix time written in hours. Subtract `availabilityStartTime` to get video
  time (`1704067200`, 2024-01-01, on the race measured). The script does this, but its live path has only run on synthetic input: the race
  had ended when it was written. The original measurement came from a live race.
- **HLS:** cue times follow the playlist's position, within a few seconds of their segment. Segments carry
  `X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:180000`, which is a 2s offset. Whether to apply it hasn't been checked against the picture.

Captions share the video's timeline, so the roughly 15s wall-clock bias in `docs/STATUS.md` doesn't affect them.

## Whole sessions, English

From `scripts/captions-check.mjs`, each taking about a minute with 8 workers and no failed segments:

| | 2026 Mexico, F1 LIVE | 2024 Hungarian, F1 LIVE | 2021 Belgian, INTERNATIONAL |
| --- | --- | --- | --- |
| contentId | 1000010420 | 1000007897 | 1000003957 |
| Segments | 1888 | 2063 | 2491 |
| Cues, raw then merged | 6038, 4575 | 2424, 1509 | 4050, 2938 |
| Words | 27,094 | 20,140 | 38,170 |
| Text | 140KB | 101KB | 189KB |
| Words per minute | 151 | 154 | 156 |
| Median cue | 1.92s | 4.55s | 4.31s |
| Cues ending a sentence | 45% | 0% | 2% |
| Gaps over 30s | 4 | 4 | 11 |
| Longest gap | 303s | 403s | 246s |

## Live

Measured during the 2026 São Paulo Grand Prix. The text track's edge matches the video's, with about 2h of DVR, and 10 of the last 14
segments had cues. So on live, the agent can only read ahead by as far as the viewer is behind live.

## Sync

On the 2026 Mexico replay:

- The first race-start call came 0.5s after lights out (video time 512.9s).
- Three major race-control events were first mentioned 0.2-4.7s after their messages.
- Mentions of investigations and penalties were too noisy to line up.

That's a few checks on one race. 2025 looked coarser around lights out.

## Cleaning needed

- **Duplicates:** segment boundaries repeat lines. Merge identical neighbours less than 0.5s apart, as `mergeCues` does.
- **Fragments:** 2026 lines are short pieces that need joining into sentences. Other seasons have no punctuation, so sentence boundaries
  have to be inferred.
- **Normalisation:** all-caps seasons need case-insensitive matching for driver names.

## Still unknown

Roughly in the order to check them when this resumes:

1. How far live captions lag the picture. All the sync numbers above come from a replay, and live captioning could be slower.
2. Whether HLS cues line up with the picture, and whether the 2s offset applies. Check at lights out, as on 2026 Mexico.
3. How accurate the words are. Only names were checked: 22 of 22 current drivers appear in the 2026 Mexico script.
4. How long a signed URL stays valid.
5. Whether the 2018-2020 embedded tracks hold anything, and whether it's worth the download.

## Running the check

```bash
node scripts/captions-check.mjs 1000010420                        # The default feed, in English
node scripts/captions-check.mjs 1000010420 --channel 1025 --lang fra
node scripts/captions-check.mjs 1000010420 --out /tmp/cues.json   # Saves the merged cues, spoilers included: keep this out of the repo
```

It needs a signed-in profile and prints counts only.
