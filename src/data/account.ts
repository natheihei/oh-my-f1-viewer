/** Sign-ins, and the link to the agent loop in the main process. */
import type { AgentEvent, AgentToolCall, AgentToolDefinition, AgentToolResult, AiStatus, F1TvStatus } from '../../shared/api';

export type Service = 'f1tv' | 'chatgpt';

export const account = {
  async status(): Promise<{ f1tv: F1TvStatus; chatgpt: AiStatus }> {
    const [f1tv, chatgpt] = await Promise.all([
      window.f1a.f1tv.status().catch(() => ({ signedIn: false, ready: false })),
      window.f1a.ai.status().catch(() => ({ signedIn: false, model: null })),
    ]);
    return { f1tv, chatgpt };
  },
  login: async (service: Service): Promise<void> => {
    await (service === 'f1tv' ? window.f1a.f1tv.login() : window.f1a.ai.login());
  },
  logout: (service: Service): Promise<void> => (service === 'f1tv' ? window.f1a.f1tv.logout() : window.f1a.ai.logout()),
  onExpired: (cb: () => void): (() => void) => window.f1a.f1tv.onExpired(cb),
};

export const agentLink = {
  status: (): Promise<AiStatus> => window.f1a.ai.status().catch(() => ({ signedIn: false, model: null })),
  send: (text: string, context: string, tools: AgentToolDefinition[]): Promise<void> => window.f1a.ai.send(text, context, tools),
  cancel: (): Promise<void> => window.f1a.ai.cancel(),
  onEvent: (cb: (event: AgentEvent) => void): (() => void) => window.f1a.ai.onEvent(cb),
  onToolCall: (cb: (call: AgentToolCall) => void): (() => void) => window.f1a.ai.onToolCall(cb),
  toolResult: (result: AgentToolResult): void => window.f1a.ai.toolResult(result),
};
