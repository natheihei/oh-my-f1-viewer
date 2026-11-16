# From pi-coding-agent to pi-durable

The agent runs on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable), with models
and sign-ins from pi-ai. Until Nov 2026 it ran on pi-coding-agent. This says why it moved, what each part became, and what changed for
someone using or working on the app. [ARCHITECTURE.md](ARCHITECTURE.md) describes the agent as it is now.

## Why

pi-coding-agent is a terminal coding agent the app borrowed a session from. It brings its own model settings, session files,
built-in tools and extension loading, and assumes Node everywhere. pi-durable is the harness alone, written to run anywhere: it takes
its storage, its model credentials and its tools from the host, so the app supplies exactly what the agent can reach.

It's also what makes a browser build of f1a practical, which is kept for later. A browser bundle of what `agent.ts` imported from
pi-coding-agent asks for 39 Node modules and is 7.6 MB minified. pi-durable with pi-ai's OpenAI and Anthropic providers asks for
three (`http`, `crypto` and `fs`, all from pi-ai's ChatGPT sign-in and one helper) and is 0.9 MB.

## What each part became

| On pi-coding-agent | On pi-durable |
| --- | --- |
| `ModelRuntime` | pi-ai's `createModels()` with only the supported providers, and `auth.json` through a `CredentialStore` of the app's (`credentialFile.ts`). The file's shape is the same, so a login made before still works |
| `SettingsManager` | `settingsFile.ts`, on the same `settings.json` and keys |
| `createAgentSession`, `SessionManager` | A `Harness` per conversation on pi-durable's `MemoryStorage`, since nothing is resumed, and `transcript.ts`, which writes the same one `.jsonl` per conversation with pi's line types |
| The prompt extension, over `SYSTEM.md` | One prompt `section()`, from `SYSTEM_PROMPT` in code. `SYSTEM.md` is no longer written |
| The tools extension | `defineTool()` tools in an extension that's installed again to replace the set, also from inside a call |
| `roundCap` | `maxTurns`. The run ends with `turn_limit`, which is told apart from a cancel |
| `forgetReadAhead`, on each request and each compaction | One `f1a.forget` entry when the turn ends, holding context edits, and a `beforeCompact` hook for a turn still running. See [SPOILER_PREVENTION.md](SPOILER_PREVENTION.md) |
| `renderCheck` | An `onYield` hook that continues the run, within the rounds the message has left |
| pi's `read`, `write`, `edit`, `ls`, `find`, wrapped, and our `grep` | The app's own six, over `fs` alone (`modFiles.ts`) |
| `text_delta` events | A watch on the conversation: the reply in progress is published every 40 ms, and each finished reply is an entry |

## What changed

What the agent does is the same. These are the differences someone could notice:

- **Stored conversations** are still one `.jsonl` each, with pi's `session`, `model_change`, `thinking_level_change` and `message`
  lines. A line's `id` and `parentId` are the file's own, a summary's message carries `"kind": "pi.compaction"`, and a cut-down turn
  adds a `custom` line of type `f1a.forget` that lists what was cut. Lines pi wrote for things the app never used are gone.
- **`SYSTEM.md`, `models.json` and `models-store.json`** in `pi-agent` are no longer written or read: pi-coding-agent read its prompt
  from the first and kept its own model settings in the others, which the app never used.
- **The mods folder** no longer gets an `AGENTS.md` or a `tsconfig.json`. Nothing in the app read them: they were for a coding
  agent or an editor working there from outside, which is left for when outside agents are supported (issue 33). `.types` stays,
  for the build agent.
- **The build agent's file tools** are the app's own now, with the names, descriptions, parameters and results pi's had: the same
  words for each success, notice and error, naming a path the same way. That includes `read` handing the model an image or a binary
  file as text, as the wrapped tool did: sending a picture instead is left for a change of its own.
- **A summary made during a turn that is still reading ahead** is made with the app's own short prompt, not pi's. Every other
  summary is pi-durable's.
- **Installing** needs `legacy-peer-deps` (set in `.npmrc`): chord, which pi-durable is built on, names an exact React as an optional
  peer for bindings the app doesn't use.

pi-durable calls itself experimental, and its API can change between releases. The agent tests (`electron/agent/*.test.ts`) run
the whole agent against pi-ai's scripted provider, so an upgrade that changes behaviour shows there.
