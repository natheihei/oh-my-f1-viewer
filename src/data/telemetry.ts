/** Anonymous usage counts: the renderer's few events, which main checks and sends. See electron/telemetry.ts. */
import { BUILT_IN_TILES, type RendererEvent, type TelemetryProps, type TelemetryStatus } from '../../shared/telemetry';

const api = () => globalThis.window?.omfv?.telemetry;

/** Counts `event`. Never throws, and does nothing outside the app, as in tests. */
export function track<E extends RendererEvent>(event: E, props?: TelemetryProps<E>): void {
  try {
    api()?.track(event, props);
  } catch (e) {
    console.warn('[telemetry]', (e as Error).message);
  }
}

/** A tile's type as it's counted: a mod's is just `mod`. */
export const tileKind = (type: string): TelemetryProps<'tile_added'>['tile'] =>
  (BUILT_IN_TILES as readonly string[]).includes(type) ? (type as (typeof BUILT_IN_TILES)[number]) : 'mod';

export const telemetryInfo = {
  status: (): Promise<TelemetryStatus> => window.omfv.telemetry.status(),
  setEnabled: (enabled: boolean): Promise<TelemetryStatus> => window.omfv.telemetry.setEnabled(enabled),
  needsNotice: (): Promise<boolean> => window.omfv.telemetry.needsNotice(),
  noticed: (): void => window.omfv.telemetry.noticed(),
};
