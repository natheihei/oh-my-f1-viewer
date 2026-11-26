import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation as DurableConversation, Harness } from '@earendil-works/pi-durable';
import type { AgentEvent, AgentToolCall, AgentToolDefinition } from '../../shared/api';
import { BUILD_PROMPT } from '../../shared/buildPrompt';
import type { PlaceHealth } from '../../shared/health';
import { PICK_PROMPT, VIEW_PROMPT } from '../../shared/viewPrompt';
import { EXAMPLE_CUSTOM_MODELS } from '../../shared/customModels';
import { RECOMMENDED } from './supported';

const host = vi.hoisted(() => ({
  userData: '',
  events: [] as unknown[],
  /** Everything sent to the renderer, on any channel. */
  sent: [] as unknown[],
  onToolCall: (_call: unknown): void => {},
  askForKey: (_title: string, _message: string, _signal: AbortSignal): Promise<string> => Promise.resolve('sk-test-key'),
  askForPrompt: (_title: string, _prompt: unknown, _signal: AbortSignal): Promise<string> => Promise.resolve('prompt-answer'),
  keyTitles: [] as string[],
  prompts: [] as { title: string; prompt: unknown }[],
  /** What the shell was asked to open or show, and what opening answers: '' when something opened it. */
  shell: [] as string[],
  openPath: '',
}));

vi.mock('electron', () => ({
  app: { getPath: () => host.userData },
  shell: {
    openExternal: async (url: string) => void host.shell.push(`external ${url}`),
    openPath: async (file: string) => {
      host.shell.push(`open ${file}`);
      return host.openPath;
    },
    showItemInFolder: (file: string) => void host.shell.push(`show ${file}`),
  },
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
  askForPrompt: (title: string, prompt: unknown, signal: AbortSignal) => {
    host.prompts.push({ title, prompt });
    return host.askForPrompt(title, prompt, signal);
  },
}));

const { Agent, KEPT_CONVERSATIONS, pruneConversations } = await import('./agent');
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
/** The stored conversations of one kind, oldest first: one database each. */
const conversationsDir = () => path.join(host.userData, 'conversations');
const conversationFiles = (kind: 'pick' | 'view' | 'build') =>
  existsSync(conversationsDir()) ? readdirSync(conversationsDir()).filter((f) => f.endsWith(`_${kind}.sqlite`)).sort() : [];
type StoredEntry = { kind: string; model?: Message[]; edits?: unknown[] };
/** A stored conversation's entries, in order. */
function records(file: string): StoredEntry[] {
  const db = new DatabaseSync(path.join(conversationsDir(), file), { readOnly: true });
  try {
    return (db.prepare('SELECT record FROM entries ORDER BY id').all() as { record: string }[]).map((row) => JSON.parse(row.record) as StoredEntry);
  } finally {
    db.close();
  }
}
/** Its messages, as "role: text", without the system ones. */
const stored = (file: string) =>
  records(file).flatMap((r) => (r.model ?? []).filter((m) => m.role !== 'system').map((m) => `${m.role}: ${text(m.content)}`));

/** The app's settings file, in memory, with what the agent wrote to it. */
function memoryStore(agent: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>([['agent', agent]]);
  const written: unknown[] = [];
  return {
    written,
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value);
      if (key === 'agent') written.push(value);
    },
  };
}
let store = memoryStore();
/** The settings the agent last wrote, if it changed any. */
const savedSettings = () => store.written.at(-1);

const modelsFile = () => path.join(host.userData, 'models.json');
/** Saves models.json as an editor would: `value` as it is when it's text, else as JSON. */
const writeModels = (value: unknown) => writeFileSync(modelsFile(), typeof value === 'string' ? value : JSON.stringify(value, null, 2));

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
    /** More of the settings, such as compaction. `custom` is not one: it's written to models.json, as text or as JSON. */
    settings?: Record<string, unknown>;
  } = {},
) {
  const { custom: models, ...settings } = options.settings ?? {};
  if (models !== undefined) writeModels(models);
  const faux = fauxProvider({
    provider: 'openai',
    models: [
      { id: 'gpt-6-luna', reasoning: true },
      { id: 'gpt-6.1-terra', reasoning: true },
    ],
  });
  // Give the faux openai provider the same auth ways as the real one so OAuth & API-key tests work without network.
  const fauxWithAuth = {
    ...faux.provider,
    name: 'OpenAI',
    auth: {
      ...faux.provider.auth,
      apiKey: faux.provider.auth.apiKey
        ? { ...faux.provider.auth.apiKey, login: async () => ({ type: 'api_key' as const, key: 'test' }) }
        : undefined,
      oauth: {
        name: 'OpenAI (ChatGPT subscription)',
        loginLabel: 'Sign in with ChatGPT',
        login: async () => ({ type: 'oauth' as const, access: 'test', refresh: '', expires: Number.MAX_SAFE_INTEGER }),
        refresh: async (c: unknown) => c as never,
        toAuth: async () => ({ apiKey: 'test' }),
      },
    },
  };
  const credentials = new Map<string, Way>(options.credentials ?? [['openai', 'oauth']]);
  const ops: string[] = [];
  const requests: Request[] = [];
  store = memoryStore({ provider: options.provider ?? 'openai', model: options.model ?? 'gpt-6-luna', thinking: options.thinking ?? 'medium', ...settings });
  const agent = new Agent((providers) => {
    providers.setProvider(fauxWithAuth as never);
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
  }, store);
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
  host.userData = mkdtempSync(path.join(os.tmpdir(), 'omfv-agent-test-'));
  host.events.length = 0;
  host.sent.length = 0;
  host.keyTitles.length = 0;
  host.prompts.length = 0;
  host.shell.length = 0;
  host.openPath = '';
  host.onToolCall = () => {};
  host.askForKey = () => Promise.resolve('sk-test-key');
  host.askForPrompt = () => Promise.resolve('prompt-answer');
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

  // A conversation's watch starts with only its newest 50 entries, and the end of a turn reads the newest 100.
  it('passes on only its own reply in a long conversation', async () => {
    const { agent, script } = setup();
    answerTools(agent);
    const turns = 30;
    script(
      ...Array.from({ length: turns }, (_, i) => [fauxAssistantMessage([fauxToolCall('act', { n: i })]), fauxAssistantMessage(`Reply ${i}.`)]).flat(),
      fauxAssistantMessage('The newest.'),
    );
    for (let i = 0; i < turns; i += 1) await agent.send(`message ${i}`, 'state', [TOOL]);
    host.events.length = 0;
    await agent.send('one more', 'state', [TOOL]);
    expect(said()).toBe('The newest.');
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
    expect(requests[0].system).toBe(`${VIEW_PROMPT}\n\nTHE REFERENCE`);
    expect(requests[0].tools).toEqual(['act']);
  });

  it('is the viewing prompt alone without a reference', async () => {
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('ok'));
    await agent.send('hi', 'state', [TOOL]);
    expect(requests[0].system).toBe(VIEW_PROMPT);
  });

  it('follows the reference as it changes, keeping the tools', async () => {
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('one'));
    await agent.send('a', 'state', [TOOL], 'FIRST');
    script(fauxAssistantMessage('two'));
    await agent.send('b', 'state', [TOOL], 'SECOND');
    expect(requests[1].system).toBe(`${VIEW_PROMPT}\n\nSECOND`);
    expect(requests[1].tools).toEqual(['act']);
  });

  it('never treats viewer text as a template', async () => {
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('ok'));
    await agent.send('/compact now', 'state', [TOOL]);
    expect(requests[0].lastUser).toContain('/compact now');
  });
});

describe('picking and viewing', () => {
  const OPEN: AgentToolDefinition = { ...TOOL, name: 'open' };
  const VIEW_TOOL: AgentToolDefinition = { ...TOOL, name: 'view' };
  /** The renderer answering every call, with `open` opening a session for the scope `scope`. */
  function answerOpening(agent: InstanceType<typeof Agent>, scope = 'view-1') {
    const calls: AgentToolCall[] = [];
    host.onToolCall = (raw) => {
      const call = raw as AgentToolCall;
      calls.push(call);
      const handoff = { mode: 'view' as const, scope, appState: `session: ${scope}`, reference: 'EVENTS AND CHARTS', tools: [OPEN, VIEW_TOOL] };
      agent.onToolResult({ callId: call.callId, ok: true, content: 'Opened.', ...(call.name === 'open' ? { handoff } : {}) });
    };
    return calls;
  }

  it('picks with its own prompt, in a conversation of its own', async () => {
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('Which one?'), fauxAssistantMessage('ok'));
    await agent.send('mexico', 'session: none open', [OPEN], 'EVENTS', 'pick', 'pick');
    await agent.send('the race', 'session: none open', [OPEN], 'EVENTS', 'pick', 'pick');
    expect(requests[0].system).toBe(`${PICK_PROMPT}\n\nEVENTS`);
    expect(requests[1].history).toContain('Which one?');
    expect(conversationFiles('pick')).toHaveLength(1);
  });

  it('answers the message again in a new viewing conversation once a call opens a session', async () => {
    const { agent, requests, script } = setup();
    const calls = answerOpening(agent);
    script(fauxAssistantMessage([{ type: 'text', text: 'Opening. ' }, fauxToolCall('open', { n: 1 })]), fauxAssistantMessage('Suggested Norris.'));
    await agent.send('mexico with norris', 'session: none open', [OPEN], 'EVENTS', 'pick', 'pick');
    expect(calls.map((c) => c.name)).toEqual(['open']);
    expect(requests).toHaveLength(2);
    expect(requests[1].system).toBe(`${VIEW_PROMPT}\n\nEVENTS AND CHARTS`);
    expect(requests[1].tools).toEqual(['open', 'view']);
    expect(requests[1].roles.filter((r) => r !== 'system')).toEqual(['user']);
    expect(requests[1].lastUser).toBe('<app_state>\nsession: view-1\n</app_state>\n\nmexico with norris');
    expect(said()).toBe('Opening. Suggested Norris.');
    expect(types().filter((t) => t === 'turn_start' || t === 'turn_end')).toEqual(['turn_start', 'turn_end']);
    expect(events().at(-1)).toMatchObject({ type: 'turn_end', acted: true });
    expect(conversationFiles('pick')).toHaveLength(1);
    expect(conversationFiles('view')).toHaveLength(1);
  });

  it('runs nothing more of the round that opened a session', async () => {
    const { agent, requests, script } = setup();
    const calls = answerOpening(agent);
    script(fauxAssistantMessage([fauxToolCall('open', { n: 1 }), fauxToolCall('act', { n: 2 })]), fauxAssistantMessage('Done.'));
    await agent.send('go', 'state', [OPEN, TOOL], '', 'pick', 'pick');
    expect(calls.map((c) => c.name)).toEqual(['open']);
    expect(requests).toHaveLength(2);
    expect(said()).toBe('Done.');
  });

  it('keeps one viewing conversation per opening of a session, and starts afresh for the next', async () => {
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('one'), fauxAssistantMessage('two'), fauxAssistantMessage('three'), fauxAssistantMessage('four'));
    await agent.send('a', 'state', [TOOL], '', 'view', 'view-1');
    await agent.send('b', 'state', [TOOL], '', 'view', 'view-1');
    await agent.send('c', 'state', [TOOL], '', 'view', 'view-2');
    await agent.send('d', 'state', [TOOL], '', 'pick', 'pick');
    expect(requests[1].history).toContain('one');
    expect(requests[2].history).not.toContain('one');
    expect(requests[3].history).not.toContain('three');
    expect(requests[3].system).toBe(PICK_PROMPT);
    expect(conversationFiles('view')).toHaveLength(2);
    expect(conversationFiles('pick')).toHaveLength(1);
  });

  it('hands one message on at most twice', async () => {
    const { agent, requests, script } = setup();
    let opened = 0;
    host.onToolCall = (raw) => {
      const call = raw as AgentToolCall;
      opened += 1;
      const handoff = { mode: 'view' as const, scope: `view-${opened}`, appState: 'state', reference: '', tools: [OPEN] };
      agent.onToolResult({ callId: call.callId, ok: true, content: 'Opened.', handoff });
    };
    script(...[1, 2, 3, 4].map((n) => fauxAssistantMessage([fauxToolCall('open', { n })])), fauxAssistantMessage('never'));
    await agent.send('go', 'state', [OPEN], '', 'pick', 'pick');
    expect(requests).toHaveLength(3);
    expect(events().at(-1)).toMatchObject({ type: 'turn_end' });
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
    expect(requests[2].system).toBe(`${VIEW_PROMPT}\n\nTHE REFERENCE`);
    expect(requests[2].tools).toEqual(['act']);
  });

  it('cuts a read ahead it failed to cut before the next message', async () => {
    const { agent, requests, script } = setup();
    answerReadAhead(agent);
    vi.spyOn(agent as unknown as { forget(): Promise<void> }, 'forget').mockRejectedValueOnce(new Error('disk full'));
    script(...readAhead(), fauxAssistantMessage('ok'));
    await agent.send('go', 'state', [TOOL]);
    await agent.send('next', 'state', [TOOL]);
    expect(requests[2].history).not.toContain('SECRET ROWS');
    expect(requests[2].history).toContain('Jumped to lap 30.');
    expect(requests[2].history).toContain('<app_note>');
  });

  it('starts over when a read ahead still cannot be cut', async () => {
    const { agent, requests, script } = setup();
    answerReadAhead(agent);
    vi.spyOn(agent as unknown as { forget(): Promise<void> }, 'forget').mockRejectedValue(new Error('disk full'));
    script(...readAhead(), fauxAssistantMessage('ok'));
    await agent.send('go', 'state', [TOOL]);
    await agent.send('next', 'state', [TOOL]);
    expect(requests[2].history).not.toContain('SECRET ROWS');
    expect(requests[2].history).not.toContain('Jumped to lap 30.');
    expect(requests[2].roles.filter((r) => r !== 'system')).toEqual(['user']);
    expect(types()).not.toContain('error');
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
  const sessions = (kind: 'view' | 'build') => conversationFiles(kind).map((f) => stored(f).join('\n'));
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
    expect(requests[2].system).toBe(VIEW_PROMPT);
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
    expect(sessions('view')).toHaveLength(1);
    expect(sessions('view')[0]).not.toContain('a lap stepper');
    expect(sessions('build')).toHaveLength(1);
    expect(sessions('build')[0]).toContain('a lap stepper');
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
    expect(sessions('build')).toHaveLength(2);
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
      fauxToolCall('write', { path: '/tmp/omfv-escape.txt', content: 'x' }),
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
    expect(existsSync('/tmp/omfv-escape.txt')).toBe(false);
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
    expect(events().at(-1)).toMatchObject({ type: 'error', message: 'OpenAI usage limit reached.', fix: 'limit' });
    host.events.length = 0;
    script(fauxAssistantMessage('Fine now.'));
    await agent.send('again', 'state', [TOOL]);
    expect(said()).toBe('Fine now.');
    expect(events().at(-1)).toMatchObject({ type: 'turn_end' });
  });

  it('refuses when not set up, even with the chosen provider set up in the environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'not-a-real-key');
    vi.stubEnv('GEMINI_API_KEY', 'not-a-real-key');
    vi.stubEnv('OPENROUTER_API_KEY', 'not-a-real-key');
    vi.stubEnv('OPENCODE_API_KEY', 'not-a-real-key');
    for (const [provider, model] of [
      ['anthropic', 'claude-sonnet-5-5'],
      ['google', 'gemini-4-hydrogen'],
      ['openrouter', 'openai/gpt-6.1-terra'],
      ['opencode-go', 'qwen4-max'],
    ]) {
      host.events.length = 0;
      const agent = new Agent(undefined, memoryStore({ provider, model }));
      await agent.send('go', 'state', [TOOL]);
      expect(events().map((e) => e.type)).toEqual(['turn_start', 'error']);
      expect(events().at(-1)).toMatchObject({ message: "The agent isn't set up yet.", fix: 'setup' });
      expect(await agent.status()).toMatchObject({ ready: false });
    }
  });

  it('maps Gemini invalid-key and quota errors to their fixes', async () => {
    const { agent, script } = setup();
    script(fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'API key not valid. Please pass a valid API key. (API_KEY_INVALID)' }));
    await agent.send('go', 'state', [TOOL]);
    expect(events().at(-1)).toMatchObject({ type: 'error', message: "OpenAI didn't accept the connection.", fix: 'connect' });

    host.events.length = 0;
    script(fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429 RESOURCE_EXHAUSTED: quota exceeded' }));
    await agent.send('again', 'state', [TOOL]);
    expect(events().at(-1)).toMatchObject({ type: 'error', message: 'OpenAI usage limit reached.', fix: 'limit' });
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

  it('counts only the provider in settings, connected a way the provider offers', async () => {
    expect(await setup({ provider: 'anthropic' }).agent.status()).toMatchObject({ ready: false });
    const oauthGoogle = setup({ provider: 'google', model: 'gemini-4-hydrogen', credentials: [['google', 'oauth']] });
    expect(await oauthGoogle.agent.status()).toMatchObject({ ready: false });
  });

  it('lists all built-in pi providers in alphabetical order with their models, ways to connect and optional recommended defaults', async () => {
    const { agent } = setup();
    const list = await agent.providers();
    // Built-in providers stay in alphabetical order by label (never re-ordered to put recommended first).
    expect(list.map((p) => p.label)).toEqual([...list.map((p) => p.label)].sort((a, b) => a.localeCompare(b)));
    expect(list.length).toBeGreaterThan(20);
    const byId = (id: string) => list.find((p) => p.id === id)!;
    const openai = byId('openai');
    const anthropic = byId('anthropic');
    const google = byId('google');
    const openrouter = byId('openrouter');
    const opencodeGo = byId('opencode-go');

    expect(openai.connected).toMatchObject({ way: 'oauth' });
    // The faux provider stands in for OpenAI, so only its two models exist, kept in alphabetical order.
    expect(openai.models.map((m) => m.id)).toEqual(['gpt-6-luna', 'gpt-6.1-terra']);
    expect(openai.recommended).toEqual({ model: 'gpt-6.1-terra', thinking: 'medium' });

    expect(anthropic.connected).toBeNull();
    expect(anthropic.ways.map((w) => w.way)).toEqual(['oauth', 'api_key']);
    expect(anthropic.models.map((m) => m.id)).toContain('claude-sonnet-5-5');
    expect(anthropic.recommended).toBeUndefined();

    expect(google.label).toBe('Google');
    expect(google.ways.map((w) => w.way)).toEqual(['api_key']);
    expect(google.models.map((m) => m.id)).toContain('gemini-4-neon');
    expect(google.recommended).toBeUndefined();

    expect(openrouter.label).toBe('OpenRouter');
    expect(openrouter.ways.map((w) => w.way)).toEqual(['oauth', 'api_key']);
    expect(openrouter.models.map((m) => m.id)).toContain('google/gemini-4-neon');
    expect(openrouter.recommended).toBeUndefined();

    expect(opencodeGo.label).toBe('OpenCode Go');
    expect(opencodeGo.ways.map((w) => w.way)).toEqual(['api_key']);
    expect(opencodeGo.models.map((m) => m.id)).toContain('qwen4-max');
    expect(opencodeGo.recommended).toBeUndefined();

    // Providers with no chat models (e.g. classifier-only TypeSafe) are omitted.
    expect(list.find((p) => p.id === 'typesafe')).toBeUndefined();
  });

  it('exposes every built-in pi-ai provider and chat model, with valid RECOMMENDED defaults', async () => {
    const { builtinModels } = await import('@earendil-works/pi-ai/providers/all');
    const catalog = builtinModels();
    const expectedIds = catalog
      .getProviders()
      .filter((p) => catalog.getModels(p.id).length > 0 && (p.auth.oauth || p.auth.apiKey?.login))
      .map((p) => p.id)
      .sort();

    const agent = new Agent(undefined, memoryStore());
    const list = await agent.providers();
    expect(list.map((p) => p.id).sort()).toEqual(expectedIds);
    for (const option of list) {
      const catalogSorted = [...catalog.getModels(option.id)]
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .map((m) => m.id);
      expect(option.models.map((m) => m.id), option.id).toEqual(catalogSorted);
      const rec = RECOMMENDED[option.id];
      if (rec) {
        expect(option.recommended).toEqual(rec);
        const recModel = option.models.find((m) => m.id === rec.model);
        expect(recModel, `${option.id} recommended model`).toBeDefined();
        expect(recModel!.thinking).toContain(rec.thinking);
      } else {
        expect(option.recommended).toBeUndefined();
      }
    }
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

  it('refuses a model the provider does not offer', async () => {
    const { agent } = setup();
    await expect(agent.choose('gpt-4', 'medium')).rejects.toThrow(/isn't offered/);
    expect(savedSettings()).toBeUndefined();
  });

  it('switches to a provider without a recommended model: removes the old one, shows it connected, and waits for a model choice', async () => {
    const { agent, credentials, ops } = setup();
    const status = await agent.connect('anthropic', 'api_key');
    expect(ops).toEqual(['login anthropic', 'logout openai']);
    expect([...credentials]).toEqual([['anthropic', 'api_key']]);
    expect(status).toMatchObject({ ready: false });
    expect(savedSettings()).toEqual({ provider: 'anthropic' });
    expect((await agent.providers()).find((p) => p.id === 'anthropic')?.connected).toEqual({ way: 'api_key', label: 'API key' });

    await agent.send('hi', 'state', [TOOL]);
    expect(events().at(-1)).toMatchObject({ type: 'error', message: 'Choose a model for Anthropic in /settings-agent.', fix: 'setup' });

    expect(await agent.choose('claude-sonnet-5-5', 'medium')).toMatchObject({
      ready: true,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      thinking: 'medium',
    });
    expect(savedSettings()).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'medium' });
  });

  it('connects Google, OpenRouter and OpenCode Go and lets the viewer pick any catalog model', async () => {
    const { agent, credentials } = setup();
    expect(await agent.connect('google', 'api_key')).toMatchObject({ ready: false });
    expect(host.keyTitles.at(-1)).toBe('Google API key');
    expect(await agent.choose('gemini-4-neon', 'high')).toMatchObject({ ready: true, provider: 'google', model: 'gemini-4-neon', thinking: 'high' });

    expect(await agent.connect('openrouter', 'oauth')).toMatchObject({ ready: false });
    expect([...credentials]).toEqual([['openrouter', 'oauth']]);
    expect(await agent.choose('google/gemini-4-neon', 'medium')).toMatchObject({ ready: true, provider: 'openrouter', model: 'google/gemini-4-neon', thinking: 'medium' });

    expect(await agent.connect('opencode-go', 'api_key')).toMatchObject({ ready: false });
    expect(host.keyTitles.at(-1)).toBe('OpenCode Go API key');
    expect(await agent.choose('qwen4-max', 'medium')).toMatchObject({ ready: true, provider: 'opencode-go', model: 'qwen4-max', thinking: 'medium' });

    await expect(agent.connect('google', 'oauth')).rejects.toThrow();
    await expect(agent.connect('opencode-go', 'oauth')).rejects.toThrow();
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

  it('refuses a way the provider does not offer', async () => {
    const { agent, ops } = setup();
    await expect(agent.connect('google', 'oauth')).rejects.toThrow();
    expect(ops).toEqual([]);
  });

  it('needs setting up again after disconnecting', async () => {
    const { agent, credentials } = setup();
    await agent.disconnect();
    expect([...credentials]).toEqual([]);
    expect(await agent.status()).toMatchObject({ ready: false });
  });
});

describe('models from Advanced', () => {
  /** A local OpenAI-compatible server, like Ollama's: it streams one reply and records each request. */
  async function localServer(reply = 'Hello from a local model.') {
    const requests: { url: string; headers: IncomingHttpHeaders; body: { model: string; messages: { role: string }[]; tools?: unknown[] } }[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        requests.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.end(chunk({ role: 'assistant', content: reply }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    return { baseUrl, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  const custom = (baseUrl: string, extra: Record<string, unknown> = {}) => ({
    providers: {
      ollama: {
        name: 'Ollama',
        baseUrl,
        api: 'openai-completions',
        models: [
          { id: 'qwen3:14b', name: 'Qwen3 14B', reasoning: true },
          { id: 'llama3.2', name: 'Llama 3.2' },
        ],
        ...extra,
      },
    },
  });

  it('lists each provider it sets up after the built-in ones, with its models and thinking levels', async () => {
    const { agent } = setup({ settings: { custom: custom('http://localhost:11434/v1') } });
    const list = await agent.providers();
    expect(list.at(-1)?.id).toBe('ollama');
    const ollama = list.at(-1)!;
    expect(ollama).toMatchObject({
      label: 'Ollama',
      connected: null,
      custom: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', hasKey: false, active: false },
      ways: [],
    });
    // The app recommends only among the models it ships with.
    expect(ollama.recommended).toBeUndefined();
    expect(ollama.models.map((m) => [m.id, m.name])).toEqual([
      ['qwen3:14b', 'Qwen3 14B'],
      ['llama3.2', 'Llama 3.2'],
    ]);
    expect(ollama.models[0].thinking).toContain('high');
    expect(ollama.models[1].thinking).toEqual(['off']);
    // Setting one up changes nothing until one of its models is chosen.
    expect(await agent.status()).toMatchObject({ ready: true, provider: 'openai' });
  });

  it('answers through a local server once one of its models is chosen, and the supported provider stays connected', async () => {
    const local = await localServer();
    try {
      const { agent, credentials } = setup({ settings: { custom: custom(local.baseUrl) } });
      expect(await agent.choose('qwen3:14b', 'medium', 'ollama')).toMatchObject({ ready: true, provider: 'ollama', model: 'qwen3:14b', modelName: 'Qwen3 14B' });
      expect(savedSettings()).toMatchObject({ provider: 'ollama', model: 'qwen3:14b', thinking: 'medium' });
      await agent.send('who leads?', 'state', [TOOL]);
      expect(types()).toEqual(['turn_start', 'text_delta', 'turn_end']);
      expect(said()).toBe('Hello from a local model.');
      expect(local.requests).toHaveLength(1);
      const [request] = local.requests;
      expect(request.url).toBe('/v1/chat/completions');
      expect(request.body.model).toBe('qwen3:14b');
      expect(request.body.tools).toHaveLength(1);
      // No key is set up, and none from the environment is sent.
      expect(request.headers.authorization).toBe('Bearer omfv-no-key');
      expect([...credentials]).toEqual([['openai', 'oauth']]);
      expect((await agent.providers()).find((p) => p.id === 'ollama')?.custom?.active).toBe(true);
    } finally {
      await local.close();
    }
  });

  it("sends the setup's key, the provider's headers and each model's own, and never a key stored or in the environment", async () => {
    const local = await localServer();
    process.env.OLLAMA_API_KEY = 'sk-from-env';
    try {
      const withKey = { providers: { ollama: { baseUrl: local.baseUrl, apiKey: 'sk-from-setup', headers: { 'x-team': 'f1', 'x-from': 'provider' }, models: [{ id: 'llama3.2', headers: { 'x-from': 'model' } }] } } };
      // A credential left under its id, by an earlier version's key window, is not used.
      const { agent } = setup({ provider: 'ollama', model: 'llama3.2', credentials: [['openai', 'oauth'], ['ollama', 'api_key']], settings: { custom: withKey } });
      const ollama = (await agent.providers()).find((p) => p.id === 'ollama');
      // The panel is told there's a key, never the key.
      expect(ollama?.custom).toEqual({ baseUrl: local.baseUrl, api: 'openai-completions', hasKey: true, active: true });
      await agent.send('hi', 'state', [TOOL]);
      expect(local.requests[0].headers).toMatchObject({ authorization: 'Bearer sk-from-setup', 'x-team': 'f1', 'x-from': 'model' });
      await expect(agent.connect('ollama', 'api_key')).rejects.toThrow("ollama can't be connected that way.");
    } finally {
      delete process.env.OLLAMA_API_KEY;
      await local.close();
    }
  });

  it('reaches each model at the server it names, over the one its provider does', async () => {
    const [shared, own] = [await localServer('From the shared server.'), await localServer('From its own server.')];
    try {
      const mixed = { providers: { ollama: { baseUrl: shared.baseUrl, models: [{ id: 'a' }, { id: 'b', baseUrl: own.baseUrl, api: 'openai-completions' }] } } };
      const { agent } = setup({ provider: 'ollama', model: 'b', settings: { custom: mixed } });
      await agent.send('hi', 'state', [TOOL]);
      expect(said()).toBe('From its own server.');
      expect([shared.requests.length, own.requests.length]).toEqual([0, 1]);
    } finally {
      await Promise.all([shared.close(), own.close()]);
    }
  });

  it('stays set up when a built-in provider connects, and that one takes over', async () => {
    const { agent, credentials, ops } = setup({ provider: 'ollama', model: 'qwen3:14b', settings: { custom: custom('http://localhost:11434/v1') } });
    expect(await agent.connect('anthropic', 'api_key')).toMatchObject({ ready: false });
    expect(ops).toEqual(['login anthropic', 'logout openai']);
    expect([...credentials].map(([id]) => id)).toEqual(['anthropic']);
    expect((await agent.providers()).at(-1)?.id).toBe('ollama');
  });

  it('reads models.json where the app keeps its data, and says what it read without its text', async () => {
    const { agent } = setup();
    const beside = { schema: path.join(host.userData, 'models.schema.json'), example: path.join(host.userData, 'models.example.json') };
    expect(await agent.customModels()).toEqual({ path: modelsFile(), exists: false, ...beside, providers: [], errors: [] });
    // Both are there once Advanced has asked, before any models.json: the copied prompt names them.
    expect(JSON.parse(readFileSync(beside.example, 'utf8'))).toEqual(EXAMPLE_CUSTOM_MODELS);
    expect(JSON.parse(readFileSync(beside.schema, 'utf8')).title).toBe('oh-my-f1-viewer models.json');
    writeModels(custom('http://localhost:11434/v1', { apiKey: 'sk-secret' }));
    expect(await agent.customModels()).toEqual({ path: modelsFile(), exists: true, ...beside, providers: ['Ollama'], errors: [] });
    expect((await agent.providers()).at(-1)?.id).toBe('ollama');
    // Nothing the renderer is given holds the key.
    expect(JSON.stringify([await agent.customModels(), await agent.providers(), await agent.status()])).not.toContain('sk-secret');
    // The file is no part of the settings.
    expect(savedSettings()).toBeUndefined();
  });

  it('uses none of a file with anything wrong in it, and says what', async () => {
    const { agent } = setup({ provider: 'ollama', model: 'qwen3:14b', settings: { custom: custom('not a url') } });
    expect(await agent.status()).toMatchObject({ ready: false });
    expect((await agent.providers()).some((p) => p.id === 'ollama')).toBe(false);
    expect(await agent.customModels()).toMatchObject({ exists: true, providers: [], errors: ['providers.ollama.baseUrl must be an http or https URL, like http://localhost:11434/v1.'] });
    writeModels('{ "providers": { "openai": { "baseUrl": "http://x", "models": [] }, "openrouter": { "baseUrl": "http://x", "models": [{ "id": "m" }] }, "deepseek": { "baseUrl": "http://x", "models": [{ "id": "m" }] } } }');
    expect((await agent.customModels()).errors).toEqual([
      'providers.openai: "openai" is already one of the app\'s providers. Give it another key.',
      'providers.openai.models must list at least one model.',
      'providers.openrouter: "openrouter" is already one of the app\'s providers. Give it another key.',
      'providers.deepseek: "deepseek" is already one of the app\'s providers. Give it another key.',
    ]);
    writeModels('{ "providers": ');
    expect((await agent.customModels()).errors[0]).toMatch(/^It isn't valid JSON: /);
    // Fixed, it's used at the next thing the agent does.
    writeModels(custom('http://localhost:11434/v1'));
    expect(await agent.status()).toMatchObject({ ready: true, provider: 'ollama', model: 'qwen3:14b' });
  });

  it('makes the file from an example named as one and opens it in the editor, with its schema beside it', async () => {
    const { agent } = setup();
    await agent.openCustomModels();
    expect(host.shell).toEqual([`open ${modelsFile()}`]);
    const made = JSON.parse(readFileSync(modelsFile(), 'utf8'));
    expect(made).toMatchObject({ $schema: './models.schema.json', providers: { 'example-ollama': { name: 'Ollama (example)', baseUrl: 'http://localhost:11434/v1' } } });
    expect(await agent.customModels()).toMatchObject({ exists: true, providers: ['Ollama (example)'], errors: [] });
    const schema = JSON.parse(readFileSync(path.join(host.userData, 'models.schema.json'), 'utf8'));
    expect(schema.properties.providers.additionalProperties.properties.models.items.required).toEqual(['id']);
    // A file that's there is opened as it is, and shown in its folder when nothing opens .json files.
    writeModels(custom('http://localhost:1/v1'));
    host.openPath = 'No application is associated with this file';
    await agent.openCustomModels();
    expect(JSON.parse(readFileSync(modelsFile(), 'utf8'))).toEqual(custom('http://localhost:1/v1'));
    expect(host.shell.slice(1)).toEqual([`open ${modelsFile()}`, `show ${modelsFile()}`]);
    agent.revealCustomModels();
    expect(host.shell.at(-1)).toBe(`show ${modelsFile()}`);
  });

  it('takes up a saved file at once, tells the panel, and starts the conversation over when its provider is in use', async () => {
    const local = await localServer();
    try {
      const { agent } = setup({ provider: 'ollama', model: 'qwen3:14b', settings: { custom: custom(local.baseUrl) } });
      await agent.send('one', 'state', [TOOL]);
      const told = () => host.sent.filter((s) => (s as [string])[0] === 'ai:customModels').length;
      // A change the watcher reports with the file as it was is nothing.
      await agent.customModelsChanged();
      expect(told()).toBe(0);
      writeModels(custom(local.baseUrl, { name: 'Ollama, renamed' }));
      await agent.customModelsChanged();
      expect(told()).toBe(1);
      expect((await agent.customModels()).providers).toEqual(['Ollama, renamed']);
      await agent.send('two', 'state', [TOOL]);
      // The second message starts a conversation of its own: the first isn't sent again.
      expect(local.requests.at(-1)?.body.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    } finally {
      await local.close();
    }
  });

  it('chooses nothing in its place when the provider in use is taken out of the file, and says what went', async () => {
    const { agent } = setup({ provider: 'ollama', model: 'qwen3:14b', settings: { custom: custom('http://localhost:11434/v1') } });
    expect(await agent.status()).toMatchObject({ provider: 'ollama' });
    rmSync(modelsFile());
    await agent.customModelsChanged();
    expect(await agent.status()).toMatchObject({ ready: false });
    expect(savedSettings()).toBeUndefined();
    expect((await agent.providers()).some((p) => p.id === 'ollama')).toBe(false);
    await agent.send('hi', 'state', [TOOL]);
    const error = events().find((e) => e.type === 'error') as { message: string; fix?: string } | undefined;
    expect(error).toMatchObject({ message: 'The agent was using "ollama", which is no longer in models.json. Choose a model in /settings-agent.', fix: 'setup' });
  });

  it('chooses no other model when the one in use is taken out of the file, and says which went', async () => {
    const { agent } = setup({ provider: 'ollama', model: 'qwen3:14b', settings: { custom: custom('http://localhost:11434/v1') } });
    writeModels({ providers: { ollama: { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', models: [{ id: 'llama3.2' }] } } });
    await agent.customModelsChanged();
    expect(await agent.status()).toMatchObject({ ready: false });
    await agent.send('hi', 'state', [TOOL]);
    const error = events().find((e) => e.type === 'error') as { message: string; fix?: string } | undefined;
    expect(error).toMatchObject({ message: 'Ollama no longer has the model qwen3:14b. Choose one in /settings-agent.', fix: 'setup' });
    // Choosing one sets the agent up again.
    expect(await agent.choose('llama3.2', 'off', 'ollama')).toMatchObject({ ready: true, provider: 'ollama', model: 'llama3.2' });
  });

  it('says when a local server is not running', async () => {
    const local = await localServer();
    await local.close();
    const { agent } = setup({ provider: 'ollama', model: 'qwen3:14b', settings: { custom: custom(local.baseUrl) } });
    await agent.send('hi', 'state', [TOOL]);
    const error = events().find((e) => e.type === 'error') as { message: string; fix?: string } | undefined;
    expect(error).toMatchObject({ message: `Couldn't reach Ollama at ${local.baseUrl}. Is its server running?`, fix: 'setup' });
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

describe('stored conversations', () => {
  const files = () => conversationFiles('view');

  it('keeps each conversation in a database of its own', async () => {
    const { agent, script } = setup();
    script(fauxAssistantMessage('Hello.'));
    await agent.send('hi', 'state', [TOOL]);
    expect(files()).toHaveLength(1);
    expect(stored(files()[0])).toEqual(['user: <app_state>\nstate\n</app_state>\n\nhi', 'assistant: Hello.']);
    // The prompt as the model got it, for review.
    expect(records(files()[0]).find((r) => r.model?.[0]?.role === 'system')?.model?.[0]?.sections).toEqual({ omfv: VIEW_PROMPT });
  });

  it('adds later turns to the same one', async () => {
    const { agent, script } = setup();
    script(fauxAssistantMessage('one'));
    await agent.send('first', 'state', [TOOL]);
    script(fauxAssistantMessage('two'));
    await agent.send('second', 'state', [TOOL]);
    expect(files()).toHaveLength(1);
    expect(stored(files()[0])).toHaveLength(4);
  });

  it('starts a new one on reset, leaving the old one', async () => {
    const { agent, requests, script } = setup();
    script(fauxAssistantMessage('one'));
    await agent.send('first', 'state', [TOOL]);
    const [first] = files();
    const before = stored(first);
    await agent.reset();
    script(fauxAssistantMessage('two'));
    await agent.send('second', 'state', [TOOL]);
    expect(files()).toHaveLength(2);
    expect(stored(first)).toEqual(before);
    expect(requests[1].roles.filter((r) => r === 'user')).toHaveLength(1);
  });

  it('never resumes a stored conversation after a restart', async () => {
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

  it('keeps what a cut-down turn read, with the edit that cuts it', async () => {
    const { agent, script } = setup();
    host.onToolCall = (call) => agent.onToolResult({ callId: (call as AgentToolCall).callId, ok: true, content: 'SECRET ROWS', pastPlayhead: true });
    script(fauxAssistantMessage([fauxToolCall('act', { n: 1 })]), fauxAssistantMessage('Jumped to lap 30.'));
    await agent.send('go', 'state', [TOOL]);
    expect(stored(files()[0])).toEqual(['user: <app_state>\nstate\n</app_state>\n\ngo', 'assistant: ', 'toolResult: SECRET ROWS', 'assistant: Jumped to lap 30.']);
    expect(records(files()[0]).at(-1)).toMatchObject({ kind: 'omfv.forget' });
  });

  it('keeps only the newest of each kind when a new one starts', async () => {
    mkdirSync(conversationsDir());
    const old = (i: number, kind: string) => `2020-01-01T00-00-${String(i).padStart(3, '0')}Z_${kind}.sqlite`;
    for (let i = 0; i < KEPT_CONVERSATIONS; i++) {
      for (const extra of ['', '-wal', '-shm']) writeFileSync(path.join(conversationsDir(), old(i, 'view') + extra), '');
    }
    writeFileSync(path.join(conversationsDir(), old(0, 'build')), '');
    const { agent, script } = setup();
    script(fauxAssistantMessage('Hello.'));
    await agent.send('hi', 'state', [TOOL]);
    // The oldest view one goes, with its side files; the new one and the other kinds stay.
    expect(files()).toHaveLength(KEPT_CONVERSATIONS);
    expect(files()).not.toContain(old(0, 'view'));
    expect(readdirSync(conversationsDir()).filter((f) => f.startsWith(old(0, 'view')))).toEqual([]);
    expect(files()).toContain(old(1, 'view'));
    expect(stored(files().at(-1)!)).toContain('assistant: Hello.');
    expect(conversationFiles('build')).toEqual([old(0, 'build')]);
  });

  it('prunes nothing it cannot read, and keeps exactly as many as asked', async () => {
    await pruneConversations(conversationsDir(), 'view', 1);
    mkdirSync(conversationsDir());
    for (const name of ['a_view.sqlite', 'b_view.sqlite', 'c_view.sqlite', 'notes.txt']) writeFileSync(path.join(conversationsDir(), name), '');
    await pruneConversations(conversationsDir(), 'view', 2);
    expect(readdirSync(conversationsDir()).sort()).toEqual(['b_view.sqlite', 'c_view.sqlite', 'notes.txt']);
  });

  it('writes nothing until there is a message', async () => {
    await new Agent(undefined, memoryStore()).status();
    expect(existsSync(conversationsDir())).toBe(false);
  });

  it('reports an error, rather than hanging, when the conversation cannot be stored', async () => {
    writeFileSync(conversationsDir(), 'a file where the folder should be');
    const { agent, script } = setup();
    script(fauxAssistantMessage('Not reached.'));
    await agent.send('hi', 'state', [TOOL]);
    expect(events().at(-1)).toMatchObject({ type: 'error' });
  });
});

describe('its settings', () => {
  it('come from the settings file, and anything they get wrong is left out', async () => {
    const agent = new Agent(undefined, memoryStore({ provider: 'openai', model: 7, thinking: 'loud', compaction: { enabled: false, reserveTokens: -1 }, extra: 1 }));
    expect(await agent.status()).toMatchObject({ ready: false });
    expect(readdirSync(host.userData)).toEqual([]);
  });
});
