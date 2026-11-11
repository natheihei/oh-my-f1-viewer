import { describe, expect, it } from 'vitest';
import { FORGOTTEN_NOTE, forgetFinishedTurns, forgetForCompaction, PAST_PLAYHEAD } from './forgetReadAhead';

type Messages = Parameters<typeof forgetFinishedTurns>[0];

const user = (text: string) => ({ role: 'user', content: text, timestamp: 0 });
const assistant = (content: unknown[], extra = {}) => ({
  role: 'assistant',
  content,
  api: 'x',
  provider: 'x',
  model: 'x',
  usage: {},
  stopReason: 'toolUse',
  timestamp: 0,
  ...extra,
});
const text = (t: string) => ({ type: 'text', text: t, textSignature: 'signed' });
const thinking = (t: string) => ({ type: 'thinking', thinking: t, thinkingSignature: 'signed' });
const call = (id: string, sql: string) => ({ type: 'toolCall', id, name: 'query_session', arguments: { sql } });
const result = (id: string, rows: string, details?: unknown) => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'query_session',
  content: [{ type: 'text', text: rows }],
  details,
  isError: false,
  timestamp: 0,
});
const history = (...messages: unknown[]) => messages as Messages;

const readAheadTurn = () => [
  user('go to the second stop'),
  assistant([thinking('SECRET reasoning'), text('Looking.'), call('a', 'SECRET sql')]),
  result('a', 'SECRET rows', PAST_PLAYHEAD),
  assistant([thinking('more SECRET'), text('Jumped to lap 30.')], { stopReason: 'stop', responseId: 'r1' }),
];
const plainTurn = () => [user('ham'), assistant([call('b', 'SELECT 1')]), result('b', 'rows'), assistant([text('Suggested Hamilton.')], { stopReason: 'stop' })];

describe('forgetting finished turns', () => {
  it('cuts a finished read ahead down to the message and everything the agent said', () => {
    const out = forgetFinishedTurns(history(...readAheadTurn(), user('next')));
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(out)).not.toContain('SECRET');
    expect(out[0]).toMatchObject({ content: `${FORGOTTEN_NOTE}go to the second stop` });
    expect(out[1]).toMatchObject({ content: [{ type: 'text', text: 'Looking.\n\nJumped to lap 30.' }], stopReason: 'stop' });
  });

  it('leaves no signature or response id to pair with the dropped reasoning', () => {
    const out = forgetFinishedTurns(history(...readAheadTurn(), user('next')));
    expect(JSON.stringify(out[1])).not.toContain('signed');
    expect(out[1]).not.toHaveProperty('responseId');
  });

  it('keeps the current turn whole, so the agent can use what it read', () => {
    const turn = readAheadTurn();
    expect(forgetFinishedTurns(history(...turn))).toEqual(turn);
  });

  it('leaves a turn that did not read ahead alone', () => {
    const turn = plainTurn();
    expect(forgetFinishedTurns(history(...turn, user('next')))).toEqual([...turn, user('next')]);
  });

  it('forgets only the turns that read ahead', () => {
    const plain = plainTurn();
    const out = forgetFinishedTurns(history(...plain, ...readAheadTurn(), ...plainTurn(), user('next')));
    expect(out.slice(0, 4)).toEqual(plain);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant', 'user', 'assistant', 'user', 'assistant', 'toolResult', 'assistant', 'user']);
  });

  it('keeps nothing for the agent when a stopped turn said nothing', () => {
    const out = forgetFinishedTurns(history(user('go'), assistant([call('a', 'SECRET')]), result('a', 'SECRET', PAST_PLAYHEAD), user('next')));
    expect(out.map((m) => m.role)).toEqual(['user', 'user']);
  });

  it('turns a stopped reply into a normal one, so it is not dropped as an error', () => {
    const out = forgetFinishedTurns(
      history(user('go'), assistant([call('a', 'x')]), result('a', 'SECRET', PAST_PLAYHEAD), assistant([text('Half a re')], { stopReason: 'aborted', errorMessage: 'stopped' }), user('next')),
    );
    expect(out[1]).toMatchObject({ stopReason: 'stop' });
    expect(out[1]).not.toHaveProperty('errorMessage');
  });

  it('treats a finished turn that lost its start to compaction as a read ahead', () => {
    const summary = { role: 'compactionSummary', summary: 'earlier', tokensBefore: 1, timestamp: 0 };
    const out = forgetFinishedTurns(history(summary, assistant([thinking('SECRET'), text('Jumped.'), call('a', 'SECRET')]), result('a', 'plain'), user('next')));
    expect(out.map((m) => m.role)).toEqual(['compactionSummary', 'assistant', 'user']);
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('keeps a turn in progress whole even when compaction took its start', () => {
    const tail = [{ role: 'compactionSummary', summary: 'earlier', tokensBefore: 1, timestamp: 0 }, assistant([call('a', 'x')]), result('a', 'rows', PAST_PLAYHEAD)];
    expect(forgetFinishedTurns(history(...tail))).toEqual(tail);
  });

  it('does not change the messages it was given', () => {
    const turn = [...readAheadTurn(), user('next')];
    const before = structuredClone(turn);
    forgetFinishedTurns(history(...turn));
    expect(turn).toEqual(before);
  });

  it('ignores a failed read, which has no mark', () => {
    const turn = [user('go'), assistant([call('a', 'x')]), result('a', 'refused'), assistant([text('You said no.')], { stopReason: 'stop' })];
    expect(forgetFinishedTurns(history(...turn, user('next')))).toEqual([...turn, user('next')]);
  });
});

describe('forgetting for compaction', () => {
  it('forgets the turn in progress too, because a summary outlives it', () => {
    const out = forgetForCompaction(history(...readAheadTurn()));
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('leaves a turn in progress alone if it has not read ahead', () => {
    const turn = plainTurn();
    expect(forgetForCompaction(history(...turn))).toEqual(turn);
  });

  it('copes with nothing to summarize', () => {
    expect(forgetForCompaction([])).toEqual([]);
  });
});
