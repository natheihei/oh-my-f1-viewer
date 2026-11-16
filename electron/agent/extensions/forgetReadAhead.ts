/**
 * An approved read ahead is usable only in the turn that asked for it. After that, the agent remembers
 * only what it told the viewer: a turn that read past the playhead is cut down to the viewer's message
 * and the agent's words. Only what the model is shown changes, never the stored conversation: the turn's
 * entries stay, and one more entry says how each of them reads from then on.
 * See docs/SPOILER_PREVENTION.md.
 */
import type { AssistantMessage, Message } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };
import type { ContextEdit, EntryRecord } from '@earendil-works/pi-durable' with { 'resolution-mode': 'import' };

/** On the viewer's side, next to app_state, so the agent isn't shown a block of its own to copy. */
export const FORGOTTEN_NOTE =
  '<app_note>\nThe tool calls and results of this turn were removed to avoid spoilers, so the reply is all that remains of it. If you need them, call the tools again. Do not mention this note.\n</app_note>\n\n';

/** A message from the viewer. A compaction's summary also reaches the model as a user message, and isn't one. */
const isUser = (entry: EntryRecord) => entry.kind === 'pi.user';

function withNote(message: Message): Message {
  if (message.role !== 'user') return message;
  return { ...message, content: typeof message.content === 'string' ? FORGOTTEN_NOTE + message.content : [{ type: 'text', text: FORGOTTEN_NOTE }, ...message.content] };
}

/** Whether any of these messages is the result of a call that read past the playhead. */
export function readAheadIn(messages: readonly Message[], readAhead: ReadonlySet<string>): boolean {
  return messages.some((m) => m.role === 'toolResult' && readAhead.has(m.toolCallId));
}

/**
 * How the last turn of `entries` reads once it's over, if one of its calls is in `readAhead`: the viewer's
 * message with a note on it, then everything the agent said as one reply, and nothing of its tool calls or
 * their results. Nothing when the turn read nothing past the playhead.
 */
export function forgetTurn(entries: readonly EntryRecord[], readAhead: ReadonlySet<string>): ContextEdit[] {
  const start = entries.findLastIndex(isUser);
  if (start < 0) return [];
  const turn = entries.slice(start).filter((entry) => entry.model?.length);
  if (!turn.some((entry) => readAheadIn(entry.model ?? [], readAhead))) return [];

  const replies = turn.filter((entry) => entry.model?.[0]?.role === 'assistant');
  const said = replies
    .flatMap((entry) => (entry.model as AssistantMessage[]).flatMap((m) => m.content.flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))))
    .join('\n\n');
  const last = replies.at(-1);
  return turn.flatMap((entry): ContextEdit[] => {
    const [message] = entry.model as Message[];
    if (isUser(entry)) return [{ target: entry.id, action: 'replace', messages: [withNote(message)] }];
    // A summary made while the turn ran was made from its cut-down form, and stays.
    if (message.role === 'user') return [];
    if (message.role === 'assistant' && entry === last && said) {
      // A fresh block with no signature: OpenAI pairs a signed reply with the reasoning dropped here.
      const { responseId: _responseId, errorMessage: _errorMessage, diagnostics: _diagnostics, ...rest } = message as AssistantMessage & { diagnostics?: unknown };
      return [{ target: entry.id, action: 'replace', messages: [{ ...rest, content: [{ type: 'text', text: said }], stopReason: 'stop' }] }];
    }
    if (message.role === 'assistant' || message.role === 'toolResult') return [{ target: entry.id, action: 'omit' }];
    return [];
  });
}

/** What comes before the viewer's first message, then one list per message of theirs. */
function turnsOf(messages: readonly Message[], fromViewer: (message: Message) => boolean): Message[][] {
  const turns: Message[][] = [[]];
  for (const message of messages) {
    if (fromViewer(message)) turns.push([]);
    turns[turns.length - 1].push(message);
  }
  return turns;
}

const textOf = (message: Message | undefined): string =>
  !message ? '' : typeof message.content === 'string' ? message.content : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');

/**
 * Messages about to be summarized, with every turn that read ahead cut down as above, the one in progress
 * too: a summary outlives the turn, so it can't hold what the turn read. `entries` are the entries behind
 * the messages: an earlier summary also reaches the model as a user message, and doesn't start a turn.
 */
export function forgetForSummary(messages: readonly Message[], readAhead: ReadonlySet<string>, entries: readonly EntryRecord[] = []): Message[] {
  const summaries = new Set(entries.filter((entry) => entry.kind === 'pi.compaction').map((entry) => textOf(entry.model?.[0])));
  const fromViewer = (message: Message) => message.role === 'user' && !summaries.has(textOf(message));
  return turnsOf(messages, fromViewer).flatMap((turn) => {
    if (!readAheadIn(turn, readAhead)) return turn;
    const said = turn.flatMap((m) => (m.role === 'assistant' ? m.content.flatMap((block) => (block.type === 'text' && block.text ? [block.text] : [])) : [])).join('\n\n');
    const last = turn.findLast((m): m is AssistantMessage => m.role === 'assistant');
    const kept = turn.filter((m) => m.role !== 'assistant' && m.role !== 'toolResult').map((m) => (fromViewer(m) ? withNote(m) : m));
    return last && said ? [...kept, { ...last, content: [{ type: 'text', text: said }], stopReason: 'stop' } as AssistantMessage] : kept;
  });
}

export const SUMMARY_SYSTEM_PROMPT =
  'You summarize a conversation between a viewer and the assistant that runs their Formula 1 viewing app, so another assistant can carry it on. Do not continue the conversation or answer anything in it. Only output the summary.';
const SUMMARY_PROMPT =
  'The messages above are the conversation to summarize. Say what the viewer has asked for, what is on screen and what was done, in the order it happened, and anything still open. Keep names, sessions and tile names exact. Be brief.';
/** The longest tool result a summary's source keeps. */
const RESULT_CHARS = 2000;

const blocksText = (content: Message['content']): string =>
  typeof content === 'string' ? content : content.flatMap((block) => (block.type === 'text' ? [block.text] : block.type === 'toolCall' ? [`[called ${block.name} ${JSON.stringify(block.arguments)}]`] : [])).join('\n');

/** The summarizer's message: the conversation as a transcript, so it's read rather than continued. */
export function summaryRequest(messages: readonly Message[], instructions?: string): string {
  const lines = messages.flatMap((m) => {
    if (m.role === 'user') return [`[User]: ${blocksText(m.content)}`];
    if (m.role === 'assistant') return [`[Assistant]: ${blocksText(m.content)}`];
    if (m.role === 'toolResult') return [`[Result of ${m.toolName}]: ${blocksText(m.content).slice(0, RESULT_CHARS)}`];
    return [];
  });
  return `<conversation>\n${lines.join('\n\n')}\n</conversation>\n\n${SUMMARY_PROMPT}${instructions ? `\n\nAlso: ${instructions}` : ''}`;
}
