# f1a

An agent-driven, multi-view F1 TV player. Instead of menus, you tell an agent what you want to watch:

```
> 2025 Mexico
2025 Mexico City Grand Prix loaded.
> Hamilton. Also battle between Norris and Leclerc.
Hamilton, Norris and Leclerc added.
> Done with Norris and Leclerc.
Removed: NOR, LEC.
```

Every stream, and the session data, stays locked to one session clock. Needs an F1 TV subscription, and a ChatGPT plan or an OpenAI or Anthropic API key for the agent.

## Run it

Linux only for now.

```bash
npm install --allow-git=all
```

```bash
node node_modules/electron/install.js
```

```bash
npm run dev
```

The first two commands install the dependencies and the castLabs Electron build with Widevine. The app then opens to a
blank page with the command palette, which tells you what to sign in to.

## Using it

| | |
|---|---|
| `Ctrl+Shift+P` | Show or hide the palette, with its history |
| `Space` | Play or pause, when the palette isn't focused |
| `←` `→` | Back or forward 10s |
| `/login-f1tv` | Sign in to F1 TV (`/logout-f1tv` to sign out) |
| `/settings-agent` | Connect the agent's provider, and choose its model and thinking level |
| Drag a tile | Move it; drop it on another tile to swap them |
| Drag a tile's edge | Resize it |

Everything else goes to the agent in plain words. Before it reads past where you are or moves playback forward, the palette
shows a spoiler check: answer Yes (once), Yes (for the session) or No. The timeline goes anywhere without asking.

### Mods

A [mod](docs/MODS.md) is a plugin: a folder in `~/.config/f1a/mods` that the app reloads on every save. For now it can add a component
for tiles to show, such as a chart or a controller that jumps between laps. Write one yourself or have a coding agent write it, then
ask the agent above to show it.

## Development

```bash
npm run check
```

Typecheck and unit tests. The scripts below run the real app in Electron, and all but the first two need both sign-ins:

```bash
node scripts/layout-check.mjs
```

```bash
node scripts/suggestions-check.mjs
```

```bash
node scripts/drm-check.mjs
```

```bash
node scripts/journey.mjs
```

```bash
node scripts/seek-check.mjs
```

```bash
npm run build && node scripts/prod-check.mjs
```

This one needs only the F1 TV sign-in, and puts a mod in the real profile's mods folder while it runs:

```bash
node scripts/mods-check.mjs /tmp/mods-check
```

```bash
node scripts/stream-soak.mjs 10
```

```bash
node scripts/captions-check.mjs 1000010420
```

During a live session:

```bash
node scripts/live-check.mjs
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together and [docs/STATUS.md](docs/STATUS.md) for what is
verified and what isn't.

## Credits and legal

The F1 TV, DRM and timing code comes from [F1 OpenViewer](https://github.com/npanu420/F1OpenViewer) (MIT), kept in
`electron/vendor/f1ov` and `src/data/vendor`. Unofficial and not affiliated with Formula 1. It does not bypass anything:
you sign in with your own subscription, and F1 TV enforces its own access and regional rules.
