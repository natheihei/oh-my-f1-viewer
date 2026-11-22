<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="icons/omfv-wordmark-dark.svg">
    <img src="icons/omfv-wordmark-light.svg" alt="oh-my-f1-viewer" width="341">
  </picture>
</p>

<p align="center">
  <b>An agent-driven, multi-view F1 TV player.</b><br>
  Onboards, charts, insights: one ask away.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-lightgrey" alt="Platforms: Linux and macOS">
</p>

<p align="center">
  <a href="https://oh-my-f1-viewer.yueyao.run">Website</a> ·
  <a href="https://oh-my-f1-viewer.yueyao.run/download">Install</a>
</p>

## Features

- **Ask in plain words.** Name a session, a driver or a battle, and the agent opens it and suggests the tiles to show.
- **Multi-view, in sync.** The race feed, onboards and charts all follow one session clock.
- **No spoilers.** Charts and the agent only see data up to the frame on screen.
- **Race charts.** Battles, gaps, timing, tyres, pit windows and telemetry, built from F1's timing feed.
- **Builds what's missing.** Ask for a view that isn't there, and the agent writes it as a [mod](docs/MODS.md) you can keep
  or undo.
- **Replays and live races.** Any session from 2023 on.

> [!NOTE]
> OMFV is under active development, and new features are added often.

## Run from source

You need [Node.js](https://nodejs.org). Install the dependencies, then the castLabs Electron
build with Widevine, then start it:

```bash
# --allow-git=all: Electron comes from castLabs' GitHub (their build with Widevine, for F1 TV's DRM), not the npm registry
npm install --allow-git=all
```

```bash
node node_modules/electron/install.js
```

```bash
npm run dev
```

On macOS, live sessions and other DRM streams also need that Electron build VMP-signed, with a free castLabs EVS account:
see [VMP-sign the Mac build](docs/RELEASE.md#vmp-sign-the-mac-build).

## Credits

- [F1 OpenViewer](https://github.com/npanu420/F1OpenViewer) (MIT) by npanu420. OMFV builds on its hard-won F1 TV sign-in,
  entitlement, DRM licensing, playback, stream sync and timing work. It is vendored in `electron/vendor/f1ov` and
  `src/data/vendor`, and `src/data/stream.ts`, `syncEngine.ts` and `timeMap.ts` are ported from it.
- [pi](https://github.com/earendil-works/pi) (MIT) runs the agent (pi-durable).

## License and disclaimer

OMFV is released under the [MIT license](LICENSE), which also carries the notices for the code above.

OMFV is unofficial and not affiliated with, endorsed by or connected to Formula 1, F1 TV or the Formula One group of
companies. F1, Formula 1 and F1 TV are their trademarks. OMFV does not bypass anything: you sign in with your own account,
and F1 TV enforces its own access and regional rules.
