/**
 * The agent: a pi session on the provider, model and thinking level chosen in `/settings-agent`, from the
 * providers in supported.ts. It holds the credentials, so it lives here, but its tools run in the renderer,
 * which owns layout and playback. The renderer sends their definitions with each message, each call goes
 * over IPC, and its result comes back here.
 */
import { app, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Api, AssistantMessage, AuthInteraction, Model } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };
import type { AgentSession, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type {
  AgentConnectEvent,
  AgentEvent,
  AgentProviderOption,
  AgentToolCall,
  AgentToolDefinition,
  AgentToolResult,
  AiStatus,
  ConnectWay,
  ThinkingLevel,
} from '../../shared/api';
import { SYSTEM_PROMPT } from '../../shared/tools';
import { sendToRenderer } from '../windows';
import { installId } from './credentials';
import { forgetReadAhead } from './extensions/forgetReadAhead';
import { promptExtension } from './extensions/prompt';
import { roundCap, type RoundCap } from './extensions/roundCap';
import { toolsExtension, type ToolsExtension } from './extensions/tools';
import { askForKey } from './keyWindow';
import { SUPPORTED, supported, type SupportedProvider } from './supported';

const MAX_TOOL_ROUNDS = 10;
const TOOL_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 5 * 60_000;
const SETUP_NEEDED = 'The agent needs setting up first: /settings-agent';
const WAYS: ConnectWay[] = ['oauth', 'api_key'];
const LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Written only if missing, so it can be edited. The provider, model and thinking level come from `/settings-agent`. */
const STARTER_SETTINGS = {
  compaction: { enabled: true },
  retry: { enabled: false },
  cacheWarming: 'off',
};

const NOT_READY: AiStatus = { ready: false, provider: null, model: null, modelName: null, thinking: null };

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

/** Set up once per run of the app. */
interface Runtime {
  models: ModelRuntime;
  settings: SettingsManager;
  agentDir: string;
  cwd: string;
  levels: (model: Model<Api>) => ThinkingLevel[];
  clamp: (model: Model<Api>, level: ThinkingLevel) => ThinkingLevel;
}

/** What the agent runs on: a supported provider with a stored credential, and the model and level chosen for it. */
interface Choice {
  entry: SupportedProvider;
  way: ConnectWay;
  model: Model<Api>;
  thinking: ThinkingLevel;
}

/** One conversation. Starting over makes a new one. */
interface Conversation {
  session: AgentSession;
  tools: ToolsExtension;
  cap: RoundCap;
  reference: string;
  provider: string;
}

interface Turn {
  id: string;
  cancelled: boolean;
  acted: boolean;
}

export class Agent {
  private runtimePromise: Promise<Runtime> | null = null;
  private conversation: Conversation | null = null;
  private turn: Turn | null = null;
  private running: Promise<void> | null = null;
  /** Bumped by each send and cancel, so a send waiting on the last turn knows when it's been replaced. */
  private generation = 0;
  private pendingTools = new Map<string, (result: AgentToolResult) => void>();
  private connectAbort: AbortController | null = null;

  /** `onRuntime` lets tests register a fake model. */
  constructor(private readonly onRuntime?: (models: ModelRuntime) => void) {}

  private runtime(): Promise<Runtime> {
    this.runtimePromise ??= this.createRuntime().catch((e) => {
      this.runtimePromise = null;
      throw e;
    });
    return this.runtimePromise;
  }

  private async createRuntime(): Promise<Runtime> {
    const { ModelRuntime, SettingsManager } = await import('@earendil-works/pi-coding-agent');
    const { clampThinkingLevel, getSupportedThinkingLevels } = await import('@earendil-works/pi-ai');
    const agentDir = path.join(app.getPath('userData'), 'pi-agent');
    const cwd = path.join(app.getPath('userData'), 'mods');
    await fsp.mkdir(agentDir, { recursive: true });
    await fsp.mkdir(cwd, { recursive: true });
    // App-owned, like the mods folder's tsconfig.json: hand edits are lost, and app updates always reach it.
    await fsp.writeFile(path.join(agentDir, 'SYSTEM.md'), SYSTEM_PROMPT);
    await fsp
      .writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(STARTER_SETTINGS, null, 2) + '\n', { flag: 'wx' })
      .catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
    const models = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
    });
    this.onRuntime?.(models);
    // Not trusted: anything in mods/.pi could otherwise override the prompt or run in this process.
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    return {
      models,
      settings,
      agentDir,
      cwd,
      levels: (model) => getSupportedThinkingLevels(model) as ThinkingLevel[],
      clamp: (model, level) => clampThinkingLevel(model, level) as ThinkingLevel,
    };
  }

  /** The way a provider is connected: its credential in auth.json. Environment variables never count. */
  private async connectedWay(entry: SupportedProvider): Promise<ConnectWay | null> {
    const { models } = await this.runtime();
    const credential = (await models.listCredentials()).find((c) => c.providerId === entry.provider);
    return credential && entry.ways[credential.type] ? credential.type : null;
  }

  /**
   * What the agent runs on, or null if it isn't set up. The provider is the one in settings.json, and a
   * model missing from its supported list falls back to the recommended one.
   */
  private async current(): Promise<Choice | null> {
    const { models, settings, clamp } = await this.runtime();
    const entry = supported(settings.getDefaultProvider());
    if (!entry) return null;
    const way = await this.connectedWay(entry);
    if (!way) return null;
    const saved = settings.getDefaultModel();
    const id = saved && entry.models.includes(saved) && models.getModel(entry.provider, saved) ? saved : entry.recommended.model;
    const model = models.getModel(entry.provider, id);
    if (!model) return null;
    const thinking = clamp(model, (settings.getDefaultThinkingLevel() as ThinkingLevel | undefined) ?? entry.recommended.thinking);
    return { entry, way, model, thinking };
  }

  private async createConversation(choice: Choice): Promise<Conversation> {
    const { DefaultResourceLoader, SessionManager, createAgentSession } = await import('@earendil-works/pi-coding-agent');
    const { models, settings, agentDir, cwd } = await this.runtime();
    const { model } = choice;

    const tools = toolsExtension((call) => this.callTool(call));
    const cap = roundCap(MAX_TOOL_ROUNDS);
    const conversation: Conversation = {
      session: null as unknown as AgentSession,
      tools,
      cap,
      reference: '',
      provider: choice.entry.provider,
    };
    // pi also walks up from cwd and reads ~/.agents/skills: keep only what's in agentDir.
    const inside = (p: string) => path.resolve(p).startsWith(agentDir + path.sep);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      agentsFilesOverride: (base) => ({ agentsFiles: base.agentsFiles.filter((f) => inside(f.path)) }),
      skillsOverride: (base) => ({ ...base, skills: base.skills.filter((s) => inside(s.filePath)) }),
      extensionFactories: [promptExtension(() => conversation.reference), tools.factory, cap.factory, forgetReadAhead],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: choice.thinking,
      modelRuntime: models,
      settingsManager: settings,
      resourceLoader,
      noTools: 'builtin',
      // Stored for review but never resumed: each conversation gets its own timestamped file.
      // A fixed id, passed on to the provider as the prompt cache key.
      sessionManager: SessionManager.create(cwd, path.join(agentDir, 'sessions'), { id: 'f1a' }),
    });
    session.agent.toolExecution = 'sequential';
    conversation.session = session;
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
    const { models, levels } = await this.runtime();
    const choice = await this.current();
    return SUPPORTED.flatMap((entry): AgentProviderOption[] => {
      const provider = models.getProvider(entry.provider);
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
            const model = models.getModel(entry.provider, id);
            return model ? [{ id, name: model.name, thinking: levels(model) }] : [];
          }),
          recommended: entry.recommended,
        },
      ];
    });
  }

  /**
   * Connects a provider: the browser for a sign-in, the key window for an API key. Only once that succeeds
   * is any other provider removed, since the agent uses one at a time. Switching provider starts a new
   * conversation with its recommended model and thinking level.
   */
  async connect(providerId: string, way: ConnectWay): Promise<AiStatus> {
    const entry = supported(providerId);
    if (!entry || !entry.ways[way]) throw new Error(`${providerId} can't be connected that way.`);
    const { models, settings } = await this.runtime();
    this.connectAbort?.abort();
    const abort = new AbortController();
    this.connectAbort = abort;
    const timeout = setTimeout(() => abort.abort(), CONNECT_TIMEOUT_MS);
    try {
      await models.login(entry.provider, way, this.interaction(entry, abort.signal), { agentName: 'f1a', getDeviceId: installId });
    } finally {
      clearTimeout(timeout);
      if (this.connectAbort === abort) this.connectAbort = null;
    }

    const switched = settings.getDefaultProvider() !== entry.provider;
    if (switched) await this.reset();
    for (const credential of await models.listCredentials()) {
      if (credential.providerId !== entry.provider) await models.logout(credential.providerId);
    }
    if (switched || !entry.models.includes(settings.getDefaultModel() ?? '')) {
      settings.setDefaultModelAndProvider(entry.provider, entry.recommended.model);
      settings.setDefaultThinkingLevel(entry.recommended.thinking);
      await settings.flush();
    }
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
    const { models, settings } = await this.runtime();
    const provider = settings.getDefaultProvider();
    if (provider) await models.logout(provider);
  }

  /** Saves the model and thinking level. A conversation picks them up at its next message. */
  async choose(modelId: string, thinking: ThinkingLevel): Promise<AiStatus> {
    const choice = await this.current();
    if (!choice) throw new Error(SETUP_NEEDED);
    const { models, settings } = await this.runtime();
    if (!LEVELS.includes(thinking)) throw new Error(`Unknown thinking level: ${thinking}`);
    if (!choice.entry.models.includes(modelId) || !models.getModel(choice.entry.provider, modelId)) {
      throw new Error(`${modelId} isn't offered for ${choice.entry.label}.`);
    }
    settings.setDefaultModelAndProvider(choice.entry.provider, modelId);
    settings.setDefaultThinkingLevel(thinking);
    await settings.flush();
    return this.status();
  }

  /** Starts a new conversation. The next send creates it. */
  async reset(): Promise<void> {
    await this.cancel();
    this.conversation?.session.dispose();
    this.conversation = null;
  }

  async cancel(): Promise<void> {
    this.generation += 1;
    await this.stopTurn();
  }

  /** The abort has to start before tools are released, and be awaited after: pi waits for a running tool. */
  private async stopTurn(): Promise<void> {
    if (!this.turn) return;
    this.turn.cancelled = true;
    const stopped = this.conversation?.session.abort();
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
    if (!turn) return { callId: call.callId, ok: false, content: 'Cancelled by the user.' };
    emit({ type: 'tool_start', turnId: turn.id, name: call.name, args: call.args });
    const result = await this.runTool(call);
    emit({ type: 'tool_end', turnId: turn.id, name: call.name, ok: result.ok });
    turn.acted = turn.acted || result.ok;
    return result;
  }

  async send(text: string, appState: string, definitions: AgentToolDefinition[], reference = ''): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    await this.stopTurn();
    if (generation !== this.generation) return;
    const turn: Turn = { id: randomUUID(), cancelled: false, acted: false };
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

  private async runTurn(
    turn: Turn,
    text: string,
    appState: string,
    definitions: AgentToolDefinition[],
    reference: string,
  ): Promise<void> {
    emit({ type: 'turn_start', turnId: turn.id });
    let label: string | undefined;
    try {
      // Only a credential stored through /settings-agent counts: agentDir doesn't isolate the environment,
      // so a key like ANTHROPIC_API_KEY would otherwise be used without anyone choosing it.
      const choice = await this.current();
      if (!choice) throw new Error(SETUP_NEEDED);
      label = choice.entry.label;
      // A provider changed outside connect(), such as a hand edit of settings.json, starts over too.
      if (this.conversation && this.conversation.provider !== choice.entry.provider) {
        this.conversation.session.dispose();
        this.conversation = null;
      }
      this.conversation ??= await this.createConversation(choice);
      if (turn.cancelled) return;

      const conversation = this.conversation;
      const { session, tools, cap } = conversation;
      // A model or thinking level chosen since the last message.
      if (session.model?.id !== choice.model.id) await session.setModel(choice.model);
      if (session.thinkingLevel !== choice.thinking) session.setThinkingLevel(choice.thinking);
      conversation.reference = reference;
      tools.register(definitions);
      cap.start();
      const unsubscribe = session.subscribe((event) => {
        if (turn.cancelled) return;
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          emit({ type: 'text_delta', turnId: turn.id, delta: event.assistantMessageEvent.delta });
        }
      });
      try {
        await session.prompt(`<app_state>\n${appState}\n</app_state>\n\n${text}`, { expandPromptTemplates: false });
      } finally {
        unsubscribe();
      }
      if (turn.cancelled) return;

      if (!cap.capped) {
        // prompt() doesn't throw on model errors: they end up on the last reply.
        const last = session.messages.findLast((m): m is AssistantMessage => m.role === 'assistant');
        if (last?.stopReason === 'error' || last?.stopReason === 'aborted') {
          throw new Error(last.errorMessage || 'The model request failed.');
        }
      }
      emit({ type: 'turn_end', turnId: turn.id, acted: turn.acted });
    } catch (e) {
      if (turn.cancelled) return;
      emit({ type: 'error', turnId: turn.id, message: friendlyError(e, label) });
    }
  }
}

function friendlyError(e: unknown, label = 'The provider'): string {
  const message = e instanceof Error ? e.message : String(e);
  if (message === SETUP_NEEDED) return message;
  if (/usage_limit|usage limit|rate_limit|rate limit/i.test(message)) return `${label} usage limit reached. Try again later.`;
  if (/not_eligible/i.test(message)) return `This ${label} account cannot use its plan in other apps.`;
  if (/No API key|not configured|unauthor|invalid_grant|invalid x-api-key|authentication_error|incorrect api key|token/i.test(message)) {
    return `${label} didn't accept the connection. Connect it again in /settings-agent.`;
  }
  return message;
}

export const agent = new Agent();
