# Spoiler prevention

OMFV holds whole races in a local database, and most viewers are watching a replay they don't know the end of. The rule across the app:

**The viewer learns nothing past the frame on screen unless they asked to.**

Protection comes in layers, from the data up. Each one assumes the layer above it could misbehave.

| Layer | What it stops | Where |
| --- | --- | --- |
| Data as of the playhead | Charts and queries seeing the future | `electron/timingdb/store.ts`, `src/data/sessionData.ts` |
| What the agent is given | Spoilers arriving unasked in the agent's input | `src/agent/bridge.ts`, `src/agent/tools.ts` |
| The spoiler check | The agent reading ahead or seeking forward unapproved | `src/agent/spoilerGate.ts`, `src/shell/lookAhead.ts` |
| Forgetting read-ahead turns | An approved read leaking into later turns | `electron/agent/extensions/forgetReadAhead.ts` |
| The system prompt | The agent saying what it knows from memory | `shared/viewPrompt.ts` |

## Data as of the playhead

[SESSION_DATA.md](SESSION_DATA.md) has the details.

- **Every row knows when it was revealed.** `visible_from` is when the feed made a row known, on the same clock as the playhead. A row's own `date` can't
  serve, because a message often reports something earlier than when it was sent.
- **Rows that change are stored as versions.** `laps`, `stints`, `pit`, `drivers` and the championship tables return the newest version the playhead has
  reached, so a stint's `lap_end` can't reveal a stop that hasn't happened yet.
- **SQL can only reach limited views.** Consumers' queries run on a read-only connection against temporary views limited to the session and the playhead. An
  authorizer refuses everything else, including the tables behind those views.
- **`sessionData` follows the playhead too.** The roster and `lapCount` read as they stood at that frame.
- **The result waits for the finish.** `session_result` is revealed when the feed reports the session over, so it's empty until the
  playhead gets there. `asOf: 'session'` reads it like any other table.
- **Charts read as of the playhead.** `useSql` does by default, and seeking back hides what had been shown. A component can ask it
  for the whole session, and its author decides whether to warn: with `looksAhead: true` in its definition, the grid shows a red `! spoiler`, "This tile
  looks ahead of where you are." and an Allow button in place of the tile until the viewer allows it. See [BUILD_MODE.md](BUILD_MODE.md).
- **A live session waits for the video.** Rows are compared with the stream's wall clock, since F1 TV's video runs tens of seconds behind the feed.

Reading the whole session takes `host.data.sql({ asOf: 'session' })`, asked for by name. The host doesn't check who's calling: policy belongs to the caller.

## What the agent is given

Nothing that reaches the agent by default says how a session went:

- **Its system prompt reference** lists events by name, round and dates, charts by what they're for, and tables by their columns.
- **`app_state`**, sent with each message, adds only the playhead and the roster: who is entered, not where they are.
- **Tool results** say what exists and what's on screen. A seek reports only where playback landed.
- **Charts** are picked by description, and the agent never sees what they show. `planCharts` refuses a chart only for reasons that don't depend on how the
  session is going.
- **`query_session`** reads as of the playhead unless it asks for more.

## The spoiler check

The gate runs in the agent's tools, before anything executes, so no row reaches the model and no stream moves unapproved. It's asked for two things:

- **Reading ahead:** `query_session` with `asOf: 'session'`.
- **Seeking forward:** `seek_to` to a moment later than the playhead, or when the playhead isn't known.

Both are ways of looking ahead. The viewer sees a red `! spoiler`, "The agent wants to look ahead of where you are.", and never the SQL, the target time or how far ahead it is, since any of those could give something away.

- **Allow once** lasts for the agent's turn.
- **Allow for this session** lasts until another session opens.
- **Don't allow**, Esc, or 50 seconds without an answer refuses. So does the turn ending. The tool call fails and the query or seek never runs.

Reading ahead at the live edge doesn't ask, since it only sees the seconds the feed is ahead of the video. The viewer's own timeline is never gated.

[DESIGN.md](DESIGN.md) covers the check in full.

## Forgetting read-ahead turns

The check decides what the agent may read. It doesn't say how long the agent keeps it. Without a limit, rows from an approved read stay in the conversation
and can come out in a later turn or a compaction summary, long after an "Allow once" has lapsed.

**An approved read ahead is usable only in the turn that asked for it. After that, the agent remembers only what it told the viewer.**

Within the turn the agent can answer from what it read, because the viewer agreed to the peek. Once the turn is over, the history holds what the viewer asked
and what the agent said to them, which the viewer already knows.

How it works, in `electron/agent/extensions/forgetReadAhead.ts`:

- **Marking.** A tool that reads past the playhead says so with `pastPlayhead` on its exposure in `src/agent/tools.ts`, and the agent notes the call of each successful
  result that carries it, for as long as the turn lasts. The mark means "read past the playhead", not "the viewer was asked", so live-edge reads count too.
- **Collapsing.** A marked turn is reduced to its user message and one assistant message holding everything the agent said, in order. Tool calls, tool
  results and reasoning are all dropped, including the SQL and seek dates, which can carry what the agent learned.
- **Telling the agent.** The user message gains an `<app_note>` block saying the tool calls were removed. It's on the user side, next to `<app_state>`, so the
  agent isn't shown a pattern of replying without tools that it could copy.
- **When the turn ends**, however it ends, one more entry is written to the conversation (`omfv.forget`). It holds an edit for each
  entry of the turn: replace the user message with the noted one, replace the last reply with everything the agent said, and omit the
  rest. pi-durable applies those edits whenever it builds what the model sees, so every later request reads the cut-down turn.
  If writing it fails, the turn's calls stay marked and it's tried again before the next message; if that fails too, the
  conversation starts over, so the rows never reach another request.
- **Compaction** summarizes what the model sees, so it reads the cut-down turn too. A turn that read ahead and is still running
  has its rows in the context it needs, and a summary would outlive the turn. So a `beforeCompact` hook makes that summary itself:
  from the same messages with the running turn cut down the same way, by the conversation's own model. If that fails, compaction
  is declined: no summary is better than one that could give the race away.
- **Build mode** marks nothing: its agent reads the whole session by design, and its conversation ends with the build.

The stored conversation isn't changed: the turn's entries stay as they were, and the edits apply only to what the model is sent. The palette is built from events during the turn, so the viewer's history
doesn't change either. The first request after a collapse re-reads that turn and the new message. The prompt and the turns before it stay cached.

If the agent needs the data again, it queries again. Under "Allow once" that asks again. Under "Allow for this session" it doesn't.

## The system prompt

The viewing prompt, `VIEW_PROMPT` in `shared/viewPrompt.ts`, covers what code can't:

- Never reveal results from memory, or from anything not approved to read.
- With approval, the agent may answer from what that read returned. It's allowed to, not required to: "Jumped to lap 30." is still a fine answer.
- Never ask for permission itself: the app asks.
- Never describe what a chart shows.

The picking prompt beside it, for when no session is open, says only never to reveal or hint at results. Its agent can't read a
session or see a chart.

## What this doesn't cover

- **The model's own memory.** It may know how a past race ended, and only the prompt stops it from saying so.
- **Within the turn.** The rows are in context until the turn ends, so that turn's reply depends on the prompt.
- **What the agent said.** Its replies stay in the history. If it disclosed something in an approved turn, later turns can repeat it.
- **Live sessions with no wall clock.** With nothing to compare against, everything is visible.
- **Mods.** A mod can read the whole session, with `useSql` or `host.data.sql` and `asOf: 'session'`, and show the result. Nothing
  gates that. A component that declares `looksAhead` asks the viewer once per tile, but declaring it is up to the author. See [MODS.md](MODS.md).
- **Build mode.** Its agent reads the whole session with no check: entering build mode is the viewer's consent, said in red beside
  `/build`: "! spoiler the agent looks ahead without asking". The viewing agent can offer build mode, to fix a tile's code or
  build something no chart does (`offer_build`), and the offer says the same in red beside **Switch to build**, so switching from it is
  the same consent. Its reason, which the offer shows, comes from the viewing agent, under its own rules. What the viewing agent hands
  over is a note of its own and any tiles' errors. The build agent's conversation is its own, ends with the build, and reaches the viewing agent only as one line the app writes. What it
  says to the viewer while building depends on its prompt. See [BUILD_MODE.md](BUILD_MODE.md).
- **Commentary captions.** Not in the app yet. They contain the race, so reading them ahead has to go through the check. See [CAPTIONS.md](CAPTIONS.md).

## How it's checked

- `electron/timingdb/store.test.ts`: reads are limited to the playhead and direct table reads are refused.
- `src/agent/tools.test.ts` and `src/shell/lookAhead.test.ts`: the gate and the check.
- `electron/agent/extensions/forgetReadAhead.test.ts` and `electron/agent/agent.test.ts`: collapsing, in the request and in compaction.
- `scripts/seek-check.mjs`: the check in the real palette with the real model, including later turns sent after a read-ahead turn is cut down.

Compaction has only run against a fake model. See [STATUS.md](STATUS.md).
