# OMFV Live Timing & Telemetry Ingestor (`ingest/`)

Standalone Node.js CLI (`omfv-live-ingest`) that connects to F1's live SignalR Core feed, captures all 17 feeds (15 timing + `CarData.z`/`Position.z` telemetry when signed in to F1 TV), compresses immutable chunks locally, and writes the v1 static manifest + chunks directly to **Cloudflare R2** (via S3 API) or a **local directory** (e.g. served by Nginx/Caddy on a VPS).

No Cloudflare Worker, no Durable Object, no database required.

## Quick start

```bash
cd ingest
npm install

# 1. Sign in to F1 TV (optional; enables CarData.z + Position.z telemetry)
npm run login              # Opens Chromium at account.formula1.com
# Or headless paste mode (copies token without echoing on TTY):
npm run login -- --paste

# Check saved token status / expiry (never prints the token)
npm run status
```

## Run against Cloudflare R2 (recommended)

Create an R2 bucket (e.g. `omfv-replay-chunks`), attach a public custom domain (e.g. `https://replay.oh-my-f1-viewer.yueyao.run`), and create a bucket-scoped R2 API token (Object Read & Write).

Save your credentials once in `~/.config/omfv-live-ingest/config.env` (auto-loaded on startup; shell env vars and CLI flags override it):

```bash
mkdir -p ~/.config/omfv-live-ingest
cat <<'EOF' > ~/.config/omfv-live-ingest/config.env
OMFV_R2_ACCOUNT_ID=<cloudflare-account-id>
OMFV_R2_BUCKET=omfv-replay-chunks
OMFV_R2_ACCESS_KEY_ID=<r2-access-key-id>
OMFV_R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
# Optional:
# OMFV_CHUNK_INTERVAL_MS=15000
# OMFV_F1TV_TOKEN=<jwt-or-cookie>
EOF
chmod 600 ~/.config/omfv-live-ingest/config.env
```

Then run the ingestor from any shell without re-exporting credentials:

```bash
# Default: flushes immutable gzipped chunks every 30s
npm run ingest

# Custom chunk timing (e.g. every 15s)
npm run ingest -- --chunk-interval-ms 15000
```

You can also pass any `OMFV_*` variable directly in the shell environment instead of (or to override) `config.env`.

OMFV defaults to `https://replay.oh-my-f1-viewer.yueyao.run` out of the box. Override (or disable with `""` / `"off"`) via `OMFV_REPLAY_URL`:

```bash
OMFV_REPLAY_URL="https://replay.your-custom-domain.example" npm run dev
```

## Run against a local directory (VPS + Nginx/Caddy or local dev)

```bash
npm run ingest -- --output-dir /var/www/omfv-replay --chunk-interval-ms 30000
```

Serve `/var/www/omfv-replay` with Caddy or Nginx (setting `Cache-Control: public, max-age=31536000, immutable` and `Content-Encoding: gzip` on `/v1/sessions/*/chunks/*.ndjson.gz`, and `Cache-Control: no-store` on `manifest.json`).

## Storage layout (`v1/`)

```text
v1/sessions/index.json
v1/sessions/{sessionKey}/manifest.json
v1/sessions/{sessionKey}/chunks/timing-000001.ndjson.gz
v1/sessions/{sessionKey}/chunks/telemetry-000001.ndjson.gz
```

## Startup options

| Flag | Env var | Default | Purpose |
| --- | --- | --- | --- |
| `--chunk-interval-ms <ms>` | `OMFV_CHUNK_INTERVAL_MS` | `30000` | How often to flush buffered records into immutable chunks |
| `--chunk-max-records <n>` | `OMFV_CHUNK_MAX_RECORDS` | `2000` | Max records per chunk before sealing early |
| `--chunk-max-bytes <bytes>` | `OMFV_CHUNK_MAX_BYTES` | `2097152` | Max uncompressed NDJSON bytes per chunk |
| `--r2-account-id <id>` | `OMFV_R2_ACCOUNT_ID` | — | Cloudflare account ID for R2 endpoint |
| `--r2-bucket <name>` | `OMFV_R2_BUCKET` | — | R2 / S3 bucket name |
| `--r2-access-key-id <id>` | `OMFV_R2_ACCESS_KEY_ID` | — | R2 / S3 access key ID |
| `--r2-secret-access-key <k>` | `OMFV_R2_SECRET_ACCESS_KEY` | — | R2 / S3 secret access key |
| `--s3-endpoint <url>` | `OMFV_S3_ENDPOINT` | R2 URL | Custom S3-compatible endpoint (MinIO, AWS S3, etc.) |
| `--s3-region <region>` | `OMFV_S3_REGION` | `auto` | SigV4 signing region |
| `--output-dir <dir>` | `OMFV_OUTPUT_DIR` | — | Local directory sink instead of R2/S3 |
| `--takeover` | `OMFV_TAKEOVER=1` | `false` | Replace an active writer lease in `manifest.json` |
| `--wait-for-live` / `--no-wait-for-live` | `OMFV_WAIT_FOR_LIVE` | `true` | Ignore an already-`Finalised` initial snapshot between sessions |
| `--exit-on-finish` | — | `false` | Flush final chunks and exit 0 when the session finishes |

## Checks

```bash
npm run check   # typecheck + unit/E2E tests
npm run build   # compiles to dist/
```
