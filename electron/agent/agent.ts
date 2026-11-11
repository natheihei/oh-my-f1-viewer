/**
 * The agent: a pi session using Sign in with ChatGPT. It holds the credentials, so it lives here, but its
 * tools run in the renderer, which owns layout and playback. The renderer sends their definitions with
 * each message, each call goes over IPC, and its result comes back here.
 */
import { app, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };
import type { AgentSession, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { AgentEvent, AgentToolCall, AgentToolDefinition, AgentToolResult, AiStatus } from '../../shared/api';
import { SYSTEM_PROMPT } from '../../shared/tools';
import { sendToRenderer } from '../windows';
import { installId } from './credentials';
import { promptExtension } from './extensions/prompt';
import { roundCap, type RoundCap } from './extensions/roundCap';
import { toolsExtension, type ToolsExtension } from './extensions/tools';

const PROVIDER = 'openai';
const MAX_TOOL_ROUNDS = 10;
const TOOL_TIMEOUT_MS = 60_000;
const SIGN_IN_NEEDED = 'ChatGPT sign-in is needed. Run /login-chatgpt.';

/** Written only if missing, so it can be edited. */
const STARTER_SETTINGS = {
  defaultProvider: PROVIDER,
  defaultModel: 'gpt-6-luna',
  defaultThinkingLevel: 'medium',
  compaction: { enabled: true },
  retry: { enabled: false },
  cacheWarming: 'off',
};

function emit(event: AgentEvent): void {
  sendToRenderer('ai:event', event);
}

/** Set up once per run of the app. */
interface Runtime {
  models: ModelRuntime;
  settings: SettingsManager;
  agentDir: string;
  cwd: string;
}

/** One conversation. Starting over makes a new one. */
interface Conversation {
  session: AgentSession;
  tools: ToolsExtension;
  cap: RoundCap;
  reference: string;
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
  private loginAbort: AbortController | null = null;

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
    return { models, settings, agentDir, cwd };
  }

  private async createConversation(): Promise<Conversation> {
    const { DefaultResourceLoader, SessionManager, createAgentSession } = await import('@earendil-works/pi-coding-agent');
    const { models, settings, agentDir, cwd } = await this.runtime();
    const modelId = settings.getDefaultModel();
    const model = modelId ? models.getModel(settings.getDefaultProvider() ?? PROVIDER, modelId) : undefined;
    if (!model) throw new Error(`Model ${modelId} is not available.`);

    const tools = toolsExtension((call) => this.callTool(call));
    const cap = roundCap(MAX_TOOL_ROUNDS);
    const conversation: Conversation = { session: null as unknown as AgentSession, tools, cap, reference: '' };
    // pi also walks up from cwd and reads ~/.agents/skills: keep only what's in agentDir.
    const inside = (p: string) => path.resolve(p).startsWith(agentDir + path.sep);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      agentsFilesOverride: (base) => ({ agentsFiles: base.agentsFiles.filter((f) => inside(f.path)) }),
      skillsOverride: (base) => ({ ...base, skills: base.skills.filter((s) => inside(s.filePath)) }),
      extensionFactories: [promptExtension(() => conversation.reference), tools.factory, cap.factory],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime: models,
      settingsManager: settings,
      resourceLoader,
      noTools: 'builtin',
      // A fixed id, passed on to the provider as the prompt cache key.
      sessionManager: SessionManager.inMemory(cwd, { id: 'f1a' }),
    });
    session.agent.toolExecution = 'sequential';
    conversation.session = session;
    return conversation;
  }

  async status(): Promise<AiStatus> {
    const { models, settings } = await this.runtime();
    const check = await models.checkAuth(PROVIDER);
    return { signedIn: check?.type === 'oauth', model: check ? (settings.getDefaultModel() ?? null) : null };
  }

  /** Opens the real browser. pi runs the local callback server and stores the result. */
  async login(): Promise<AiStatus> {
    const { models } = await this.runtime();
    this.loginAbort?.abort();
    const abort = new AbortController();
    this.loginAbort = abort;
    const timeout = setTimeout(() => abort.abort(), 5 * 60_000);
    try {
      await models.login(
        PROVIDER,
        'oauth',
        {
          signal: abort.signal,
          notify: (event) => {
            if (event.type === 'auth_url') {
              const url = new URL(event.url);
              if (url.protocol === 'https:' && url.hostname === 'auth.openai.com') void shell.openExternal(event.url);
              else console.warn('[ai] ignored unexpected sign-in URL host:', url.hostname);
            }
          },
          // pi races this against its callback server. The palette offers no paste box, so this
          // prompt just waits until the callback wins or the login is cancelled.
          prompt: (p) =>
            new Promise<string>((_resolve, reject) => {
              const cancel = () => reject(new Error('Sign-in cancelled'));
              if (p.signal?.aborted || abort.signal.aborted) cancel();
              p.signal?.addEventListener('abort', cancel, { once: true });
              abort.signal.addEventListener('abort', cancel, { once: true });
            }),
        },
        { agentName: 'f1a', getDeviceId: installId },
      );
    } finally {
      clearTimeout(timeout);
      if (this.loginAbort === abort) this.loginAbort = null;
    }
    return this.status();
  }

  async logout(): Promise<void> {
    await this.reset();
    const { models } = await this.runtime();
    await models.logout(PROVIDER);
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
    try {
      const { models } = await this.runtime();
      // agentDir doesn't isolate the environment: without this, a key like ANTHROPIC_API_KEY would be used instead.
      const check = await models.checkAuth(PROVIDER);
      if (check?.type !== 'oauth') throw new Error(SIGN_IN_NEEDED);
      this.conversation ??= await this.createConversation();
      if (turn.cancelled) return;

      const conversation = this.conversation;
      const { session, tools, cap } = conversation;
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
      emit({ type: 'error', turnId: turn.id, message: friendlyError(e) });
    }
  }
}

function friendlyError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (/usage_limit|usage limit/i.test(message)) return 'ChatGPT usage limit reached. Try again later.';
  if (/not_eligible/i.test(message)) return 'This ChatGPT account cannot use its plan in other apps.';
  if (/No API key|not configured|unauthor|invalid_grant|token/i.test(message)) return SIGN_IN_NEEDED;
  return message;
}

export const agent = new Agent();
