<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="icons/omfv-wordmark-dark.svg">
    <img src="icons/omfv-wordmark-light.svg" alt="oh-my-f1-viewer, beta" width="320">
  </picture>
</p>

An agent-driven, multi-view F1 TV player, built on Electron and React. **[oh-my-f1-viewer.yueyao.run](https://oh-my-f1-viewer.yueyao.run)**
has what it does, with screenshots. This README is for running and working on it.

OMFV is in beta, and an unofficial fan project. It needs an F1 TV subscription and an agent provider: a ChatGPT plan, or an
OpenAI or Anthropic API key. It runs on Linux x64 and macOS on Apple silicon.

## Install

Download a `.pacman` (Omarchy and Arch), an AppImage (other Linux) or a `.dmg` (macOS) from the
[download page](https://oh-my-f1-viewer.yueyao.run/download) or [Releases](https://github.com/natheihei/oh-my-f1-viewer/releases).
[docs/RELEASE.md](docs/RELEASE.md#install-it) says how to install each.

## Run from source

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

On macOS, live sessions and other DRM streams also need that Electron build VMP-signed, with a free castLabs EVS account:
see [VMP-sign the Mac build](docs/RELEASE.md#vmp-sign-the-mac-build).

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) has the app's commands and the checks that run the real app, and
[AGENTS.md](AGENTS.md) lists the rest of the docs.

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

## Privacy

OMFV is open source, and knowing people use it is what keeps me going. It sends anonymous usage counts so I can see what to
improve, never who you are or what you type. `/settings-usage off` turns them off. [docs/TELEMETRY.md](docs/TELEMETRY.md)
lists every event.

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
