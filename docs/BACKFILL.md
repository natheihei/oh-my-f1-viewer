# Live Timing Backfill

Optional, non-blocking historical backfill for live F1 sessions (and post-race replays before F1 publishes its official static archive).

There is no custom server. `ingest/` captures F1's live SignalR Core feed, gzips immutable chunks locally, and writes static files directly to Cloudflare R2 (or any S3-compatible bucket / local directory). OMFV reads those static files over plain HTTPS.

If no backfill host is configured — or if `ingest/` did not run for a session — OMFV behaves identically to pre-backfill live capture.

## Static storage layout & versioning (`v1`)

All objects live under a versioned prefix so future breaking formats (`v2/`) can coexist without breaking older OMFV clients:

```text
v1/sessions/index.json
v1/sessions/{sessionKey}/manifest.json
v1/sessions/{sessionKey}/chunks/timing-000001.ndjson.gz
v1/sessions/{sessionKey}/chunks/telemetry-000001.ndjson.gz
```

| Object | `Content-Type` | `Content-Encoding` | `Cache-Control` |
| --- | --- | --- | --- |
| `v1/sessions/{key}/manifest.json` (live) | `application/json; charset=utf-8` | — | `no-store` |
| `v1/sessions/{key}/manifest.json` (finished) | `application/json; charset=utf-8` | — | `public, max-age=60` |
| `v1/sessions/{key}/chunks/*.ndjson.gz` | `application/x-ndjson; charset=utf-8` | `gzip` | `public, max-age=31536000, immutable` |
| `v1/sessions/index.json` | `application/json; charset=utf-8` | — | `no-store` |

### Compatibility rules
- **Additive within `v1`:** Adding new manifest fields, new chunk metadata fields, new stream names, new chunk encodings, or new F1 feed topics stays in `v1/`. Clients must ignore unknown JSON fields, unknown chunk streams, and unknown topics, and skip chunks with unsupported `encoding` with a warning.
- **Breaking changes (`v2`):** Use a new path prefix (`v2/sessions/...`) and bump `protocol_version: 2`. A `v1` client that encounters `protocol_version !== 1` logs a warning and degrades cleanly to the direct F1 live feed.

## Wire protocol (`protocol_version: 1`)

### Manifest (`GET {baseUrl}/v1/sessions/{sessionKey}/manifest.json`)

```json
{
  "protocol_version": 1,
  "session_key": 11420,
  "meeting_key": 1275,
  "session_name": "Race",
  "session_type": "Race",
  "meeting_name": "Las Vegas Grand Prix",
  "status": "live",
  "captured_from": 1795800000000,
  "last_received_at": 1795800300000,
  "last_seq": 412,
  "record_count": 413,
  "has_telemetry": true,
  "gaps": [{ "from": 1795800040000, "to": 1795800055000 }],
  "chunks": [
    {
      "id": 1,
      "stream": "timing",
      "encoding": "ndjson+gzip",
      "path": "/v1/sessions/11420/chunks/timing-000001.ndjson.gz",
      "seq_start": 0,
      "seq_end": 180,
      "from_ms": 1795800000000,
      "to_ms": 1795800030000,
      "record_count": 181,
      "byte_len": 14820
    }
  ],
  "tail": { "timing_count": 0, "telemetry_count": 0, "from_ms": null, "to_ms": null },
  "writer_id": "2c8a7c4e-...",
  "lease_expires_at": 1795800390000,
  "updated_at": 1795800300000
}
```

Key fields:
- `protocol_version`: Required integer `1`.
- `session_key`: F1's numeric session key. Client verifies it matches the requested session.
- `status`: `'live'` while the ingestor is capturing, `'finished'` once `SessionData` reports `Finalised` or `Ends`.
- `captured_from` / `last_received_at`: Earliest and latest ingestor arrival timestamps (`UTC ms`) across all published chunks.
- `gaps`: Known capture outages (`{ from, to }`, `to: null` while open), from SignalR disconnects or writer restarts > 5 s.
- `chunks`: Ordered list of immutable sealed chunks. Each chunk carries:
  - `id`: Strictly increasing integer chunk ID per session.
  - `stream`: `'timing'` (the 15 plain F1 feeds) or `'telemetry'` (`CarData.z`, `Position.z`).
  - `encoding`: `'ndjson+gzip'`.
  - `path`: Same-origin path resolved against `baseUrl` (clients always follow `chunk.path` rather than hardcoding URLs).
  - `seq_start` / `seq_end`, `from_ms` / `to_ms`, `record_count`, `byte_len`.
- `writer_id` / `lease_expires_at`: Single-writer lease metadata used by `ingest/` (cleared on finish or graceful shutdown).
- `server_now_ms` *(optional)*: Not set on static R2 files; OMFV falls back to the HTTP `Date` response header to detect client-vs-ingestor clock skew.

### Chunk body (`GET {baseUrl}{chunk.path}`)

Gzipped UTF-8 NDJSON (`application/x-ndjson`, `Content-Encoding: gzip`). Each line is one `LiveRecord`:

```json
{"seq":0,"topic":"SessionInfo","data":{"Key":11420,"Type":"Race"},"ts":null,"snapshot":true,"received_at":1795800000000}
```

- `seq`: Server/publisher-assigned strictly monotonic sequence number across the session (shared across timing and telemetry).
- `topic`: F1 SignalR feed name (one of the 17 `LIVE_FEEDS`). Compressed feeds (`CarData.z`, `Position.z`) are stored as already-inflated JSON in `data`, matching OMFV's live processor format.
- `ts`: F1's feed timestamp string when sent on Type 1 incremental updates, or `null` on Type 3 `Subscribe` snapshots.
- `snapshot`: `true` for initial `Subscribe` snapshot frames, `false` for incremental feed updates.
- `received_at`: Ingestor wall-clock arrival time (`UTC ms`).

## Publisher contract (`ingest/`)

Implemented in [ingest/src/publisher.ts](../ingest/src/publisher.ts) and [ingest/src/storage.ts](../ingest/src/storage.ts):

- **Chunking policy:** Buffers `timing` and `telemetry` separately in memory and seals a stream whenever any threshold is reached:
  - Time since first buffered record in the stream ≥ `--chunk-interval-ms` (default `30000` ms, env `OMFV_CHUNK_INTERVAL_MS`),
  - Record count ≥ `--chunk-max-records` (default `2000`),
  - Uncompressed NDJSON bytes ≥ `--chunk-max-bytes` (default `2 MiB`),
  - Or immediately on session finish (`Finalised` / `Ends`) or graceful `SIGINT` / `SIGTERM`.
- **Upload ordering & CAS:** Always uploads immutable chunk object(s) first, then updates `manifest.json` with conditional `If-Match: <etag>` (or `If-None-Match: *` on creation). Orphan chunks from a failed manifest write are harmless and unreferenced.
- **Single-writer lease:** Before publishing to an existing session, `ingest/` checks `writer_id` and `lease_expires_at` (TTL = `max(60s, 3 × chunkIntervalMs)`). A second ingestor stops with exit code `2` unless `--takeover` is passed. On `412 Precondition Failed`, `ingest/` reloads `manifest.json` to check whether another writer took the lease.
- **Post-finish & between-sessions safety:** `--wait-for-live` defaults to on (ignoring an already-`Finalised` initial `Subscribe` snapshot until the next session starts; override with `--no-wait-for-live`). Once `Finalised`/`Ends` is seen, trailing records for that session are dropped so a finished manifest is never reopened.
- **Outage memory bound:** Caps pending buffers (`50,000` records / `32 MiB`), shedding oldest telemetry first and recording gap events if timing records must be dropped.

## Client contract (OMFV)

Implemented in [electron/timingdb/liveBackfill.ts](../electron/timingdb/liveBackfill.ts), [electron/timingdb/index.ts](../electron/timingdb/index.ts), and [electron/timingdb/ingest.ts](../electron/timingdb/ingest.ts):

- **Configuration:** `OMFV_REPLAY_URL` (or `OMFV_LIVE_SERVER_URL`), falling back to `replayUrl` / `liveServerUrl` in settings, and finally `DEFAULT_REPLAY_URL` (`https://replay.oh-my-f1-viewer.yueyao.run`). Setting any of those to `""` / `"off"` (or `false` / `null` in settings) disables backfill with zero requests.
- **Non-blocking live startup:** `beginLive` starts immediately from F1's direct SignalR feed and emits `data:status` (`ready`) without waiting on HTTP. Charts and live playback work immediately even if the backfill host is slow, offline, or returns 404.
- **Continuous background catch-up:** A background loop anchors `targetUntilMs` to the viewer's first direct SignalR record (`T1`) and continuously polls `manifest.json` (default every 10 s, backing off up to 60 s on 404/network error):
  - Fetches only un-fetched chunks overlapping `(streamAfterMs, targetUntilMs]` in parallel (concurrency 12), tracking `fetchedTimingIds` and `fetchedTelemetryIds` separately.
  - **Timing chunks:** Atomically merged with already-captured local timing messages via `LiveCapture.mergeTimingBackfill` inside a single SQLite WAL transaction — live charts never flash empty, and telemetry rows in `t_live_messages` are untouched.
  - **Telemetry chunks:** Streamed per chunk via `onBatch` directly to `liveAppendBackfill` so Electron main never buffers a whole race's telemetry in memory.
  - **Completion:** Stops polling once all overlapping chunks are fetched and both streams' manifests cover `>= targetUntilMs` (or `manifest.status === 'finished'`).
- **Agent awareness:** When backfill is configured on a live session, `DataStatus.backfill` / `SessionDataView.backfill` exposes `{ state: 'catching-up' | 'complete' | 'unavailable', capturedFrom, backfilledTo, targetUntilMs }`, surfaced to the agent in [src/agent/bridge.ts](../src/agent/bridge.ts) (`describeAppState`). Omitted completely when backfill is unconfigured.
- **Post-race VOD fallback:** When opening a replay whose official F1 archive is not published yet, `openArchive` checks `manifest.json` (never connecting F1's global live SignalR socket). If captured, it loads timing + background telemetry, derives `FeedClock` only from an observed non-snapshot `ExtrapolatedClock` `false -> true` transition (preventing late-capture alignment spoilers), and keeps retrying F1's official archive every 5 minutes (cancelling fallback telemetry before upgrading).
- **Security & resilience:**
  - Enforces same-origin on resolved `chunk.path` URLs and HTTP redirects (blocks SSRF).
  - Caps compressed (16 MiB) and decompressed (32 MiB) response sizes (blocks gzip bombs).
  - Skips individual malformed NDJSON lines with a warning instead of aborting a chunk.
  - Rejects and disconnects direct live SignalR if incoming `SessionInfo.Key` does not match the opened session.
