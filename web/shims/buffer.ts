/** `buffer`: the `buffer` package, with the constants and web classes Node's module also has. */
/* eslint-disable @typescript-eslint/no-require-imports */
const polyfill = require('f1a-npm:buffer');

// The package predates `base64url`, which sign-in flows encode their PKCE values with.
const BufferClass = polyfill.Buffer;
const toString = BufferClass.prototype.toString;
BufferClass.prototype.toString = function (encoding?: string, ...rest: unknown[]) {
  if (encoding !== 'base64url') return toString.call(this, encoding, ...rest);
  return toString.call(this, 'base64', ...rest).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const from = BufferClass.from;
BufferClass.from = function (value: unknown, encoding?: unknown, length?: unknown) {
  if (typeof value === 'string' && encoding === 'base64url') return from.call(BufferClass, value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return from.call(BufferClass, value, encoding, length);
};
const isEncoding = BufferClass.isEncoding;
BufferClass.isEncoding = (encoding: string) => encoding === 'base64url' || isEncoding.call(BufferClass, encoding);

module.exports = {
  ...polyfill,
  constants: { MAX_LENGTH: 2 ** 31 - 1, MAX_STRING_LENGTH: 2 ** 29 - 24 },
  kMaxLength: 2 ** 31 - 1,
  kStringMaxLength: 2 ** 29 - 24,
  Blob: globalThis.Blob,
  File: globalThis.File,
  atob: globalThis.atob.bind(globalThis),
  btoa: globalThis.btoa.bind(globalThis),
  isUtf8: (input: Uint8Array) => {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(input);
      return true;
    } catch {
      return false;
    }
  },
  isAscii: (input: Uint8Array) => input.every((byte) => byte < 128),
};
