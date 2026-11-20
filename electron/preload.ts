import { contextBridge, ipcRenderer } from 'electron';
import type { AgentConnectEvent, AgentEvent, AgentToolCall, AgentToolResult, OmfvApi } from '../shared/api';
import type { BuildState, ModStatus } from '../shared/mods';
import type { UpdateState } from '../shared/release';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T) => {
    try {
      cb(payload);
    } catch (e) {
      console.error(`[preload] ${channel} listener failed`, e);
    }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: OmfvApi = {
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
  app: {
    version: () => invoke('app:version'),
    update: () => invoke('app:update'),
    onUpdate: (cb) => subscribe<UpdateState>('app:update', cb),
    whatsNew: () => invoke('app:whats-new'),
  },
  settings: {
    ui: () => invoke('settings:ui'),
    setUi: (key, value) => ipcRenderer.send('settings:setUi', key, value),
  },
  ai: {
    status: () => invoke('ai:status'),
    providers: () => invoke('ai:providers'),
    connect: (provider, way) => invoke('ai:connect', provider, way),
    cancelConnect: () => invoke('ai:cancelConnect'),
    onConnect: (cb) => subscribe<AgentConnectEvent>('ai:connect', cb),
    disconnect: () => invoke('ai:disconnect'),
    choose: (model, thinking) => invoke('ai:choose', model, thinking),
    send: (text, context, tools, reference, mode, scope) => invoke('ai:send', text, context, tools, reference, mode, scope),
    endBuild: () => invoke('ai:endBuild'),
    cancel: () => invoke('ai:cancel'),
    reset: () => invoke('ai:reset'),
    onEvent: (cb) => subscribe<AgentEvent>('ai:event', cb),
    onToolCall: (cb) => subscribe<AgentToolCall>('ai:toolCall', cb),
    toolResult: (result: AgentToolResult) => ipcRenderer.send('ai:toolResult', result),
  },
  mods: {
    list: () => invoke('mods:list'),
    onChanged: (cb) => subscribe<ModStatus[]>('mods:changed', cb),
    loaded: (name, version, error) => ipcRenderer.send('mods:loaded', name, version, error),
    log: (name, line) => ipcRenderer.send('mods:log', name, line),
    onHealthAsked: (cb) => subscribe<string>('mods:healthAsk', cb),
    health: (id, places) => ipcRenderer.send('mods:health', id, places),
    onPictureAsked: (cb) => subscribe<{ id: string; type: string }>('mods:pictureAsk', cb),
    picture: (id, result) => ipcRenderer.send('mods:picture', id, result),
  },
  build: {
    state: () => invoke('build:state'),
    onChanged: (cb) => subscribe<BuildState>('build:changed', cb),
    begin: () => invoke('build:begin'),
    save: () => invoke('build:save'),
    undo: () => invoke('build:undo'),
  },
};

contextBridge.exposeInMainWorld('omfv', api);
