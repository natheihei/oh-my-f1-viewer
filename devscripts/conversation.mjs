// Prints one of the agent's stored conversations, to review what it did: the prompt and each change to it,
// the messages with their app_state, tool calls and results, summaries, and what a read ahead had cut.
// They hold whatever the agent read, including race data.
//
//   node devscripts/conversation.mjs                 the newest, of any kind
//   node devscripts/conversation.mjs view            the newest of a kind: pick, view or build
//   node devscripts/conversation.mjs <file.sqlite>   that one
//   OMFV_CONVERSATIONS=<dir>                         another profile's conversations folder
import { existsSync } from 'node:fs';
import { conversationEntries, conversationFiles, MAIN_CONVERSATIONS } from '../scripts/conversations.mjs';

const arg = process.argv[2];
const dir = process.env.OMFV_CONVERSATIONS ?? MAIN_CONVERSATIONS;
const file = arg && existsSync(arg) ? arg : conversationFiles(dir, ['pick', 'view', 'build'].includes(arg) ? arg : undefined).at(-1);
if (!file) {
  console.error(`No stored conversations in ${dir}.`);
  process.exit(1);
}
console.log(`# ${file}\n`);

const text = (content) =>
  typeof content === 'string'
    ? content
    : content
        .map((b) => (b.type === 'text' ? b.text : b.type === 'thinking' ? `(thinking) ${b.thinking}` : b.type === 'toolCall' ? `→ ${b.name}(${JSON.stringify(b.arguments)})` : `[${b.type}]`))
        .join('\n');

for (const entry of conversationEntries(file)) {
  // f1a.forget: written before the app was renamed.
  if (entry.kind === 'omfv.forget' || entry.kind === 'f1a.forget') {
    console.log(`--- ${entry.kind}: ${entry.edits?.length ?? 0} edits cut a read-ahead turn from what the model sees\n`);
    continue;
  }
  for (const m of entry.model ?? []) {
    if (m.role === 'system') {
      const sections = Object.entries(m.sections ?? {}).map(([name, value]) => `[section ${name}: ${value === null ? 'removed' : `${value.length} chars`}]`);
      const tools = [...(m.toolsAdded ?? []).map((t) => `+${t.name}`), ...(m.toolsRemoved ?? []).map((t) => `-${t.name ?? t}`)];
      console.log(`--- system ${[...sections, tools.length ? `tools ${tools.join(' ')}` : ''].filter(Boolean).join(' ')}\n`);
    } else if (m.role === 'toolResult') {
      console.log(`--- ${m.toolName} ${m.isError ? 'failed' : 'returned'}\n${text(m.content)}\n`);
    } else {
      const usage = m.usage ? ` (${m.model}, ${m.usage.input} in + ${m.usage.cacheRead} cached, ${m.usage.output} out)` : '';
      console.log(`--- ${entry.kind === 'pi.compaction' ? 'summary' : m.role}${usage}\n${text(m.content)}\n`);
    }
  }
}
