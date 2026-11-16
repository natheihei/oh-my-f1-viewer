// The agent's stored conversations: one SQLite database each under <userData>/conversations, named
// <time>_view.sqlite or <time>_build.sqlite. Each entry is a row of pi-durable's `entries` table, its
// record JSON. Read-only, so it works while the app has the newest one open.
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MAIN_CONVERSATIONS = path.join(os.homedir(), '.config', 'f1a', 'conversations');

/** The stored conversations of a kind ('view' or 'build', or both when omitted), oldest first, as full paths. */
export function conversationFiles(dir = MAIN_CONVERSATIONS, kind) {
  if (!existsSync(dir)) return [];
  const suffix = kind ? `_${kind}.sqlite` : '.sqlite';
  return readdirSync(dir).filter((f) => f.endsWith(suffix)).sort().map((f) => path.join(dir, f));
}

/** A conversation's entries, in order: `{ kind, model?, edits?, ... }`. */
export function conversationEntries(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT record FROM entries ORDER BY id').all().map((row) => JSON.parse(row.record));
  } finally {
    db.close();
  }
}

/** The newest conversation of a kind as one string of its entries' JSON, for a check to search. Empty if there's none. */
export function newestConversationText(dir, kind) {
  const file = conversationFiles(dir, kind).at(-1);
  return file ? conversationEntries(file).map((entry) => JSON.stringify(entry)).join('\n') : '';
}
