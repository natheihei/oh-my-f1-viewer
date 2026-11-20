import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentToolCall, AgentToolResult, EventInfo, SessionInfo } from '../../shared/api';
import type { SessionDataView, SqlTableInfo } from '../../shared/sessionData';

vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { askAgent, connectTools, describeEvents, describeTables } = await import('./bridge');
const { PICKING_TOOLS, AGENT_TOOLS } = await import('./tools');
const { useSession } = await import('../data/session');

const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
const event = (pageId: number, round: number, shortName: string, start: string, end: string, isTest = false): EventInfo => ({
  pageId,
  name: `FORMULA 1 ${shortName.toUpperCase()}`,
  shortName,
  round,
  startMs: day(start),
  endMs: day(end),
  isTest,
});

describe('the event list for the agent', () => {
  it('has one line per event, in date order, with the pageId list_sessions takes', () => {
    const text = describeEvents({
      state: 'ready',
      error: null,
      seasons: [
        {
          year: 2025,
          events: [
            event(10498, 20, 'Mexico City Grand Prix', '2025-10-24', '2025-10-26'),
            event(10400, 0, 'Pre-Season Testing', '2025-02-26', '2025-02-28', true),
            event(10410, 1, 'Australian Grand Prix', '2025-03-14', '2025-03-16'),
            event(10520, 21, 'São Paulo Grand Prix', '2025-10-31', '2025-11-02'),
          ],
        },
      ],
    });
    expect(text.split('\n').slice(1)).toEqual([
      '',
      '2025:',
      '10400 test Pre-Season Testing, Feb 26-28',
      '10410 R1 Australian Grand Prix, Mar 14-16',
      '10498 R20 Mexico City Grand Prix, Oct 24-26',
      '10520 R21 São Paulo Grand Prix, Oct 31-Nov 2',
    ]);
    expect(text).toMatch(/^Events on F1 TV, 2023 on\./);
  });
});

describe('the table list for the agent', () => {
  const tables: SqlTableInfo[] = [
    { name: 'laps', columns: ['session_key', 'meeting_key', 'driver_number', 'lap_number', 'date_start', 'visible_from'] },
    { name: 'lap_summary', columns: ['session_key', 'meeting_key', 'driver_number', 'lap_number', 'date_start', 'date_end'], about: 'One row per driver per lap.' },
  ];
  const ready = (list: SqlTableInfo[]) => ({ state: 'ready', tables: list }) as unknown as SessionDataView;

  it('has one line per table once the data is ready, with the columns every table has said once', () => {
    expect(describeTables(ready(tables)).split('\n')).toEqual([
      'Tables for query_session. Each line: name: columns. Every table also has session_key and meeting_key.',
      'laps: driver_number, lap_number, date_start, visible_from',
      'lap_summary: driver_number, lap_number, date_start, date_end. One row per driver per lap.',
    ]);
  });

  it('claims visible_from only for the tables that have it', () => {
    const text = describeTables(ready(tables));
    expect(text).not.toMatch(/Every table also has[^\n]*visible_from/);
    expect(text).toMatch(/^lap_summary: (?!.*visible_from)/m);
  });

  it('only claims a column for every table when every table has it', () => {
    expect(describeTables(ready([...tables, { name: 'x', columns: ['session_key', 'a'] }]))).toMatch(/Every table also has session_key\.\n/);
  });

  it('is left out until the data is ready', () => {
    expect(describeTables({ state: 'loading', sessionKey: 1, datasets: null })).toBe('');
    expect(describeTables({ state: 'idle' })).toBe('');
    expect(describeTables(ready([]))).toBe('');
  });
});

describe("the tools sent with the agent's messages", () => {
  afterEach(() => {
    useSession.setState({ session: null, channels: [] });
    vi.unstubAllGlobals();
  });

  /** Records what each message and tool result sends, with tool calls made as the agent would. */
  function connect() {
    const sent: { tools: string[]; reference: string; mode: string; scope: string }[] = [];
    const results: AgentToolResult[] = [];
    let onCall: (call: AgentToolCall) => void = () => {};
    vi.stubGlobal('window', {
      omfv: {
        ai: {
          send: async (_text: string, _context: string, tools: { name: string }[], reference: string, mode: string, scope: string) =>
            void sent.push({ tools: tools.map((t) => t.name), reference, mode, scope }),
          onToolCall: (cb: (call: AgentToolCall) => void) => ((onCall = cb), () => {}),
          toolResult: (result: AgentToolResult) => results.push(result),
        },
      },
    });
    const call = async (callId: string) => {
      onCall({ callId, name: 'list_streams', args: {} });
      await vi.waitFor(() => expect(results.find((r) => r.callId === callId)).toBeDefined());
      return results.find((r) => r.callId === callId)!;
    };
    return { sent, call, stop: connectTools() };
  }
  const race = (): SessionInfo => ({ contentId: 1, title: 'Race', type: 'race', status: 'replay' }) as SessionInfo;

  it('go to the picking agent with no session, with its tools and the events alone', async () => {
    const { sent, stop } = connect();
    await askAgent('last race');
    expect(sent[0]).toMatchObject({ tools: PICKING_TOOLS, mode: 'pick', scope: 'pick' });
    expect(sent[0].reference).toMatch(/^Events on F1 TV/);
    expect(sent[0].reference).not.toMatch(/Components for suggest_tiles/);
    stop();
  });

  it('hand the message on to a viewing conversation when a call opens a session, once', async () => {
    const { sent, call, stop } = connect();
    await askAgent('last race');

    // As load_session leaves things: a session open, part way through the turn.
    useSession.setState({ session: race(), channels: [] });
    const opened = await call('a');
    expect(opened.handoff).toMatchObject({ mode: 'view', tools: AGENT_TOOLS.map((t) => t.name).map((name) => expect.objectContaining({ name })) });
    expect(opened.handoff!.scope).toMatch(/^view-/);
    expect(opened.handoff!.appState).toMatch(/session: Race/);
    // It was opened for this message, not already open, and isn't paused while it starts.
    expect(opened.handoff!.appState).toMatch(/just opened: this message's own earlier step opened the session/);
    expect(opened.handoff!.reference).toMatch(/^Events on F1 TV/);
    expect(opened.tools).toBeUndefined();
    expect((await call('b')).handoff).toBeUndefined();

    // The next message is for the same opening, so it goes on in that conversation.
    await askAgent('norris');
    expect(sent[1]).toMatchObject({ tools: AGENT_TOOLS.map((t) => t.name), mode: 'view', scope: opened.handoff!.scope });
    stop();
  });

  it('give each opening of a session a scope of its own, even of the same one', async () => {
    const { sent, stop } = connect();
    useSession.setState({ session: race(), channels: [] });
    await askAgent('norris');
    await askAgent('and piastri');
    useSession.setState({ session: race(), channels: [] });
    await askAgent('norris');
    expect(sent[0].scope).toBe(sent[1].scope);
    expect(sent[2].scope).not.toBe(sent[0].scope);
    useSession.setState({ session: null, channels: [] });
    await askAgent('the next race');
    expect(sent[3]).toMatchObject({ mode: 'pick', scope: 'pick' });
    stop();
  });

  it('switch sessions with a hand-off, and leave a failed switch in the same conversation with the picking tools', async () => {
    const { call, stop } = connect();
    useSession.setState({ session: race(), channels: [] });
    await askAgent('the sprint');
    useSession.setState({ session: { ...race(), contentId: 2, title: 'Sprint' }, channels: [] });
    const switched = await call('a');
    expect(switched.handoff).toMatchObject({ mode: 'view' });
    expect(switched.handoff!.appState).toMatch(/session: Sprint/);

    // load_session closes the open session before opening the next, so a failure leaves none open.
    useSession.setState({ session: null, channels: [] });
    const failed = await call('b');
    expect(failed.handoff).toBeUndefined();
    expect(failed.tools?.map((t) => t.name)).toEqual(PICKING_TOOLS);
    stop();
  });
});
