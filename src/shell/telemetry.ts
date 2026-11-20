/**
 * What the palette says about the anonymous usage counts: once, the first time they'd be sent, and whenever
 * `/settings-usage` is run. Nothing is sent before the notice has shown. See electron/telemetry.ts.
 */
import type { TelemetryStatus } from '../../shared/telemetry';
import { host } from '../host';
import { palette } from './palette';

/** In the maker's own words: the counts are why it's worth carrying on, not a policy. */
export const NOTICE =
  'OMFV is open source, and knowing people use it is what keeps me going. It sends anonymous usage counts so I can see what to improve, never who you are or what you type. /settings-usage off turns them off.';

export const THANKS = 'Thanks for helping me see how OMFV is used.';

/** Says once that it's on, then lets main send. */
export async function showTelemetryNotice(): Promise<void> {
  try {
    if (!(await host.telemetry.needsNotice())) return;
    palette.push('system', NOTICE);
    host.telemetry.noticed();
  } catch (e) {
    console.warn('[telemetry]', (e as Error).message);
  }
}

/** How it stands, in the palette's words. */
export function statusLine(status: TelemetryStatus): string {
  if (status.blocked === 'environment') return 'Usage counts are off: OMFV_TELEMETRY=0 or DO_NOT_TRACK is set.';
  if (status.blocked === 'no-key') return "Usage counts aren't set up in this build.";
  if (!status.enabled) return 'Usage counts are off. If you change your mind, /settings-usage on turns them on again, with a new id.';
  return `Usage counts are on. ${THANKS}`;
}

/** `/settings-usage`, with `on`, `off`, or nothing to say how it stands. */
export async function runTelemetryCommand(text: string): Promise<void> {
  const word = text.trim().toLowerCase();
  if (word && word !== 'on' && word !== 'off') {
    palette.push('error', 'Use /settings-usage on, /settings-usage off, or /settings-usage alone to see how it stands.');
    return;
  }
  const status = word ? await host.telemetry.setEnabled(word === 'on') : await host.telemetry.status();
  palette.push('system', word === 'off' ? 'Usage counts are off.' : statusLine(status));
}
