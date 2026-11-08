# Design direction: one host, components as mods

Agreed on 2026-11-08. This is where the app's layering is heading. `docs/ARCHITECTURE.md` describes what exists today, and `docs/STATUS.md`
says what's verified.

The pattern comes from [herdr-app](https://github.com/herdrdev/herdr-app), whose interface is mods reading one data surface and changing the
app through one write path. f1a adopts the idea, not the machinery.

## The rules

1. **One read surface.** Everything a consumer can know comes from the host, in the same shape for every season and every source.
2. **One write surface.** Nothing changes except through `host.*` functions, and `tests/layers.test.ts` forbids any other route.
3. **Components are mods.** A tile component only declares itself and uses the host. It can't reach the data or layout layers.
4. **The host doesn't judge.** It has no gates or per-caller rules. `host.playback.seek()` goes anywhere, and policy belongs to whoever calls it.
5. **Differences are data.** When something must vary by year or Grand Prix, it goes in a looked-up spec that names a parser, not in `if` branches.
6. **Missing data is data.** Each data kind carries its own state and reason.

## Layers

```
┌ CONSUMERS ─────────────────────────────────────────────────┐
│ Components   video now, more later (the "mods")            │
│ Frame        timeline · palette · countdown                │
│ Agent        tools built on the host · spoiler gate        │
├ HOST (src/host): the only import consumers may use ────────┤
│ reads    session · clock · feeds · streams · timing …      │
│ writes   host.session · playback · audio · layout (typed)  │
│ native   <Video feed />                                    │
├ CORE ──────────────────────────────────────────────────────┤
│ Data · Playback (streams, sync) · Layout (tree, GridStack) │
│ Per-year/race spec → parser registry → one output shape    │
├ main process: privileged work only, reached through IPC ───┤
│ Sign-in · signed requests · DRM proxy · live socket ·      │
│ agent loop                                                 │
└────────────────────────────────────────────────────────────┘
```

IPC is a process boundary, not a layer. Electron requires it to reach the main process, and only the core uses it. Main holds what needs
privileges: tokens stay out of a renderer that runs with `webSecurity` and `sandbox` off. Everything else belongs in the renderer's core, so
the IPC surface doesn't grow as data kinds are added.

## The host

```ts
// Live reads: re-render only when what you selected changes
useLive((s) => s.clock.playing);
read();                               // The same state, once, outside React

// Typed writes, and async queries
host.session.open({ contentId, fromStart });
host.playback.seekBy({ seconds: -10 });
host.layout.group({ feeds, title });
await host.catalog.events({ year });

// A native primitive, like Herdr's embedded terminal: mounting it is what requests the stream
<Video feed={id} />

// A component
export default defineComponent({
  name: 'video',
  View: ({ props }) => <Video feed={props.feed} />,
});
```

Each write and query declares its description and argument schema. The agent's tools are built from them, so a host change that breaks a tool
fails to compile.

## The agent

The agent is a consumer like any other. `src/agent/tools.ts` exposes host functions with one entry per tool:

```ts
expose(host.layout.add, { name: 'add_streams', args: streams, adapt: matchNames, gate: sessionOpen });
expose(host.playback.seekBy, { name: 'seek_back', adapt: negate, gate: [sessionOpen, rewindOnly] });
```

The tool's name, model-facing wording, name matching ("Hamilton") and gates live here, not in the host. A tool that needs different wording or
arguments from the host's declares its own, and `adapt` must turn them into the host function's types.

The agent can change layout and groups, as it always could. `/` commands stay a separate set for the user, and the two don't share entries.

### Spoiler approval

The gate belongs to the agent tool, based on the session state and playhead it reads from the host. It must run before any data reaches
the model, because the model could repeat what it read. Until that approval exists, the agent has no forward seek and no race-state tool.
The timeline is unaffected: the viewer can seek anywhere.

## Missing data is part of the data

There's no separate report of what a session has. Each data kind says so itself, and types stop a consumer from reading data without checking:

```ts
type Timing =
  | { state: 'idle' }                        // No session is open
  | { state: 'loading'; heldRecords: number }
  | { state: 'failed'; reason: string }
  | { state: 'ready'; drivers: DriverRow[] /* … */ };
```

Feeds and streams already work this way: an empty list means none, and each stream has its status and error.

The cost is that a consumer learns this once a session is open, not before. If something needs to know earlier, a spec would answer it without
loading anything. A `none` state, meaning we know there's no data, can arrive with the spec: 2022's refused archive shows as `failed` until then.
Reasons can reach the agent, so they must not hint at what happened in the race.

## Per-year and per-race differences

**Not built, and waiting for its first real case.** Today nothing needs one: the default parser handles every season, and a season with no data just
fails to load, which `state: 'failed'` reports. Build this when a season or Grand Prix needs its own parser, or needs the app to behave differently.

The spec is a tree that follows how F1 is organised: defaults at the root, then year, Grand Prix and session. Each level overrides the one above
it. The file names parsers and the registry holds their code, so a new case means at most one parser and one entry:

```jsonc
{
  "timing": { "source": "f1-archive", "parser": "f1-feed-v1" },
  "years": {
    "2021": {
      "meetings": {
        "1074": {
          "name": "Belgian Grand Prix",
          "timing": { "limited": "Limited timing" }
        }
      }
    },
    "2022": {
      "timing": { "source": "none", "reason": "Not available for this season" }
    },
    "2024": {
      "meetings": {
        "1229": {
          "name": "Bahrain Grand Prix",
          "sessions": {
            "9472": { "name": "Race", "timing": { "archivePath": "…" } }
          }
        }
      }
    }
  }
}
```

- **Keys are F1's own:** `meetingKey` and `sessionKey`, which F1 TV reports for each session. `name` is only for reading the file, and the resolver ignores it.
- **It holds what the source doesn't tell us or gets wrong:** refused archives, thin data, key mismatches and parser choice. HLS vs DASH, feed
  lists and play links come in each response, and copying them would create a second source of truth that goes stale.
- **An audit script keeps it honest:** it walks every session, reports counts only, and flags anything that disagrees with the spec, including keys
  that match no session, such as a Grand Prix filed under the wrong year.
- **New races inherit their year and the defaults,** so the next Grand Prix works with no entry unless the audit finds a problem.

## What we took from Herdr, and what we didn't

| Herdr | f1a |
| --- | --- |
| Mod | Component in a tile |
| Layout block `{mod, props}` | `ComponentSpec`, where a copy is keyed by name and props |
| The `herdr` module | `src/host` |
| Live reads with per-key revisions | Selectors in `useLive` |
| Native terminal inside a mod | `<Video>` |
| `frame/` mods | Timeline and palette: same API, outside the grid |
| Three questions before adding to core | Same: does the app act on it, can only the app see it, and can components not do it correctly? |

Deliberately different:

- **Typed functions, not `run(name)`.** Herdr needs string names because calls cross from JS to Rust and also come from `keys.json` and a CLI.
  We have none of those, and typed calls give compile errors and real return types. A name-based bridge can be added if sandboxed views need one.
- **Writes return results.** Herdr's are fire-and-forget, but the agent needs answers such as which feeds loaded.
- **No per-actor rules.** The agent's powers are its tool list, and the user's are the UI.
- **No sandbox, hot reload or file-based mods yet.** Every component is our own code. Keep reads and write arguments JSON-safe, so that
  agent-created views can run sandboxed later.
- **No edit rescue or separate daemon.** Those solve problems of user-installed mods and long-lived terminals, which we don't have.

## Order of work

1. Commit the 2021+ playback fix and the caption notes. *Done.*
2. Add `src/host`, route every write through it, and enforce it in the layer test. *Done.*
3. Move `VideoTile`, the timeline, the palette and the agent onto it, with tools built from it. *Done.*
4. Have timing report its real state. *Done.*
5. Add the spec and parser registry, when the first real case needs them.
6. Build the audit script, once timing is on screen and its findings matter.
7. Add captions as the next data kind, when the moments feature starts.

Also still to add: an error boundary per tile, so that a broken component can't take the app down.
