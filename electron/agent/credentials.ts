/**
 * The model providers' credentials, and the stable install id sign-in needs. They're kept in the app's data
 * folder beside F1 TV's sign-in, and like it encrypted with the OS keystore (safeStorage).
 */
import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };

/* eslint-disable @typescript-eslint/no-require-imports */
const { createSecureStore } = require('../vendor/f1ov/secureStore');

interface SecureStore {
  writeText(file: string, text: string): Promise<void>;
  remove(file: string): Promise<void>;
  readText(file: string): Promise<{ text: string } | null>;
}

/** OpenAI's login asks for a stable id for this installation. */
export function installId(): string {
  const file = path.join(app.getPath('userData'), 'f1a-install-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim().replace(/^urn:uuid:/, '');
    if (existing) return existing;
  } catch {
    // First run.
  }
  const id = randomUUID();
  fs.writeFileSync(file, id, { mode: 0o600 });
  return id;
}

type Stored = Record<string, Credential>;

/**
 * One credential per provider, in one encrypted file. pi-ai refreshes an expired sign-in inside `modify`, so
 * changes go one at a time. The app is one instance per profile, so nothing else writes the file.
 * `secure` is for tests: the OS keystore by default.
 */
export function credentialStore(file: string, secure: SecureStore = createSecureStore(safeStorage)): CredentialStore {
  let turn: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<Stored> => {
    const stored = await secure.readText(file);
    if (!stored) return {};
    try {
      const parsed = JSON.parse(stored.text) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Stored) : {};
    } catch {
      return {};
    }
  };
  const write = async (stored: Stored): Promise<void> => {
    if (Object.keys(stored).length === 0) return secure.remove(file);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    // Written readable only by this user, for when the OS has no keystore and the store falls back to plain text.
    await secure.writeText(file, JSON.stringify(stored));
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
