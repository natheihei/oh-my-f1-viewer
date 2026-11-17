import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiStorage } from './uiState';

// The host pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));

const { onboarding, shouldOnboard, useOnboarding } = await import('./onboardingState');
const { host } = await import('../host');
const { usePalette } = await import('./palette');
const { errorText } = await import('./commands');

function memory(values: Record<string, unknown> = {}): UiStorage & { values: Record<string, unknown> } {
  return { values, get: (k) => values[k], set: (k, v) => void (values[k] = v) };
}

function setUp(signedIn: boolean, ready: boolean) {
  vi.spyOn(host.account, 'status').mockResolvedValue({
    f1tv: { signedIn, ready: signedIn },
    agent: { ready, provider: null, model: null, modelName: null, thinking: null },
  });
}

describe('onboarding', () => {
  beforeEach(() => {
    useOnboarding.setState({ active: false });
    usePalette.setState({ entries: [] });
    vi.restoreAllMocks();
  });

  it('shows until finished, unless the profile is already set up', () => {
    expect(shouldOnboard(false, false)).toBe(true);
    expect(shouldOnboard(false, true)).toBe(false);
    expect(shouldOnboard(true, false)).toBe(false);
  });

  it('shows on a first launch', async () => {
    setUp(false, false);
    const storage = memory();
    await onboarding.start(storage);
    expect(useOnboarding.getState().active).toBe(true);
  });

  it("doesn't show for a profile set up before onboarding existed, and remembers that", async () => {
    setUp(true, true);
    const storage = memory();
    await onboarding.start(storage);
    expect(useOnboarding.getState().active).toBe(false);
    expect(storage.values.onboarded).toBe(true);
  });

  it("doesn't show again once finished, even if a sign-in is gone", async () => {
    setUp(false, false);
    await onboarding.start(memory({ onboarded: true }));
    expect(useOnboarding.getState().active).toBe(false);
  });

  it('skipped, says how to bring it back; finished by opening a session, says nothing', () => {
    const storage = memory();
    useOnboarding.setState({ active: true });
    onboarding.finish('skipped', storage);
    expect(storage.values.onboarded).toBe(true);
    expect(usePalette.getState().entries.at(-1)?.text).toMatch('/reset-onboarding');

    usePalette.setState({ entries: [] });
    useOnboarding.setState({ active: true });
    onboarding.finish('done', storage);
    expect(useOnboarding.getState().active).toBe(false);
    expect(usePalette.getState().entries).toEqual([]);
  });

  it('/reset-onboarding shows it again', () => {
    const storage = memory({ onboarded: true });
    onboarding.reset(storage);
    expect(useOnboarding.getState().active).toBe(true);
    expect(storage.values.onboarded).toBe(false);
  });
});

describe('errorText', () => {
  it("names OMFV's own command where F1 TV's code names a button OMFV doesn't have", () => {
    const e = new Error(`Error invoking remote method 'f1tv:play': Error: Session expired or invalid. Please sign in again (e.g. "Sign in with browser") and retry.`);
    expect(errorText(e)).toBe('Session expired or invalid. Sign in again with /login-f1tv.');
  });
});
