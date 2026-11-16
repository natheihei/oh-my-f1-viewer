/**
 * `settings.json`: the provider, model and thinking level `/settings-agent` chose, and the run policy that can be
 * edited by hand. The keys are the ones pi used, so a file from before the move to pi-durable still reads.
 * It's read at every use, so a hand edit applies from the next message, and a write keeps every other key.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export interface StoredSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  retry?: { enabled?: boolean; maxRetries?: number };
  [key: string]: unknown;
}

/** Written only if the file is missing. */
const STARTER: StoredSettings = {
  compaction: { enabled: true },
  retry: { enabled: false },
  cacheWarming: 'off',
};

export class AgentSettings {
  constructor(private readonly file: string) {}

  /** Writes the starter file if there's none. */
  async ensure(): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(STARTER, null, 2) + '\n', { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
  }

  /** What the file says now. A file that can't be read counts as empty, so a bad hand edit doesn't stop the app. */
  async read(): Promise<StoredSettings> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.file, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as StoredSettings) : {};
    } catch {
      return {};
    }
  }

  async change(values: Partial<StoredSettings>): Promise<void> {
    const merged = { ...(await this.read()), ...values };
    await fsp.writeFile(this.file, JSON.stringify(merged, null, 2) + '\n');
  }
}
