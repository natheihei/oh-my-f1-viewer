import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentToolCall, AgentToolDefinition } from '../../shared/api';
import { SYSTEM_PROMPT } from '../../shared/tools';

const host = vi.hoisted(() => ({
  userData: '',
  events: [] as unknown[],
  /** Everything sent to the renderer, on any channel. */
  sent: [] as unknown[],
  onToolCall: (_call: unknown): void => {},
  askForKey: (_title: string, _message: string, _signal: AbortSignal): Promise<string> => Promise.resolve('sk-test-key'),
  keyTitles: [] as string[],
}));

vi.mock('electron', () => ({
  app: { getPath: () => host.userData },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../windows', () => ({
  sendToRenderer: (channel: string, payload: unknown) => {
    host.sent.push([channel, payload]);
    if (channel === 'ai:event') host.events.push(payload);
    if (channel === 'ai:toolCall') host.onToolCall(payload);
  },
}));
vi.mock('./keyWindow', () => ({
  askForKey: (title: string, message: string, signal: AbortSignal) => {
    host.keyTitles.push(title);
    return host.askForKey(title, message, signal);
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
  /** Everything but the system messages. */
  history: string;
  model: string;
  reasoning: string | undefined;
}

type Message = { role: string; content: unknown; toolsAdded?: { name: string }[]; stopReason?: string };
type Way = 'oauth' | 'api_key';

const text = (content: unknown): string =>
  typeof content === 'string' ? content : (content as { text?: string }[]).map((b) => b.text ?? '').join('');

const agentDir = () => path.join(host.userData, 'pi-agent');
const savedSettings = () => JSON.parse(readFileSync(path.join(agentDir(), 'settings.json'), 'utf8')) as Record<string, unknown>;

/**
 * An agent on a faux `openai`, connected the way `credentials` says. Credentials live in memory, and
 * login and logout change them, so connecting and switching run without a network.
 */
function setup(
  options: {
    provider?: string;
    model?: string;
    thinking?: string;
    credentials?: [string, Way][];
    /** More of settings.json, such as compaction. */
    settings?: Record<string, unknown>;
  } = {},
) {
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(
    path.join(agentDir(), 'settings.json'),
    JSON.stringify({
      defaultProvider: options.provider ?? 'openai',
      defaultModel: options.model ?? 'gpt-6-luna',
      defaultThinkingLevel: options.thinking ?? 'medium',
      ...options.settings,
    }),
  );
  const faux = fauxProvider({
    provider: 'openai',
    models: [
      { id: 'gpt-6-luna', reasoning: true },
      { id: 'gpt-6.1-terra', reasoning: true },
    ],
  });
  const credentials = new Map<string, Way>(options.credentials ?? [['openai', 'oauth']]);
  const ops: string[] = [];
  const requests: Request[] = [];
  const agent = new Agent((models) => {
    models.registerNativeProvider(faux.provider);
    models.checkAuth = (async () => ({ type: 'oauth' })) as never;
    models.listCredentials = (async () => [...credentials].map(([providerId, type]) => ({ providerId, type }))) as never;
    models.login = (async (id: string, type: Way, interaction: { prompt(p: { type: string; message: string }): Promise<string> }) => {
      if (type === 'api_key') await interaction.prompt({ type: 'secret', message: 'Enter key' });
      ops.push(`login ${id}`);
      credentials.set(id, type);
      return { type };
    }) as never;
    models.logout = (async (id: string) => {
      ops.push(`logout ${id}`);
      credentials.delete(id);
    }) as never;
  });
  /** A scripted reply that records the request it answers. */
  const reply =
    (message: ReturnType<typeof fauxAssistantMessage>) =>
    (context: { messages: unknown[] }, streamOptions: { reasoning?: string } | undefined, _state: unknown, model: { id: string }) => {
      const messages = context.messages as Message[];
      const system = messages.filter((m) => m.role === 'system');
      requests.push({
        system: system.map((m) => text(m.content)).join('\n---\n'),
        tools: system.flatMap((m) => (m.toolsAdded ?? []).map((t) => t.name)),
        roles: messages.map((m) => m.role + (m.stopReason === 'error' || m.stopReason === 'aborted' ? `:${m.stopReason}` : '')),
        lastUser: text(messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''),
        history: JSON.stringify(messages.filter((m) => m.role !== 'system')),
        model: model.id,
        reasoning: streamOptions?.reasoning,
      });
      return message;
    };
  const script = (...messages: ReturnType<typeof fauxAssistantMessage>[]) => faux.setResponses(messages.map(reply) as never);
  return { agent, faux, requests, script, credentials, ops };
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
  host.sent.length = 0;
  host.keyTitles.length = 0;
  host.onToolCall = () => {};
  host.askForKey = () => Promise.resolve('sk-test-key');
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

describe('forgetting a read ahead', () => {
  /** The renderer answering every call as a read past the playhead. */
  function answerReadAhead(agent: InstanceType<typeof Agent>) {
    host.onToolCall = (call) => agent.onToolResult({ callId: (call as AgentToolCall).callId, ok: true, content: 'SECRET ROWS', pastPlayhead: true });
  }
  const readAhead = () => [fauxAssistantMessage([fauxToolCall('act', { n: 12345 })]), fauxAssistantMessage('Jumped to lap 30.')];

  it('lets the turn use what it read, and later turns keep only what was said', async () => {
    const { agent, requests, script } = setup();
    answerReadAhead(agent);
    script(...readAhead(), fauxAssistantMessage('ok'));
    await agent.send('go', 'state', [TOOL]);
    await agent.send('next', 'state', [TOOL]);
    expect(requests[1].history).toContain('SECRET ROWS');
    expect(requests[2].history).not.toContain('SECRET ROWS');
    expect(requests[2].history).not.toContain('12345');
    expect(requests[2].history).toContain('Jumped to lap 30.');
    expect(requests[2].history).toContain('<app_note>');
    expect(requests[2].roles.filter((r) => r !== 'system')).toEqual(['user', 'assistant', 'user']);
  });

  it('keeps the prompt and tools when history is cut down', async () => {
    const { agent, requests, script } = setup();
    answerReadAhead(agent);
    script(...readAhead(), fauxAssistantMessage('ok'));
    await agent.send('go', 'state', [TOOL], 'THE REFERENCE');
    await agent.send('next', 'state', [TOOL], 'THE REFERENCE');
    expect(requests[2].system).toBe(`${SYSTEM_PROMPT}\n\nTHE REFERENCE`);
    expect(requests[2].tools).toEqual(['act']);
  });

  it('remembers a turn that read nothing past the playhead', async () => {
    const { agent, requests, script } = setup();
    answerTools(agent);
    script(fauxAssistantMessage([fauxToolCall('act', { n: 12345 })]), fauxAssistantMessage('Done.'), fauxAssistantMessage('ok'));
    await agent.send('go', 'state', [TOOL]);
    await agent.send('next', 'state', [TOOL]);
    expect(requests[2].history).toContain('12345');
    expect(requests[2].history).not.toContain('<app_note>');
  });

  it('ignores the mark on a failed call', async () => {
    const { agent, requests, script } = setup();
    host.onToolCall = (call) => agent.onToolResult({ callId: (call as AgentToolCall).callId, ok: false, content: 'refused', pastPlayhead: true });
    script(fauxAssistantMessage([fauxToolCall('act', { n: 12345 })]), fauxAssistantMessage('You said no.'), fauxAssistantMessage('ok'));
    await agent.send('go', 'state', [TOOL]);
    await agent.send('next', 'state', [TOOL]);
    expect(requests[2].history).toContain('12345');
  });

  it('forgets it in a compaction summary, and leaves the stored conversation alone', async () => {
    const { agent, requests, script } = setup({ settings: { compaction: { enabled: true, keepRecentTokens: 1 } } });
    answerReadAhead(agent);
    script(...readAhead(), fauxAssistantMessage('ok'), fauxAssistantMessage('THE SUMMARY'), fauxAssistantMessage('THE TURN SO FAR'));
    await agent.send('go', 'state', [TOOL]);
    await agent.send('next', 'state', [TOOL]);
    const { session } = (agent as unknown as { conversation: { session: { compact(): Promise<unknown>; messages: unknown[] } } }).conversation;
    expect(JSON.stringify(session.messages)).toContain('SECRET ROWS');
    await session.compact();
    const summarized = requests.slice(3).map((r) => r.history).join('');
    expect(summarized).toContain('Jumped to lap 30.');
    expect(summarized).not.toContain('SECRET ROWS');
    expect(summarized).not.toContain('12345');
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
    expect(events().at(-1)).toMatchObject({ type: 'error', message: 'OpenAI usage limit reached. Try again later.' });
    host.events.length = 0;
    script(fauxAssistantMessage('Fine now.'));
    await agent.send('again', 'state', [TOOL]);
    expect(said()).toBe('Fine now.');
    expect(events().at(-1)).toMatchObject({ type: 'turn_end' });
  });

  it('refuses when not set up, even with the chosen provider set up in the environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'not-a-real-key');
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(path.join(agentDir(), 'settings.json'), '{"defaultProvider":"anthropic","defaultModel":"claude-sonnet-5-5"}');
    const agent = new Agent();
    await agent.send('go', 'state', [TOOL]);
    expect(events().map((e) => e.type)).toEqual(['turn_start', 'error']);
    expect(events().at(-1)).toMatchObject({ message: 'The agent needs setting up first: /settings-agent' });
    expect(await agent.status()).toMatchObject({ ready: false });
  });
});

describe('setup', () => {
  it('reports the connected provider, model and thinking level', async () => {
    const { agent } = setup();
    expect(await agent.status()).toMatchObject({ ready: true, provider: 'openai', model: 'gpt-6-luna', thinking: 'medium' });
  });

  it('falls back to the recommended model when the saved one is not offered', async () => {
    const { agent } = setup({ model: 'gpt-4' });
    expect(await agent.status()).toMatchObject({ ready: true, model: 'gpt-6.1-terra' });
  });

  it('counts only the provider in settings, connected a way the supported list offers', async () => {
    expect(await setup({ provider: 'anthropic' }).agent.status()).toMatchObject({ ready: false });
    const oauthAnthropic = setup({ provider: 'anthropic', model: 'claude-sonnet-5-5', credentials: [['anthropic', 'oauth']] });
    expect(await oauthAnthropic.agent.status()).toMatchObject({ ready: false });
  });

  it('lists the supported providers with their ways to connect, models and thinking levels', async () => {
    const { agent } = setup();
    const list = await agent.providers();
    expect(list.map((p) => p.id)).toEqual(['openai', 'anthropic']);
    const [openai, anthropic] = list;
    expect(openai.connected).toMatchObject({ way: 'oauth' });
    // The faux provider stands in for OpenAI, so only its two models exist.
    expect(openai.models.map((m) => m.id)).toEqual(['gpt-6.1-terra', 'gpt-6-luna']);
    expect(openai.recommended).toEqual({ model: 'gpt-6.1-terra', thinking: 'medium' });
    expect(anthropic.connected).toBeNull();
    expect(anthropic.ways.map((w) => w.way)).toEqual(['api_key']);
    expect(anthropic.models.map((m) => m.id)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']);
    expect(anthropic.models[0].thinking).not.toContain('off');
  });

  it('applies a new model and thinking level from the next message, in the same conversation', async () => {
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('one'));
    await agent.send('first', 'state', [TOOL]);
    expect(await agent.choose('gpt-6.1-terra', 'high')).toMatchObject({ model: 'gpt-6.1-terra', thinking: 'high' });
    expect(savedSettings()).toMatchObject({ defaultModel: 'gpt-6.1-terra', defaultThinkingLevel: 'high' });
    script(fauxAssistantMessage('two'));
    await agent.send('second', 'state', [TOOL]);
    expect(requests.map((r) => [r.model, r.reasoning])).toEqual([
      ['gpt-6-luna', 'medium'],
      ['gpt-6.1-terra', 'high'],
    ]);
    expect(requests[1].roles.filter((r) => r === 'user')).toHaveLength(2);
  });

  it('refuses a model the supported list does not offer', async () => {
    const { agent } = setup();
    await expect(agent.choose('gpt-4', 'medium')).rejects.toThrow(/isn't offered/);
    expect(savedSettings()).toMatchObject({ defaultModel: 'gpt-6-luna' });
  });

  it('switches provider: removes the old one only after the new one connects, with its recommended settings', async () => {
    const { agent, credentials, ops } = setup();
    const status = await agent.connect('anthropic', 'api_key');
    expect(ops).toEqual(['login anthropic', 'logout openai']);
    expect([...credentials]).toEqual([['anthropic', 'api_key']]);
    expect(status).toMatchObject({ ready: true, provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'medium' });
    expect(savedSettings()).toMatchObject({
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-5-5',
      defaultThinkingLevel: 'medium',
    });
  });

  it('asks for a key in the key window, and never sends it to the renderer', async () => {
    const { agent } = setup();
    await agent.connect('anthropic', 'api_key');
    expect(host.keyTitles).toEqual(['Anthropic API key']);
    expect(JSON.stringify(host.sent)).not.toContain('sk-test-key');
    expect(host.sent).toContainEqual(['ai:connect', expect.objectContaining({ type: 'key_window' })]);
  });

  it('leaves the connected provider as it was when connecting another is cancelled', async () => {
    const { agent, credentials, ops } = setup();
    host.askForKey = () => Promise.reject(new Error('Sign-in cancelled'));
    await expect(agent.connect('anthropic', 'api_key')).rejects.toThrow('Sign-in cancelled');
    expect(ops).toEqual([]);
    expect([...credentials]).toEqual([['openai', 'oauth']]);
    expect(await agent.status()).toMatchObject({ ready: true, provider: 'openai', model: 'gpt-6-luna' });
  });

  it('keeps the chosen model when the same provider connects another way', async () => {
    const { agent, credentials } = setup();
    await agent.connect('openai', 'api_key');
    expect([...credentials]).toEqual([['openai', 'api_key']]);
    expect(await agent.status()).toMatchObject({ provider: 'openai', model: 'gpt-6-luna' });
  });

  it('refuses a way the supported list does not offer', async () => {
    const { agent, ops } = setup();
    await expect(agent.connect('anthropic', 'oauth')).rejects.toThrow();
    expect(ops).toEqual([]);
  });

  it('needs setting up again after disconnecting', async () => {
    const { agent, credentials } = setup();
    await agent.disconnect();
    expect([...credentials]).toEqual([]);
    expect(await agent.status()).toMatchObject({ ready: false });
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

describe('stored sessions', () => {
  const dir = () => path.join(host.userData, 'pi-agent', 'sessions');
  const files = () => (existsSync(dir()) ? readdirSync(dir()).sort() : []);
  const entries = (file: string) =>
    readFileSync(path.join(dir(), file), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; id: string; message?: Message });
  const stored = (file: string) =>
    entries(file).flatMap((e) =>
      e.message && e.message.role !== 'system' ? [`${e.message.role}: ${text(e.message.content)}`] : [],
    );

  it('writes the conversation to a .jsonl, keeping the id used as the cache key', async () => {
    const { agent, script } = setup();
    script(fauxAssistantMessage('Hello.'));
    await agent.send('hi', 'state', [TOOL]);
    expect(files()).toHaveLength(1);
    expect(files()[0]).toMatch(/_f1a\.jsonl$/);
    expect(entries(files()[0])[0]).toMatchObject({ type: 'session', id: 'f1a' });
    expect(stored(files()[0])).toEqual(['user: <app_state>\nstate\n</app_state>\n\nhi', 'assistant: Hello.']);
  });

  it('adds later turns to the same file', async () => {
    const { agent, script } = setup();
    script(fauxAssistantMessage('one'));
    await agent.send('first', 'state', [TOOL]);
    script(fauxAssistantMessage('two'));
    await agent.send('second', 'state', [TOOL]);
    expect(files()).toHaveLength(1);
    expect(stored(files()[0])).toHaveLength(4);
  });

  it('starts a new file on reset, leaving the old one', async () => {
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('one'));
    await agent.send('first', 'state', [TOOL]);
    const [first] = files();
    const before = readFileSync(path.join(dir(), first), 'utf8');
    await agent.reset();
    script(fauxAssistantMessage('two'));
    await agent.send('second', 'state', [TOOL]);
    expect(files()).toHaveLength(2);
    expect(readFileSync(path.join(dir(), first), 'utf8')).toBe(before);
    expect(requests[1].roles.filter((r) => r === 'user')).toHaveLength(1);
  });

  it('never resumes a stored session after a restart', async () => {
    const before = setup();
    before.script(fauxAssistantMessage('one'));
    await before.agent.send('first', 'state', [TOOL]);
    const after = setup();
    after.script(fauxAssistantMessage('two'));
    await after.agent.send('second', 'state', [TOOL]);
    expect(files()).toHaveLength(2);
    expect(after.requests[0].roles.filter((r) => r === 'user')).toHaveLength(1);
    expect(after.requests[0].lastUser).toContain('second');
  });

  it('keeps the prompt of a cancelled turn', async () => {
    const { agent, script } = setup();
    let reached!: () => void;
    const started = new Promise<void>((resolve) => (reached = resolve));
    host.onToolCall = () => reached();
    script(fauxAssistantMessage([fauxToolCall('act', { n: 1 })]), fauxAssistantMessage('Should not be said.'));
    const turn = agent.send('go', 'state', [TOOL]);
    await started;
    await agent.cancel();
    await turn;
    expect(stored(files()[0])[0]).toContain('go');
  });

  it('writes nothing until there is a message', async () => {
    await new Agent().status();
    expect(files()).toEqual([]);
  });

  it('reports an error, rather than hanging, when the session cannot be written', async () => {
    mkdirSync(path.join(host.userData, 'pi-agent'), { recursive: true });
    writeFileSync(dir(), 'a file where the folder should be');
    const { agent, script } = setup();
    script(fauxAssistantMessage('Not reached.'));
    await agent.send('hi', 'state', [TOOL]);
    expect(events().at(-1)).toMatchObject({ type: 'error' });
  });
});

describe('its files', () => {
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
    expect(savedSettings()).toEqual({
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
