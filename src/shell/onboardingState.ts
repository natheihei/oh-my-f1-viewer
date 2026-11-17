/**
 * Onboarding: the steps to get from a first launch to watching. It shows on the empty screen until it's
 * finished or skipped, and `/reset-onboarding` brings it back. Once it's over, a sign-in or setup that needs
 * doing again comes to the viewer as a fix block in the palette instead (fixes.ts).
 */
import { create } from 'zustand';
import { host } from '../host';
import { palette } from './palette';
import { loadUiState, saveUiState, type UiStorage } from './uiState';

const KEY = 'onboarded';

/** `pointing`: its last step is open, which is done in the palette, so the palette lights up. */
export const useOnboarding = create<{ active: boolean; pointing: boolean }>(() => ({ active: false, pointing: false }));

/**
 * Whether to show onboarding at start. Once finished or skipped, never again on its own. Before that, a
 * profile that's already set up, from before onboarding existed, counts as finished.
 */
export function shouldOnboard(onboarded: boolean, setUp: boolean): boolean {
  return !onboarded && !setUp;
}

export const onboarding = {
  /** Decides at start whether it shows. Call it once, before reporting what's missing. */
  async start(storage?: UiStorage | null): Promise<void> {
    const onboarded = loadUiState(KEY, (v) => (typeof v === 'boolean' ? v : null), false, storage);
    if (onboarded) return;
    const { f1tv, agent } = await host.account.status();
    if (shouldOnboard(onboarded, f1tv.signedIn && agent.ready)) useOnboarding.setState({ active: true });
    else saveUiState(KEY, true, storage);
  },
  /** Over: by opening a session, or skipped. Either way it doesn't show again on its own. */
  finish(how: 'done' | 'skipped', storage?: UiStorage | null): void {
    if (!useOnboarding.getState().active) return;
    useOnboarding.setState({ active: false });
    saveUiState(KEY, true, storage);
    if (how === 'skipped') palette.push('system', 'Onboarding skipped. /reset-onboarding brings it back.');
  },
  /** `/reset-onboarding`: shows it again, with the steps already done marked so. */
  reset(storage?: UiStorage | null): void {
    saveUiState(KEY, false, storage);
    useOnboarding.setState({ active: true });
  },
};
