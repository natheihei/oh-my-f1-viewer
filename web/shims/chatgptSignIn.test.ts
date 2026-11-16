import { afterEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
// pi-ai's own ChatGPT sign-in, with the http shim as its `node:http`, as in the browser build.
vi.mock('node:http', async () => await import('./http'));
import './http';
import { openaiChatGPTOAuth } from '../../node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js';

const shimFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = shimFetch;
});

describe("pi-ai's ChatGPT sign-in on the http shim", () => {
  it('takes the callback, exchanges the code and closes its server without an error', async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input?.url ?? input);
      if (!url.startsWith('https://auth.openai.com/')) return shimFetch(input, init);
      asked.push(String(init?.body));
      return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', id_token: 'i', expires_in: 3600, scope: asked.scope }), { status: 200 });
    }) as typeof fetch;

    let callback: Promise<Response> | null = null;
    const interaction = {
      signal: new AbortController().signal,
      notify: (event: any) => {
        if (event.type !== 'auth_url') return;
        const url = new URL(event.url);
        (asked as any).scope = url.searchParams.get('scope');
        const back = new URL(url.searchParams.get('redirect_uri') as string);
        back.search = new URLSearchParams({ code: 'the-code', state: url.searchParams.get('state') as string, client_id: 'issued' }).toString();
        // As the sign-in tab's move to the callback address is handed over, in web/backend/agentSignIn.ts.
        callback = Promise.resolve().then(() => fetch(back.href));
      },
      prompt: (p: any) => new Promise<string>((_resolve, reject) => p.signal?.addEventListener('abort', () => reject(new Error('cancelled')))),
    };
    const credential: any = await openaiChatGPTOAuth.login(interaction as never, { getDeviceId: () => '3f2b8c1e-6a4d-4e7f-9b0a-1c2d3e4f5a6b' } as never);

    expect(credential).toMatchObject({ type: 'oauth', access: 'a', refresh: 'r', clientId: 'issued' });
    expect((await (callback as unknown as Promise<Response>)).status).toBe(200);
    expect(asked[0]).toContain('code=the-code');
    // The port is free again for the next sign-in.
    await expect(fetch('http://127.0.0.1:1455/auth/callback')).rejects.toThrow();
  });
});
