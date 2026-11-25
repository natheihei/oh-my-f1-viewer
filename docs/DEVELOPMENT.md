# Development

How to drive the app while working on it, and the checks that run it. [README.md](../README.md) has how to run it from source,
and [RELEASE.md](RELEASE.md#install-it) how to install a release.

## Commands in the app

| | |
|---|---|
| `Ctrl+K` | Show or hide the palette, with its history. `Cmd+K` works too. From elsewhere in the app it brings you to the palette, even one still showing. It also hides itself 3 seconds after you move elsewhere (or at once on a second click outside once it has lost focus), and Esc in it hides it. The chevron on its top edge folds it to its input row, see-through, and a click on that unfolds it. Folded, it shows a tip every 20 seconds in place of its placeholder, from the list in `src/shell/tips.ts`. Click the key written at the end of the input row and press another to change it; Backspace there goes back to `Ctrl+K` |
| `Space` | Play or pause, when the palette isn't focused |
| `←` `→` | Back or forward 10s |
| `/login-f1tv` | Sign in to F1 TV (`/logout-f1tv` to sign out) |
| `/settings-agent` | Connect the agent's provider, and choose its model and thinking level |
| `/reset-onboarding` | Show the steps to get started again |
| `/version` | Show which release this is |
| `/whats-new` | Open this release's notes in the browser |
| `/about` | Open the [OMFV site](https://oh-my-f1-viewer.yueyao.run) in the browser |
| `/build` | Enter build mode, where the agent builds or changes mods. Marked `! spoiler`: the agent looks ahead without asking |
| Drag a tile's title bar | Move it; drop it on another tile to swap them. With `Alt` held (`Option` on a Mac), drag it by any part |
| Drag a tile's edge | Resize it |
| `/auto-layout` | Re-tile the grid, undoing moves and resizes |
| `/close-session` | Close the session, or stop a countdown, and go back to the list of sessions. The × at the right end of the timeline and "stop waiting" under a countdown do the same, and so does asking the agent to "take me home" |

`/build` and `/auto-layout` work on an open session, so the command list leaves them out until there is one. `/close-session` is left out
until a session or a countdown is open.

Everything else goes to the agent in plain words. Before it looks ahead of where you are, by reading ahead or moving playback forward, the palette
shows a spoiler check: answer Allow once, Allow for this session or Don't allow. The timeline goes anywhere without asking.

## Checks

```bash
npm run check
```

Typecheck and unit tests. The scripts below run the real app in Electron, and all but the first three need both sign-ins:

A check that needs a sign-in runs an OMFV of its own, apart from any other on the machine, on a fresh profile with copies of
the F1 TV sign-in and, when it needs the agent, of the agent's sign-in and settings from the main profile. An agent sign-in the
run refreshed is written back, so the original stays valid ([scripts/isolated.mjs](../scripts/isolated.mjs)). On Hyprland the
check's window opens on workspace 3 without taking focus; elsewhere, macOS included, it opens as an ordinary window in front
([scripts/platform.mjs](../scripts/platform.mjs)).

```bash
node scripts/layout-check.mjs
```

```bash
node scripts/suggestions-check.mjs
```

`palette-away-check.mjs` checks when the palette hides itself and what's unread: 3 seconds after a press on the video, even mid-reply or
with suggestions showing, a reply or a question that comes while you're elsewhere marked and waiting folded without taking focus, and the
palette's key bringing you to it.

```bash
node scripts/palette-away-check.mjs
```

```bash
node scripts/overflow-check.mjs /tmp/overflow-check
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

This one runs the packaged app that `npm run dist` makes, as a release installs it: see [RELEASE.md](RELEASE.md#check-a-build).

```bash
npm run dist && node scripts/packaged-check.mjs /tmp/packaged-check
```

This one updates an AppImage from one release to the next, served from localhost: see [RELEASE.md](RELEASE.md#check-a-build).

```bash
npm run build && node scripts/update-check.mjs /tmp/update-check
```

This one needs only the F1 TV sign-in, and puts a mod in the mods folder of an OMFV of its own while it runs:

```bash
node scripts/mods-check.mjs /tmp/mods-check
```

This one needs only the F1 TV sign-in. It reads the usage counts a dev build logs, and checks the ones a session, its tiles and
the `/` commands produce, and that `/settings-usage off` stops them: see [TELEMETRY.md](TELEMETRY.md):

```bash
npm run build:electron && node scripts/usage-counts-check.mjs /tmp/usage-counts-check
```

This one needs only the F1 TV sign-in. It opens a replay race and adds suggestions one by one: each re-tiles the grid until a
tile is arranged by hand, and after that a new one goes into the biggest gap:

```bash
node scripts/auto-layout-add-check.mjs /tmp/auto-layout-add-check
```

This one needs only the F1 TV sign-in. It opens a replay race and adds suggestions clicked in turn about: an onboard, its
telemetry and its pedals for each of two drivers. Auto-layout keeps each driver's tiles together as a block and lays the two
blocks out alike, in line. Then it adds a batch of two charts about no one driver, which stay together too, and steps the grid's size as a window drag
does: no tile moves until the size holds still:

```bash
node scripts/group-layout-check.mjs /tmp/group-layout-check
```

This one needs only the F1 TV sign-in. It opens a replay race, muted, and adds P1's and P2's onboards and P1's telemetry, which
follow those places: each shows the car in it and says so in its title, and the P1 tiles are one group. It swaps P1 and P2 by hand,
and the two onboards trade videos in one render with no new stream. Then it plays through the next change of lead, and the P1
tiles follow the new leader:

```bash
node scripts/places-check.mjs /tmp/places-check [lap] [session key]
```

This one needs only the F1 TV sign-in, and sends nothing to the agent. It opens a replay race and leaves it by the timeline's ×,
then by `/close-session`, then stops a countdown with "stop waiting". Each goes back to the landing page with no tiles and no timeline,
and "Allow for this session" ends with the session:

```bash
npm run build:electron && node scripts/close-session-check.mjs /tmp/close-session-check
```

This one opens no session and sends nothing to the agent. It checks the landing page: onboarding's two steps give way to it,
it opens on now with no row open unless a session is live, a row clicked writes its session in the input and opens to its
suffixes, and the arrow keys walk the sessions:

```bash
node scripts/landing-check.mjs /tmp/landing-check
```

This one runs [build mode](BUILD_MODE.md) with the real agent: it needs both sign-ins, and takes about a quarter of an
hour:

```bash
node scripts/build-check.mjs /tmp/build-check
```

This one asks the real agent for sessions with nothing open, each request in a fresh conversation, and records which session it
loads or what it asks:

```bash
node scripts/picking-check.mjs /tmp/picking-check
```

This one asks the real agent for a session and a moment in it in one message, on a profile with no timing data yet, and checks
that the tools wait for the data, that the palette says so, and that playback is moved. It needs both sign-ins and plays the session:

```bash
node scripts/data-wait-check.mjs /tmp/data-wait-check
```

```bash
node scripts/stream-soak.mjs 10
```

```bash
node scripts/captions-check.mjs 1000010420
```

This one asks the real agent to move by an amount of time, on a live session when there is one and a replay race otherwise,
and checks it used `seek_to`'s `delta` and where playback landed:

```bash
node scripts/move-check.mjs
```

During a live session:

```bash
node scripts/live-check.mjs
```

And against a packaged app, which reads only the page since there's no source to import. On macOS it defaults to the
installed `/Applications/oh-my-f1-viewer.app`, the one the keychain lets read the sign-ins:

```bash
node scripts/packaged-live-check.mjs /tmp/packaged-live-check
```

And this one, also on a packaged app during a live session, runs build mode's `look_at` over the DRM video, then quits and
starts again on the same profile to check the capture is rebuilt with the time closed as a gap:

```bash
node scripts/packaged-live-extra.mjs /tmp/packaged-live-extra
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it fits together and [STATUS.md](STATUS.md) for what is
verified and what isn't.
