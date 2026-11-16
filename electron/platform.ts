/**
 * What the main-process services need from whatever shows the app: Electron's window, or the page itself
 * in the browser build, where they run in it (`web/backend`). `ipc.ts` is written against this, so both
 * run the same handlers. See docs/WEB.md.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Platform {
  /** A call the renderer awaits. */
  handle(channel: string, fn: (...args: any[]) => unknown): void;
  /** A one-way message from the renderer. */
  on(channel: string, fn: (...args: any[]) => void): void;
  /** A one-way message to the renderer. Dropped when there's none. */
  send(channel: string, payload?: unknown): void;
  hasRenderer(): boolean;
  /**
   * Runs the F1 TV sign-in and resolves to the subscription token. `validate` takes a captured token,
   * starts the F1 client with it, and throws if F1 refuses it.
   */
  login(validate: (token: string) => Promise<string>): Promise<string>;
  /** A PNG of a component as the renderer shows it now, or null when it's not on screen. */
  picture(name: string): Promise<Buffer | null>;
}
