/**
 * The agent's credentials on disk: `auth.json`, one credential per provider, in the shape pi keeps them, so a
 * login made before the move to pi-durable still works. pi-ai refreshes an expired sign-in inside `modify`,
 * so writes to one provider go one at a time. The app is one instance per profile, so nothing else writes it.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };

type Stored = Record<string, Credential>;

export function fileCredentialStore(file: string): CredentialStore {
  let turn: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<Stored> => {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Stored) : {};
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
  };
  const write = async (stored: Stored): Promise<void> => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
    await fsp.rename(temp, file);
  };
  /** After whatever is already changing the file. */
  const next = <T>(run: () => Promise<T>): Promise<T> => {
    const result = turn.then(run, run);
    turn = result.catch(() => {});
    return result;
  };
  return {
    read: async (providerId) => (await read())[providerId],
    list: async () => Object.entries(await read()).map(([providerId, credential]) => ({ providerId, type: credential.type })),
    modify: (providerId, change) =>
      next(async () => {
        const stored = await read();
        const changed = await change(stored[providerId]);
        if (changed === undefined) return stored[providerId];
        await write({ ...stored, [providerId]: changed });
        return changed;
      }),
    delete: (providerId) =>
      next(async () => {
        const { [providerId]: removed, ...rest } = await read();
        if (removed !== undefined) await write(rest);
      }),
  };
}
