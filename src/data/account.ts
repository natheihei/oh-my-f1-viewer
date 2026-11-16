/** Sign-ins, the agent's setup, and the link to the agent loop in the main process. */
import type {
  AgentConnectEvent,
  AgentEvent,
  AgentMode,
  AgentProviderOption,
  AgentToolCall,
  AgentToolDefinition,
  AgentToolResult,
  AiStatus,
  ConnectWay,
  F1TvStatus,
  ThinkingLevel,
} from '../../shared/api';
import type { AgentSettings } from '../../shared/agentSettings';

const NOT_READY: AiStatus = { ready: false, provider: null, model: null, modelName: null, thinking: null };

/** What signs in from here. The agent's provider is set up through `host.agent` instead. */
export type Service = 'f1tv';

export const account = {
  async status(): Promise<{ f1tv: F1TvStatus; agent: AiStatus }> {
    const [f1tv, agent] = await Promise.all([
      window.f1a.f1tv.status().catch(() => ({ signedIn: false, ready: false })),
      window.f1a.ai.status().catch(() => NOT_READY),
    ]);
    return { f1tv, agent };
  },
  login: async (_service: Service): Promise<void> => {
    await window.f1a.f1tv.login();
  },
  logout: (_service: Service): Promise<void> => window.f1a.f1tv.logout(),
  onExpired: (cb: () => void): (() => void) => window.f1a.f1tv.onExpired(cb),
};

export const agentLink = {
  /** Hands main the agent's settings the renderer keeps. IPC keeps order, so whatever is asked after this sees them. */
  useSettings: (settings: AgentSettings): Promise<void> => window.f1a.ai.useSettings(settings),
  /** Main changed the settings, by connecting or choosing. */
  onSettings: (cb: (settings: AgentSettings) => void): (() => void) => window.f1a.ai.onSettings(cb),
  status: (): Promise<AiStatus> => window.f1a.ai.status().catch(() => NOT_READY),
  providers: (): Promise<AgentProviderOption[]> => window.f1a.ai.providers(),
  connect: (provider: string, way: ConnectWay): Promise<AiStatus> => window.f1a.ai.connect(provider, way),
  cancelConnect: (): Promise<void> => window.f1a.ai.cancelConnect(),
  onConnect: (cb: (event: AgentConnectEvent) => void): (() => void) => window.f1a.ai.onConnect(cb),
  disconnect: (): Promise<void> => window.f1a.ai.disconnect(),
  choose: (model: string, thinking: ThinkingLevel): Promise<AiStatus> => window.f1a.ai.choose(model, thinking),
  send: (text: string, context: string, tools: AgentToolDefinition[], reference: string, mode: AgentMode = 'view'): Promise<void> =>
    window.f1a.ai.send(text, context, tools, reference, mode),
  /** Ends build mode's conversation. */
  endBuild: (): Promise<void> => window.f1a.ai.endBuild(),
  cancel: (): Promise<void> => window.f1a.ai.cancel(),
  onEvent: (cb: (event: AgentEvent) => void): (() => void) => window.f1a.ai.onEvent(cb),
  onToolCall: (cb: (call: AgentToolCall) => void): (() => void) => window.f1a.ai.onToolCall(cb),
  toolResult: (result: AgentToolResult): void => window.f1a.ai.toolResult(result),
};
