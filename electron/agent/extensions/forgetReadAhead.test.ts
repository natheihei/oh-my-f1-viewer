import type { EntryRecord } from '@earendil-works/pi-durable';
import { describe, expect, it } from 'vitest';
import { FORGOTTEN_NOTE, forgetForSummary, forgetTurn, readAheadIn } from './forgetReadAhead';

let nextId = 1;
const entry = (kind: string, message: Record<string, unknown>): EntryRecord => ({ id: nextId++, conversationId: 1, kind, model: [message] }) as unknown as EntryRecord;
const user = (text: string) => entry('pi.user', { role: 'user', content: text });
const system = () => entry('pi.system', { role: 'system', content: '', sections: { f1a: 'PROMPT' } });
const calls = (text: string, ...ids: string[]) =>
  entry('pi.assistant', {
    role: 'assistant',
    stopReason: 'toolUse',
    responseId: 'resp_1',
    content: [{ type: 'thinking', thinking: 'hm', thinkingSignature: 'sig' }, ...(text ? [{ type: 'text', text }] : []), ...ids.map((id) => ({ type: 'toolCall', id, name: 'query_session', arguments: { sql: 'SECRET SQL' } }))],
  });
const result = (id: string, text = 'SECRET ROWS') => entry('pi.tool-result', { role: 'toolResult', toolCallId: id, toolName: 'query_session', content: [{ type: 'text', text }], isError: false });
const answer = (text: string, extra: Record<string, unknown> = {}) => entry('pi.assistant', { role: 'assistant', stopReason: 'stop', responseId: 'resp_2', content: text ? [{ type: 'text', text }] : [], ...extra });

/** What the model is shown of `entries` once `edits` apply. */
function shown(entries: EntryRecord[], edits: ReturnType<typeof forgetTurn>): unknown[] {
  const by = new Map(edits.map((edit) => [edit.target, edit]));
  return entries.flatMap((e) => {
    const edit = by.get(e.id);
    return !edit ? (e.model ?? []) : edit.action === 'omit' ? [] : edit.messages;
  });
}

describe('forgetting a turn that read ahead', () => {
  it('cuts it down to the message, with a note, and everything the agent said', () => {
    const turn = [user('what happened on lap 30?'), system(), calls('Looking.', 'a'), result('a'), answer('Jumped to lap 30.')];
    const left = shown(turn, forgetTurn(turn, new Set(['a'])));
    expect(JSON.stringify(left)).not.toContain('SECRET');
    expect(left.map((m) => (m as { role: string }).role)).toEqual(['user', 'system', 'assistant']);
    expect(left[0]).toMatchObject({ content: `${FORGOTTEN_NOTE}what happened on lap 30?` });
    expect(left[2]).toMatchObject({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Looking.\n\nJumped to lap 30.' }] });
  });

  it('leaves no signature or response id to pair with the dropped reasoning', () => {
    const turn = [user('go'), calls('', 'a'), result('a'), answer('Done.', { errorMessage: 'x' })];
    const reply = shown(turn, forgetTurn(turn, new Set(['a']))).at(-1) as Record<string, unknown>;
    expect(reply.responseId).toBeUndefined();
    expect(reply.errorMessage).toBeUndefined();
    expect(JSON.stringify(reply)).not.toContain('sig');
  });

  it('puts the note in front of a message made of blocks', () => {
    const turn = [entry('pi.user', { role: 'user', content: [{ type: 'text', text: 'go' }] }), calls('', 'a'), result('a'), answer('Done.')];
    expect(shown(turn, forgetTurn(turn, new Set(['a'])))[0]).toMatchObject({ content: [{ type: 'text', text: FORGOTTEN_NOTE }, { type: 'text', text: 'go' }] });
  });

  it('leaves a turn that did not read ahead alone', () => {
    const turn = [user('go'), calls('', 'a'), result('a', 'plain'), answer('Done.')];
    expect(forgetTurn(turn, new Set())).toEqual([]);
    expect(forgetTurn(turn, new Set(['another call']))).toEqual([]);
  });

  it('touches only the last turn', () => {
    const earlier = [user('first'), calls('', 'a'), result('a', 'EARLIER ROWS'), answer('One.')];
    const last = [user('second'), calls('', 'b'), result('b'), answer('Two.')];
    const edits = forgetTurn([...earlier, ...last], new Set(['b']));
    expect(edits.map((e) => e.target)).toEqual(last.map((e) => e.id));
    expect(JSON.stringify(shown([...earlier, ...last], edits))).toContain('EARLIER ROWS');
  });

  it('keeps nothing of the agent when a stopped turn said nothing', () => {
    const turn = [user('go'), calls('', 'a'), result('a')];
    expect(shown(turn, forgetTurn(turn, new Set(['a']))).map((m) => (m as { role: string }).role)).toEqual(['user']);
  });

  it('turns a stopped reply into a normal one, so it is not dropped as an error', () => {
    const turn = [user('go'), calls('Half an answer', 'a'), result('a'), answer('', { stopReason: 'aborted' })];
    const left = shown(turn, forgetTurn(turn, new Set(['a'])));
    expect(left.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Half an answer' }] });
  });

  it('still finds the turn when a summary was placed in the middle of it', () => {
    const summary = entry('pi.compaction', { role: 'user', content: [{ type: 'text', text: 'The conversation history before this point was compacted' }] });
    const turn = [user('go to lap 30'), calls('', 'a'), result('a'), summary, calls('', 'b'), result('b', 'plain'), answer('Jumped to lap 30.')];
    const edits = forgetTurn(turn, new Set(['a']));
    const left = shown(turn, edits);
    expect(JSON.stringify(left)).not.toContain('SECRET');
    expect(edits.some((e) => e.target === summary.id)).toBe(false);
    expect(left.map((m) => (m as { role: string }).role)).toEqual(['user', 'user', 'assistant']);
    expect(left[0]).toMatchObject({ content: `${FORGOTTEN_NOTE}go to lap 30` });
  });

  it('does nothing without a message to start from', () => {
    expect(forgetTurn([], new Set(['a']))).toEqual([]);
    expect(forgetTurn([calls('', 'a'), result('a')], new Set(['a']))).toEqual([]);
  });
});

describe('finding a read ahead among messages', () => {
  it('goes by the call each result answers', () => {
    const messages = [{ role: 'toolResult', toolCallId: 'a' }, { role: 'assistant', content: [] }] as never[];
    expect(readAheadIn(messages, new Set(['a']))).toBe(true);
    expect(readAheadIn(messages, new Set(['b']))).toBe(false);
    expect(readAheadIn([], new Set(['a']))).toBe(false);
  });
});

describe('what a summary is made from while a turn still reads ahead', () => {
  const messagesOf = (entries: EntryRecord[]) => entries.flatMap((e) => e.model ?? []) as never[];

  it('cuts down the turn in progress, and leaves the turns that read nothing ahead', () => {
    const earlier = [user('first'), calls('', 'x'), result('x', 'EARLIER ROWS'), answer('One.')];
    const running = [user('go to lap 30'), calls('Looking.', 'a'), result('a')];
    const left = forgetForSummary(messagesOf([...earlier, ...running]), new Set(['a']), [...earlier, ...running]);
    expect(JSON.stringify(left)).toContain('EARLIER ROWS');
    expect(JSON.stringify(left)).not.toContain('SECRET ROWS');
    // The earlier turn's call stays, and the running turn's is gone.
    expect(JSON.stringify(left).split('"toolCall"').length - 1).toBe(1);
    expect(left.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] });
    expect(left.at(-2)).toMatchObject({ content: `${FORGOTTEN_NOTE}go to lap 30` });
  });

  it('counts an earlier summary inside the turn as part of it, not as a new message from the viewer', () => {
    const summary = entry('pi.compaction', { role: 'user', content: [{ type: 'text', text: 'SUMMARY SO FAR' }] });
    // The second call carries what the first one read, in its arguments, and its own result has no mark.
    const running = [user('go to lap 30'), calls('', 'a'), result('a'), summary, calls('', 'b'), result('b', 'sought')];
    const left = forgetForSummary(messagesOf(running), new Set(['a']), running);
    expect(JSON.stringify(left)).not.toContain('SECRET');
    expect(JSON.stringify(left)).toContain('SUMMARY SO FAR');
    expect(left.filter((m) => (m as { role: string }).role === 'toolResult')).toEqual([]);
  });
});
