/** Sign-ins, the agent's setup, and the link to the agent loop in the main process. */
import type {
  AgentConnectEvent,
  AgentEvent,
  AgentMode,
  AgentProviderOption,
  AgentScope,
  AgentToolCall,
  AgentToolDefinition,
  AgentToolResult,
  AiStatus,
  ConnectWay,
  CustomModelsFile,
  F1TvStatus,
  ThinkingLevel,
} from '../../shared/api';

const NOT_READY: AiStatus = { ready: false, provider: null, model: null, modelName: null, thinking: null };

/** What signs in from here. The agent's provider is set up through `host.agent` instead. */
export type Service = 'f1tv';

export const account = {
  async status(): Promise<{ f1tv: F1TvStatus; agent: AiStatus }> {
    const [f1tv, agent] = await Promise.all([
      window.omfv.f1tv.status().catch(() => ({ signedIn: false, ready: false })),
      window.omfv.ai.status().catch(() => NOT_READY),
    ]);
    return { f1tv, agent };
  },
  login: async (_service: Service): Promise<void> => {
    await window.omfv.f1tv.login();
  },
  logout: (_service: Service): Promise<void> => window.omfv.f1tv.logout(),
  onExpired: (cb: () => void): (() => void) => window.omfv.f1tv.onExpired(cb),
};

export const agentLink = {
  status: (): Promise<AiStatus> => window.omfv.ai.status().catch(() => NOT_READY),
  providers: (): Promise<AgentProviderOption[]> => window.omfv.ai.providers(),
  connect: (provider: string, way: ConnectWay): Promise<AiStatus> => window.omfv.ai.connect(provider, way),
  cancelConnect: (): Promise<void> => window.omfv.ai.cancelConnect(),
  onConnect: (cb: (event: AgentConnectEvent) => void): (() => void) => window.omfv.ai.onConnect(cb),
  disconnect: (): Promise<void> => window.omfv.ai.disconnect(),
  choose: (model: string, thinking: ThinkingLevel, provider?: string): Promise<AiStatus> => window.omfv.ai.choose(model, thinking, provider),
  /** `/settings-agent` → Advanced: the custom providers' text, and saving it. */
  customModels: (): Promise<CustomModelsFile> => window.omfv.ai.customModels(),
  customModelsDocs: (): Promise<void> => window.omfv.ai.customModelsDocs(),
  openCustomModels: (): Promise<void> => window.omfv.ai.openCustomModels(),
  revealCustomModels: (): Promise<void> => window.omfv.ai.revealCustomModels(),
  onCustomModels: (cb: () => void): (() => void) => window.omfv.ai.onCustomModels(cb),
  send: (text: string, context: string, tools: AgentToolDefinition[], reference: string, mode: AgentMode = 'view', scope: AgentScope = mode): Promise<void> =>
    window.omfv.ai.send(text, context, tools, reference, mode, scope),
  /** Ends build mode's conversation. */
  endBuild: (): Promise<void> => window.omfv.ai.endBuild(),
  cancel: (): Promise<void> => window.omfv.ai.cancel(),
  onEvent: (cb: (event: AgentEvent) => void): (() => void) => window.omfv.ai.onEvent(cb),
  onToolCall: (cb: (call: AgentToolCall) => void): (() => void) => window.omfv.ai.onToolCall(cb),
  toolResult: (result: AgentToolResult): void => window.omfv.ai.toolResult(result),
};
