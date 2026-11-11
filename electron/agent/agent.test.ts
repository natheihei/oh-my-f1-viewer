import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentToolCall, AgentToolDefinition } from '../../shared/api';
import { SYSTEM_PROMPT } from '../../shared/tools';

const host = vi.hoisted(() => ({
  userData: '',
  events: [] as unknown[],
  onToolCall: (_call: unknown): void => {},
}));

vi.mock('electron', () => ({
  app: { getPath: () => host.userData },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../windows', () => ({
  sendToRenderer: (channel: string, payload: unknown) => {
    if (channel === 'ai:event') host.events.push(payload);
    if (channel === 'ai:toolCall') host.onToolCall(payload);
  },
}));

const { Agent } = await import('./agent');
const { fauxAssistantMessage, fauxProvider, fauxToolCall } = await import('@earendil-works/pi-ai');

const TOOL: AgentToolDefinition = {
  name: 'act',
  description: 'Does something',
  parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false },
};

interface Request {
  system: string;
  tools: string[];
  roles: string[];
  lastUser: string;
}

type Message = { role: string; content: unknown; toolsAdded?: { name: string }[]; stopReason?: string };

const text = (content: unknown): string =>
  typeof content === 'string' ? content : (content as { text?: string }[]).map((b) => b.text ?? '').join('');

function setup() {
  const faux = fauxProvider({ provider: 'openai', models: [{ id: 'gpt-6-luna', reasoning: true }] });
  const requests: Request[] = [];
  const agent = new Agent((models) => {
    models.registerNativeProvider(faux.provider);
    models.checkAuth = (async () => ({ type: 'oauth' })) as never;
  });
  /** A scripted reply that records the request it answers. */
  const reply = (message: ReturnType<typeof fauxAssistantMessage>) => (context: { messages: unknown[] }) => {
    const messages = context.messages as Message[];
    const system = messages.filter((m) => m.role === 'system');
    requests.push({
      system: system.map((m) => text(m.content)).join('\n---\n'),
      tools: system.flatMap((m) => (m.toolsAdded ?? []).map((t) => t.name)),
      roles: messages.map((m) => m.role + (m.stopReason === 'error' || m.stopReason === 'aborted' ? `:${m.stopReason}` : '')),
      lastUser: text(messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''),
    });
    return message;
  };
  const script = (...messages: ReturnType<typeof fauxAssistantMessage>[]) => faux.setResponses(messages.map(reply));
  return { agent, faux, requests, script };
}

const events = () => host.events as AgentEvent[];
const types = () => events().map((e) => e.type);
const said = () =>
  events()
    .flatMap((e) => (e.type === 'text_delta' ? [e.delta] : []))
    .join('');

/** The renderer answering every call. */
function answerTools(agent: InstanceType<typeof Agent>, ok = true) {
  const calls: AgentToolCall[] = [];
  host.onToolCall = (call) => {
    calls.push(call as AgentToolCall);
    agent.onToolResult({ callId: (call as AgentToolCall).callId, ok, content: 'done' });
  };
  return calls;
}

beforeEach(() => {
  host.userData = mkdtempSync(path.join(os.tmpdir(), 'f1a-agent-test-'));
  host.events.length = 0;
  host.onToolCall = () => {};
});

afterEach(() => {
  rmSync(host.userData, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('a turn', () => {
  it('streams a reply and reports its end', async () => {
    const { agent, script } = setup();
    script(fauxAssistantMessage('Suggested Hamilton.'));
    await agent.send('ham', 'now: then', [TOOL]);
    expect(types()[0]).toBe('turn_start');
    expect(said()).toBe('Suggested Hamilton.');
    expect(events().at(-1)).toMatchObject({ type: 'turn_end', acted: false });
    expect(new Set(events().map((e) => e.turnId)).size).toBe(1);
  });

  it('sends the app state ahead of the text', async () => {
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('ok'));
    await agent.send('ham', 'now: then', [TOOL]);
    expect(requests[0].lastUser).toBe('<app_state>\nnow: then\n</app_state>\n\nham');
  });

  it('runs tools in the renderer, one at a time, and reports them', async () => {
    const { agent, script } = setup();
    let running = 0;
    let most = 0;
    const calls: AgentToolCall[] = [];
    host.onToolCall = (raw) => {
      const call = raw as AgentToolCall;
      calls.push(call);
      most = Math.max(most, ++running);
      setTimeout(() => {
        running -= 1;
        agent.onToolResult({ callId: call.callId, ok: true, content: 'done' });
      }, 5);
    };
    script(fauxAssistantMessage([fauxToolCall('act', { n: 1 }), fauxToolCall('act', { n: 2 })]), fauxAssistantMessage('Done.'));
    await agent.send('go', 'state', [TOOL]);
    expect(calls.map((c) => c.args)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(most).toBe(1);
    expect(types().filter((t) => t.startsWith('tool_'))).toEqual(['tool_start', 'tool_end', 'tool_start', 'tool_end']);
    expect(events().find((e) => e.type === 'tool_start')).toMatchObject({ name: 'act', args: { n: 1 } });
    expect(events().at(-1)).toMatchObject({ type: 'turn_end', acted: true });
  });

  it('does not count a failed tool as acting', async () => {
    const { agent, script } = setup();
    answerTools(agent, false);
    script(fauxAssistantMessage([fauxToolCall('act', { n: 1 })]), fauxAssistantMessage('Could not.'));
    await agent.send('go', 'state', [TOOL]);
    expect(events().find((e) => e.type === 'tool_end')).toMatchObject({ ok: false });
    expect(events().at(-1)).toMatchObject({ type: 'turn_end', acted: false });
  });

  it('sends invalid arguments back to the model without running the tool', async () => {
    const { agent, requests, script } = setup();
    const calls = answerTools(agent);
    script(fauxAssistantMessage([fauxToolCall('act', { n: 'not a number' })]), fauxAssistantMessage('Sorry.'));
    await agent.send('go', 'state', [TOOL]);
    expect(calls).toEqual([]);
    expect(types()).not.toContain('tool_start');
    expect(requests[1].roles).toContain('toolResult');
    expect(events().at(-1)).toMatchObject({ type: 'turn_end', acted: false });
  });
});

describe('the prompt', () => {
  it('is SYSTEM.md and the reference, with nothing of pi around them', async () => {
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('ok'));
    await agent.send('hi', 'state', [TOOL], 'THE REFERENCE');
    expect(requests[0].system).toBe(`${SYSTEM_PROMPT}\n\nTHE REFERENCE`);
    expect(requests[0].tools).toEqual(['act']);
  });

  it('is SYSTEM.md alone without a reference', async () => {
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('ok'));
    await agent.send('hi', 'state', [TOOL]);
    expect(requests[0].system).toBe(SYSTEM_PROMPT);
  });

  it('follows the reference as it changes, keeping the tools', async () => {
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('one'));
    await agent.send('a', 'state', [TOOL], 'FIRST');
    script(fauxAssistantMessage('two'));
    await agent.send('b', 'state', [TOOL], 'SECOND');
    expect(requests[1].system).toBe(`${SYSTEM_PROMPT}\n\nSECOND`);
    expect(requests[1].tools).toEqual(['act']);
  });

  it('never treats viewer text as a template', async () => {
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('ok'));
    await agent.send('/compact now', 'state', [TOOL]);
    expect(requests[0].lastUser).toContain('/compact now');
  });
});

describe('the round cap', () => {
  const batch = () => fauxAssistantMessage([fauxToolCall('act', { n: 1 }), fauxToolCall('act', { n: 'bad' })]);

  it('stops a model that keeps calling tools, even with invalid calls in every batch', async () => {
    const { agent, requests, script } = setup();
    answerTools(agent);
    script(...Array.from({ length: 15 }, batch));
    await agent.send('go', 'state', [TOOL]);
    expect(requests).toHaveLength(10);
    expect(events().at(-1)).toMatchObject({ type: 'turn_end', acted: true });
    expect(types()).not.toContain('error');
  });

  it('leaves later turns working', async () => {
    const { agent, requests, script } = setup();
    answerTools(agent);
    script(...Array.from({ length: 11 }, batch));
    await agent.send('go', 'state', [TOOL]);
    host.events.length = 0;
    requests.length = 0;
    script(fauxAssistantMessage('Back.'));
    await agent.send('again', 'state', [TOOL]);
    expect(said()).toBe('Back.');
    expect(events().at(-1)).toMatchObject({ type: 'turn_end' });
    expect(requests).toHaveLength(1);
  });
});

describe('failures', () => {
  it('reports a model error, and the next turn still works', async () => {
    const { agent, script } = setup();
    script(fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'usage_limit_reached' }));
    await agent.send('go', 'state', [TOOL]);
    expect(events().at(-1)).toMatchObject({ type: 'error', message: 'ChatGPT usage limit reached. Try again later.' });
    host.events.length = 0;
    script(fauxAssistantMessage('Fine now.'));
    await agent.send('again', 'state', [TOOL]);
    expect(said()).toBe('Fine now.');
    expect(events().at(-1)).toMatchObject({ type: 'turn_end' });
  });

  it('refuses when signed out, even with another provider set up in the environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'not-a-real-key');
    const agent = new Agent();
    await agent.send('go', 'state', [TOOL]);
    expect(events().map((e) => e.type)).toEqual(['turn_start', 'error']);
    expect(events().at(-1)).toMatchObject({ message: 'ChatGPT sign-in is needed. Run /login-chatgpt.' });
    expect(await agent.status()).toMatchObject({ signedIn: false });
  });
});

describe('cancelling', () => {
  /** Starts a turn and waits until its tool is waiting on the renderer. */
  async function untilToolRuns(agent: InstanceType<typeof Agent>, script: ReturnType<typeof setup>['script']) {
    let reached!: () => void;
    const started = new Promise<void>((resolve) => (reached = resolve));
    host.onToolCall = () => reached();
    script(fauxAssistantMessage([fauxToolCall('act', { n: 1 })]), fauxAssistantMessage('Should not be said.'));
    const turn = agent.send('go', 'state', [TOOL]);
    await started;
    return { turn };
  }

  it('stops a turn waiting on a tool, without reporting an end, and later turns work', async () => {
    const { agent, requests, script } = setup();
    const { turn } = await untilToolRuns(agent, script);
    await agent.cancel();
    await turn;
    expect(requests).toHaveLength(1);
    expect(types()).not.toContain('turn_end');
    expect(types()).not.toContain('error');

    host.events.length = 0;
    script(fauxAssistantMessage('Still here.'));
    await agent.send('again', 'state', [TOOL]);
    expect(said()).toBe('Still here.');
    expect(events().at(-1)).toMatchObject({ type: 'turn_end' });
  });

  it('lets a new message replace the running turn', async () => {
    const { agent, script } = setup();
    const { turn } = await untilToolRuns(agent, script);
    host.events.length = 0;
    script(fauxAssistantMessage('Newer.'));
    await agent.send('newer', 'state', [TOOL]);
    await turn;
    expect(said()).toBe('Newer.');
    expect(events().at(-1)).toMatchObject({ type: 'turn_end' });
  });
});

describe('starting over', () => {
  it('forgets the conversation', async () => {
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('one'));
    await agent.send('first', 'state', [TOOL]);
    await agent.reset();
    script(fauxAssistantMessage('two'));
    await agent.send('second', 'state', [TOOL]);
    expect(requests[1].roles.filter((r) => r === 'user')).toHaveLength(1);
    expect(requests[1].tools).toEqual(['act']);
  });
});

describe('its files', () => {
  const agentDir = () => path.join(host.userData, 'pi-agent');

  it('writes SYSTEM.md every time, and settings only if missing', async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(path.join(agentDir(), 'SYSTEM.md'), 'hand edit');
    writeFileSync(path.join(agentDir(), 'settings.json'), '{"defaultModel":"edited"}');
    await new Agent().status();
    expect(readFileSync(path.join(agentDir(), 'SYSTEM.md'), 'utf8')).toBe(SYSTEM_PROMPT);
    expect(readFileSync(path.join(agentDir(), 'settings.json'), 'utf8')).toBe('{"defaultModel":"edited"}');
  });

  it('starts with the expected settings', async () => {
    await new Agent().status();
    expect(JSON.parse(readFileSync(path.join(agentDir(), 'settings.json'), 'utf8'))).toEqual({
      defaultProvider: 'openai',
      defaultModel: 'gpt-6-luna',
      defaultThinkingLevel: 'medium',
      compaction: { enabled: true },
      retry: { enabled: false },
      cacheWarming: 'off',
    });
  });

  it('ignores a .pi folder planted in the mods folder, and writes nothing there', async () => {
    const planted = path.join(host.userData, 'mods', '.pi');
    mkdirSync(path.join(planted, 'extensions'), { recursive: true });
    writeFileSync(path.join(planted, 'SYSTEM.md'), 'PLANTED PROMPT');
    writeFileSync(path.join(planted, 'settings.json'), '{"defaultModel":"planted"}');
    const marker = path.join(host.userData, 'extension-ran');
    writeFileSync(
      path.join(planted, 'extensions', 'evil.ts'),
      `import { writeFileSync } from 'node:fs'; export default () => { writeFileSync(${JSON.stringify(marker)}, 'x'); };`,
    );
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('ok'));
    await agent.send('hi', 'state', [TOOL]);
    expect(requests[0].system).toBe(SYSTEM_PROMPT);
    expect(existsSync(marker)).toBe(false);
    expect(events().at(-1)).toMatchObject({ type: 'turn_end' });
  });
});
