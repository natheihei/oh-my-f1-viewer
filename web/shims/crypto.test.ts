import nodeCrypto from 'node:crypto';
import { describe, expect, it } from 'vitest';


import shim from './crypto';

describe('the crypto shim', () => {
  it('hashes as Node does', () => {
    for (const name of ['sha1', 'sha256', 'sha512', 'md5']) {
      expect(shim.createHash(name).update('lap ').update(Buffer.from('time')).digest('hex')).toBe(nodeCrypto.createHash(name).update('lap time').digest('hex'));
    }
    expect(shim.createHmac('sha256', 'key').update('data').digest('base64')).toBe(nodeCrypto.createHmac('sha256', 'key').update('data').digest('base64'));
  });

  it('verifies an RS256 signature against a JWK, as the F1 client checks its token', () => {
    const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const data = Buffer.from('header.payload');
    const signature = nodeCrypto.sign('RSA-SHA256', data, privateKey);
    const key = shim.createPublicKey({ key: publicKey.export({ format: 'jwk' }), format: 'jwk' });
    expect(shim.verify('RSA-SHA256', data, key, signature)).toBe(true);
    expect(shim.verify('RSA-SHA256', Buffer.from('header.other'), key, signature)).toBe(false);
    const forged = Buffer.from(signature);
    forged[forged.length - 1] ^= 1;
    expect(shim.verify('RSA-SHA256', data, key, forged)).toBe(false);
    expect(shim.verify('RSA-SHA256', data, key, signature.subarray(1))).toBe(false);
  });

  it('refuses a signature made with another key', () => {
    const ours = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const theirs = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const data = Buffer.from('a.b');
    const key = shim.createPublicKey({ key: ours.publicKey.export({ format: 'jwk' }), format: 'jwk' });
    expect(shim.verify('RSA-SHA256', data, key, nodeCrypto.sign('RSA-SHA256', data, theirs.privateKey))).toBe(false);
  });

  it('makes random values of the size asked', () => {
    expect(shim.randomBytes(70_000)).toHaveLength(70_000);
    expect(shim.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
    expect(shim.timingSafeEqual(Buffer.from('ab'), Buffer.from('ab'))).toBe(true);
    expect(shim.timingSafeEqual(Buffer.from('ab'), Buffer.from('ac'))).toBe(false);
  });
});
