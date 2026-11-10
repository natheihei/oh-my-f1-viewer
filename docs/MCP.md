# MCP

f1a is an MCP server, so the user can bring their own agent, such as Claude Code. That agent controls viewing the way the app's own
agent does, and it can build [mods](MODS.md), see what they draw and iterate on them. Agreed on 2026-11-09 and built the same day.

## Connecting

Build once with `npm run build:electron` (`npm run dev` and `npm start` do it too). Then, in Claude Code:

```sh
claude mcp add f1a -- <path to f1a>/bin/f1a-mcp
```

`bin/f1a-mcp` runs a small stdio server with the app's own Electron as Node (`ELECTRON_RUN_AS_NODE`), so nothing else needs
installing. It forwards each request over a socket to the running app: `f1a.sock` in the app's data folder, which only the user can
open, or a named pipe on Windows. `F1A_SOCKET` overrides where both sides look.

```
your agent ─stdio─> bin/f1a-mcp ─socket─> main process ─IPC─> renderer: the host
```

The agent can connect before the app is running. It sees no tools then, and a call says the app isn't running. Once the app is up
the server tells the agent its tools changed (`notifications/tools/list_changed`), and again when the app quits. A call made while the
window is still loading waits for it, up to 30 seconds.

Main forwards a call to the renderer the way it does the app's own agent's tool calls, and the renderer runs it against the host.

## The tools

The outside agent uses the host directly, not the app's own agent's tools: it's a capable agent, and the host is the one surface every
consumer uses. Each tool is generated from a host op's description and argument schema, so a new op becomes a tool with no extra work.
They're named `<group>_<op>` in snake case. Arguments are checked against the op's schema before anything runs, which the host itself
doesn't do.

| Group | Tools |
| --- | --- |
| `session` | `session_open`, `session_close`, `session_feeds` |
| `catalog` | `catalog_seasons`, `catalog_events`, `catalog_sessions`, `catalog_live`, `catalog_upcoming`, `catalog_load_index` |
| `playback` | `playback_play`, `playback_pause`, `playback_toggle`, `playback_seek`, `playback_seek_by`, `playback_seek_to_date`, `playback_seek_to_start`, `playback_go_live` |
| `audio` | `audio_set`, `audio_set_volume`, `audio_change_volume_by`, `audio_toggle_mute` |
| `layout` | `layout_add`, `layout_remove`, `layout_close`, `layout_group`, `layout_close_group`, `layout_ungroup`, `layout_focus`, `layout_reset`, `layout_move`, `layout_swap` |
| `appearance` | `appearance_set_background`, which picks what fills the gaps between tiles and changes its settings |
| `data` | `data_sql`, which returns at most 500 rows and says when it cut some |

Left out: `components` and `backgrounds`, whose arguments are code, `suggestions`, the strip that belongs to the app's own agent and the user's pointer,
and the sign-ins. A few tools carry a note the host's description leaves out, such as where to find a tile's key.

On top of those:

| Tool | Runs in | What it does |
| --- | --- | --- |
| `state` | Renderer | What's open and on screen: the session, clock, feeds, tiles (id, key, type, label, props and grid cells), groups, streams, audio, the session data's state, roster, tables, lap count and playhead, the circuit, the components with their props' schemas, the mods, and the backgrounds with their settings' schemas and current settings |
| `screenshot` | Main | A PNG of the whole window, or with `tile` only that tile's component. It comes with each tile in the image: key, type, label, rectangle in CSS pixels, what each of its queries last returned (row count and the first three rows), and a mod's state, version and last 10 log lines |
| `mods_list` | Main | Every mod: state, version and error |
| `mods_logs` | Main | A mod's recent console output and render errors, 50 lines by default |
| `mods_check` | Main | Waits for a mod's latest save to build and for the renderer to answer for it, then reports `ready` or `failed` with the error and the last log lines. A save the file watcher hasn't reported yet still counts: it compares the files' times with the last build. A failure is marked as an error |

The server's instructions tell the agent where mods go, what they can import, how to check their types, the example to start from,
and the loop: save, `mods_check`, `layout_add`, `screenshot`.

## Spoilers

There's no spoiler gate: an agent the user brings is the user's to direct, and avoiding spoilers is its job. The app makes the risk
explicit instead. `data_sql` reads only what the feed had revealed at the frame on screen unless the call sets `asOf: "session"`, and
its description says, under "SPOILERS", that this reveals what hadn't happened yet, results included. `state` holds nothing past the
playhead, and a screenshot shows only what the viewer sees. Seeking needs no flag: the agent learns nothing from a seek but where it
landed.

## Checking it

`node scripts/mcp-check.mjs <screenshot-dir>` uses the real app only through `bin/f1a-mcp`, as an MCP client. It connects before the
app starts, finds and opens a replay race, mutes it, jumps to a lap, sets a background and puts the user's back, builds a mod, checks
it, puts it on screen, screenshots it, saves a change and checks at once, saves a broken version, sends wrong arguments and removes
the mod.

## Limits

- Protected (DRM) video may come out black in a screenshot. Not checked: the replays used had none.
- A minimized window isn't drawn, so a screenshot fails with that reason instead of returning a blank image.
- Only Linux has been run. macOS uses the same unix socket, and Windows a named pipe, but neither has been tried.
- One app runs per profile, so every agent connected talks to the same window.

## Where it lives

| Piece | File |
| --- | --- |
| The stdio server, started by `bin/f1a-mcp` | `electron/mcp/shim.ts` |
| What crosses the socket, and where it is | `electron/mcp/protocol.ts` |
| The socket, forwarding, screenshots and mod tools | `electron/mcp/server.ts` |
| Tools generated from the host, and `state` | `src/mcp/tools.ts` |
| Answering main in the renderer | `src/mcp/index.ts` |
| The bridge to main | `src/data/external.ts` |
| What each tile's queries last returned | `src/host/tile.ts` |
| Types shared by main and the renderer | `shared/external.ts` |
