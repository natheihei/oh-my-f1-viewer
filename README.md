<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="icons/omfv-wordmark-dark.svg">
    <img src="icons/omfv-wordmark-light.svg" alt="oh-my-f1-viewer, beta" width="456">
  </picture>
</p>

<p align="center">
  <b>An agent-driven, multi-view F1 TV player.</b><br>
  Tell it what you want to watch, and it opens the session and lays out the onboards and live charts on one clock.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-lightgrey" alt="Platforms: Linux and macOS">
  <img src="https://img.shields.io/badge/status-beta-orange" alt="Status: beta">
</p>

<p align="center">
  <a href="https://oh-my-f1-viewer.yueyao.run">Website</a> ·
  <a href="#install">Install</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a>
</p>

![The 2026 Mexico City Grand Prix in OMFV: the race feed and the Hamilton and Leclerc onboards, with their pit windows, gap, telemetry, pedals, sectors, tyres and track positions, all on one session clock.](site/src/assets/shots/page/hero-charts.webp)

> [!NOTE]
> OMFV is in beta. It's an unofficial fan project, not affiliated with Formula 1, and it needs your own F1 TV subscription
> and an LLM provider. Everything runs on your machine: there is no OMFV server.

## Features

- **Ask in plain words.** Name a session, a driver or a battle, and the agent opens it and suggests the tiles to show.
- **Multi-view, in sync.** The race feed, onboards and charts all follow one session clock. Drag, swap and resize tiles, or
  let `/auto-layout` arrange them.
- **No spoilers.** Charts and the agent only see data up to the frame on screen. The agent asks before it looks ahead.
- **Race charts.** Battles, gaps, timing, tyre degradation, pit windows, telemetry and more, built from F1's timing feed.
- **Build mode.** Describe a view that isn't there, and the agent writes it as a [mod](docs/MODS.md) you can keep or undo.
- **Replays and live races.** Any session from 2023 on. Live is in alpha.

## Build mode

`/build` turns the agent into a builder. Describe a view that isn't there, with no code needed:

```
show whoever's pitting
always show the leader's onboard
buttons to skip a lap
the gap to the car behind, on every onboard
```

It writes a [mod](docs/MODS.md) and runs it on the race you're watching as a draft. **Save** keeps it, and **Undo all**
puts everything back. Mods are plain folders, so you can also write or change one yourself. See
[docs/BUILD_MODE.md](docs/BUILD_MODE.md).

## Requirements

- **Video and data:** an F1 TV subscription. You sign in with your own account, and F1 TV's access and regional rules
  apply.
- **Agent:** a ChatGPT plan (sign in with ChatGPT), or an OpenAI or Anthropic API key.
- **Platform:** Linux x64, or macOS on Apple silicon. Windows isn't supported yet.

## Install

Releases have a `.pacman` package for Omarchy and Arch, an AppImage for other Linux, and a `.dmg` for macOS. Download them
from [Releases](https://github.com/natheihei/oh-my-f1-viewer/releases), and see
[docs/RELEASE.md](docs/RELEASE.md#install-it) for how to install each. Until the first app release is out, run it from
source.

On first launch the app walks you through signing in to F1 TV and connecting the agent's model. Then open a session.
`Ctrl+Shift+P` (`Cmd+Shift+P` on macOS) shows or hides the palette.

### Run from source

You need [Node.js](https://nodejs.org) (`brew install node` on macOS). Install the dependencies, then the castLabs Electron
build with Widevine, then start it:

```bash
npm install --allow-git=all
```

```bash
node node_modules/electron/install.js
```

```bash
npm run dev
```

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) has the app's commands and the checks that run the real app.

## How it works

OMFV is an Electron app with a React renderer.

- **Playback.** The main process signs in to F1 TV and handles entitlement and the Widevine license. The renderer plays
  every feed and keeps them in sync on one session clock.
- **Session data.** F1's timing feed is read into a local SQLite database. Every row records when it became known, so a
  query only returns what the video has reached.
- **Components.** Each tile shows a component. Charts draw on Canvas 2D through a small kit. Components read and write only
  through the host (`src/host`), and mods use the same interface.
- **Agent.** The agent runs on [pi](https://github.com/earendil-works/pi) with your provider. It gets tools built on the
  host, and a spoiler check sits between it and anything ahead of the playhead.

## Credits

- [F1 OpenViewer](https://github.com/npanu420/F1OpenViewer) (MIT) by npanu420. OMFV builds on its hard-won F1 TV sign-in,
  entitlement, DRM licensing, playback, stream sync and timing work. It is vendored in `electron/vendor/f1ov` and
  `src/data/vendor`, and `src/data/stream.ts`, `syncEngine.ts` and `timeMap.ts` are ported from it.
- [pi](https://github.com/earendil-works/pi) (MIT) runs the agent. The build agent's output limits and edit matching in
  `electron/agent/extensions/modFiles.ts` are ported from it.

## License and disclaimer

OMFV is released under the [MIT license](LICENSE), which also carries the notices for the code above.

OMFV is unofficial and not affiliated with, endorsed by or connected to Formula 1, F1 TV or the Formula One group of
companies. F1, Formula 1 and F1 TV are their trademarks. OMFV does not bypass anything: you sign in with your own account,
and F1 TV enforces its own access and regional rules.
