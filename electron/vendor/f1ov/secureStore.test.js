import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ss from './secureStore.js';

const flip = (buf) => Buffer.from(Buffer.from(buf).map((b) => b ^ 0x5a));
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Fake safeStorage: "encryption" = reversible byte flip, so plaintext never appears on disk. Only the
 * async methods exist, so any call to the removed sync ones fails the test.
 */
const fakeSafeStorage = (available = true, overrides = {}) => ({
  isAsyncEncryptionAvailable: async () => available,
  encryptStringAsync: async (s) => flip(Buffer.from(s, 'utf8')),
  decryptStringAsync: async (buf) => ({ shouldReEncrypt: false, result: flip(buf).toString('utf8') }),
  ...overrides,
});

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'f1ov-secure-')), 'session.json');
const TOKEN_JSON = JSON.stringify({ accessToken: 'eyJhbGciOi.SUPER_SECRET_TOKEN.sig' });

test('encrypts at rest and round-trips', async () => {
  const file = tmpFile();
  const store = ss.createSecureStore(fakeSafeStorage());
  await store.writeText(file, TOKEN_JSON);
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(!onDisk.includes('SUPER_SECRET_TOKEN'), 'token must not be readable on disk');
  assert.ok(onDisk.includes(ss.FORMAT));
  assert.deepEqual(await store.readText(file), { text: TOKEN_JSON, encrypted: true, shouldReEncrypt: false });
});

test('reads a file written by the sync version (encryptString)', async () => {
  const file = tmpFile();
  // Exactly what the sync store wrote: the same envelope around safeStorage.encryptString's bytes.
  const encryptString = (s) => flip(Buffer.from(s, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ format: ss.FORMAT, data: encryptString(TOKEN_JSON).toString('base64') }));
  const read = await ss.createSecureStore(fakeSafeStorage()).readText(file);
  assert.equal(read.text, TOKEN_JSON);
  assert.equal(read.encrypted, true);
});

test('passes on shouldReEncrypt so callers can rewrite the file', async () => {
  const file = tmpFile();
  await ss.createSecureStore(fakeSafeStorage()).writeText(file, TOKEN_JSON);
  const rotated = fakeSafeStorage(true, {
    decryptStringAsync: async (buf) => ({ shouldReEncrypt: true, result: flip(buf).toString('utf8') }),
  });
  assert.deepEqual(await ss.createSecureStore(rotated).readText(file), { text: TOKEN_JSON, encrypted: true, shouldReEncrypt: true });
});

test('falls back to plain text when the OS cannot encrypt', async () => {
  const file = tmpFile();
  const store = ss.createSecureStore(fakeSafeStorage(false));
  assert.equal(await store.isEncryptionAvailable(), false);
  await store.writeText(file, TOKEN_JSON);
  assert.equal(fs.readFileSync(file, 'utf8'), TOKEN_JSON);
  assert.deepEqual(await store.readText(file), { text: TOKEN_JSON, encrypted: false });
});

test('legacy plain files stay readable (and are flagged so callers can upgrade them)', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, TOKEN_JSON);
  const store = ss.createSecureStore(fakeSafeStorage());
  assert.deepEqual(await store.readText(file), { text: TOKEN_JSON, encrypted: false });
  await store.writeText(file, TOKEN_JSON); // upgrade
  assert.equal((await store.readText(file)).encrypted, true);
});

test('unreadable envelope (other machine/user, or encryption gone) reads as missing', async () => {
  const file = tmpFile();
  await ss.createSecureStore(fakeSafeStorage()).writeText(file, TOKEN_JSON);
  assert.equal(await ss.createSecureStore(fakeSafeStorage(false)).readText(file), null);
  const broken = fakeSafeStorage(true, { decryptStringAsync: async () => { throw new Error('bad key'); } });
  assert.equal(await ss.createSecureStore(broken).readText(file), null);
  const throwing = fakeSafeStorage(true, { isAsyncEncryptionAvailable: () => { throw new Error('no keyring'); } });
  assert.equal(await ss.createSecureStore(throwing).readText(file), null);
});

test('missing file and missing safeStorage', async () => {
  const file = tmpFile();
  assert.equal(await ss.createSecureStore(fakeSafeStorage()).readText(file), null);
  const store = ss.createSecureStore(undefined);
  await store.writeText(file, 'x');
  assert.deepEqual(await store.readText(file), { text: 'x', encrypted: false });
});

test('atomic write leaves no temp files behind', async () => {
  const file = tmpFile();
  await ss.createSecureStore(fakeSafeStorage()).writeText(file, 'a');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['session.json']);
});

test('a slow encrypt cannot let an older write land after a newer one', async () => {
  const file = tmpFile();
  // The first encrypt is held until released; later ones resolve at once.
  let release;
  const held = new Promise((r) => { release = r; });
  let calls = 0;
  const store = ss.createSecureStore(fakeSafeStorage(true, {
    encryptStringAsync: async (s) => {
      if (calls++ === 0) await held;
      return flip(Buffer.from(s, 'utf8'));
    },
  }));
  const older = store.writeText(file, 'older');
  const newer = store.writeText(file, 'newer');
  await tick();
  release();
  await Promise.all([older, newer]);
  assert.equal((await store.readText(file)).text, 'newer');
});

test('remove waits for a write in flight, so a sign-out is not undone', async () => {
  const file = tmpFile();
  let release;
  const held = new Promise((r) => { release = r; });
  const store = ss.createSecureStore(fakeSafeStorage(true, {
    encryptStringAsync: async (s) => { await held; return flip(Buffer.from(s, 'utf8')); },
  }));
  const write = store.writeText(file, TOKEN_JSON);
  const removed = store.remove(file);
  await tick();
  release();
  await Promise.all([write, removed]);
  assert.equal(fs.existsSync(file), false);
});

test('a failed write rejects but does not block the next one', async () => {
  const file = tmpFile();
  let fail = true;
  const store = ss.createSecureStore(fakeSafeStorage(true, {
    encryptStringAsync: async (s) => {
      if (fail) { fail = false; throw new Error('keyring locked'); }
      return flip(Buffer.from(s, 'utf8'));
    },
  }));
  await assert.rejects(store.writeText(file, 'a'), /keyring locked/);
  await store.writeText(file, 'b');
  assert.equal((await store.readText(file)).text, 'b');
});
