import { afterEach, describe, expect, it, vi } from 'vitest';
import undici from './undici';

const ARCHIVE = 'https://livetiming.formula1.com/static/2025/race/';

/** A fetch whose responses are finished by hand, to see the order requests go out in. */
function fakeFetch() {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    started.push(input);
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`body of ${input.split('/').pop()}`));
            finish.set(input, () => controller.close());
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
          },
        }),
        { status: 200 },
      ),
    );
  });
  return { started, finish: (name: string) => finish.get(ARCHIVE + name)!() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the undici shim, for the timing archive', () => {
  it('holds a telemetry file until the small files have arrived', async () => {
    const { started, finish } = fakeFetch();
    const small = undici.fetch(ARCHIVE + 'TimingData.jsonStream');
    const large = undici.fetch(ARCHIVE + 'CarData.z.jsonStream');
    await Promise.resolve();
    expect(started).toEqual([ARCHIVE + 'TimingData.jsonStream']);
    finish('TimingData.jsonStream');
    expect(await (await small).text()).toBe('body of TimingData.jsonStream');
    await vi.waitFor(() => expect(started).toHaveLength(2));
    finish('CarData.z.jsonStream');
    expect(await (await large).text()).toBe('body of CarData.z.jsonStream');
  });

  it('sends a telemetry file at once when nothing small is in flight', async () => {
    const { started, finish } = fakeFetch();
    const large = undici.fetch(ARCHIVE + 'Position.z.jsonStream');
    await Promise.resolve();
    expect(started).toHaveLength(1);
    finish('Position.z.jsonStream');
    expect((await large).status).toBe(200);
  });

  it("doesn't pass on the caller's time limit, and gives up only when a download stalls", async () => {
    vi.useFakeTimers();
    const signals: (AbortSignal | undefined)[] = [];
    let push!: (text: string) => void;
    vi.stubGlobal('fetch', (_input: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              push = (text) => controller.enqueue(new TextEncoder().encode(text));
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
            },
          }),
        ),
      );
    });
    const caller = AbortSignal.timeout(30_000);
    const download = undici.fetch(ARCHIVE + 'TimingData.jsonStream', { signal: caller });
    const failed = download.then(() => null, (e: Error) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(signals[0]).not.toBe(caller);
    // Slow, but still arriving: a chunk every 20 seconds, for well over the caller's 30.
    for (let i = 0; i < 4; i++) {
      push('x');
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(signals[0]?.aborted).toBe(true);
    expect((await failed)?.message).toBe('The download stalled.');
  });

  it('leaves every other request as it is', async () => {
    const seen: unknown[] = [];
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      seen.push([input, init]);
      return Promise.resolve(new Response('ok'));
    });
    const signal = AbortSignal.timeout(1000);
    await undici.fetch('https://f1tv.formula1.com/x', { signal, dispatcher: {}, headers: { a: 'b' } } as never);
    expect(seen).toEqual([['https://f1tv.formula1.com/x', { signal, headers: { a: 'b' } }]]);
  });
});
