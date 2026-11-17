# Design direction: one host, components on top of it

Agreed on 2026-11-08. This is where the app's layering is heading. `docs/ARCHITECTURE.md` describes what exists today, and `docs/STATUS.md`
says what's verified.

The pattern comes from [herdr-app](https://github.com/herdrdev/herdr-app), whose interface is mods reading one data surface and changing the
app through one write path. f1a adopts the idea, not the machinery.

## The rules

1. **One read surface.** Everything a consumer can know comes from the host, in the same shape for every season and every source.
2. **One write surface.** Nothing changes except through `host.*` functions, and `tests/layers.test.ts` forbids any other route.
3. **Components only use the host.** A tile component only declares itself and uses the host. It can't reach the data or layout layers.
4. **The host doesn't judge.** It has no gates or per-caller rules. `host.playback.seek()` goes anywhere, and policy belongs to whoever calls it.
5. **Differences are data.** When something must vary by year or Grand Prix, it goes in a looked-up spec that names a parser, not in `if` branches.
6. **Missing data is data.** Each data kind carries its own state and reason.

## Layers

```
┌ CONSUMERS ─────────────────────────────────────────────────┐
│ Components   video and charts, from the app or from mods   │
│ Backgrounds  what fills the gaps between tiles             │
│ Frame        timeline · palette · countdown · settings     │
│ Agent        tools built on the host · spoiler gate        │
├ HOST (src/host): the only import consumers may use ────────┤
│ reads    session · clock · feeds · streams · data …        │
│ writes   host.session · playback · audio · layout ·        │
│          appearance (typed)                                │
│ native   useStream · <Video /> · <Grid /> · <Backdrop />   │
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
host.layout.setProps({ tile: 'tile-3', props: { driver: 44 } });
await host.catalog.events({ year });

// A native primitive, like Herdr's embedded terminal: holding a video is what requests the stream
const stream = useStream(feed);
<Video stream={stream} />
useTileHeader({ label: 'Battle', drivers: [4, 1], ...streamSlots(a, b) }); // what the title bar shows

// A component
export default defineComponent({
  name: 'video',
  title: 'Video',
  description: 'One feed from the open session.',
  args: Type.Object({ feed: Type.String() }),
  spec: ({ feed }) => ({ key: feed, label: labelOf(feed) }),
  View: ({ props }) => <Video feed={props.feed} />,
});
host.components.register({ components }); // Once, at start: the grid and the agent read them from the host
```

Each write and query declares its description and argument schema. The agent's tools are built from them, so a host change that breaks a tool
fails to compile. [HOST.md](HOST.md) lists them all.

## The agent

The agent is a consumer like any other. `src/agent/tools.ts` exposes host functions with one entry per tool:

```ts
expose(host.suggestions.offer, { name: 'suggest_tiles', args: streamsAndCharts, adapt: matchNames, gate: [sessionOpen, chartsFit] });
expose(host.playback.seekToDate, { name: 'seek_to', adapt: toDateMs, gate: [sessionOpen, dataReady, askIfForward] });
```

The tool's name, model-facing wording, name matching ("Hamilton") and gates live here, not in the host. A tool that needs different wording or
arguments from the host's declares its own, and `adapt` must turn them into the host function's types.

The agent can change the layout, except that it can't add to it: it suggests tiles, and the user adds them. It names a tile on screen by
its id, which `app_state` lists.

### Components

A component is a spec that conforms to its props and draws in a tile. Charts are components that happen to draw charts, `video` is
one that draws a feed, and `battle` draws two feeds and a list: nothing is attached to any kind. (2026-11-15.) Each message carries a
list of every component but video at the end of the system prompt, which `streams` names by feed: name, title, session types,
description and props. The agent picks one by its description, fills in its props and suggests it, a chart next to the onboards it's
about.

- What the viewer picks inside a tile is the component's own state, not props: the battle has none, and starts on the closest fight.
  Its title bar says what it shows, from `useTileHeader`, and `app_state` lists that with the feeds the tile shows, so the agent knows,
  but it can't change the pick.
- Sound belongs to a video. "Play HAM's onboard audio" still names a stream: `set_audio` picks the video, without asking, and refuses a
  feed no tile shows.

Suggesting a component shows the agent no race data, so it needs no approval gate of its own. Its SQL tool is separate, and has the gate
described below:

- A chart declares the props it needs, and the agent fills them in: only the drivers the user named, as car numbers. A chart never
  picks a driver itself, so one about a driver needs one (#77). The agent changes them on screen with `edit_tile`.
- A refusal never depends on how the session is going. It may say no session is open, the chart is for another session type, the session
  has no data, the name is unknown, or the props are missing or don't fit.
- The agent has not seen what a component shows, so it never describes it.

Once session data is ready, the tables `query_session` can read follow the components, from `sessionData.tables`. The tool's own description
doesn't change, so opening a session only changes the end of the system prompt.

### A tile that isn't drawing

The viewer can attach a tile's error to their next message, from the tile's "Attach error to agent". The agent reads it as data, not
as a sentence the app wrote for the viewer: an `<error>` block of JSON per tile after `app_state`, from `errorBlock` in
`shared/health.ts`, then the viewer's words, which may be none. Attaching never sends, so it needs no busy state: the message goes
when the viewer sends it. The viewing agent fixes props with `edit_tile`. For a fix in a component's code it calls `offer_build`, and
the viewer decides whether to switch: build mode lets its agent look ahead, so the offer carries `/build`'s spoiler warning. Switching
starts the build agent on the tiles at once, with the viewing agent's note. It offers build mode the same way when the viewer clearly
asks for something no chart does, with a reason the offer asks and a note for the build agent. See [BUILD_MODE.md](BUILD_MODE.md).

### Finding a session

The app supports seasons from 2023 on. At start it loads F1 TV's events for those seasons, one page per season, and every message to the
picking and viewing agents carries them at the end of its system prompt. With no session open, a message goes to the picking agent, whose
prompt is about this alone, and once a session opens, the same message goes on in a new viewing conversation (see
[ARCHITECTURE.md](ARCHITECTURE.md#agent)). The list has one line per event with its pageId, round, name and dates, so nothing that could spoil
a result. The agent works out with the user which weekend they mean from that list, and asks when it isn't clear. A weekend's sessions still
come from `list_sessions`, since their status changes. If the events don't load, the palette says so and `/reload-events` retries; the
agent isn't asked anything until they're there.

`load_session` opens whatever it's given: a replay or live session plays, and one that hasn't started shows a countdown and opens itself
once F1 TV has it live.

### Suggested tiles

`suggest_tiles` puts streams and charts in a strip between the palette's history and its input, and returns at once: the turn doesn't wait for the user.
Each suggestion is a live preview, unless that tile is already on screen. Then it shows its title with an "on screen" badge, and hovering or
focusing it puts that tile in the spotlight (see "Mentions"). The layout never holds the same component twice, so adding one of those only takes it out of the
strip.

- Click or Enter adds a suggestion where auto-layout puts it. Dragging one onto the grid splits the tile under the pointer across its longer
  side, or fills the gap there. Either way it leaves the strip, and an empty strip closes.
- A preview can be resized by hand from its right edge, bottom edge or corner, like a tile. Its size starts from the component's
  `size.aspect` (see `src/shell/stripShape.ts`). A hand-picked size is at least 120×60, at most the strip's width and half the window's
  height, and holds for that component for the rest of the app session, across turns but not restarts. Double-clicking a grip gives back
  the automatic shape. Resizing never adds or drags the card, and the size doesn't carry to the tile it becomes.
- Suggestions belong to a turn. Another call in the same turn joins the strip, skipping what's already in it or was added from it, with no
  limit on streams (2026-11-15: each preview's videos are real streams, so this costs bandwidth, accepted for now). The user's next message clears it, and tells the agent what they added, dismissed or left.
- Keys: the first suggestion takes focus. ← → move, Enter adds, ↓ or typing returns to the input, ↑ from an empty input comes back. Esc
  dismisses the strip, but while the agent is still working it takes a second Esc, which also stops the turn: otherwise the agent could fill
  the strip again right after.
- The palette stays open while the strip is showing.
- A preview holds its videos quietly: they're never heard. Each holder has its own video, but one let go is taken over by a new holder
  of the same feed in the same moment, so adding a previewed suggestion hands the same element to the tile rather than starting the
  stream again. That matters for DRM and the CDN alike. `/` commands stay a separate set for the user, and the two don't share entries.

### Mentions

Typing `@` in the palette's prompt opens a picker above the input, and picking a row puts a tag in the prompt: a tile on screen, a
driver or a team. A tag is that thing, not the text that found it, so nothing has to be guessed. Typing a name without `@` stays plain
text, and the agent resolves it as before. (2026-11-13. Turning names into tags as they're typed was the first idea. It was dropped
because bare numbers ("lap 44", "top 10"), codes that are words (PER, CAM) and "max speed" would each have needed a rule, and still
misfired. Teams and tiles came 2026-11-16.)

- What can be mentioned:
  - **A tile on screen**, drawn as its title bar reads it, framed: `ONBOARD ▌HAM`. It names the tile by id, so it's that tile even if
    another comes to show the same thing. The agent reads `tile "Onboard HAM" (tile-3)`, the id its tools take.
  - **A driver**, drawn as the driver code library draws one: `▌HAM`. The tag is the code alone: no name beside it and no tooltip. The
    agent reads `HAM (#44)`, code and car number, so it is never mistaken.
  - **A team**, drawn as two bars in its colour and its short name in capitals (`▌▌FERRARI`; "Racing", "F1 Team" and "Team" are dropped
    from the end, so Red Bull Racing is `RED BULL`), so it never reads as a driver. The agent reads `team Ferrari (LEC #16, HAM #44)`,
    with its drivers, so it needs no lookup. A logo was considered and not used: nothing in the data has one, most are unreadable at
    the size of a line of text, they change with sponsors, and nothing else in the app draws one.
  - None of them says what kind of component a tile is, such as a video or a chart: one component can draw both.
- A bare `@` lists every kind under a heading: the tiles on screen in the order they were added, then the roster by car number, then the
  teams in the order of their first driver. The tiles come first since there are few and they're what's most often meant.
- A typed query lists rows of every kind together, best match first, with no headings, and a tile's row says "on screen". A driver
  matches by car number (`@44`, `@#4`), code (`@ham`), first name, surname or full name (`@lewis ham`); a tile by any word of its label,
  codes included (`@gap` finds "Gap to leader", `@ham` "Onboard HAM"); a team by any word of its name (`@red`, `@bull`). Each matches
  from the start of a word, ignoring case and accents. An exact number or code comes first, then whole words, then numbers or codes that
  start with the query, then words that do, so `@1` lists #1, then #10, #11..., and `@ham` lists the driver before the onboard. Rows that
  match as well keep the kinds' order: tiles, drivers, teams. Two drivers with the same name would both be rows; the viewer picks one.
- Keys: ↑ ↓ move, wrapping at the ends and skipping the headings; Enter or Tab picks, and never sends. Esc closes the picker and leaves
  the text, which stays text until the `@` is edited again. Prose after an `@` that matches nothing closes it too. Backspace just after
  a tag turns it back into the `@` text that found it, with the picker open. ← → step over a tag as one piece.
- Pointing at a tile puts it in the spotlight: its row selected in the picker, by keys or under the mouse (the latest wins: keys take over from a still mouse until it moves again), or its tag under the mouse in
  the prompt or the history. Every other tile dims, and this one gets a 2px ink frame round it, title bar included, with its title bar lit:
  ink, with black text. It goes through `host.layout.point`, and a suggestion in the strip that duplicates a tile wins over it, with the
  same spotlight. (2026-11-16. A 1px outline round the tile's content came first. It was too faint on a dark chart or a stream still
  syncing, and the title bar, the part that matches the tag, stayed as it was. A frame and lit bar alone, without the dimming, was the
  other option.)
- What the tags name can change while the viewer types, since the agent opens and closes tiles during its turn. The picker searches
  again, keeping its row while that's still there, and each tag in the prompt is drawn again. A tile's tag follows its title while it's
  on screen. Once it closes, the tag goes dashed and grey, in the prompt and the history, and keeps the title it last had; sent like
  that, the agent reads `tile "Onboard HAM" (tile-3, closed)`.
- No session, no picker: there's no roster, and no tiles. A team named before a session is plain text, which `load_session` reads as
  before. `/` commands don't take mentions.
- What can be mentioned is a list of kinds (`src/shell/mentionKinds.tsx`): each searches what it has, draws its tag and says it as text
  for the agent. A feed would be one more kind.
- The input is a contenteditable box (`src/shell/PromptInput.tsx`) so a tag can be drawn as a code and stepped over as one piece. React
  renders it once; the prompt is read back from the DOM. Pasted text comes in plain, on one line.

### Spoiler approval

The gate belongs to the agent's tools, based on the session state and playhead they read from the host. It must run before any data reaches
the model, because the model could repeat what it read. `spoilerGate` in `src/agent/spoilerGate.ts` is asked once per tool call, before
anything runs, in two cases:

- **Reading ahead:** `query_session` with `asOf: 'session'`, which sees the whole session instead of what the feed had revealed at the
  frame on screen. The request carries the playhead and the SQL. A query as of the playhead doesn't ask.
- **Seeking forward:** `seek_to` to a moment later than the playhead, or when the playhead isn't known. The request carries the playhead
  and the target. A backward seek doesn't ask.

The gate hands the request to an asker the shell registers (`src/shell/lookAhead.ts`), which shows a spoiler check in the palette,
between the history and any suggested tiles: a red `! spoiler`, then "The agent wants to look ahead of where you are.". It never shows the SQL, the
target time or how far ahead it is, since any of those could give something away. Reading ahead and seeking forward ask the same question.
The viewer answers:

- **Allow once:** allowed for the rest of the agent's turn, since one request often takes a few queries and then a seek.
- **Allow for this session:** allowed until another session opens. A `looks ahead · ×` tag beside the input shows it, and clicking it asks
  again next time.
- **Don't allow**, or Esc: refused.

An allow covers both kinds: reading ahead and seeking forward are the two ways the agent looks ahead. A refusal makes the tool fail with a message the agent passes on, and the query or seek never runs. A check left
unanswered for 50s is refused as "they didn't answer", under the 60s a tool call gets before the agent reads it as the app not responding.
A turn that ends, is stopped or is replaced by a new message refuses its open check. Each outcome leaves a line in the palette's history.

Once the viewer approves a read ahead, the agent may answer from what it read, for that turn only. After the turn it remembers only what it
said: see [SPOILER_PREVENTION.md](SPOILER_PREVENTION.md). The `seek_to` result says only where playback landed, as session clock time.

A live session works the same way, except that reading ahead at the live edge doesn't ask: it only sees the seconds the feed is ahead of
the video. Behind the live edge it asks as a replay does, and a seek stays within the seekable range. The timeline is unaffected: the
viewer can seek anywhere.

## Missing data is part of the data

There's no separate report of what a session has. Each data kind says so itself, and types stop a consumer from reading data without checking:

```ts
type SessionData =
  | { state: 'idle' }                        // No session is open
  | { state: 'unsupported'; reason: string } // Before 2023
  | { state: 'loading'; datasets: Record<Dataset, DatasetState> | null }
  | { state: 'failed'; reason: string }
  | { state: 'ready'; drivers: DriverEntry[] /* … */ };
```

Feeds and streams already work this way: an empty list means none, and each stream has its status and error.

The cost is that a consumer learns this once a session is open, not before. If something needs to know earlier, a spec would answer it without
loading anything. A `none` state, meaning we know there's no data, can arrive with the spec.
Reasons can reach the agent, so they must not hint at what happened in the race.

## Per-year and per-race differences

**Started, with one rule.** [src/data/spec.ts](../src/data/spec.ts) holds the tree below, and `specFor` resolves it for the open session
into `live.spec`. Its first entry is `chaseAid`: 2026's cars have no DRS, so the 1 second line in the gap chart is called
Overtake ("OT") from 2026. Parsers aren't in it yet, since the default parser still handles every season and a season with no data just fails
to load, which `state: 'failed'` reports. Add them when a season or Grand Prix needs its own.

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
| Mod, drawn in a layout block | Component in a tile |
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
- **No sandbox.** Mods are plugins in folders that hot reload, like Herdr's ([MODS.md](MODS.md)), but they run in the renderer like
  our own components: a mod is trusted like anything else the user chooses to run.
- **No edit rescue or separate daemon.** Those solve problems of user-installed mods and long-lived terminals, which we don't have.

## Order of work

1. Commit the 2021+ playback fix and the caption notes. *Done.*
2. Add `src/host`, route every write through it, and enforce it in the layer test. *Done.*
3. Move `VideoTile`, the timeline, the palette and the agent onto it, with tools built from it. *Done.*
4. Have session data report its real state, in `sessionData`. *Done.*
5. Add the spec and parser registry, when the first real case needs them.
6. Build the audit script, once session data is on screen and its findings matter.
7. Add captions as the next data kind, when the moments feature starts.

Every tile has an error boundary in `<Grid>`, so a broken component can't take the app down. Charts also have their own, in
`ChartFrame`.
