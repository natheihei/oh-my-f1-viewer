/**
 * What pi-ai loads at run time by a name it hides from bundlers, given to it from the bundle instead: its
 * ChatGPT sign-in, and the three Node modules a helper of its asks for when it sees a `process`.
 * `web/build.mjs` rewrites those hidden `import()` calls to `__f1aNodeImport`. Imported for its effects,
 * before the agent is.
 */
import { registerBundledOAuthFlowLoaders } from '../../node_modules/@earendil-works/pi-ai/dist/auth/oauth/load.js';
import { openaiChatGPTOAuth } from '../../node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const BUILTINS: Record<string, () => unknown> = {
  fs: () => require('../shims/fs'),
  'fs/promises': () => require('../shims/fs-promises'),
  os: () => require('../shims/os'),
  path: () => require('path'),
};

Object.assign(globalThis, {
  __f1aNodeImport: async (specifier: string) => {
    const load = BUILTINS[specifier.replace(/^node:/, '')];
    if (!load) throw new Error(`Cannot find module '${specifier}' in the browser`);
    const module = load() as Record<string, unknown>;
    return { ...module, default: module };
  },
});

// The only sign-in supported.ts offers. The others are never asked for.
registerBundledOAuthFlowLoaders({ openaiChatGPT: async () => openaiChatGPTOAuth } as never);
