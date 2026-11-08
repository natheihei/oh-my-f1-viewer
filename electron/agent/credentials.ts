/** Encrypted, file-backed credential store for pi-ai, plus the stable install id login needs. */
import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };

/* eslint-disable @typescript-eslint/no-require-imports */
const { createSecureStore } = require('../vendor/f1ov/secureStore');

const secure = createSecureStore(safeStorage);

function credentialsPath(): string {
  return path.join(app.getPath('userData'), 'f1a-ai-credentials.json');
}

function readAll(): Record<string, Credential> {
  try {
    const stored = secure.readText(credentialsPath());
    return stored ? (JSON.parse(stored.text) as Record<string, Credential>) : {};
  } catch (e) {
    console.warn('[ai] could not read credentials:', (e as Error).message);
    return {};
  }
}

function writeAll(all: Record<string, Credential>): void {
  const file = credentialsPath();
  secure.writeText(file, JSON.stringify(all));
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort: the file is already encrypted where the OS keystore is available.
  }
}

/** All writes run one at a time: token refresh rotates the refresh token, so overlaps lose it. */
export function createFileCredentialStore(): CredentialStore {
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  return {
    read: async (providerId) => readAll()[providerId],
    list: async () =>
      Object.entries(readAll()).map(([providerId, c]): CredentialInfo => ({ providerId, type: c.type })),
    modify: (providerId, fn) =>
      serialized(async () => {
        const all = readAll();
        const next = await fn(all[providerId]);
        if (next !== undefined) {
          all[providerId] = next;
          writeAll(all);
        }
        return all[providerId];
      }),
    delete: (providerId) =>
      serialized(async () => {
        const all = readAll();
        delete all[providerId];
        writeAll(all);
      }),
  };
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
