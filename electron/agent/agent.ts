/**
 * The agent: a pi-durable conversation on the provider, model and thinking level chosen in `/settings-agent`,
 * from the providers in supported.ts, or one set up by hand in its Advanced view (custom.ts). It holds the credentials, so it lives here, but its tools run in the
 * renderer, which owns layout and playback. The renderer sends their definitions with each message, each call
 * goes over IPC, and its result comes back here.
 */
import { app, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fsp, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { Context } from '@earendil-works/chord/context' with { 'resolution-mode': 'import' };
import type { Api, AuthInteraction, CredentialStore, Message, Model, Models, Provider } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };
import type { Conversation as DurableConversation, EntryRecord, Harness, HarnessSettings, Storage } from '@earendil-works/pi-durable' with { 'resolution-mode': 'import' };
import type {
  AgentConnectEvent,
  AgentErrorFix,
  AgentEvent,
  AgentHandoff,
  AgentMode,
  AgentProviderOption,
  AgentScope,
  AgentToolCall,
  AgentToolDefinition,
  AgentToolResult,
  AiStatus,
  ConnectWay,
  CustomModelsFile,
  ThinkingLevel,
} from '../../shared/api';
import { parseAgentSettings, THINKING_LEVELS, type AgentSettings } from '../../shared/agentSettings';
import { CUSTOM_MODELS_DOCS, CUSTOM_MODELS_EXAMPLE_FILE, CUSTOM_MODELS_FILE, CUSTOM_MODELS_SCHEMA_FILE, EXAMPLE_CUSTOM_MODELS, parseCustomModelsText } from '../../shared/customModels';
import { BUILD_PROMPT } from '../../shared/buildPrompt';
import { PICK_PROMPT, VIEW_PROMPT } from '../../shared/viewPrompt';
import { appSettings, type Settings } from '../settings';
import { sendToRenderer } from '../windows';
import { credentialStore, installId } from './credentials';
import { track } from '../telemetry';
import { forgetForSummary, forgetTurn, readAheadIn, SUMMARY_SYSTEM_PROMPT, summaryRequest } from './extensions/forgetReadAhead';
import { modFilesExtension, type ModFilesHost } from './extensions/modFiles';
import { renderCheck, type RenderCheck } from './extensions/renderCheck';
import { customEntry, customProvider, type CustomParts } from './custom';
import { customModelsSchema } from './modelsSchema';
import { askForKey } from './keyWindow';
import { SUPPORTED, supported, type SupportedProvider } from './supported';

const MAX_TOOL_ROUNDS = 10;
/** Building takes more steps than viewing: reading the types, writing, fixing, looking. */
const MAX_BUILD_ROUNDS = 60;
const TOOL_TIMEOUT_MS = 60_000;
/** How many times one message may be handed on to a new conversation: picking, then switching once more. */
const MAX_HANDOFFS = 2;
/** What a call gets when one before it in the same round opened a session: the message is answered there now. */
const HANDED_OFF = 'Not run: a session was opened, so this message is answered in a new conversation for it.';
const PROMPTS: Record<AgentMode, string> = { pick: PICK_PROMPT, view: VIEW_PROMPT, build: BUILD_PROMPT };
const CONNECT_TIMEOUT_MS = 5 * 60_000;
/** How often the text of a reply in progress is published. */
const PARTIAL_INTERVAL_MS = 40;
const SETUP_NEEDED = 'The agent needs setting up first: /settings-agent';

/** The agent can't answer until something is chosen in /settings-agent. Its message is in the viewer's words. */
class SetupError extends Error {}
const WAYS: ConnectWay[] = ['oauth', 'api_key'];
/** Ids a provider from Advanced can't take: the supported ones', and the panel's own for Advanced. */
/** The level a model from Advanced starts at, clamped to what it has. */
const DEFAULT_THINKING: ThinkingLevel = 'medium';
const RESERVED = [...SUPPORTED.map((s) => s.provider), 'advanced'];

/** Stored conversations of each kind kept for review. Older ones are deleted when a new one starts. */
export const KEPT_CONVERSATIONS = 100;

const NOT_READY: AiStatus = { ready: false, provider: null, model: null, modelName: null, thinking: null };

type Durable = typeof import('@earendil-works/pi-durable', { with: { 'resolution-mode': 'import' } });

function emit(event: AgentEvent): void {
  sendToRenderer('ai:event', event);
}

function emitConnect(event: AgentConnectEvent): void {
  sendToRenderer('ai:connect', event);
}

/** Sign-in pages open in the real browser, and only over https. */
function openExternal(raw: string): void {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') void shell.openExternal(url.href);
    else console.warn('[ai] ignored a sign-in URL that is not https:', url.protocol);
  } catch {
    console.warn('[ai] ignored an invalid sign-in URL');
  }
}

/** The model providers and their credentials, as the agent uses them. Tests put fakes in its place. */
export interface AgentModels {
  models: Models;
  credentials: CredentialStore;
  /** Adds a provider, or replaces the one with its id. */
  setProvider(provider: Provider): void;
  deleteProvider(id: string): void;
  login: Models['login'];
  logout: Models['logout'];
}

/** Set up once per run of the app. */
interface Runtime {
  durable: Durable;
  context: Context;
  providers: AgentModels;
  /** Opens a conversation's storage. */
  open: (file: string) => Promise<Storage>;
  /** Where each conversation is kept, for review. */
  conversationsDir: string;
  levels: (model: Model<Api>) => ThinkingLevel[];
  clamp: (model: Model<Api>, level: ThinkingLevel) => ThinkingLevel;
  /** What Advanced's providers are made of. */
  custom: CustomParts;
}

/**
 * What the agent runs on: a supported provider with a stored credential, or one from Advanced, and the model and
 * level chosen for it. `way` is null for one from Advanced, which needs no connecting.
 */
interface Choice {
  entry: SupportedProvider;
  way: ConnectWay | null;
  model: Model<Api>;
  thinking: ThinkingLevel;
  stored: AgentSettings;
}

/** One conversation. Starting over makes a new one. */
interface Conversation {
  mode: AgentMode;
  /** What it's about: picking, one opening of a session, or the build. */
  scope: AgentScope;
  harness: Harness;
  root: DurableConversation;
  /** Makes exactly these tools available to the model, from its next request. */
  register(definitions: AgentToolDefinition[]): void;
  /** The build agent's look at the screen before it ends a turn. */
  check: RenderCheck | null;
  reference: string;
  provider: string;
  model: Model<Api>;
  /** Model requests made for the message being answered. */
  rounds: number;
  maxRounds: number;
  /** Calls of the message being answered that read past the playhead. */
  readAhead: Set<string>;
  close(): Promise<void>;
}

interface Turn {
  id: string;
  /** The conversation it's answered in, which a hand-off changes. */
  mode: AgentMode;
  scope: AgentScope;
  cancelled: boolean;
  acted: boolean;
  /** Tools it called, for the usage counts. */
  toolCalls: number;
  /** A call opened a session: once this run ends, the message goes on in a new conversation for it. */
  handoff: AgentHandoff | null;
}

const MODES: AgentMode[] = ['pick', 'view', 'build'];

/** A hand-off as the renderer sent it, or null if it isn't one. */
function handoffOf(value: unknown): AgentHandoff | null {
  const v = value as Partial<AgentHandoff> | null | undefined;
  if (!v || typeof v !== 'object' || !MODES.includes(v.mode as AgentMode) || v.mode === 'build') return null;
  if (typeof v.scope !== 'string' || typeof v.appState !== 'string' || typeof v.reference !== 'string' || !Array.isArray(v.tools)) return null;
  return { mode: v.mode as AgentMode, scope: v.scope, appState: v.appState, reference: v.reference, tools: v.tools };
}

/**
 * Deletes all but the newest `keep` stored conversations of one kind, with SQLite's files beside each. Names start
 * with the time, so they sort oldest first. Best effort: a file that can't be deleted is left for next time.
 */
export async function pruneConversations(dir: string, mode: AgentMode, keep = KEPT_CONVERSATIONS): Promise<void> {
  const suffix = `_${mode}.sqlite`;
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const ofMode = names.filter((name) => name.endsWith(suffix)).sort();
  const old = ofMode.slice(0, Math.max(0, ofMode.length - keep));
  await Promise.all(
    old.flatMap((name) => ['', '-wal', '-shm', '-journal'].map((extra) => fsp.rm(path.join(dir, name + extra), { force: true }).catch(() => {}))),
  );
}

/** The text blocks of a model message, joined. */
function textOf(message: Message | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
}

export class Agent {
  private runtimePromise: Promise<Runtime> | null = null;
  /**
   * The picking or viewing conversation. A message for another mode or scope closes it and starts a new one:
   * opening a session, or closing it, starts afresh.
   */
  private conversation: Conversation | null = null;
  /** Build mode's own conversation, apart from the viewing one. Leaving build mode ends it. See docs/BUILD_MODE.md. */
  private building: Conversation | null = null;
  private modFiles: ModFilesHost | null = null;
  private turn: Turn | null = null;
  private running: Promise<void> | null = null;
  /** Bumped by each send and cancel, so a send waiting on the last turn knows when it's been replaced. */
  private generation = 0;
  private pendingTools = new Map<string, (result: AgentToolResult) => void>();
  private connectAbort: AbortController | null = null;
  /** The run policy every conversation reads, from the settings as they stood at the last message. */
  private policy: HarnessSettings = {};
  /** Advanced's providers as registered with pi-ai, and the stored setup they were made from. */
  /** Advanced's providers as registered with pi-ai, the text of models.json they were made from, and what's wrong with it. */
  private custom: { from: string | null; entries: SupportedProvider[]; errors: string[] } = { from: null, entries: [], errors: [] };
  private customWatcher: FSWatcher | null = null;

  /** `onRuntime` lets tests register a fake model and credentials, and `store` is for their settings. */
  constructor(
    private readonly onRuntime?: (providers: AgentModels) => void,
    private readonly store?: Settings,
  ) {}

  /** The agent's part of the app's settings file: see shared/agentSettings.ts. Read at each use, so a change applies at once. */
  private get settings(): AgentSettings {
    return parseAgentSettings((this.store ?? appSettings()).get('agent'));
  }

  private runtime(): Promise<Runtime> {
    this.runtimePromise ??= this.createRuntime().catch((e) => {
      this.runtimePromise = null;
      throw e;
    });
    return this.runtimePromise;
  }

  private async createRuntime(): Promise<Runtime> {
    const durable = await import('@earendil-works/pi-durable');
    const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
    const { clampThinkingLevel, getSupportedThinkingLevels } = await import('@earendil-works/pi-ai');
    const { createModels } = await import('@earendil-works/pi-ai/models');
    const { openaiProvider } = await import('@earendil-works/pi-ai/providers/openai');
    const { anthropicProvider } = await import('@earendil-works/pi-ai/providers/anthropic');
    const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node');
    const { createProvider } = await import('@earendil-works/pi-ai');
    const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy');
    const { openAIResponsesApi } = await import('@earendil-works/pi-ai/api/openai-responses.lazy');
    const { anthropicMessagesApi } = await import('@earendil-works/pi-ai/api/anthropic-messages.lazy');
    // A test's fakes go in first: its credentials are what the collection is made over, and its providers
    // replace the real ones of the same id.
    const added: Provider[] = [];
    const providers: AgentModels = {
      models: null as unknown as Models,
      credentials: credentialStore(path.join(app.getPath('userData'), 'omfv-credentials.json')),
      setProvider: (provider) => void added.push(provider),
      deleteProvider: () => {},
      login: (...args) => providers.models.login(...args),
      logout: (...args) => providers.models.logout(...args),
    };
    this.onRuntime?.(providers);
    const models = createModels({ credentials: providers.credentials });
    // Only the providers supported.ts offers: nothing else in pi's catalog can be reached. Advanced's are added
    // later, from the settings (customEntries).
    for (const provider of [openaiProvider(), anthropicProvider(), ...added]) models.setProvider(provider);
    providers.models = models;
    providers.setProvider = (provider) => models.setProvider(provider);
    providers.deleteProvider = (id) => models.deleteProvider(id);
    return {
      durable,
      context: BACKGROUND_CONTEXT,
      providers,
      open: (file) => openNodeSqliteStorage(file),
      conversationsDir: path.join(app.getPath('userData'), 'conversations'),
      levels: (model) => getSupportedThinkingLevels(model) as ThinkingLevel[],
      clamp: (model, level) => clampThinkingLevel(model, level) as ThinkingLevel,
      custom: {
        createProvider,
        apis: { 'openai-completions': openAICompletionsApi, 'openai-responses': openAIResponsesApi, 'anthropic-messages': anthropicMessagesApi },
      },
    };
  }

  /** The setup's file, models.json, and its schema and an example beside it. */
  private get customFiles(): { setup: string; schema: string; example: string } {
    const dir = app.getPath('userData');
    return { setup: path.join(dir, CUSTOM_MODELS_FILE), schema: path.join(dir, CUSTOM_MODELS_SCHEMA_FILE), example: path.join(dir, CUSTOM_MODELS_EXAMPLE_FILE) };
  }

  /**
   * Advanced's providers, registered with pi-ai to match models.json (shared/customModels.ts). The file is read at
   * each use, and the providers are made again whenever its text has changed, so an edit applies at the next thing
   * the agent does. A file with anything wrong in it is used not at all, and Advanced says why.
   */
  private async customEntries(): Promise<SupportedProvider[]> {
    const { providers, custom } = await this.runtime();
    let from = '';
    try {
      from = readFileSync(this.customFiles.setup, 'utf8');
    } catch {
      // No file: nothing is set up.
    }
    if (from === this.custom.from) return this.custom.entries;
    for (const old of this.custom.entries) providers.deleteProvider(old.provider);
    const { config, errors } = parseCustomModelsText(from, RESERVED);
    if (errors.length) console.warn(`[ai] ${CUSTOM_MODELS_FILE} is not used:`, errors.join(' '));
    const entries = Object.entries(config?.providers ?? {}).flatMap(([id, provider]) => {
      try {
        providers.setProvider(customProvider(custom, id, provider));
        return [customEntry(id, provider)];
      } catch (e) {
        console.warn(`[ai] the provider ${id} of ${CUSTOM_MODELS_FILE} can't be used:`, (e as Error).message);
        return [];
      }
    });
    this.custom = { from, entries, errors };
    return entries;
  }

  /** Why the agent isn't set up, when what it was set up with is gone from models.json. */
  private async setupProblem(): Promise<Error> {
    const { provider, model } = this.settings;
    if (!provider || supported(provider)) return new Error(SETUP_NEEDED);
    const entry = await this.entryFor(provider);
    if (!entry) return new SetupError(`The agent was using "${provider}", which is no longer in models.json. Choose a model in /settings-agent.`);
    return new SetupError(`${entry.label} no longer has the model ${model ?? 'the agent was using'}. Choose one in /settings-agent.`);
  }

  /** A supported provider, or one from Advanced. */
  private async entryFor(id: string | undefined): Promise<SupportedProvider | undefined> {
    return supported(id) ?? (await this.customEntries()).find((e) => e.provider === id);
  }

  /** The way a provider is connected: its stored credential. Environment variables never count. */
  private async connectedWay(entry: SupportedProvider): Promise<ConnectWay | null> {
    const { providers } = await this.runtime();
    const credential = (await providers.credentials.list()).find((c) => c.providerId === entry.provider);
    const way = credential?.type as ConnectWay | undefined;
    return way && entry.ways[way] ? way : null;
  }

  /**
   * What the agent runs on, or null if it isn't set up. The provider is the one in the settings, and a
   * model missing from its supported list falls back to the recommended one. A provider from Advanced has no
   * recommended model, so when its saved one is gone the agent isn't set up until another is chosen.
   */
  private async current(): Promise<Choice | null> {
    const { providers, clamp } = await this.runtime();
    const stored = this.settings;
    const entry = await this.entryFor(stored.provider);
    if (!entry) return null;
    const way = entry.custom ? null : await this.connectedWay(entry);
    if (!entry.custom && !way) return null;
    const saved = stored.model;
    const id = saved && entry.models.includes(saved) && providers.models.getModel(entry.provider, saved) ? saved : entry.recommended?.model;
    const model = id ? (providers.models.getModel(entry.provider, id) as Model<Api> | undefined) : undefined;
    if (!model) return null;
    const thinking = clamp(model, stored.thinking ?? entry.recommended?.thinking ?? DEFAULT_THINKING);
    return { entry, way, model, thinking, stored };
  }

  /** Gives the build agent its mods folder. Until then it has no file tools. */
  attachMods(host: ModFilesHost): void {
    this.modFiles = host;
  }

  /** Changes the settings, in the app's settings file. */
  private changeSettings(values: AgentSettings): void {
    (this.store ?? appSettings()).set('agent', { ...this.settings, ...values });
  }

  /** The run policy for a conversation, from what the settings say. */
  private policyOf(stored: AgentSettings): HarnessSettings {
    const { enabled, reserveTokens, keepRecentTokens } = stored.compaction ?? {};
    return {
      // The renderer's tools change what's on screen: one at a time, in the order the model asked.
      toolExecution: 'sequential',
      retry: { maxRetries: stored.retry?.enabled ? (stored.retry.maxRetries ?? 3) : 0 },
      compaction: {
        enabled: enabled ?? true,
        ...(reserveTokens === undefined ? {} : { reserveTokens }),
        ...(keepRecentTokens === undefined ? {} : { keepRecentTokens }),
      },
      progress: { partialIntervalMs: PARTIAL_INTERVAL_MS },
      // A message waiting behind a turn that failed is not answered later, out of the blue.
      afterFailedRun: 'withdraw',
    };
  }

  private async createConversation(choice: Choice, mode: AgentMode, scope: AgentScope): Promise<Conversation> {
    const { durable, context, providers, open, conversationsDir } = await this.runtime();
    const { createRegistry, defineExtension, defineTool, hook, section, CompactionTask, GenerationTask, Harness: HarnessClass, ProviderDoc } = durable;
    const build = mode === 'build';
    const id = mode === 'view' ? 'omfv' : `omfv-${mode}`;
    // Kept for review, and so a crash loses nothing, but never resumed: each conversation has a database of its own,
    // and a new conversation or a restart starts empty.
    await fsp.mkdir(conversationsDir, { recursive: true });
    const storage = await open(path.join(conversationsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${mode}.sqlite`));
    await pruneConversations(conversationsDir, mode);

    const registry = createRegistry();
    const check = build ? renderCheck(() => this.modFiles?.health() ?? Promise.resolve(null)) : null;
    const conversation: Conversation = {
      mode,
      scope,
      harness: null as unknown as Harness,
      root: null as unknown as DurableConversation,
      register: () => {},
      check,
      reference: '',
      provider: choice.entry.provider,
      model: choice.model,
      rounds: 0,
      maxRounds: build ? MAX_BUILD_ROUNDS : MAX_TOOL_ROUNDS,
      readAhead: new Set(),
      close: async () => {},
    };

    const base = PROMPTS[mode];
    // One section, so the prompt is exactly these words: the app's own, then what it knows up front.
    const prompt = defineExtension({
      name: 'omfv-prompt',
      sections: [section('omfv', () => (conversation.reference ? `${base}\n\n${conversation.reference}` : base), { tag: false })],
    });

    /** The renderer's tools. Installing the extension again under its name replaces the set, from the next request. */
    const register = (definitions: AgentToolDefinition[]): void => {
      const tools = definitions.map(({ name, description, parameters }) =>
        defineTool({
          name,
          description,
          parameters,
          execute: async (args, api) => {
            // The run ends with this round, every call of which has to say so.
            if (this.turn?.handoff) return { output: [{ type: 'text', text: HANDED_OFF }], isError: true, control: { terminate: true } };
            const result = await this.callTool({ callId: api.callId, name, args: args as Record<string, unknown> });
            // A call that opened a session ends this run. The message is answered again in a conversation for that session.
            const handoff = handoffOf(result.handoff);
            if (handoff && this.turn && !this.turn.cancelled) {
              this.turn.handoff = handoff;
              return { output: [{ type: 'text', text: result.content }], isError: !result.ok, control: { terminate: true } };
            }
            // A call that closes a session changes what the model can do next, in the same turn.
            if (result.tools) register(result.tools);
            // The session's tables, once the data a call waited for has them. The prompt reads this on each request.
            if (typeof result.reference === 'string' && result.reference) conversation.reference = result.reference;
            // The build agent reads the whole session by design, and its conversation ends with the build.
            if (!build && result.ok && result.pastPlayhead) conversation.readAhead.add(api.callId);
            return { output: [{ type: 'text', text: result.content }], isError: !result.ok };
          },
        }),
      );
      registry.install(defineExtension({ name: 'omfv-tools', tools }));
    };
    conversation.register = register;

    const rules = defineExtension({
      name: 'omfv-rules',
      hooks: [
        hook(GenerationTask, {
          beforeRequest: () => {
            conversation.rounds += 1;
            return undefined;
          },
          // The build agent is sent on when something it made isn't drawing, within the rounds the message has left.
          onYield: async () => {
            const left = conversation.maxRounds - conversation.rounds;
            if (!check || left <= 0) return undefined;
            const text = await check.next();
            if (!text) return undefined;
            await conversation.root.configure({ maxTurns: left }, context);
            return { continue: text };
          },
        }),
        hook(CompactionTask, {
          // A summary outlives the turn, so it can't hold rows a turn still running read past the playhead. Such a
          // turn is summarized here from its cut-down form. Once a turn has ended it's cut down in the
          // context itself, and pi-durable's own summary is right.
          beforeCompact: async ({ messages, entries, instructions }) => {
            if (!readAheadIn(messages, conversation.readAhead)) return undefined;
            const summary = await this.summarize(conversation, forgetForSummary(messages, conversation.readAhead, entries), instructions).catch((e: Error) => {
              console.warn('[ai] summarizing a read ahead:', e.message);
              return null;
            });
            // No summary is better than one that could give the race away.
            return summary ? { summary } : { decline: true };
          },
        }),
      ],
    });

    registry.install(prompt);
    if (build) {
      registry.install(
        modFilesExtension(
          durable,
          () => {
            if (!this.modFiles) throw new Error('The mods folder is not available.');
            return this.modFiles;
          },
          (name, ok, note) => this.reportTool(name, ok, note),
          (places) => check?.heard(places),
        ),
      );
    }
    register([]);
    registry.install(rules);

    const harness = await HarnessClass.open(
      storage,
      {
        models: providers.models,
        registry,
        // Read at every use, so the settings as they stood at the last message apply.
        settings: () => this.policy,
        identity: { attribution: null },
        // A fixed id, passed on to the provider as the prompt cache key.
        conversationCreated: async (tx, created) => {
          (await tx.doc(ProviderDoc, created.id)).sessionId = id;
        },
        onReport: (report) => console.warn(`[ai] ${report.kind}:`, report.error),
      },
      context,
    );
    conversation.harness = harness;
    conversation.close = () => harness.close(context).catch((e: Error) => console.warn('[ai] closing a conversation:', e.message));
    conversation.root = await harness.root(context, {
      agent: { model: { provider: choice.model.provider, modelId: choice.model.id }, thinkingLevel: choice.thinking, maxTurns: conversation.maxRounds },
    });
    return conversation;
  }

  async status(): Promise<AiStatus> {
    const choice = await this.current();
    if (!choice) return NOT_READY;
    return {
      ready: true,
      provider: choice.entry.provider,
      model: choice.model.id,
      modelName: choice.model.name,
      thinking: choice.thinking,
    };
  }

  /** The supported providers, as pi describes them. One missing from the installed pi is left out. */
  async providers(): Promise<AgentProviderOption[]> {
    const { providers, levels } = await this.runtime();
    const choice = await this.current();
    const builtIn = SUPPORTED.flatMap((entry): AgentProviderOption[] => {
      const provider = providers.models.getProvider(entry.provider);
      if (!provider) return [];
      const { oauth, apiKey } = provider.auth;
      const label = (way: ConnectWay) => (way === 'oauth' ? (oauth?.loginLabel ?? `Sign in with ${entry.label}`) : 'Use an API key');
      const offered = (way: ConnectWay) => !!entry.ways[way] && (way === 'oauth' ? !!oauth : !!apiKey?.login);
      const way = choice?.entry === entry ? choice.way : null;
      return [
        {
          id: entry.provider,
          label: entry.label,
          ways: WAYS.filter(offered).map((w) => ({ way: w, label: label(w), note: entry.ways[w] as string })),
          connected: way ? { way, label: way === 'oauth' ? (oauth?.name ?? 'Signed in') : 'API key' } : null,
          models: entry.models.flatMap((id) => {
            const model = providers.models.getModel(entry.provider, id) as Model<Api> | undefined;
            return model ? [{ id, name: model.name, thinking: levels(model) }] : [];
          }),
          recommended: entry.recommended,
        },
      ];
    });
    const custom = (await this.customEntries()).map((entry): AgentProviderOption => {
      const config = entry.custom!;
      return {
        id: entry.provider,
        label: entry.label,
        ways: [],
        connected: null,
        models: entry.models.flatMap((id) => {
          const model = providers.models.getModel(entry.provider, id) as Model<Api> | undefined;
          return model ? [{ id, name: model.name, thinking: levels(model) }] : [];
        }),
        recommended: entry.recommended,
        custom: { baseUrl: config.baseUrl, api: config.api, hasKey: config.hasKey, active: choice?.entry.provider === entry.provider },
      };
    });
    return [...builtIn, ...custom];
  }

  /** Opens pi-ai's documentation of custom providers in the browser. The address is the app's own, never the renderer's. */
  openCustomModelsDocs(): void {
    openExternal(CUSTOM_MODELS_DOCS);
  }

  /**
   * What Advanced shows of models.json: where it is, and what the app read from it. Never its text, which can hold a
   * key. The schema and the example are written first, so the prompt Advanced copies names files that are there.
   */
  async customModels(): Promise<CustomModelsFile> {
    const entries = await this.customEntries();
    const { setup, schema, example } = this.customFiles;
    await this.writeCustomReference().catch((e) => console.warn('[ai] the models.json schema and example were not written:', (e as Error).message));
    return { path: setup, exists: existsSync(setup), schema, example, providers: entries.map((e) => e.label), errors: this.custom.errors };
  }

  /**
   * Writes what describes models.json beside it, unless that's what is there: its schema, as the installed pi-ai
   * has it, and the example a new file starts from, for an editor and for the viewer's coding agent to read.
   */
  private async writeCustomReference(): Promise<void> {
    const { schema, example } = this.customFiles;
    const files: [string, unknown][] = [
      [schema, await customModelsSchema()],
      [example, EXAMPLE_CUSTOM_MODELS],
    ];
    for (const [file, value] of files) {
      const text = `${JSON.stringify(value, null, 2)}\n`;
      if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text);
    }
  }

  /**
   * Opens models.json in the viewer's editor for `.json` files, with its schema and an example beside it. A first time, the file
   * is made with an example to change, named as one. Its key, when it has one, is the viewer's alone to read: mode 600. If
   * nothing opens `.json` files, the folder is shown with the file selected.
   */
  async openCustomModels(): Promise<void> {
    const { setup } = this.customFiles;
    await this.writeCustomReference();
    if (!existsSync(setup)) writeFileSync(setup, `${JSON.stringify(EXAMPLE_CUSTOM_MODELS, null, 2)}\n`, { mode: 0o600 });
    if (await shell.openPath(setup)) shell.showItemInFolder(setup);
  }

  /** Shows models.json in its folder, or the folder when there's no file yet. */
  revealCustomModels(): void {
    const { setup } = this.customFiles;
    if (existsSync(setup)) shell.showItemInFolder(setup);
    else void shell.openPath(path.dirname(setup));
  }

  /**
   * Takes up a change to models.json at once. A conversation on one of its providers starts over, since its
   * server or model may have changed. If the provider or model in use is gone, nothing is chosen in its place: the
   * agent isn't set up until the viewer chooses, and the next message says what went (setupProblem). The panel is
   * told, so Advanced shows what was read.
   */
  async customModelsChanged(): Promise<void> {
    const before = this.custom;
    const using = before.entries.some((e) => e.provider === this.settings.provider);
    await this.customEntries();
    if (this.custom === before) return;
    if (using) await this.reset();
    sendToRenderer('ai:customModels', null);
  }

  /**
   * Watches for models.json being saved, from the app's start. Editors save by writing another file and renaming
   * it, so the folder is watched, not the file, and a burst of changes is taken as one. The schema is brought up
   * to date for a file that's already there, and the example with it.
   */
  watchCustomModels(): void {
    if (this.customWatcher) return;
    const { setup } = this.customFiles;
    if (existsSync(setup)) void this.writeCustomReference().catch((e) => console.warn('[ai] the models.json schema and example were not written:', (e as Error).message));
    let timer: NodeJS.Timeout | null = null;
    try {
      this.customWatcher = watch(path.dirname(setup), (_event, file) => {
        if (file !== CUSTOM_MODELS_FILE) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void this.customModelsChanged().catch((e) => console.warn('[ai] models.json was not read:', (e as Error).message)), 200);
      });
    } catch (e) {
      console.warn('[ai] models.json is not watched:', (e as Error).message);
    }
  }

  /**
   * Connects a provider: the browser for a sign-in, the key window for an API key. Only once that succeeds
   * is any other provider removed, since the agent uses one at a time. Switching provider starts a new
   * conversation with its recommended model and thinking level.
   */
  async connect(providerId: string, way: ConnectWay): Promise<AiStatus> {
    const entry = await this.entryFor(providerId);
    if (!entry || !entry.ways[way]) throw new Error(`${providerId} can't be connected that way.`);
    const { providers } = await this.runtime();
    this.connectAbort?.abort();
    const abort = new AbortController();
    this.connectAbort = abort;
    const timeout = setTimeout(() => abort.abort(), CONNECT_TIMEOUT_MS);
    try {
      await providers.login(entry.provider, way, this.interaction(entry, abort.signal), { agentName: 'oh-my-f1-viewer', getDeviceId: installId });
    } finally {
      clearTimeout(timeout);
      if (this.connectAbort === abort) this.connectAbort = null;
    }
    const stored = this.settings;
    const switched = stored.provider !== entry.provider;
    if (switched) await this.reset();
    for (const credential of await providers.credentials.list()) {
      if (credential.providerId !== entry.provider) await providers.logout(credential.providerId);
    }
    const { recommended } = entry;
    if (recommended && (switched || !entry.models.includes(stored.model ?? ''))) {
      this.changeSettings({ provider: entry.provider, model: recommended.model, thinking: recommended.thinking });
    }
    track('agent_connected', { provider: entry.provider, way });
    return this.status();
  }

  async cancelConnect(): Promise<void> {
    this.connectAbort?.abort();
  }

  /** How a sign-in reaches the user. The panel shows what's happening, but never sees a key. */
  private interaction(entry: SupportedProvider, signal: AbortSignal): AuthInteraction {
    return {
      signal,
      notify: (event) => {
        if (event.type === 'auth_url') {
          openExternal(event.url);
          emitConnect({ type: 'browser', message: 'Complete sign-in in your browser.' });
        } else if (event.type === 'device_code') {
          openExternal(event.verificationUri);
          emitConnect({ type: 'device_code', code: event.userCode, url: event.verificationUri });
        } else if (event.type === 'progress' || event.type === 'info') {
          emitConnect({ type: 'progress', message: event.message });
        }
      },
      prompt: (p) => {
        const signals = p.signal ? AbortSignal.any([signal, p.signal]) : signal;
        if (p.type === 'secret') {
          emitConnect({ type: 'key_window', message: `Paste your ${entry.label} API key in the window that opened.` });
          return askForKey(`${entry.label} API key`, `Paste your ${entry.label} API key.`, signals);
        }
        if (p.type !== 'manual_code') {
          return Promise.reject(new Error(`${entry.label} asked for something the app can't show: ${p.message}`));
        }
        // pi races this against its callback server. There's no paste box, so this just waits until the
        // callback wins or the sign-in is cancelled.
        return new Promise<string>((_resolve, reject) => {
          const cancel = () => reject(new Error('Sign-in cancelled'));
          if (signals.aborted) cancel();
          signals.addEventListener('abort', cancel, { once: true });
        });
      },
    };
  }

  /** Removes the connected provider. The agent then needs setting up again. */
  async disconnect(): Promise<void> {
    await this.reset();
    const { providers } = await this.runtime();
    const provider = this.settings.provider;
    if (provider) await providers.logout(provider);
  }

  /**
   * Saves the model and thinking level. A conversation picks them up at its next message. `providerId` switches
   * to another provider: one from Advanced, or a supported one that's connected. A new provider means a new
   * conversation, from its next message.
   */
  async choose(modelId: string, thinking: ThinkingLevel, providerId?: string): Promise<AiStatus> {
    const choice = await this.current();
    let entry = choice?.entry;
    if (providerId !== undefined && providerId !== entry?.provider) {
      entry = await this.entryFor(providerId);
      if (!entry) throw new Error(`${providerId} isn't a provider the app offers.`);
      if (!entry.custom && !(await this.connectedWay(entry))) throw new Error(`${entry.label} isn't connected.`);
    }
    if (!entry) throw new Error(SETUP_NEEDED);
    const { providers } = await this.runtime();
    if (!THINKING_LEVELS.includes(thinking)) throw new Error(`Unknown thinking level: ${thinking}`);
    if (!entry.models.includes(modelId) || !providers.models.getModel(entry.provider, modelId)) {
      throw new Error(`${modelId} isn't offered for ${entry.label}.`);
    }
    this.changeSettings({ provider: entry.provider, model: modelId, thinking });
    return this.status();
  }

  /** Starts a new conversation. The next send creates it. */
  async reset(): Promise<void> {
    await this.cancel();
    const [viewing, building] = [this.conversation, this.building];
    this.conversation = null;
    this.building = null;
    await viewing?.close();
    await building?.close();
  }

  /** Leaves build mode: its conversation ends here, and the viewing one never sees it. */
  async endBuild(): Promise<void> {
    if (this.turn?.mode === 'build') await this.cancel();
    const building = this.building;
    this.building = null;
    await building?.close();
  }

  async cancel(): Promise<void> {
    this.generation += 1;
    await this.stopTurn();
  }

  /** The abort has to start before tools are released, and be awaited after: a running tool is waited for. */
  private async stopTurn(): Promise<void> {
    if (!this.turn) return;
    this.turn.cancelled = true;
    const { context } = await this.runtime();
    const stopped = (this.turn.mode === 'build' ? this.building : this.conversation)?.root.abort(context).catch(() => {});
    for (const resolve of this.pendingTools.values()) {
      resolve({ callId: '', ok: false, content: 'Cancelled by the user.' });
    }
    this.pendingTools.clear();
    await stopped;
    await this.running;
  }

  onToolResult(result: AgentToolResult): void {
    const resolve = this.pendingTools.get(result.callId);
    if (resolve) {
      this.pendingTools.delete(result.callId);
      resolve(result);
    }
  }

  private runTool(call: AgentToolCall): Promise<AgentToolResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTools.delete(call.callId);
        resolve({ callId: call.callId, ok: false, content: 'The app did not respond in time.' });
      }, TOOL_TIMEOUT_MS);
      this.pendingTools.set(call.callId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      sendToRenderer('ai:toolCall', call);
    });
  }

  private async callTool(call: AgentToolCall): Promise<AgentToolResult> {
    const turn = this.turn;
    if (!turn || turn.cancelled) return { callId: call.callId, ok: false, content: 'Cancelled by the user.' };
    emit({ type: 'tool_start', turnId: turn.id, name: call.name, args: call.args });
    const result = await this.runTool(call);
    emit({ type: 'tool_end', turnId: turn.id, name: call.name, ok: result.ok });
    turn.acted = turn.acted || result.ok;
    turn.toolCalls += 1;
    track('agent_tool', { mode: turn.mode, tool: call.name, ok: result.ok });
    return result;
  }

  /** One of the build agent's own tools ended: they run here, so nothing else tells the renderer. */
  private reportTool(name: string, ok: boolean, note: string | null): void {
    const turn = this.turn;
    if (!turn || turn.cancelled) return;
    emit({ type: 'tool_start', turnId: turn.id, name, args: {} });
    emit({ type: 'tool_end', turnId: turn.id, name, ok, ...(note ? { note } : {}) });
    turn.acted = turn.acted || ok;
    turn.toolCalls += 1;
    track('agent_tool', { mode: turn.mode, tool: name, ok });
  }

  /** `scope` is what the message is about: one for another than the conversation's starts a new one. See AgentScope. */
  async send(text: string, appState: string, definitions: AgentToolDefinition[], reference = '', mode: AgentMode = 'view', scope: AgentScope = mode): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    await this.stopTurn();
    if (generation !== this.generation) return;
    const turn: Turn = { id: randomUUID(), mode, scope, cancelled: false, acted: false, toolCalls: 0, handoff: null };
    this.turn = turn;
    const running = this.runTurn(turn, text, appState, definitions, reference);
    this.running = running;
    try {
      await running;
    } finally {
      if (this.turn === turn) {
        this.turn = null;
        this.running = null;
      }
    }
  }

  /**
   * Passes on a reply's text as it arrives. The text of the reply in progress is published a few times a
   * second, and each finished reply is an entry, so whatever of an entry wasn't passed on yet goes with it.
   */
  private async streamText(turn: Turn, conversation: Conversation, context: Context): Promise<{ flush(): Promise<void> }> {
    const { durable } = await this.runtime();
    const seen = new Set<EntryRecord['id']>();
    let sent = '';
    const say = (full: string, done: boolean) => {
      const delta = full.startsWith(sent) ? full.slice(sent.length) : full;
      sent = done ? '' : full;
      if (delta && !turn.cancelled) emit({ type: 'text_delta', turnId: turn.id, delta });
    };
    const watch = await conversation.root.watch(context);
    // Entries are in ID order, and the watch sees every commit after its first value and nothing earlier, so
    // whatever is newer than that value's newest entry is this message's. The window doesn't start the
    // transcript, so `before` is the newest when it's empty.
    const last = watch.value.entries.at(-1)?.id ?? watch.value.before;
    const take = (entries: readonly EntryRecord[]) => {
      for (const entry of entries) {
        if ((last !== undefined && entry.id <= last) || seen.has(entry.id)) continue;
        seen.add(entry.id);
        if (durable.AssistantEntry.is(entry)) say(textOf(entry.model?.[0]), true);
      }
    };
    watch.start(async (call) => {
      if (call.kind !== 'value') return;
      take(call.value.entries);
      const live = call.value.docs['pi.live'] as { generation?: { message?: Message } } | undefined;
      if (live?.generation?.message) say(textOf(live.generation.message), false);
    });
    return {
      flush: async () => {
        await watch.stop();
        // The watch folds commits together, so the last entries are read again, in order. `minEntryId` is
        // inclusive, so this message's start from the ID after `last`.
        const after = last === undefined ? {} : { minEntryId: (last + 1) as EntryRecord['id'] };
        const page = await conversation.root.entries({ order: 'descending', ...after }, 100, undefined, context);
        take([...page.items].reverse());
      },
    };
  }

  /** The conversation a turn is answered in now: the one it's for, if there is one already, or a new one. */
  private async conversationFor(turn: Turn, choice: Choice): Promise<Conversation> {
    // A provider changed outside connect(), such as a hand edit of the settings, starts over too.
    const stale = (c: Conversation | null) => c && (c.provider !== choice.entry.provider || c.mode !== turn.mode || c.scope !== turn.scope);
    if (turn.mode === 'build') {
      if (stale(this.building)) {
        const old = this.building!;
        this.building = null;
        await old.close();
      }
      return (this.building ??= await this.createConversation(choice, 'build', turn.scope));
    }
    if (stale(this.conversation)) {
      const old = this.conversation!;
      this.conversation = null;
      await old.close();
    }
    // A read ahead the last turn couldn't cut is cut now. If it still can't be, the conversation starts over:
    // what it read past the playhead must not reach another request, or a summary.
    if (this.conversation?.readAhead.size) {
      const left = this.conversation;
      const cut = await this.forget(left).then(
        () => true,
        (e: Error) => (console.warn('[ai] forgetting a read ahead, again:', e.message), false),
      );
      if (!cut) {
        this.conversation = null;
        await left.close();
      }
    }
    return (this.conversation ??= await this.createConversation(choice, turn.mode, turn.scope));
  }

  private async runTurn(turn: Turn, text: string, appState: string, definitions: AgentToolDefinition[], reference: string): Promise<void> {
    emit({ type: 'turn_start', turnId: turn.id });
    let label: string | undefined;
    let server: string | undefined;
    let choice: Choice | null = null;
    let outcome: 'done' | 'error' | 'cancelled' = 'cancelled';
    let fix: AgentErrorFix | 'none' = 'none';
    try {
      // Only a credential stored through /settings-agent counts: a key in the environment, like
      // ANTHROPIC_API_KEY, would otherwise be used without anyone choosing it.
      choice = await this.current();
      if (!choice) throw await this.setupProblem();
      label = choice.entry.label;
      server = choice.entry.custom?.baseUrl;
      this.policy = this.policyOf(choice.stored);
      let message = { appState, definitions, reference };
      for (let handoffs = 0; ; handoffs += 1) {
        const conversation = await this.conversationFor(turn, choice);
        if (turn.cancelled) return;
        const settled = await this.answer(turn, conversation, choice, text, message.appState, message.definitions, message.reference);
        if (turn.cancelled) return;
        const next = turn.handoff;
        turn.handoff = null;
        // The run that opened a session ended there, unanswered: the new conversation answers.
        if (next && handoffs < MAX_HANDOFFS) {
          turn.mode = next.mode;
          turn.scope = next.scope;
          message = { appState: next.appState, definitions: next.tools, reference: next.reference };
          continue;
        }
        // A model that keeps calling tools is stopped at the cap, and what it did stands: that's an end, not an error.
        if (settled.status === 'unanswered' && settled.reason !== 'turn_limit') {
          const detail = typeof settled.detail === 'string' ? settled.detail : '';
          throw new Error(detail || 'The model request failed.');
        }
        break;
      }
      emit({ type: 'turn_end', turnId: turn.id, acted: turn.acted });
      outcome = 'done';
    } catch (e) {
      if (turn.cancelled) return;
      const error = friendlyError(e, label, server);
      emit({ type: 'error', turnId: turn.id, ...error });
      outcome = 'error';
      fix = error.fix ?? 'none';
    } finally {
      // A provider from Advanced is named only as `custom`: its ids are the viewer's own words. See docs/TELEMETRY.md.
      const custom = !!choice?.entry.custom;
      track('agent_turn', {
        mode: turn.mode,
        provider: custom ? 'custom' : choice?.entry.provider,
        model: custom ? undefined : choice?.model.id,
        thinking: choice?.thinking,
        tool_calls: turn.toolCalls,
        acted: turn.acted,
        outcome,
        fix,
      });
    }
  }

  /** Has `conversation` answer the message, and waits until it has. */
  private async answer(turn: Turn, conversation: Conversation, choice: Choice, text: string, appState: string, definitions: AgentToolDefinition[], reference: string) {
    const { context } = await this.runtime();
    const { root, check } = conversation;
    // A model or thinking level chosen since the last message, and the rounds this message may take.
    await root.configure({ model: { provider: choice.model.provider, modelId: choice.model.id }, thinkingLevel: choice.thinking, maxTurns: conversation.maxRounds }, context);
    conversation.model = choice.model;
    conversation.reference = reference;
    conversation.register(definitions);
    conversation.rounds = 0;
    check?.start();

    const stream = await this.streamText(turn, conversation, context);
    try {
      const submission = await root.submit({ type: 'input', content: `<app_state>\n${appState}\n</app_state>\n\n${text}` }, context);
      return await submission.wait(context);
    } finally {
      await stream.flush().catch(() => {});
      await this.forget(conversation).catch((e: Error) => console.warn('[ai] forgetting a read ahead:', e.message));
    }
  }

  /** A summary of `messages`, from the conversation's own model. Throws if the model gives none. */
  private async summarize(conversation: Conversation, messages: Message[], instructions?: string): Promise<string> {
    const { providers } = await this.runtime();
    const now = Date.now();
    const reply = await providers.models.completeSimple(conversation.model, {
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT, timestamp: now },
        { role: 'user', content: [{ type: 'text', text: summaryRequest(messages, instructions) }], timestamp: now },
      ],
    });
    const summary = reply.stopReason === 'stop' ? textOf(reply).trim() : '';
    if (!summary) throw new Error(reply.errorMessage || 'The model gave no summary.');
    return summary;
  }

  /**
   * An approved read ahead is usable only in the turn that asked for it. Once the turn is over, its tool calls
   * and results are taken out of what the model sees, leaving the viewer's message and the agent's words.
   * The stored entries stay as they are. See docs/SPOILER_PREVENTION.md.
   *
   * The calls stay in `readAhead` until the cut is written, so a cut that fails is tried again before the
   * next message, and compaction still sees them meanwhile.
   */
  private async forget(conversation: Conversation): Promise<void> {
    if (!conversation.readAhead.size) return;
    const { context } = await this.runtime();
    await conversation.root.waitForIdle(context);
    const page = await conversation.root.entries({ order: 'descending' }, 500, undefined, context);
    const edits = forgetTurn([...page.items].reverse(), conversation.readAhead);
    if (edits.length) {
      const written = await conversation.root.submit({ type: 'write', entry: { kind: 'omfv.forget', edits } }, context);
      const settled = await written.wait(context);
      if (settled.status !== 'done') throw new Error(`the cut was not written (${settled.status})`);
    }
    conversation.readAhead.clear();
  }
}

/**
 * A failed turn's error in the viewer's words, and what fixes it, so the palette can offer that. `server` is set
 * for a provider from Advanced: one that can't be reached is most often a local server that isn't running.
 */
function friendlyError(e: unknown, label = 'The provider', server?: string): { message: string; fix?: AgentErrorFix } {
  const message = e instanceof Error ? e.message : String(e);
  if (message === SETUP_NEEDED) return { message: "The agent isn't set up yet.", fix: 'setup' };
  if (e instanceof SetupError) return { message, fix: 'setup' };
  if (server && /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|connection error|connect timeout/i.test(message)) {
    return { message: `Couldn't reach ${label} at ${server}. Is its server running?`, fix: 'setup' };
  }
  if (/usage_limit|usage limit|rate_limit|rate limit/i.test(message)) return { message: `${label} usage limit reached.`, fix: 'limit' };
  if (/not_eligible/i.test(message)) return { message: `This ${label} account can't use its plan in other apps.`, fix: 'connect' };
  if (/No API key|not configured|unauthor|invalid_grant|invalid x-api-key|authentication_error|incorrect api key|token/i.test(message)) {
    return { message: `${label} didn't accept the connection.`, fix: 'connect' };
  }
  return { message };
}

export const agent = new Agent();
