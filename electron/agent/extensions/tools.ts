import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { AgentToolCall, AgentToolDefinition, AgentToolResult } from '../../../shared/api';

export interface ToolsExtension {
  factory: ExtensionFactory;
  /** Makes exactly these tools available to the model. Identical definitions don't change the prompt. */
  register(definitions: AgentToolDefinition[]): void;
}

/** The renderer's tools, which it sends with each message. `run` carries a call out and waits for its result. */
export function toolsExtension(run: (call: AgentToolCall) => Promise<AgentToolResult>): ToolsExtension {
  let pi: ExtensionAPI | null = null;
  return {
    factory: (api) => {
      pi = api;
    },
    register(definitions) {
      if (!pi) throw new Error('The tools extension is not loaded.');
      for (const { name, description, parameters } of definitions) {
        pi.registerTool({
          name,
          label: name,
          description,
          parameters: parameters as unknown as ToolDefinition['parameters'],
          execute: async (callId, args) => {
            const result = await run({ callId, name, args: args as Record<string, unknown> });
            return { content: [{ type: 'text', text: result.content }], details: undefined, isError: !result.ok };
          },
        });
      }
      pi.setActiveTools(definitions.map((d) => d.name));
    },
  };
}
