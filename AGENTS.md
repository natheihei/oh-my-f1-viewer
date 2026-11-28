# oh-my-f1-viewer

OMFV (oh-my-f1-viewer) is an agent-driven, multi-view F1 TV player, built on Electron and React. The viewer tells an agent what to watch, and it opens the
session and suggests tiles: video feeds and charts. The agent can also build mods in build mode, including components a tile can show.

It was called f1a until 2026-11-16. Use OMFV or oh-my-f1-viewer in what people read and `omfv` in code. `f1a` is left only where it
names the old profile, `~/.config/f1a`, or reads what the old name wrote. The logo and icons are in `icons/`.

## Build targets

The repo builds three things that share no code. Each has its own build manifest in its own folder.

| Target | Where | Stack | Build |
| --- | --- | --- | --- |
| OMFV electron app | Repo root: `electron/` (main process), `src/` (renderer), `shared/` (imported by both) | Electron, React, Vite | `npm run build`. See [README.md](README.md) |
| OMFV product site | `site/` | Astro (static), Tailwind CSS v4 | `npm run build` in `site/`, which writes `site/dist/`. See [site/README.md](site/README.md). Deployed to Cloudflare Workers: see [site/DEPLOY.md](site/DEPLOY.md) |
| OMFV live timing ingestor | `ingest/` | TypeScript, Node.js (`ws`, Playwright) | `npm run check` / `npm run login` / `npm run ingest` in `ingest/`. Writes v1 static chunks + manifest directly to R2 or local dir. See [ingest/README.md](ingest/README.md) |

Don't import across them. The site keeps its own copies of the logo from `icons/`.

## Docs

Read the one that covers what you're changing. [README.md](README.md) has how to run the app from source.

| Doc | Read it for |
| --- | --- |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | The app's commands and shortcuts, and the check scripts that run the real app |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | What exists today: the layers, the host, charts and their kit, streams and sync, aligning data to video, layout, the agent on pi, sign-in. Start here |
| [DESIGN.md](docs/DESIGN.md) | Where the layering is heading and its rules: one read surface and one write path through `src/host`, and a host with no gates. Also the agent's tools, suggested tiles, mentions and the spoiler check in full |
| [HOST.md](docs/HOST.md) | Every read, query, write and primitive in `src/host`, and the agent tool built on each |
| [COMPONENTS.md](docs/COMPONENTS.md) | How a tile's component should behave: props, size, auto-layout, overflow, colour, driver codes, and each chart's decisions. Rules a mod must follow are copied into `shared/modGuide.ts` by hand, in the same change |
| [AUTO_LAYOUT.md](docs/AUTO_LAYOUT.md) | How tiles are placed: when the grid is re-tiled, what the solver tries and how it scores it, how tiles about one driver or from one batch of suggestions are kept together, hand-arranged layouts, and resizing |
| [MODS.md](docs/MODS.md) | What a mod is, what it may import, and how the app watches, compiles, serves and reloads it |
| [BUILD_MODE.md](docs/BUILD_MODE.md) | `/build`: the build agent and its file tools, drafts, Save and Undo all, what isn't drawing, and the cases that check it |
| [SESSION_DATA.md](docs/SESSION_DATA.md) | The session database: tables, `visible_from` and versioned rows, ingest and caching, linking it to the video, and quirks in F1's data |
| [BACKFILL.md](docs/BACKFILL.md) | Live timing backfill: v1 static R2/local-dir storage layout, manifest & chunk wire protocol, ingestor publisher contract, and OMFV's non-blocking client catch-up |
| [SPOILER_PREVENTION.md](docs/SPOILER_PREVENTION.md) | Each layer that keeps the race from the viewer, from the data up to the agent's prompt. Read it before changing what a chart or the agent can see |
| [RELEASE.md](docs/RELEASE.md) | Releasing the app and the site: the actions, how a release is named, installing it, and what packaging changes |
| [TELEMETRY.md](docs/TELEMETRY.md) | The anonymous usage counts: every event, what's never sent, and how to add one. Read it before sending anything new |
| [STATUS.md](docs/STATUS.md) | What's verified on real sessions, what isn't, known issues, and what's deferred |
| [PI_DURABLE.md](docs/PI_DURABLE.md) | Why the agent moved from pi-coding-agent to pi-durable, what each part became, and what changed |
| [CAPTIONS.md](docs/CAPTIONS.md) | Research for a deferred feature: F1 TV's commentary caption tracks, by season. Captions contain the race |
