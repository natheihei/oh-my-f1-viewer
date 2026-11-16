import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { AgentToolCall, AgentToolDefinition, AgentToolResult } from '../../../shared/api';
import { PAST_PLAYHEAD } from './forgetReadAhead';

export interface ToolsExtension {
  factory: ExtensionFactory;
  /** Makes exactly these tools available to the model. Identical definitions don't change the prompt. */
  register(definitions: AgentToolDefinition[]): void;
}

/**
 * The renderer's tools, which it sends with each message, and again with a call's result when the call
 * changed them. `run` carries a call out and waits for its result. `always` names tools registered
 * elsewhere that stay active beside them.
 */
export function toolsExtension(run: (call: AgentToolCall) => Promise<AgentToolResult>, always: string[] = []): ToolsExtension {
  let pi: ExtensionAPI | null = null;
  function register(definitions: AgentToolDefinition[]): void {
    if (!pi) throw new Error('The tools extension is not loaded.');
    for (const { name, description, parameters } of definitions) {
      pi.registerTool({
        name,
        label: name,
        description,
        parameters: parameters as unknown as ToolDefinition['parameters'],
        execute: async (callId, args) => {
          const result = await run({ callId, name, args: args as Record<string, unknown> });
          // A call that opened or closed a session changed what the model may call next, within this turn.
          if (result.tools) register(result.tools);
          return {
            content: [{ type: 'text', text: result.content }],
            details: result.ok && result.pastPlayhead ? PAST_PLAYHEAD : undefined,
            isError: !result.ok,
          };
        },
      });
    }
    pi.setActiveTools([...definitions.map((d) => d.name), ...always]);
  }
  return {
    factory: (api) => {
      pi = api;
    },
    register,
  };
}
