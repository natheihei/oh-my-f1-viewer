/** Wires every ipcMain handler `window.f1a` talks to. Glue over the other main-process modules. */
import { ipcMain, session, type IpcMainInvokeEvent } from 'electron';
import type { F1TvStatus, TimingSessionRef } from '../shared/api';
import { getMainAppUrl, sendToRenderer } from './windows';
import { fetchSchedule, listChannels, listEvents, listSessions } from './f1tv/catalog';
import { agent } from './agent/agent';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const f1tv = require('./vendor/f1ov/f1tv-bridge');
const livetiming = require('./vendor/f1ov/livetiming');
const sessionState = require('./vendor/f1ov/session');
const widevine = require('./vendor/f1ov/widevine');
const licenseProxy = require('./vendor/f1ov/licenseProxy');
const { openLoginWindow } = require('./vendor/f1ov/loginWindow');
const { hasFormula1Host, toPositiveInt, rendererPlayback } = require('./vendor/f1ov/util');
const { isAppNavigation } = require('./vendor/f1ov/navigationPolicy');

const { memSession } = sessionState;

/** Only the app's own document may use the bridge. */
function isTrusted(evt: { senderFrame?: { url?: string } | null }): boolean {
  const url = evt?.senderFrame?.url;
  return !!url && isAppNavigation(url, getMainAppUrl());
}

function handle(channel: string, fn: (evt: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, (evt, ...args) => {
    if (!isTrusted(evt)) {
      console.warn('[ipc] rejected', channel, 'from untrusted sender');
      throw new Error('Untrusted sender');
    }
    return fn(evt, ...args);
  });
}

function f1Status(): F1TvStatus {
  return { signedIn: !!memSession.accessToken, ready: !!f1tv.isClientReady };
}

/** The saved session restores in the background at startup, so a request can arrive before it's done. */
async function ensureF1Client(): Promise<void> {
  if (f1tv.isClientReady) return;
  if (!memSession.accessToken) throw new Error('Not signed in to F1 TV. Run /login-f1tv.');
  await sessionState.refreshSessionBeforePlayback();
}

/** Spacing between CONTENT/PLAY calls: bursts trigger CloudFront "too much traffic" blocks. */
const CONTENT_PLAY_DELAY_MS = 450;
let contentPlayQueue: Promise<unknown> = Promise.resolve();

function queueContentPlay(contentId: number, channelId?: number): Promise<unknown> {
  const job = contentPlayQueue
    .catch(() => null)
    .then(async () => {
      await widevine.whenCdmReady();
      if (!f1tv.isClientReady) await sessionState.refreshSessionBeforePlayback();
      return f1tv.contentPlay(contentId, channelId);
    })
    .then((result: any) => {
      f1tv.setPlaybackEntitlementOverride(result?.licenseEntitlementToken || null);
      if (result?.playToken) {
        const cdnOrigins = [
          'https://f1tv.formula1.com',
          'https://ott-video-fer-cf.formula1.com',
          'https://ott-video-cf.formula1.com',
        ];
        for (const url of cdnOrigins) {
          session.defaultSession.cookies.set({ url, name: 'playToken', value: result.playToken, path: '/' }).catch(() => {});
        }
      }
      let proxied = false;
      if (result?.licenseUrl?.startsWith('https://') && hasFormula1Host(result.licenseUrl)) {
        const key = licenseProxy.buildStreamKey(result.contentId ?? contentId, result.channelId ?? channelId);
        const proxyUrl = licenseProxy.registerLicenseStream(key, result);
        if (proxyUrl) {
          result.licenseUrl = proxyUrl;
          proxied = true;
        }
      }
      return rendererPlayback(result, proxied);
    });
  const spaced = <T,>(v: T) => new Promise<T>((resolve) => setTimeout(() => resolve(v), CONTENT_PLAY_DELAY_MS));
  contentPlayQueue = job.then(
    (result) => spaced(result),
    (err) => spaced(null).then(() => { throw err; }),
  );
  return contentPlayQueue;
}

export function setupIpc(): void {
  // --- F1 TV account ---
  handle('f1tv:status', () => f1Status());
  handle('f1tv:login', async () => {
    const token = await openLoginWindow(async (raw: string) => {
      const { subscriptionToken } = f1tv.loginWithToken(raw);
      await sessionState.initClientWithRetry(subscriptionToken);
      return subscriptionToken;
    });
    memSession.accessToken = token;
    sessionState.persistSession(token);
    return f1Status();
  });
  handle('f1tv:logout', async () => {
    f1tv.clearCatalogCache();
    licenseProxy.clearStreams();
    await sessionState.clearSessionAndCookies();
  });
  sessionState.sessionEvents.on('expired', () => {
    licenseProxy.clearStreams();
    sendToRenderer('f1tv:expired');
  });

  // --- Catalog ---
  handle('f1tv:seasons', async () => {
    await ensureF1Client();
    f1tv.clearCatalogCache();
    return f1tv.getVodSeasons();
  });
  handle('f1tv:events', async (_e, pageId) => {
    await ensureF1Client();
    return listEvents(toPositiveInt(pageId, 'pageId'));
  });
  handle('f1tv:sessions', async (_e, pageId, year) => {
    await ensureF1Client();
    return listSessions(toPositiveInt(pageId, 'pageId'), year ? Number(year) : undefined);
  });
  handle('f1tv:channels', async (_e, contentId) => {
    await ensureF1Client();
    return listChannels(toPositiveInt(contentId, 'contentId'));
  });
  handle('f1tv:liveNow', async () => {
    await ensureF1Client();
    return f1tv.getLiveNow();
  });
  handle('f1tv:schedule', (_e, year) => fetchSchedule(toPositiveInt(year, 'year')));

  // --- Playback ---
  handle('f1tv:play', (_e, rawContentId, rawChannelId) => {
    const contentId = toPositiveInt(rawContentId, 'contentId');
    const channelId = rawChannelId == null || rawChannelId === '' ? undefined : toPositiveInt(rawChannelId, 'channelId');
    return queueContentPlay(contentId, channelId);
  });
  handle('f1tv:lastLicenseError', (_e, key) => licenseProxy.getLastLicenseError(key));

  // --- Timing ---
  handle('timing:resolve', async (_e, year, query): Promise<TimingSessionRef | null> => {
    const found = await livetiming.resolveSessionPath(year, query);
    if (!found) return null;
    return {
      path: found.path,
      meetingKey: found.meeting?.Key ?? null,
      sessionKey: found.session?.Key ?? null,
      name: found.session?.Name ?? null,
    };
  });
  handle('timing:load', (_e, path) => livetiming.loadSession(path));
  handle('timing:syncData', (_e, meetingKey, sessionKey) => livetiming.fetchSyncData(meetingKey, sessionKey));
  handle('timing:liveStart', async (_e, query = {}) => {
    let path: string | null = null;
    try {
      const found = await livetiming.resolveSessionPath(query.year || new Date().getFullYear(), query);
      path = found ? found.path : null;
    } catch {
      // The archive may not list a session in progress; the live feed still works without it.
    }
    livetiming
      .connectLiveSocket(
        livetiming.DEFAULT_FEEDS,
        (feed: string, data: unknown) => sendToRenderer('timing:liveUpdate', { feed, data }),
        (status: string, detail?: string) => sendToRenderer('timing:liveStatus', { status, detail }),
      )
      .catch((e: Error) => sendToRenderer('timing:liveStatus', { status: 'error', detail: e?.message }));
    return { path };
  });
  handle('timing:liveStop', () => livetiming.disconnectLiveSocket());

  // --- Agent ---
  handle('ai:status', () => agent.status());
  handle('ai:login', () => agent.login());
  handle('ai:logout', () => agent.logout());
  handle('ai:send', (_e, text, context) => agent.send(String(text), String(context ?? '')));
  handle('ai:cancel', () => agent.cancel());
  handle('ai:reset', () => agent.reset());
  ipcMain.on('ai:toolResult', (evt, result) => {
    if (isTrusted(evt)) agent.onToolResult(result);
  });
}
