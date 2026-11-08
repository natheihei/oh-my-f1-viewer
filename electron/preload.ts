import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent, AgentToolCall, AgentToolResult, F1aApi, LiveTimingStatus } from '../shared/api';

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

const api: F1aApi = {
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
  timing: {
    resolve: (year, query) => invoke('timing:resolve', year, query),
    load: (path) => invoke('timing:load', path),
    syncData: (meetingKey, sessionKey) => invoke('timing:syncData', meetingKey, sessionKey),
    liveStart: (query) => invoke('timing:liveStart', query),
    liveStop: () => invoke('timing:liveStop'),
    onLiveUpdate: (cb) => subscribe<{ feed: string; data: unknown }>('timing:liveUpdate', cb),
    onLiveStatus: (cb) => subscribe<LiveTimingStatus>('timing:liveStatus', cb),
  },
  ai: {
    status: () => invoke('ai:status'),
    login: () => invoke('ai:login'),
    logout: () => invoke('ai:logout'),
    send: (text, context) => invoke('ai:send', text, context),
    cancel: () => invoke('ai:cancel'),
    reset: () => invoke('ai:reset'),
    onEvent: (cb) => subscribe<AgentEvent>('ai:event', cb),
    onToolCall: (cb) => subscribe<AgentToolCall>('ai:toolCall', cb),
    toolResult: (result: AgentToolResult) => ipcRenderer.send('ai:toolResult', result),
  },
};

contextBridge.exposeInMainWorld('f1a', api);
