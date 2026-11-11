import type { ContextEvent, ExtensionFactory } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };

/**
 * An approved read ahead is usable only in the turn that asked for it. After that, the agent remembers
 * only what it told the viewer: a turn that read past the playhead is cut down to the viewer's message
 * and the agent's words. Only what goes to the model changes, never the stored conversation.
 * See docs/SPOILER_PREVENTION.md.
 */

type Message = ContextEvent['messages'][number];

/** Goes in a tool result's `details`, which the model never sees. */
export const PAST_PLAYHEAD = { pastPlayhead: true };

/** On the viewer's side, next to app_state, so the agent isn't shown a block of its own to copy. */
export const FORGOTTEN_NOTE =
  '<app_note>\nThe tool calls and results of this turn were removed to avoid spoilers, so the reply is all that remains of it. If you need them, call the tools again. Do not mention this note.\n</app_note>\n\n';

const isPastPlayhead = (m: Message): boolean => m.role === 'toolResult' && (m.details as typeof PAST_PLAYHEAD | undefined)?.pastPlayhead === true;

/** What comes before the first user message, then one list per user message. */
function turnsOf(messages: Message[]): [Message[], ...Message[][]] {
  const turns: [Message[], ...Message[][]] = [[]];
  for (const m of messages) {
    if (m.role === 'user') turns.push([]);
    turns[turns.length - 1].push(m);
  }
  return turns;
}

function withNote(m: Message): Message {
  if (m.role !== 'user') return m;
  return { ...m, content: typeof m.content === 'string' ? FORGOTTEN_NOTE + m.content : [{ type: 'text', text: FORGOTTEN_NOTE }, ...m.content] };
}

function collapse(turn: Message[]): Message[] {
  const kept = turn.filter((m) => m.role !== 'assistant' && m.role !== 'toolResult').map(withNote);
  const replies = turn.filter((m) => m.role === 'assistant');
  const said = replies
    .flatMap((m) => m.content.flatMap((block) => (block.type === 'text' && block.text ? [block.text] : [])))
    .join('\n\n');
  const last = replies.at(-1);
  if (!last || !said) return kept;
  // A fresh block with no signature: OpenAI pairs a signed reply with the reasoning dropped here.
  const { responseId: _responseId, errorMessage: _errorMessage, diagnostics: _diagnostics, ...rest } = last;
  return [...kept, { ...rest, content: [{ type: 'text', text: said }], stopReason: 'stop' }];
}

/**
 * What to send the model: every finished turn with its read aheads forgotten. Compaction can cut a turn
 * in two, and what's left before the first user message may have lost its mark, so it counts as marked.
 */
export function forgetFinishedTurns(messages: Message[]): Message[] {
  const [start, ...turns] = turnsOf(messages);
  const current = turns.pop();
  if (!current) return start;
  return [...collapse(start), ...turns.flatMap((t) => (t.some(isPastPlayhead) ? collapse(t) : t)), ...current];
}

/** What to summarize: as above, and the turn in progress too, because a summary outlives it. */
export function forgetForCompaction(messages: Message[]): Message[] {
  const [start, ...turns] = turnsOf(messages);
  return [...collapse(start), ...turns.flatMap((t) => (t.some(isPastPlayhead) ? collapse(t) : t))];
}

export const forgetReadAhead: ExtensionFactory = (pi) => {
  pi.on('context', (event) => ({ messages: forgetFinishedTurns(event.messages) }));
  // Compaction reads the stored messages, so the hook above never reaches it.
  pi.on('session_before_compact', ({ preparation }) => {
    preparation.messagesToSummarize = forgetForCompaction(preparation.messagesToSummarize);
    preparation.turnPrefixMessages = forgetForCompaction(preparation.turnPrefixMessages);
  });
};
