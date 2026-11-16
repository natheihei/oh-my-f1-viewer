# The browser build

f1a also runs entirely inside Chrome, with no desktop app and no server of any kind, local or remote. It's the same renderer and
the same main-process code as the desktop app. The main-process code runs in the page, on browser stand-ins for Node's and Electron's
modules.

It's packaged as an **unpacked extension**, not a hosted page, and that isn't a choice. F1's API, its DRM license server and its
timing archive answer only their own origin (measured in Nov 2026):

| Host | To a page on another origin |
| --- | --- |
| `f1tv.formula1.com` (catalog, playback, Widevine licenses) | No `Access-Control-Allow-Origin` unless the origin is `https://f1tv.formula1.com` |
| `livetiming.formula1.com/static` (the timing archive) | Needs an `Authorization` header, and answers the preflight for it with 401 |
| `account.formula1.com` (sign-in) | The session is a cookie no other origin can read |
| `ott-video-*.formula1.com` (video) | Open: it echoes any origin |
| `api.openai.com`, `api.multiviewer.app` | Open |
| `chatgpt.com/backend-api` (ChatGPT plans), `api.anthropic.com` | Closed to pages |

A page served from anywhere else can't read those answers, and nothing in the page can change that: the browser enforces it. What can
is a server that relays them, which this build must not need, or the browser itself, when the page belongs to an extension that was
granted those hosts. An extension page is an ordinary page with an ordinary DOM. It's the only way to be both a web app and serverless
here.

## Running it

```sh
npm run build:web        # writes dist-web/
```

Then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → pick `dist-web`. Click the f1a toolbar button. The
extension's ID is fixed by the `key` in its manifest, so what it stores survives moving or rebuilding the folder.

- `/login-f1tv` opens F1's own sign-in page in a small window and reads the `login-session` cookie when it appears. If this Chrome
  is already signed in to F1, it signs in at once, with no window.
- `/settings-agent` connects OpenAI (a ChatGPT plan or an API key) or Anthropic (an API key), as in the desktop app.

Chrome 122 or later, on a desktop. Chromium builds without Widevine can't play F1 TV's video.

## How it's put together

```
dist-web/
  index.html, assets/   the renderer, built by Vite from src/ (vite.web.config.ts), entered through web/entry.ts
  backend.js            electron/ipc.ts and everything under it, bundled by esbuild with web/shims in place of Node and Electron
  timing-worker.js      electron/timingdb/worker.ts, the same way, for a Web Worker
  sw.js                 the service worker: opens the app, and serves compiled mods
  esbuild.wasm, sqlite3.wasm, mod-types.json, key.html, signin.html, folder.html, manifest.json
```

`web/entry.ts` takes a lock so only one tab runs the app, imports `backend.js` and calls its `start()`, which puts `window.f1a` in
place, then imports the renderer. `window.f1a` is `web/backend/platform.ts`: the same channels `electron/preload.ts` exposes, each a
direct call into the handlers `electron/ipc.ts` registers. `ipc.ts` is written against `electron/platform.ts`'s `Platform`, which the
desktop app fills with Electron's IPC (`electron/electronPlatform.ts`) and this build fills with the page. Values are still copied
each way, as IPC copies them.

Nothing under `electron/` knows which one it's running in. `web/build.mjs` swaps modules as it bundles:

| The code asks for | It gets (`web/shims/`) |
| --- | --- |
| `electron` | `electron.ts`: cookies through `chrome.cookies`, `BrowserWindow` as a popup window or a background tab, `session.fetch` with the browser's cookies, `safeStorage` as an AES-GCM key that can't be exported, `shell.openExternal` as a tab |
| `fs`, `fs/promises` | `fs.ts`: an in-memory volume (memfs). `fsPersist.ts` loads it from IndexedDB before anything starts and saves each change back. The app's data folder is `/f1a` in it |
| `node:sqlite` | `sqlite.ts`: SQLite's WebAssembly build, on the origin's private file system |
| `worker_threads` | `worker_threads.ts`: Web Workers |
| `esbuild` | `esbuild.ts`: esbuild's WebAssembly build, reading from the volume |
| `http` | `http.ts`: a server with no socket, which answers the page's own `fetch` to `127.0.0.1` |
| `undici`, `ws` | The browser's `fetch` and `WebSocket`. Downloads from the timing archive are paced: see below |
| `crypto`, `zlib`, `os`, `child_process`, `buffer`, `url` | Small stand-ins. `crypto.verify` checks F1's RS256 token signature with BigInt |
| `process`, `Buffer`, `setImmediate` | `globals.ts`, injected wherever one is named |

The vendored F1 client (`electron/vendor/f1ov`) isn't touched. The agent needs none of this: pi-durable and pi-ai run in a browser as
they are, apart from the two things under "The agent" below.

### What each service becomes

- **F1 TV sign-in.** `loginWindow.js` runs as it is. Its `BrowserWindow` is a popup on F1's page, and its cookie listener is
  `chrome.cookies.onChanged`. Signing out removes this Chrome's `formula1.com` cookies, which also signs F1's own site out.
- **Playback and DRM.** The player posts each Widevine challenge to the license proxy at `http://127.0.0.1:18765/la`, as in the
  desktop app. Here that address is the `http` shim, so the request never leaves the page: `licenseProxy.js` gets it, and forwards
  it to F1 with each stream's own tokens. A page can't set a `Cookie` header, so the stream's `playToken` cookie is put in the jar
  for that one request, and such requests go one at a time (`sessionFetch` in `electron.ts`). Widevine itself is Chrome's.
- **The session database.** `electron/timingdb` runs as it is, in a Web Worker. SQLite's files are in the origin's private file
  system through the `opfs-sahpool` VFS, which needs no cross-origin isolation. That VFS has no shared memory, so there's no WAL: the
  writer keeps a transaction in memory until it commits (`cache_spill = OFF`) and a commit is written without yielding, so the
  read-only connection that answers SQL never sees half of one. The VFS holds its files exclusively, which is one reason for one tab.
- **The timing archive.** Node gives each of a session's fifteen-odd files a connection of its own, and the F1 client allows each
  30 seconds. A browser sends them all down one HTTP/2 connection, where on a slow link the last ones were still arriving when their
  time ran out. `web/shims/undici.ts` gives up an archive download when nothing has arrived for 30 seconds, not when it's slow, and
  holds the two large telemetry files until the small ones are in.
- **Live timing.** The SignalR socket is the browser's `WebSocket`. Not yet run on a live session: see STATUS.md.
- **Mods.** `electron/mods` watches `/f1a/mods` in the volume and compiles with esbuild's WebAssembly build. An extension page may
  only run scripts from its own origin, so a build can't be imported from a blob. The page puts each build in a cache
  (`web/modCache.ts`), and the service worker answers `/mods-built/<name>/main.js?v=<n>` from it.
- **The agent.** `electron/agent` runs as it is, on pi-durable. Its credential, its settings and each conversation's `.jsonl` are
  files in the volume (`/f1a/pi-agent`), as on the desktop, and the newest 40 conversations of each agent are kept, since the volume
  is held in memory. pi-ai loads its ChatGPT sign-in, and three Node modules a helper asks for, by names it hides from bundlers:
  `web/build.mjs` rewrites those imports and `web/backend/piRuntime.ts` answers them from the bundle.
- **The agent's sign-in** (`web/backend/agentSignIn.ts`). A ChatGPT sign-in ends with the provider sending the browser to
  `http://127.0.0.1:1455/auth/callback`, where pi listens. pi's listener is the `http` shim, so the tab's move to that address is
  noticed (`chrome.tabs.onUpdated`) and handed to it, and the tab is closed. An API key is typed into a small window of its own
  (`key.html`), which hands it to the app's tab.
- **The build agent's picture** (`look_at`). The desktop app captures the window. Capturing a tab would need the extension to ask for
  every site, so the component's element is drawn to a PNG in the page instead (html-to-image). Canvases come out as they are. A
  video's frame is there when the browser lets the page read it, which it does for software-decoded Widevine, and black otherwise.

### Permissions

`cookies` (F1's sign-in cookie, and `playToken`), `tabs` (finding the app's tab, and seeing a sign-in tab reach its callback),
`unlimitedStorage` (a race's telemetry is about 1.4 million rows), and these hosts: `formula1.com` and its subdomains, Akamai's video
hosts, `api.multiviewer.app` (circuits), and the model providers.

## What's different from the desktop app

- **Mods run with the extension's permissions.** In the desktop app a mod runs in the renderer, which holds no credentials. Here the
  page is also the main process, so a mod can reach what it holds: the volume, with the agent's `auth.json`, and F1's cookies. Only
  load mods you'd run as a program. The API-key window still keeps a key out of the page while it's typed, but once stored, the page
  can read it.
- **The mods folder is in the browser**, not on disk. To work on mods with an editor or a coding agent outside the app, link a
  folder: the extension's options page (right-click the toolbar button → Options) asks for one, and from then on
  `web/backend/modsFolder.ts` keeps it and the app's mods folder the same, in both directions, while the app is open. The browser can't
  watch a folder, so it's read once a second. Chrome asks to allow the folder again in a new browser session unless it was allowed
  for every visit, and the options page says so when it does. From devtools, `__f1aWeb.fs` is the volume's `fs`.
- **One tab.** A second one says the app is already open.
- **No hidden window** for refreshing F1's token: the refresh opens a background tab for a few seconds and closes it.
- **Autoplay.** The desktop app starts streams with sound without a click. Chrome may hold a stream's sound until the page has been
  clicked once.
- **Storage belongs to the browser profile.** Clearing the extension's site data, or removing the extension, removes the session
  database, mods and sign-ins.

## Checks

`scripts/web.mjs` starts a Chrome of its own with the extension loaded: a fresh profile, driven over the devtools protocol, silent on
workspace 3 under Hyprland. Branded Chrome no longer takes `--load-extension`, so it loads the extension over Chrome's debugging pipe.
It borrows the desktop app's F1 TV sign-in by putting its cookies in that Chrome (Linux keyring only).

```sh
npm run build:web
node scripts/web-check.mjs <screenshot-dir>           # sign-in, DRM video, database, streams, charts, mods, build mode, reload
node scripts/web-check.mjs <screenshot-dir> --agent   # also the real agent, viewing and building
```

`--agent` borrows the desktop app's agent login and writes it back if the page refreshed it, so it refuses while the desktop app is
running. The shims that can run under Node are unit-tested (`web/shims/*.test.ts`).
