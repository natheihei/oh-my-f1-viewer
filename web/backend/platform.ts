/**
 * The platform when the app is a browser page: main-process code runs in the page itself, so a call
 * from the renderer is a function call. Values are still copied each way, as IPC copies them, so neither
 * side can change what the other holds.
 */
import type { AgentConnectEvent, AgentEvent, AgentToolCall, AgentToolResult, F1aApi } from '../../shared/api';
import type { BuildState, ModStatus } from '../../shared/mods';
import { toBlob } from 'html-to-image';
import type { Platform } from '../../electron/platform';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { openLoginWindow } = require('../../electron/vendor/f1ov/loginWindow');

type Fn = (...args: any[]) => unknown;

const handlers = new Map<string, Fn>();
const receivers = new Map<string, Fn[]>();
const listeners = new Map<string, Set<Fn>>();

const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`);
  try {
    return copy(await handler(...copy(args))) as T;
  } catch (e) {
    console.warn(`[platform] ${channel} failed:`, e);
    // The words Electron puts in front, which the renderer already takes off.
    throw new Error(`Error invoking remote method '${channel}': ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
}

function post(channel: string, ...args: unknown[]): void {
  const copied = copy(args);
  // Later, as IPC delivers: a caller never runs main-process code inside its own call.
  queueMicrotask(() => {
    for (const receive of receivers.get(channel) ?? []) {
      try {
        receive(...copied);
      } catch (e) {
        console.error(`[platform] ${channel} failed`, e);
      }
    }
  });
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  let set = listeners.get(channel);
  if (!set) listeners.set(channel, (set = new Set()));
  set.add(cb as Fn);
  return () => void set.delete(cb as Fn);
}

/**
 * A PNG of a component as the page shows it now: its tile if it has one, else its preview in the strip.
 * Drawn in the page from the element itself, because capturing the tab would need the extension to ask
 * for access to every site. A canvas is copied as it is. Protected video comes out black, as the browser
 * gives its frames to nothing but the screen.
 */
async function pictureOf(name: string): Promise<Buffer | null> {
  const el = document.querySelector<HTMLElement>(`[data-tile-type="${CSS.escape(name)}"]`) ?? document.querySelector<HTMLElement>(`[data-draft-type="${CSS.escape(name)}"]`);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  try {
    const blob = await toBlob(el, {
      pixelRatio: window.devicePixelRatio || 1,
      backgroundColor: '#000',
      cacheBust: false,
      width: Math.round(box.width),
      height: Math.round(box.height),
      // A tile is placed on the stage by its position and a transform: the copy is drawn at the picture's corner.
      style: { position: 'static', transform: 'none', left: '0', top: '0', margin: '0', inset: 'auto' },
    });
    return blob ? Buffer.from(await blob.arrayBuffer()) : null;
  } catch (e) {
    console.warn('[platform] picture:', (e as Error).message);
    return null;
  }
}

export const pagePlatform: Platform = {
  handle(channel, fn) {
    handlers.set(channel, fn);
  },
  on(channel, fn) {
    receivers.set(channel, [...(receivers.get(channel) ?? []), fn]);
  },
  send(channel, payload) {
    const set = listeners.get(channel);
    if (!set?.size) return;
    const copied = copy(payload);
    queueMicrotask(() => {
      for (const listener of [...set]) {
        try {
          listener(copied);
        } catch (e) {
          console.error(`[platform] ${channel} listener failed`, e);
        }
      }
    });
  },
  hasRenderer: () => true,
  login: (validate) => openLoginWindow(validate),
  picture: pictureOf,
};

/** `window.f1a`, channel for channel what electron/preload.ts exposes. */
export const api: F1aApi = {
  f1tv: {
    status: () => invoke('f1tv:status'),
    login: () => invoke('f1tv:login'),
    logout: () => invoke('f1tv:logout'),
    onExpired: (cb) => subscribe('f1tv:expired', cb),
    seasons: () => invoke('f1tv:seasons'),
    events: (seasonPageId) => invoke('f1tv:events', seasonPageId),
    sessions: (eventPageId, year) => invoke('f1tv:sessions', eventPageId, year),
    channels: (contentId) => invoke('f1tv:channels', contentId),
    liveNow: () => invoke('f1tv:liveNow'),
    upcoming: () => invoke('f1tv:upcoming'),
    play: (contentId, channelId) => invoke('f1tv:play', contentId, channelId),
    lastLicenseError: (streamKey) => invoke('f1tv:lastLicenseError', streamKey),
  },
  data: {
    schedule: () => invoke('data:schedule'),
    onSchedule: (cb) => subscribe('data:schedule', cb),
    open: (query, live) => invoke('data:open', query, live),
    close: () => invoke('data:close'),
    onStatus: (cb) => subscribe('data:status', cb),
    onCircuit: (cb) => subscribe('data:circuit', cb),
    objects: (sessionKey, playheadMs) => invoke('data:objects', sessionKey, playheadMs),
    sql: (sessionKey, playheadMs, sql, params) => invoke('data:sql', sessionKey, playheadMs, sql, params),
  },
  ai: {
    status: () => invoke('ai:status'),
    providers: () => invoke('ai:providers'),
    connect: (provider, way) => invoke('ai:connect', provider, way),
    cancelConnect: () => invoke('ai:cancelConnect'),
    onConnect: (cb) => subscribe<AgentConnectEvent>('ai:connect', cb),
    disconnect: () => invoke('ai:disconnect'),
    choose: (model, thinking) => invoke('ai:choose', model, thinking),
    send: (text, context, tools, reference, mode) => invoke('ai:send', text, context, tools, reference, mode),
    endBuild: () => invoke('ai:endBuild'),
    cancel: () => invoke('ai:cancel'),
    reset: () => invoke('ai:reset'),
    onEvent: (cb) => subscribe<AgentEvent>('ai:event', cb),
    onToolCall: (cb) => subscribe<AgentToolCall>('ai:toolCall', cb),
    toolResult: (result: AgentToolResult) => post('ai:toolResult', result),
  },
  mods: {
    list: () => invoke('mods:list'),
    onChanged: (cb) => subscribe<ModStatus[]>('mods:changed', cb),
    loaded: (name, version, error) => post('mods:loaded', name, version, error),
    log: (name, line) => post('mods:log', name, line),
    onHealthAsked: (cb) => subscribe<string>('mods:healthAsk', cb),
    health: (id, places) => post('mods:health', id, places),
  },
  build: {
    state: () => invoke('build:state'),
    onChanged: (cb) => subscribe<BuildState>('build:changed', cb),
    begin: () => invoke('build:begin'),
    save: () => invoke('build:save'),
    undo: () => invoke('build:undo'),
  },
};
