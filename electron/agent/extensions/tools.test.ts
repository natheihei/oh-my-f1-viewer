import { describe, expect, it } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { AgentToolCall, AgentToolDefinition, AgentToolResult } from '../../../shared/api';
import { toolsExtension } from './tools';

interface Registered {
  name: string;
  execute(callId: string, args: unknown): Promise<{ isError: boolean }>;
}

const definition = (name: string): AgentToolDefinition => ({ name, description: name, parameters: { type: 'object', properties: {} } });

/** A pi that only records what the extension registers and makes active. */
function fakePi() {
  const tools = new Map<string, Registered>();
  const state = { active: [] as string[] };
  const api = {
    registerTool: (tool: Registered) => tools.set(tool.name, tool),
    setActiveTools: (names: string[]) => (state.active = names),
  } as unknown as ExtensionAPI;
  return { api, tools, state };
}

describe("the renderer's tools", () => {
  it('makes exactly the sent tools active, beside the ones registered elsewhere', () => {
    const pi = fakePi();
    const extension = toolsExtension(async (call) => ({ callId: call.callId, ok: true, content: '' }), ['read_mod']);
    void extension.factory(pi.api);
    extension.register([definition('list_sessions'), definition('load_session')]);
    expect(pi.state.active).toEqual(['list_sessions', 'load_session', 'read_mod']);
  });

  it("takes up the set a call's result carries, within the same turn", async () => {
    const pi = fakePi();
    const opened = [definition('list_sessions'), definition('load_session'), definition('suggest_tiles')];
    const run = async (call: AgentToolCall): Promise<AgentToolResult> => ({
      callId: call.callId,
      ok: true,
      content: 'Opened.',
      tools: call.name === 'load_session' ? opened : undefined,
    });
    const extension = toolsExtension(run);
    void extension.factory(pi.api);
    extension.register([definition('list_sessions'), definition('load_session')]);

    await pi.tools.get('list_sessions')!.execute('a', {});
    expect(pi.state.active).toEqual(['list_sessions', 'load_session']);
    await pi.tools.get('load_session')!.execute('b', {});
    expect(pi.state.active).toEqual(['list_sessions', 'load_session', 'suggest_tiles']);
    expect(pi.tools.has('suggest_tiles')).toBe(true);
  });
});
