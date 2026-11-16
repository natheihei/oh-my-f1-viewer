/** Wires every ipcMain handler `window.f1a` talks to. Glue over the other main-process modules. */
import { session } from 'electron';
import { randomUUID } from 'node:crypto';
import type { F1TvStatus } from '../shared/api';
import type { PlaceHealth } from '../shared/health';
import type { Platform } from './platform';
import { listChannels, listEvents, listSessions, listUpcoming } from './f1tv/catalog';
import { agent } from './agent/agent';
import type { Mods } from './mods';
import { TimingDb } from './timingdb';
import { circuitUrl } from './timingdb/circuit';
import { localToUtc } from '../shared/feedTime';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const f1tv = require('./vendor/f1ov/f1tv-bridge');
const livetiming = require('./vendor/f1ov/livetiming');
const sessionState = require('./vendor/f1ov/session');
const widevine = require('./vendor/f1ov/widevine');
const licenseProxy = require('./vendor/f1ov/licenseProxy');
const { hasFormula1Host, toPositiveInt, rendererPlayback } = require('./vendor/f1ov/util');

const { memSession } = sessionState;

const HEALTH_TIMEOUT_MS = 3000;
const healthWaiting = new Map<string, (places: PlaceHealth[] | null) => void>();

/**
 * How every tile and draft is drawing, as the renderer reports it once each has drawn with its latest
 * code. For the build agent. Null when there's no renderer, or it didn't answer.
 */
function healthOfScreen(platform: Platform): Promise<PlaceHealth[] | null> {
  if (!platform.hasRenderer()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      healthWaiting.delete(id);
      resolve(null);
    }, HEALTH_TIMEOUT_MS);
    healthWaiting.set(id, (places) => {
      clearTimeout(timer);
      healthWaiting.delete(id);
      resolve(places);
    });
    platform.send('mods:healthAsk', id);
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

function createTimingDb(file: string, platform: Platform): TimingDb {
  return new TimingDb({
    file,
    fetchFeed: (sessionPath, feed) => livetiming.fetchSessionFeedText(sessionPath, feed),
    fetchSeasonIndex: (year) => livetiming.getIndex(year),
    fetchPage: async (url) => {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
      return res.text();
    },
    resolveSession: async (year, query) => {
      const found = await livetiming.resolveSessionPath(year, query);
      if (!found || found.meeting?.Key == null || found.session?.Key == null) return null;
      return {
        path: found.path,
        meetingKey: Number(found.meeting.Key),
        sessionKey: Number(found.session.Key),
        type: found.session.Type ?? null,
        name: found.session.Name ?? null,
        endMs: localToUtc(found.session.EndDate, found.session.GmtOffset),
      };
    },
    listUpcoming: async () => {
      await ensureF1Client();
      const seasons = await f1tv.getVodSeasons();
      const current = seasons.find((s: { year: number }) => s.year === new Date().getUTCFullYear());
      return { upcoming: await listUpcoming(seasons), events: current ? await listEvents(current.pageId) : [] };
    },
    // MultiViewer's public API: no sign-in, and nothing sent but the circuit's key and the year.
    fetchCircuit: async (circuitKey, year) => {
      const res = await fetch(circuitUrl(circuitKey, year), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`MultiViewer answered HTTP ${res.status}`);
      return res.json();
    },
    fetchSessionStart: async (meetingKey, sessionKey) => (await livetiming.fetchSyncData(meetingKey, sessionKey))?.sessionStartSec ?? null,
    connectLive: (feeds, onRecord, onStatus) => {
      livetiming
        .connectLiveSocket(
          feeds,
          (feed: string, data: unknown, record: { ts?: string; snapshot?: boolean }) =>
            onRecord({ topic: feed, data, ts: record?.ts, snapshot: record?.snapshot, receivedAt: Date.now() }),
          onStatus,
        )
        .catch((e: Error) => {
          console.warn('[timingdb] live feed:', e?.message);
          onStatus('error');
        });
    },
    disconnectLive: () => livetiming.disconnectLiveSocket(),
    send: (channel, payload) => platform.send(channel, payload),
  });
}

export function setupIpc(databaseFile: string, mods: Mods, platform: Platform): { refreshSchedule(): Promise<void> } {
  const timingDb = createTimingDb(databaseFile, platform);
  const handle: Platform['handle'] = (channel, fn) => platform.handle(channel, fn);

  // --- F1 TV account ---
  handle('f1tv:status', () => f1Status());
  handle('f1tv:login', async () => {
    const token = await platform.login(async (raw: string) => {
      const { subscriptionToken } = f1tv.loginWithToken(raw);
      await sessionState.initClientWithRetry(subscriptionToken);
      return subscriptionToken;
    });
    memSession.accessToken = token;
    await sessionState.persistSession(token);
    void timingDb.refreshSchedule().catch((e: Error) => console.warn('[timingdb] schedule:', e.message));
    return f1Status();
  });
  handle('f1tv:logout', async () => {
    f1tv.clearCatalogCache();
    licenseProxy.clearStreams();
    await sessionState.clearSessionAndCookies();
  });
  sessionState.sessionEvents.on('expired', () => {
    licenseProxy.clearStreams();
    platform.send('f1tv:expired');
  });

  // --- Catalog ---
  handle('f1tv:seasons', async () => {
    await ensureF1Client();
    f1tv.clearCatalogCache();
    return f1tv.getVodSeasons();
  });
  handle('f1tv:events', async (pageId) => {
    await ensureF1Client();
    return listEvents(toPositiveInt(pageId, 'pageId'));
  });
  handle('f1tv:sessions', async (pageId, year) => {
    await ensureF1Client();
    return listSessions(toPositiveInt(pageId, 'pageId'), year ? Number(year) : undefined);
  });
  handle('f1tv:channels', async (contentId) => {
    await ensureF1Client();
    return listChannels(toPositiveInt(contentId, 'contentId'));
  });
  handle('f1tv:liveNow', async () => {
    await ensureF1Client();
    return f1tv.getLiveNow();
  });
  handle('f1tv:upcoming', async () => {
    await ensureF1Client();
    return listUpcoming(await f1tv.getVodSeasons());
  });

  // --- Playback ---
  handle('f1tv:play', (rawContentId, rawChannelId) => {
    const contentId = toPositiveInt(rawContentId, 'contentId');
    const channelId = rawChannelId == null || rawChannelId === '' ? undefined : toPositiveInt(rawChannelId, 'channelId');
    return queueContentPlay(contentId, channelId);
  });
  handle('f1tv:lastLicenseError', (key) => licenseProxy.getLastLicenseError(key));

  // --- Session database ---
  handle('data:schedule', () => timingDb.schedule());
  handle('data:open', (query, live) => timingDb.open(query ?? {}, live === true));
  handle('data:close', () => timingDb.close());
  handle('data:objects', (sessionKey, playheadMs) => timingDb.objects(Number(sessionKey), Number(playheadMs)));
  handle('data:sql', (sessionKey, playheadMs, sql, params) => timingDb.sql(Number(sessionKey), Number(playheadMs), String(sql), Array.isArray(params) ? params : []));

  // --- Agent ---
  handle('ai:status', () => agent.status());
  handle('ai:providers', () => agent.providers());
  handle('ai:connect', (provider, way) => agent.connect(String(provider), way === 'oauth' ? 'oauth' : 'api_key'));
  handle('ai:cancelConnect', () => agent.cancelConnect());
  handle('ai:disconnect', () => agent.disconnect());
  handle('ai:choose', (model, thinking) => agent.choose(String(model), thinking));
  handle('ai:send', (text, context, tools, reference, mode) =>
    agent.send(String(text), String(context ?? ''), Array.isArray(tools) ? tools : [], String(reference ?? ''), mode === 'build' ? 'build' : 'view'),
  );
  handle('ai:endBuild', () => agent.endBuild());
  handle('ai:cancel', () => agent.cancel());
  handle('ai:reset', () => agent.reset());
  platform.on('ai:toolResult', (result) => {
    agent.onToolResult(result);
  });

  // --- Mods ---
  handle('mods:list', () => mods.list());
  platform.on('mods:loaded', (name, version, error) => {
    mods.loaded(String(name), Number(version), error == null ? null : String(error));
  });
  platform.on('mods:log', (name, line) => {
    if (line && typeof line === 'object') mods.log(String(name), line);
  });

  platform.on('mods:health', (id, places) => {
    healthWaiting.get(String(id))?.(Array.isArray(places) ? (places as PlaceHealth[]) : null);
  });

  // --- Build mode ---
  agent.attachMods({
    dir: mods.dir,
    settled: (name) => mods.settled(name),
    logs: (name) => mods.logs(name),
    picture: (name) => platform.picture(name),
    health: () => healthOfScreen(platform),
  });
  handle('build:state', () => mods.buildState());
  handle('build:begin', () => mods.beginBuild());
  handle('build:save', () => mods.saveBuild());
  handle('build:undo', () => mods.undoBuild());

  return { refreshSchedule: () => timingDb.refreshSchedule() };
}
