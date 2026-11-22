# Usage counts

OMFV sends anonymous usage counts to PostHog: how many installs and starts there are, the sessions people open
and for how long, which charts they add, and how the agent and build mode are used. These are counts only. Nothing in them
says who the viewer is, and none of it is anything they typed. This page lists everything that's sent, and
[shared/telemetry.ts](../shared/telemetry.ts) is the same list in code. Change both in the same change.

## What the viewer sees

- **On, with a notice.** The first time it would send, the palette says so once, in the maker's own words, along with how to turn
  it off. Nothing is sent before that line has shown: events from that first start are held until it has.
- **`/settings-usage`** says whether counts are on. `/settings-usage off` turns them off and forgets the id. `/settings-usage on`
  turns them on again, with a new id.
- The palette's words are in `src/shell/telemetry.ts`.
- **The environment** can also stop it: `OMFV_TELEMETRY=0`, or `DO_NOT_TRACK=1`.

## What's never sent

- **Who you are.** That covers your F1 TV account, your model provider, your email, your IP address and where you are. PostHog
  makes no person profile (`$process_person_profile: false`, `personProfiles: 'never'`), the SDK doesn't look up a place
  (`disableGeoip`), and the PostHog project discards client IPs.
- **What you type or what's on screen.** No prompts or replies, no tool arguments, no file or mod names, no mod code, no event or
  session titles. A mod's tile counts only as `mod`.
- **Free text of any kind.** Main checks every event against the list before sending it. It drops an event that isn't on the list,
  and a property that isn't listed or doesn't fit its kind. Every kind is a closed list, a boolean, a rounded and capped number, or
  a short name like `suggest_tiles` or `openai`.

## The id

A random UUID, made the first time a release sends and kept under `telemetry` in `omfv-settings.json`. It counts installs and
returning use, and that's all it does. It isn't `omfv-install-id`, which a model provider's sign-in is given, and nothing links the
two. Turning counts off deletes it.

## Every event

Each event also carries `build` (`release` or `dev`), `release` (the release name, or `none`), `os`, `arch` and `install` (`appimage`, `pacman`, `mac`,
`windows`, or `checkout`).

| Event | Properties | When |
| --- | --- | --- |
| `app_installed` | `existing_profile`: the profile was used before, by a build that didn't send | The first start that sends |
| `app_started` | `f1tv_signed_in`, `agent_ready`, `mods` (how many) | Every start |
| `app_updated` | none | The first start after an update installed |
| `onboarding_finished` | `how`: `done` or `skipped` | Onboarding ends |
| `session_opened` | `session_type` (`race`, `qualifying`, `sprint`, …), `live`, `year` | A session opens |
| `session_closed` | `minutes`, rounded to 5 and capped at 600 | It closes, another opens, or the app quits |
| `tile_added` | `tile`: a built-in component's name, or `mod` | A tile appears on the grid, from the agent, a suggestion or the viewer |
| `command_used` | `command`: a built-in `/` command's name, without what follows it | A `/` command runs |
| `agent_connected` | `provider`, `way` (`oauth` or `api_key`) | A provider is connected |
| `agent_turn` | `mode` (`pick`, `view`, `build`), `provider`, `model`, `thinking`, `tool_calls`, `acted`, `outcome` (`done`, `error`, `cancelled`), `fix` | A message is answered |
| `agent_tool` | `mode`, `tool` (the tool's name), `ok` | The agent calls a tool |
| `build_started` | none | Build mode begins |
| `build_ended` | `how` (`save` or `undo`), `mods` (how many changed) | Build mode is saved or undone |

## How it's sent

- **From main, never from the page.** `electron/telemetry.ts` sends through `posthog-node` to PostHog's US cloud
  (`us.i.posthog.com`), in batches of 20 or every minute, and for up to 2 seconds on quit. The page's CSP doesn't allow PostHog, so
  the renderer can't reach it. Its five events (`onboarding_finished`, `session_opened`, `session_closed`, `tile_added`,
  `command_used`) go over IPC, and main checks them as it checks its own. A mod runs in the page too, so it can send only those
  five, with only their properties.
- **Each event is tagged with its build.** `build` is `release` for a release, and `dev` for anything else: a checkout,
  `npm run dev`, or `npm run dist` by hand. Filter on it in PostHog.
- **Where the key comes from.** A release has it in its packaged `package.json` (`omfvPosthogKey`), which the release workflow
  adds from the repo secret `POSTHOG_KEY`, only for a real release: a pull request's build or a dry run gets none. A dev
  build sends only when `OMFV_POSTHOG_KEY` is set in its environment, as on the maker's machine. So a fork, CI or an
  agent's run from source sends nothing. The check scripts remove the variable from the apps they start
  (`appEnv` and `startElectron` in `scripts/platform.mjs`), so their fresh profiles never count as installs.
- **A dev build also logs each event** to the main process's output, as `[telemetry] <event> <properties>`, so you can see what
  goes, whether or not it sends. `scripts/usage-counts-check.mjs` reads that log on an isolated
  instance, and checks the counts a session, its tiles and the `/` commands produce, and that `off` stops them.
- **Turning it off** stops new events at once. A batch the SDK was already sending may still go.

## The PostHog project

- **It's on PostHog's US cloud,** and the app sends to `us.i.posthog.com`. Its key is the project's public key (`phc_…`), which
  can only send events. It isn't secret, but it's kept out of the source so only releases and the maker's own runs send.
- **To send from your own runs,** set `OMFV_POSTHOG_KEY=phc_…` in your shell profile. For releases, set the repo secret with
  `gh secret set POSTHOG_KEY`.
- **In the project's settings,** turn on **Discard client IP data**. The app sends no IP, but PostHog takes the request's IP unless
  told to discard it.

## Adding an event

1. Add it to `TELEMETRY_EVENTS` in `shared/telemetry.ts`, with a kind for each property. Use free text for none of them. Add it to
   `RENDERER_EVENTS` too if the page sends it.
2. Send it with `track()` from `electron/telemetry.ts` in main, or `host.telemetry.track()` in the shell.
3. Add it to the table above.
4. A new built-in component or `/` command has to go into `BUILT_IN_TILES` or `COMMANDS`. Tests check both lists against
   `src/components` and `SLASH_COMMANDS`.
