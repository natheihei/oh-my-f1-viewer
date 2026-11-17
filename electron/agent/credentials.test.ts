import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, safeStorage: undefined }));

const { credentialStore } = await import('./credentials');
const { createSecureStore } = await import('../vendor/f1ov/secureStore');

/** A keystore that "encrypts" by reversing, so a test can tell the file isn't plain. */
const keystore = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (text: string) => Buffer.from([...text].reverse().join('')),
  decryptStringAsync: async (data: Buffer) => ({ result: [...data.toString()].reverse().join(''), shouldReEncrypt: false }),
};

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'omfv-credentials-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the credential store', () => {
  it('keeps one credential per provider, encrypted, readable only by the user', async () => {
    const file = path.join(dir, 'omfv-credentials.json');
    const store = credentialStore(file, createSecureStore(keystore));
    await store.modify('openai', async () => ({ type: 'api_key', key: 'sk-secret' }));
    await store.modify('anthropic', async () => ({ type: 'api_key', key: 'sk-other' }));
    expect(readFileSync(file, 'utf8')).not.toContain('sk-secret');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await store.list()).toEqual([
      { providerId: 'openai', type: 'api_key' },
      { providerId: 'anthropic', type: 'api_key' },
    ]);
    const again = credentialStore(file, createSecureStore(keystore));
    expect(await again.read('openai')).toEqual({ type: 'api_key', key: 'sk-secret' });
  });

  it('removes the file with the last credential', async () => {
    const file = path.join(dir, 'omfv-credentials.json');
    const store = credentialStore(file, createSecureStore(keystore));
    await store.modify('openai', async () => ({ type: 'api_key', key: 'sk-secret' }));
    await store.delete('openai');
    expect(existsSync(file)).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("reads a file it can't decrypt as empty", async () => {
    const file = path.join(dir, 'omfv-credentials.json');
    await credentialStore(file, createSecureStore(keystore)).modify('openai', async () => ({ type: 'api_key', key: 'sk-secret' }));
    const elsewhere = { ...keystore, decryptStringAsync: async () => Promise.reject(new Error('another machine')) };
    expect(await credentialStore(file, createSecureStore(elsewhere)).list()).toEqual([]);
  });

  it("keeps a file it can't parse aside instead of writing over it", async () => {
    const file = path.join(dir, 'omfv-credentials.json');
    writeFileSync(file, '{"openai": {"type": "api_key", "key": "sk-sec');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = credentialStore(file, createSecureStore(keystore));
    expect(await store.list()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    await store.delete('openai');
    expect(existsSync(`${file}.bad`)).toBe(false);
    await store.modify('anthropic', async () => ({ type: 'api_key', key: 'sk-other' }));
    expect(readFileSync(`${file}.bad`, 'utf8')).toBe('{"openai": {"type": "api_key", "key": "sk-sec');
    expect(await store.list()).toEqual([{ providerId: 'anthropic', type: 'api_key' }]);
    warn.mockRestore();
  });

  it('keeps aside a file that parses but holds no credentials object', async () => {
    const file = path.join(dir, 'omfv-credentials.json');
    writeFileSync(file, '[1, 2]');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = credentialStore(file, createSecureStore(keystore));
    await store.modify('openai', async () => ({ type: 'api_key', key: 'sk-secret' }));
    expect(readFileSync(`${file}.bad`, 'utf8')).toBe('[1, 2]');
    expect(await store.read('openai')).toEqual({ type: 'api_key', key: 'sk-secret' });
    warn.mockRestore();
  });
});
