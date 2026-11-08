/**
 * The agent: Sign in with ChatGPT through pi-ai, and a short tool loop. The model only has the
 * tools in shared/tools.ts. They run in the renderer, which owns layout and playback, so each call
 * goes over IPC and its result comes back here.
 */
import { shell } from 'electron';
import { randomUUID } from 'node:crypto';
import type {
  AssistantMessage,
  Context,
  Message,
  MutableModels,
  Tool,
  ToolCall,
} from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };
import type { AgentEvent, AgentToolCall, AgentToolResult, AiStatus } from '../../shared/api';
import { AGENT_TOOLS, SYSTEM_PROMPT } from '../../shared/tools';
import { sendToRenderer } from '../windows';
import { createFileCredentialStore, installId } from './credentials';

const PROVIDER = 'openai';
const DEFAULT_MODEL = process.env.F1A_MODEL || 'gpt-6-luna';
const MAX_TOOL_ROUNDS = 10;
/** Keep the conversation small: this agent acts on app_state, not on long memory. */
const MAX_HISTORY_MESSAGES = 60;
const TOOL_TIMEOUT_MS = 60_000;

function emit(event: AgentEvent): void {
  sendToRenderer('ai:event', event);
}

class Agent {
  private modelsPromise: Promise<MutableModels> | null = null;
  private history: Message[] = [];
  private abort: AbortController | null = null;
  private pendingTools = new Map<string, (result: AgentToolResult) => void>();
  private loginAbort: AbortController | null = null;

  private models(): Promise<MutableModels> {
    this.modelsPromise ??= (async () => {
      const { createModels } = await import('@earendil-works/pi-ai');
      const { openaiProvider } = await import('@earendil-works/pi-ai/providers/openai');
      const models = createModels({ credentials: createFileCredentialStore() });
      models.setProvider(openaiProvider());
      return models;
    })();
    return this.modelsPromise;
  }

  async status(): Promise<AiStatus> {
    const models = await this.models();
    const check = await models.checkAuth(PROVIDER);
    return { signedIn: check?.type === 'oauth', model: check ? DEFAULT_MODEL : null };
  }

  /** Opens the real browser. pi-ai runs the local callback server and stores the result. */
  async login(): Promise<AiStatus> {
    const models = await this.models();
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
          // pi-ai races this against its callback server. The palette offers no paste box, so this
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
    this.cancel();
    this.reset();
    const models = await this.models();
    await models.logout(PROVIDER);
  }

  reset(): void {
    this.history = [];
  }

  cancel(): void {
    this.abort?.abort();
    for (const resolve of this.pendingTools.values()) {
      resolve({ callId: '', ok: false, content: 'Cancelled by the user.' });
    }
    this.pendingTools.clear();
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

  async send(text: string, appState: string): Promise<void> {
    this.cancel();
    const abort = new AbortController();
    this.abort = abort;
    const turnId = randomUUID();
    emit({ type: 'turn_start', turnId });
    let acted = false;
    try {
      const { validateToolCall } = await import('@earendil-works/pi-ai');
      const models = await this.models();
      const model = models.getModel(PROVIDER, DEFAULT_MODEL);
      if (!model) throw new Error(`Model ${DEFAULT_MODEL} is not available.`);

      const tools = AGENT_TOOLS as unknown as Tool[];
      this.history.push({
        role: 'user',
        content: `<app_state>\n${appState}\n</app_state>\n\n${text}`,
        timestamp: Date.now(),
      });
      if (this.history.length > MAX_HISTORY_MESSAGES) {
        this.history = this.trimHistory(this.history);
      }
      const context: Context = { systemPrompt: SYSTEM_PROMPT, messages: this.history, tools };

      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const stream = models.streamSimple(model, context, {
          reasoning: 'low',
          signal: abort.signal,
          sessionId: 'f1a',
        });
        for await (const event of stream) {
          if (event.type === 'text_delta') emit({ type: 'text_delta', turnId, delta: event.delta });
        }
        const message: AssistantMessage = await stream.result();
        if (abort.signal.aborted) return;
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          // A failed response must not stay in the history, or the next turn replays it.
          throw new Error(message.errorMessage || 'The model request failed.');
        }
        this.history.push(message);

        const calls = message.content.filter((b): b is ToolCall => b.type === 'toolCall');
        if (calls.length === 0) break;

        for (const call of calls) {
          const result = await this.executeCall(call, tools, validateToolCall, turnId);
          acted = acted || result.ok;
          this.history.push({
            role: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: 'text', text: result.content }],
            isError: !result.ok,
            timestamp: Date.now(),
          });
        }
      }
      emit({ type: 'turn_end', turnId, acted });
    } catch (e) {
      if (abort.signal.aborted) return;
      emit({ type: 'error', turnId, message: friendlyError(e) });
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  private async executeCall(
    call: ToolCall,
    tools: Tool[],
    validate: (tools: Tool[], call: ToolCall) => unknown,
    turnId: string,
  ): Promise<AgentToolResult> {
    let args: Record<string, unknown>;
    try {
      args = validate(tools, call) as Record<string, unknown>;
    } catch (e) {
      return { callId: call.id, ok: false, content: `Invalid arguments: ${(e as Error).message}` };
    }
    emit({ type: 'tool_start', turnId, name: call.name, args });
    const result = await this.runTool({ callId: call.id, name: call.name, args });
    emit({ type: 'tool_end', turnId, name: call.name, ok: result.ok });
    return result;
  }

  /** Drop old turns, always cutting at a user message so tool calls keep their results. */
  private trimHistory(history: Message[]): Message[] {
    const keepFrom = history.length - MAX_HISTORY_MESSAGES / 2;
    for (let i = keepFrom; i < history.length; i += 1) {
      if (history[i].role === 'user') return history.slice(i);
    }
    return history.slice(-1);
  }
}

function friendlyError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (/usage_limit|usage limit/i.test(message)) return 'ChatGPT usage limit reached. Try again later.';
  if (/not_eligible/i.test(message)) return 'This ChatGPT account cannot use its plan in other apps.';
  if (/No API key|not configured|unauthor|invalid_grant|token/i.test(message)) {
    return 'ChatGPT sign-in is needed. Run /login-chatgpt.';
  }
  return message;
}

export const agent = new Agent();
