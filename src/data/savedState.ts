/**
 * The app's small UI state, such as the volume, kept by main in the profile's settings file
 * (electron/settings.ts). It's read once at start, held here, and each change is passed on to be saved.
 */

let saved: Record<string, unknown> = {};

const main = () => (globalThis as { window?: Window }).window?.f1a?.settings;

export const savedState = {
  /** Reads what was saved. Call it once, before anything is restored. Nothing saved, or no main process, is empty. */
  async load(): Promise<void> {
    try {
      const values = await main()?.ui();
      saved = values && typeof values === 'object' ? { ...values } : {};
    } catch (e) {
      console.warn('[settings] loading the saved UI state:', (e as Error).message);
      saved = {};
    }
  },
  get: (key: string): unknown => saved[key],
  /** Keeps `value` under `key`. Failing to save only means it won't be restored. */
  set(key: string, value: unknown): void {
    saved[key] = value;
    try {
      main()?.setUi(key, value);
    } catch {
      // A value that can't be sent, or no main process: the app works the same, and starts from defaults next time.
    }
  },
};
