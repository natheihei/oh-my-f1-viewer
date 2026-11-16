import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation as DurableConversation, Harness } from '@earendil-works/pi-durable';
import type { AgentEvent, AgentToolCall, AgentToolDefinition } from '../../shared/api';
import { BUILD_PROMPT } from '../../shared/buildPrompt';
import type { PlaceHealth } from '../../shared/health';
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
  safeStorage: { isAsyncEncryptionAvailable: async () => false },
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
const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
const pi = await import('@earendil-works/pi-ai');
const { fauxProvider, fauxToolCall } = pi;
/** A scripted reply. One that calls tools stops for them, as a real provider's does. */
const fauxAssistantMessage: typeof pi.fauxAssistantMessage = (content, options = {}) =>
  pi.fauxAssistantMessage(content, { ...(Array.isArray(content) && content.some((block) => block.type === 'toolCall') ? { stopReason: 'toolUse' as const } : {}), ...options });

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

type Message = { role: string; content: unknown; sections?: Record<string, string | null>; toolsAdded?: { name: string }[]; toolsRemoved?: (string | { name: string })[]; stopReason?: string };
type Way = 'oauth' | 'api_key';

const text = (content: unknown): string =>
  typeof content === 'string' ? content : (content as { text?: string }[]).map((b) => b.text ?? '').join('');

const agentDir = () => path.join(host.userData, 'pi-agent');
/** The settings the agent last had the renderer keep, if it changed any. */
const savedSettings = () => (host.sent.filter((s) => (s as unknown[])[0] === 'ai:settings').at(-1) as unknown[] | undefined)?.[1];

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
    /** More of the settings, such as compaction. */
    settings?: Record<string, unknown>;
  } = {},
) {
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
  const agent = new Agent((providers) => {
    providers.setProvider(faux.provider);
    providers.credentials = {
      // Whatever way it says it's connected, the faux provider is reached with a key.
      read: async (id: string) => (credentials.has(id) ? { type: 'api_key', key: 'test' } : undefined),
      list: async () => [...credentials].map(([providerId, type]) => ({ providerId, type })),
      modify: async (id: string) => (credentials.has(id) ? { type: 'api_key', key: 'test' } : undefined),
      delete: async (id: string) => void credentials.delete(id),
    } as never;
    providers.login = (async (id: string, type: Way, interaction: { prompt(p: { type: string; message: string }): Promise<string> }) => {
      if (type === 'api_key') await interaction.prompt({ type: 'secret', message: 'Enter key' });
      ops.push(`login ${id}`);
      credentials.set(id, type);
      return { type };
    }) as never;
    providers.logout = (async (id: string) => {
      ops.push(`logout ${id}`);
      credentials.delete(id);
    }) as never;
  });
  agent.useSettings({ provider: options.provider ?? 'openai', model: options.model ?? 'gpt-6-luna', thinking: options.thinking ?? 'medium', ...options.settings });
  /** A scripted reply that records the request it answers. */
  const reply =
    (message: ReturnType<typeof fauxAssistantMessage>) =>
    (context: { messages: unknown[] }, streamOptions: { reasoning?: string } | undefined, _state: unknown, model: { id: string }) => {
      const messages = context.messages as Message[];
      // The prompt arrives as named sections, and a later system message carries only what changed since.
      const sections = new Map<string, string>();
      const tools = new Set<string>();
      for (const m of messages.filter((m) => m.role === 'system')) {
        for (const [key, value] of Object.entries(m.sections ?? {})) value === null ? sections.delete(key) : sections.set(key, value);
        for (const t of m.toolsRemoved ?? []) tools.delete(typeof t === 'string' ? t : t.name);
        for (const t of m.toolsAdded ?? []) tools.add(t.name);
      }
      requests.push({
        system: [...sections.values()].join('\n---\n'),
        tools: [...tools],
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

  it('gives the model the tools a call opened up, from its next request in the same turn', async () => {
    const { agent, requests, script } = setup();
    const more: AgentToolDefinition = { ...TOOL, name: 'more' };
    host.onToolCall = (raw) => {
      const call = raw as AgentToolCall;
      agent.onToolResult({ callId: call.callId, ok: true, content: 'opened', ...(call.name === 'act' ? { tools: [more] } : {}) });
    };
    script(fauxAssistantMessage([fauxToolCall('act', { n: 1 })]), fauxAssistantMessage([fauxToolCall('more', { n: 2 })]), fauxAssistantMessage('Done.'));
    await agent.send('go', 'state', [TOOL]);
    expect(requests.map((r) => r.tools)).toEqual([['act'], ['more'], ['more']]);
    expect(events().filter((e) => e.type === 'tool_end').map((e) => [e.name, e.ok])).toEqual([['act', true], ['more', true]]);
  });

  it('passes on what the model says before it calls a tool, and after', async () => {
    const { agent, script } = setup();
    answerTools(agent);
    script(fauxAssistantMessage([{ type: 'text', text: 'Looking. ' }, fauxToolCall('act', { n: 1 })]), fauxAssistantMessage('Found it.'));
    await agent.send('go', 'state', [TOOL]);
    expect(said()).toBe('Looking. Found it.');
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
  it('is the viewing prompt and the reference, with nothing of pi around them', async () => {
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('ok'));
    await agent.send('hi', 'state', [TOOL], 'THE REFERENCE');
    expect(requests[0].system).toBe(`${SYSTEM_PROMPT}\n\nTHE REFERENCE`);
    expect(requests[0].tools).toEqual(['act']);
  });

  it('is the viewing prompt alone without a reference', async () => {
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
    const { root, harness } = (agent as unknown as { conversation: { root: DurableConversation; harness: Harness } }).conversation;
    const all = await root.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(all.items)).toContain('SECRET ROWS');
    await harness.waitForTask(await root.compact(undefined, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
    const summarized = requests.slice(3).map((r) => r.history).join('');
    expect(summarized).toContain('Jumped to lap 30.');
    expect(summarized).not.toContain('SECRET ROWS');
    expect(summarized).not.toContain('12345');
  });
});

describe('summarizing a turn that is still reading ahead', () => {
  it('leaves what it read out of the summary, and lets the turn go on', async () => {
    const { agent, requests, script } = setup({ settings: { compaction: { enabled: true, keepRecentTokens: 1 } } });
    let held: AgentToolCall | null = null;
    let reached!: () => void;
    const second = new Promise<void>((resolve) => (reached = resolve));
    host.onToolCall = (raw) => {
      const call = raw as AgentToolCall;
      if ((call.args as { n: number }).n === 1) return agent.onToolResult({ callId: call.callId, ok: true, content: 'SECRET ROWS', pastPlayhead: true });
      held = call;
      reached();
    };
    script(
      fauxAssistantMessage([{ type: 'text', text: 'Looking it up.' }, fauxToolCall('act', { n: 1 })]),
      fauxAssistantMessage([fauxToolCall('act', { n: 2 })]),
      fauxAssistantMessage('THE SUMMARY'),
      fauxAssistantMessage('Jumped to lap 30.'),
    );
    const turn = agent.send('go', 'state', [TOOL]);
    await second;
    const { root, harness } = (agent as unknown as { conversation: { root: DurableConversation; harness: Harness } }).conversation;
    await harness.waitForTask(await root.compact(undefined, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
    const summarizing = requests[2];
    expect(summarizing.history).toContain('Looking it up.');
    expect(summarizing.history).toContain('<app_note>');
    expect(summarizing.history).not.toContain('SECRET ROWS');
    agent.onToolResult({ callId: held!.callId, ok: true, content: 'done' });
    await turn;
    expect(said()).toContain('Jumped to lap 30.');
    expect(events().at(-1)).toMatchObject({ type: 'turn_end' });
  });
});

describe('build mode', () => {
  const modsDir = () => path.join(host.userData, 'mods');
  const sessions = (folder: string) => {
    const dir = path.join(host.userData, 'pi-agent', folder);
    return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(path.join(dir, f), 'utf8')) : [];
  };
  /** The mods folder as the build agent's tools see it, with every save loading at once. */
  /** What the screen reports each time it's asked: the last answer repeats. */
  let screen: (PlaceHealth[] | null)[] = [[]];
  let asked = 0;
  beforeEach(() => {
    screen = [[]];
    asked = 0;
  });
  const place = (over: Partial<PlaceHealth>): PlaceHealth => ({ scope: 'tile-1', where: 'tile', type: 'pace', label: 'Pace HAM', state: 'drawn', missing: [], dropped: [], message: null, since: null, ...over });
  const needsDriver = place({ scope: 'preview:pace', where: 'strip', state: 'needs_props', missing: ['driver'], message: 'Needs driver' });
  const threw = place({ state: 'error', message: 'lap is undefined' });

  function attach(agent: InstanceType<typeof Agent>, picture: Buffer | null = null) {
    mkdirSync(modsDir(), { recursive: true });
    agent.attachMods({
      dir: modsDir(),
      settled: async (name) =>
        existsSync(path.join(modsDir(), name, 'main.tsx')) ? { name, state: 'ready', version: 1, url: null, error: null } : null,
      logs: () => [{ at: 0, level: 'log', text: 'drew' }],
      picture: async () => picture,
      health: async () => screen[Math.min(asked++, screen.length - 1)],
    });
  }
  const notes = () => events().flatMap((e) => (e.type === 'tool_end' && e.note ? [e.note] : []));

  it('is its own conversation, with its own prompt and file tools', async () => {
    const { agent, requests, script } = setup();
    attach(agent);
    script(fauxAssistantMessage('Viewing.'), fauxAssistantMessage('Building.'), fauxAssistantMessage('Viewing again.'));
    await agent.send('ham', 'state', [TOOL]);
    await agent.send('a lap stepper', 'state', [TOOL], 'TABLES', 'build');
    await agent.send('nor', 'state', [TOOL]);

    expect(requests[1].system).toBe(`${BUILD_PROMPT}\n\nTABLES`);
    expect(requests[1].tools).toEqual(expect.arrayContaining(['act', 'read', 'write', 'edit', 'ls', 'grep', 'find', 'delete_path', 'mod_status', 'look_at']));
    expect(requests[1].tools).not.toContain('bash');
    expect(requests[1].history).not.toContain('ham');
    expect(requests[0].tools).toEqual(['act']);
    // The viewing conversation carries on, and never saw the build.
    expect(requests[2].system).toBe(SYSTEM_PROMPT);
    expect(requests[2].history).toContain('ham');
    expect(requests[2].history).not.toContain('a lap stepper');
    expect(requests[2].history).not.toContain('Building.');
  });

  it('stores the build apart from the viewing conversation', async () => {
    const { agent, script } = setup();
    attach(agent);
    script(fauxAssistantMessage('Viewing.'), fauxAssistantMessage('Building.'));
    await agent.send('ham', 'state', [TOOL]);
    await agent.send('a lap stepper', 'state', [TOOL], '', 'build');
    expect(sessions('sessions')).toHaveLength(1);
    expect(sessions('sessions')[0]).not.toContain('a lap stepper');
    expect(sessions('build-sessions')).toHaveLength(1);
    expect(sessions('build-sessions')[0]).toContain('a lap stepper');
  });

  it('starts a new build conversation after leaving, and leaves the viewing one alone', async () => {
    const { agent, requests, script } = setup();
    attach(agent);
    script(fauxAssistantMessage('one'), fauxAssistantMessage('v'), fauxAssistantMessage('two'), fauxAssistantMessage('v2'));
    await agent.send('first build', 'state', [TOOL], '', 'build');
    await agent.send('view', 'state', [TOOL]);
    await agent.endBuild();
    await agent.send('second build', 'state', [TOOL], '', 'build');
    await agent.send('view again', 'state', [TOOL]);
    expect(requests[2].history).not.toContain('first build');
    expect(requests[3].history).toContain('view');
    expect(sessions('build-sessions')).toHaveLength(2);
  });

  it('writes, edits and deletes inside the mods folder, and says what it did', async () => {
    const { agent, requests, script } = setup();
    attach(agent);
    script(
      fauxAssistantMessage([fauxToolCall('write', { path: 'lap_stepper/main.tsx', content: 'const a = 1;' })]),
      fauxAssistantMessage([fauxToolCall('edit', { path: 'lap_stepper/main.tsx', edits: [{ oldText: 'a = 1', newText: 'a = 2' }] })]),
      fauxAssistantMessage([fauxToolCall('read', { path: 'lap_stepper/main.tsx' })]),
      fauxAssistantMessage([fauxToolCall('mod_status', { mod: 'lap_stepper' })]),
      fauxAssistantMessage([fauxToolCall('delete_path', { path: 'lap_stepper' })]),
      fauxAssistantMessage('Done.'),
    );
    await agent.send('build it', 'state', [], '', 'build');
    expect(requests[1].history).toContain('lap_stepper loaded.');
    expect(requests[3].history).toContain('const a = 2;');
    expect(requests[4].history).toContain('drew');
    expect(existsSync(path.join(modsDir(), 'lap_stepper'))).toBe(false);
    expect(notes()).toEqual(['wrote lap_stepper/main.tsx · loaded', 'edited lap_stepper/main.tsx · loaded', 'removed lap_stepper']);
    expect(events().at(-1)).toMatchObject({ type: 'turn_end', acted: true });
  });

  it('refuses paths outside the mods folder, and files the app owns', async () => {
    const { agent, requests, script } = setup();
    attach(agent);
    writeFileSync(path.join(host.userData, 'secret.txt'), 'TOKEN');
    const tries = [
      fauxToolCall('read', { path: '../secret.txt' }),
      fauxToolCall('write', { path: '../escape/main.tsx', content: 'x' }),
      fauxToolCall('write', { path: '/tmp/f1a-escape.txt', content: 'x' }),
      fauxToolCall('write', { path: 'tsconfig.json', content: 'x' }),
      fauxToolCall('write', { path: '.types/a.d.ts', content: 'x' }),
      fauxToolCall('write', { path: 'a_mod/mod.log', content: 'x' }),
      fauxToolCall('write', { path: 'Bad Name/main.tsx', content: 'x' }),
      fauxToolCall('delete_path', { path: '.' }),
    ];
    script(...tries.map((call) => fauxAssistantMessage([call])), fauxAssistantMessage('Done.'));
    await agent.send('go', 'state', [], '', 'build');
    const history = requests.at(-1)!.history;
    expect(history).not.toContain('TOKEN');
    expect(history.match(/outside the mods folder/g)).toHaveLength(3);
    expect(existsSync(path.join(host.userData, 'escape'))).toBe(false);
    expect(existsSync('/tmp/f1a-escape.txt')).toBe(false);
    expect(readdirSync(modsDir())).toEqual([]);
    expect(notes()).toEqual([]);
  });

  describe('before a build turn ends', () => {
    it('sends the agent on when something is not drawing, and ends once it is', async () => {
      const { agent, requests, script } = setup();
      attach(agent);
      screen = [[threw], []];
      script(fauxAssistantMessage('Done.'), fauxAssistantMessage('Fixed.'));
      await agent.send('build it', 'state', [], '', 'build');
      expect(requests).toHaveLength(2);
      expect(requests[0].history).not.toContain('not drawing');
      expect(requests[1].history).toContain("Before you finish, these aren't drawing:");
      expect(requests[1].history).toContain('Tile tile-1 \\"Pace HAM\\" (pace): render error: lap is undefined. Fix the code.');
      expect(types().filter((t) => t === 'turn_end')).toHaveLength(1);
      expect(types().at(-1)).toBe('turn_end');
      expect(events().filter((e) => e.type === 'text_delta').map((e) => e.delta).join('')).toBe('Done.Fixed.');
    });

    it('ends the turn at once when everything draws, or the app cannot say', async () => {
      const { agent, requests, script } = setup();
      attach(agent);
      script(fauxAssistantMessage('Done.'), fauxAssistantMessage('Again.'));
      await agent.send('build it', 'state', [], '', 'build');
      expect(requests).toHaveLength(1);
      screen = [null];
      await agent.send('and again', 'state', [], '', 'build');
      expect(requests).toHaveLength(2);
    });

    it('says the same problems only once: the agent may need the user to fix them', async () => {
      const { agent, requests, script } = setup();
      attach(agent);
      screen = [[needsDriver]];
      script(fauxAssistantMessage('Built pace.'), fauxAssistantMessage('Whose pace?'), fauxAssistantMessage('Still need a driver.'));
      await agent.send('build pace', 'state', [], '', 'build');
      expect(requests).toHaveLength(2);
      expect(requests[1].history).toContain('Draft pace in the strip: needs driver. Call suggest_tiles with it and its props, or ask the user whose.');
      // The next message: the same problem is on screen, and the agent already knows.
      await agent.send('hmm', 'state', [], '', 'build');
      expect(requests).toHaveLength(3);
    });

    it("doesn't say again what a save's result just said", async () => {
      const { agent, requests, script } = setup();
      attach(agent);
      screen = [[place({ scope: 'preview:lap_stepper', where: 'strip', type: 'lap_stepper', state: 'needs_props', missing: ['driver'], message: 'Needs driver' })]];
      script(fauxAssistantMessage([fauxToolCall('write', { path: 'lap_stepper/main.tsx', content: 'const a = 1;' })]), fauxAssistantMessage('Whose?'), fauxAssistantMessage('Extra.'));
      await agent.send('build it', 'state', [], '', 'build');
      expect(requests[1].history).toContain('Draft lap_stepper in the strip: needs driver.');
      expect(requests).toHaveLength(2);
    });

    it('says a problem again if it went away and came back', async () => {
      const { agent, requests, script } = setup();
      attach(agent);
      screen = [[threw], [], [], [threw], []];
      script(fauxAssistantMessage('1'), fauxAssistantMessage('2'), fauxAssistantMessage('3'), fauxAssistantMessage('4'), fauxAssistantMessage('5'));
      await agent.send('build it', 'state', [], '', 'build');
      expect(requests).toHaveLength(2);
      await agent.send('more', 'state', [], '', 'build');
      expect(requests).toHaveLength(3);
      await agent.send('and more', 'state', [], '', 'build');
      expect(requests).toHaveLength(5);
    });

    it('sends the agent on at most twice for one message, however the problems change', async () => {
      const { agent, requests, script } = setup();
      attach(agent);
      screen = [[threw], [place({ state: 'error', message: 'another' })], [place({ state: 'error', message: 'a third' })]];
      script(fauxAssistantMessage('1'), fauxAssistantMessage('2'), fauxAssistantMessage('3'), fauxAssistantMessage('4'));
      await agent.send('build it', 'state', [], '', 'build');
      expect(requests).toHaveLength(3);
      expect(types().filter((t) => t === 'turn_end')).toHaveLength(1);
    });

    it('never looks for the viewing agent', async () => {
      const { agent, requests, script } = setup();
      attach(agent);
      screen = [[threw]];
      script(fauxAssistantMessage('Hello.'), fauxAssistantMessage('Extra.'));
      await agent.send('hi', 'state', [TOOL]);
      expect(requests).toHaveLength(1);
      expect(asked).toBe(0);
    });

    it('tells a save what of that mod is not drawing, and mod_status where it shows', async () => {
      const { agent, requests, script } = setup();
      attach(agent);
      const draft = place({ scope: 'preview:lap_stepper', where: 'strip', type: 'lap_stepper', state: 'needs_props', missing: ['driver'], message: 'Needs driver' });
      screen = [[draft, threw]];
      script(
        fauxAssistantMessage([fauxToolCall('write', { path: 'lap_stepper/main.tsx', content: 'const a = 1;' })]),
        fauxAssistantMessage([fauxToolCall('mod_status', { mod: 'lap_stepper' })]),
        fauxAssistantMessage('Whose?'),
        fauxAssistantMessage('Still whose?'),
      );
      await agent.send('build it', 'state', [], '', 'build');
      expect(requests[1].history).toContain('lap_stepper loaded. Draft lap_stepper in the strip: needs driver.');
      // Another mod's trouble isn't a save's to report.
      expect(requests[1].history).not.toContain('lap is undefined');
      expect(requests[2].history).toContain('On screen:\\nDraft lap_stepper in the strip: needs driver.');
      expect(notes()).toEqual(['wrote lap_stepper/main.tsx · loaded · not drawing']);
    });
  });

  it('shows the build agent a picture of a draft', async () => {
    const { agent, requests, script } = setup();
    attach(agent, Buffer.from('PNGDATA'));
    script(fauxAssistantMessage([fauxToolCall('look_at', { mod: 'lap_stepper' })]), fauxAssistantMessage('Looks right.'));
    await agent.send('check it', 'state', [], '', 'build');
    expect(requests[1].history).toContain(Buffer.from('PNGDATA').toString('base64'));
    expect(notes()).toEqual(['looked at lap_stepper']);
  });

  it('keeps what a build read out of later build turns only by ending: nothing is collapsed', async () => {
    const { agent, requests, script } = setup();
    attach(agent);
    host.onToolCall = (call) => agent.onToolResult({ callId: (call as AgentToolCall).callId, ok: true, content: 'WHOLE SESSION ROWS', pastPlayhead: true });
    script(fauxAssistantMessage([fauxToolCall('act', { n: 1 })]), fauxAssistantMessage('Built.'), fauxAssistantMessage('ok'), fauxAssistantMessage('view'));
    await agent.send('build', 'state', [TOOL], '', 'build');
    await agent.send('more', 'state', [TOOL], '', 'build');
    expect(requests[2].history).toContain('WHOLE SESSION ROWS');
    await agent.endBuild();
    await agent.send('ham', 'state', [TOOL]);
    expect(requests[3].history).not.toContain('WHOLE SESSION ROWS');
    expect(requests[3].history).not.toContain('Built.');
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
    const agent = new Agent();
    agent.useSettings({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
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
    expect(savedSettings()).toEqual({ provider: 'openai', model: 'gpt-6.1-terra', thinking: 'high' });
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
    expect(savedSettings()).toBeUndefined();
  });

  it('switches provider: removes the old one only after the new one connects, with its recommended settings', async () => {
    const { agent, credentials, ops } = setup();
    const status = await agent.connect('anthropic', 'api_key');
    expect(ops).toEqual(['login anthropic', 'logout openai']);
    expect([...credentials]).toEqual([['anthropic', 'api_key']]);
    expect(status).toMatchObject({ ready: true, provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'medium' });
    expect(savedSettings()).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'medium' });
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
      .map((line) => JSON.parse(line) as { type: string; id: string; customType?: string; message?: Message });
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
    expect(entries(files()[0]).slice(1, 3).map((e) => e.type)).toEqual(['model_change', 'thinking_level_change']);
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

  it('records a cut-down turn, and keeps what the turn read', async () => {
    const { agent, script } = setup();
    host.onToolCall = (call) => agent.onToolResult({ callId: (call as AgentToolCall).callId, ok: true, content: 'SECRET ROWS', pastPlayhead: true });
    script(fauxAssistantMessage([fauxToolCall('act', { n: 1 })]), fauxAssistantMessage('Jumped to lap 30.'));
    await agent.send('go', 'state', [TOOL]);
    expect(stored(files()[0])).toEqual(['user: <app_state>\nstate\n</app_state>\n\ngo', 'assistant: ', 'toolResult: SECRET ROWS', 'assistant: Jumped to lap 30.']);
    expect(entries(files()[0]).at(-1)).toMatchObject({ type: 'custom', customType: 'f1a.forget' });
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

describe('its settings', () => {
  it('come from the renderer, and anything they get wrong is left out', async () => {
    const agent = new Agent();
    agent.useSettings({ provider: 'openai', model: 7, thinking: 'loud', compaction: { enabled: false, reserveTokens: -1 }, extra: 1 });
    expect(await agent.status()).toMatchObject({ ready: false });
    expect(readdirSync(host.userData)).toEqual([]);
  });
});
