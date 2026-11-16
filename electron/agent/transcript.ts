/**
 * One `.jsonl` per conversation, for reviewing what the agent did: its prompts, `app_state`, tool calls and
 * results, and token use. The lines are the ones pi's own sessions had (a `session` header, `model_change`,
 * `thinking_level_change`, then a `message` per model message), so older files and newer ones read the same.
 * It's a record only: nothing is ever resumed from it, and the conversation itself lives in memory.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { EntryRecord } from '@earendil-works/pi-durable' with { 'resolution-mode': 'import' };

const lineId = () => randomUUID().slice(0, 8);

export class Transcript {
  private parent: string | null = null;
  private readonly written = new Set<EntryRecord['id']>();
  private turn: Promise<void> = Promise.resolve();
  private model = '';
  private thinking = '';

  constructor(
    private readonly file: string,
    private readonly id: string,
    private readonly cwd: string,
  ) {}

  /** Creates the file with its header. Rejects if it can't be written, so a conversation never runs unrecorded. */
  async start(): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify({ type: 'session', version: 3, id: this.id, timestamp: new Date().toISOString(), cwd: this.cwd }) + '\n', { flag: 'wx' });
  }

  private line(value: Record<string, unknown>): void {
    const id = lineId();
    const text = JSON.stringify({ ...value, id, parentId: this.parent, timestamp: new Date().toISOString() }) + '\n';
    this.parent = id;
    this.turn = this.turn.then(() => fsp.appendFile(this.file, text)).catch((e: Error) => console.warn('[ai] writing the conversation:', e.message));
  }

  /** Says which model and thinking level the next messages ran on, when either changed. */
  runsOn(provider: string, modelId: string, thinkingLevel: string): void {
    if (`${provider}/${modelId}` !== this.model) this.line({ type: 'model_change', provider, modelId });
    if (thinkingLevel !== this.thinking) this.line({ type: 'thinking_level_change', thinkingLevel });
    this.model = `${provider}/${modelId}`;
    this.thinking = thinkingLevel;
  }

  /** Adds the entries not written yet, in the order given. An entry with nothing for the model is kept as it is. */
  add(entries: readonly EntryRecord[]): void {
    for (const entry of entries) {
      if (this.written.has(entry.id)) continue;
      this.written.add(entry.id);
      // A summary and a cut-down turn say so, so a reader can tell them from what the viewer and the agent said.
      const kind = entry.kind.startsWith('pi.') && entry.kind !== 'pi.compaction' ? {} : { kind: entry.kind };
      for (const message of entry.model ?? []) this.line({ type: 'message', ...kind, message });
      if (!entry.model?.length) this.line({ type: 'custom', customType: entry.kind, data: { ...(entry.data === undefined ? {} : { data: entry.data }), ...(entry.edits ? { edits: entry.edits } : {}) } });
    }
  }

  /** Resolves once everything added so far is in the file. */
  flush(): Promise<void> {
    return this.turn;
  }
}
