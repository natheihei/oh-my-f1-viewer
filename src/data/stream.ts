/**
 * One video of a channel: a <video> and its Shaka player, for one holder. This object owns the element and lives
 * outside React, so moving a tile around the layout can never restart or pause a stream.
 * Ported from F1OpenViewer's ShakaVideo, which holds the hard-won DRM and live-edge behaviour.
 */
import shaka from 'shaka-player/dist/shaka-player.compiled-es2021';
import type { Channel, PlaybackInfo } from '../../shared/api';
import type { JoinPoint } from './join';

export type StreamStatus = 'resolving' | 'loading' | 'syncing' | 'ready' | 'error';

const LOAD_TIMEOUT_MS = 45_000;
/**
 * The CDN sometimes stops answering for 10s or more. Shaka's defaults abort after 5s without progress
 * and retry at once, which only adds load while it's struggling, so this waits it out instead.
 */
const RETRY: shaka.extern.RetryParameters = {
  maxAttempts: 6,
  baseDelay: 1000,
  backoffFactor: 2,
  fuzzFactor: 0.5,
  timeout: 45_000,
  stallTimeout: 20_000,
  connectionTimeout: 20_000,
};
/**
 * How far behind the live edge to sit. Measured on a live race: 2.2s back starves the buffers, so
 * onboards drift over a second and stay at low quality, while 7-8s back holds 0.04s at full quality.
 */
export const LIVE_EDGE_OFFSET_SEC = 8;
/** How far from that target a join may land before it gets corrected. */
const LIVE_EDGE_TOLERANCE_SEC = 2;
/** The very start of a DVR window can already be gone by the time a seek lands. */
export const LIVE_START_MARGIN_SEC = 3;
const WALL_CLOCK_MIN_MS = 9.46e11; // after year 2000: HLS reports 1970-epoch garbage
const SHAKA_LOAD_INTERRUPTED = 7000;
const SHAKA_LOAD_DESTROYED = 7002;
/** Network failures worth another try: bad request, HTTP error, timeout. */
const RECOVERABLE_CODES = new Set([1001, 1002, 1003]);
const MAX_RECOVERIES = 2;
const RECOVERY_DELAY_MS = 1500;
const LOAD_TIMEOUT_MESSAGE = 'The stream took too long to start.';

let polyfilled = false;

function drmHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}`, drmtoken: token } : {};
}

function streamKeyOf(licenseUrl: string | undefined): string | undefined {
  if (!licenseUrl?.includes('/la?')) return undefined;
  try {
    return new URL(licenseUrl).searchParams.get('stream') ?? undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StreamOptions {
  /** Where to start, read each time loading begins. */
  join: () => JoinPoint;
  /** The session's position, for joining at the clock. */
  clockTime: () => number;
  /** Called on every status change. */
  onChange: () => void;
}

export class StreamHandle {
  readonly video: HTMLVideoElement;
  status: StreamStatus = 'resolving';
  error: string | null = null;

  private player: shaka.Player | null = null;
  private destroyed = false;
  private maxHeight: number | null = null;
  private playback: PlaybackInfo | null = null;
  private recoveries = 0;

  constructor(
    /** The video's id: one per holder, so a feed shown twice is two of these. */
    readonly id: string,
    readonly channel: Channel,
    private readonly options: StreamOptions,
  ) {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = false;
    video.className = 'stream-video';
    video.dataset.channel = channel.id;
    video.dataset.video = id;
    this.video = video;
  }

  private setStatus(status: StreamStatus, error: string | null = null): void {
    if (this.destroyed) return;
    this.status = status;
    this.error = error;
    this.options.onChange();
  }

  markSyncing(): void {
    if (this.status === 'ready') this.setStatus('syncing');
  }

  markReady(): void {
    if (this.status !== 'syncing') return;
    this.recoveries = 0;
    this.setStatus('ready');
  }

  get hasMedia(): boolean {
    return this.status === 'syncing' || this.status === 'ready';
  }

  async start(): Promise<void> {
    try {
      const { contentId, channelId } = this.channel;
      this.playback = await window.f1a.f1tv.play(contentId, channelId);
      if (this.destroyed) return;
      if (!this.playback?.manifestUrl) throw new Error('F1 TV returned no stream for this channel.');
      this.setStatus('loading');
      const join = this.options.join();
      await this.attachAndLoad(this.playback, join === 'clock' ? this.options.clockTime() : undefined);
      if (this.destroyed) return;
      if (this.isLiveNow() && join === 'live-edge') await this.settleAt((r) => Math.max(r.start, r.end - LIVE_EDGE_OFFSET_SEC));
      if (this.isLiveNow() && join === 'live-start') await this.settleAt((r) => r.start + LIVE_START_MARGIN_SEC);
      this.setStatus('syncing');
    } catch (e) {
      const code = (e as { code?: number })?.code;
      if (this.destroyed || code === SHAKA_LOAD_DESTROYED || code === SHAKA_LOAD_INTERRUPTED) return;
      await this.fail(e);
    }
  }

  /**
   * Passing network trouble shouldn't kill a tile. Fetch a fresh playback URL and rejoin the clock,
   * a couple of times, before showing the error.
   */
  private async fail(e: unknown): Promise<void> {
    const code = (e as { code?: number })?.code;
    const recoverable =
      (code != null && RECOVERABLE_CODES.has(code)) || (e instanceof Error && e.message === LOAD_TIMEOUT_MESSAGE);
    if (!recoverable || this.recoveries >= MAX_RECOVERIES) {
      this.setStatus('error', await this.describeError(e));
      return;
    }
    this.recoveries += 1;
    console.warn(`[stream] ${this.channel.label}: recovering from ${code ?? 'load timeout'}, attempt ${this.recoveries}`);
    this.setStatus('resolving');
    const player = this.player;
    this.player = null;
    await player?.destroy().catch(() => {});
    await sleep(RECOVERY_DELAY_MS * this.recoveries);
    if (!this.destroyed) await this.start();
  }

  private async attachAndLoad(playback: PlaybackInfo, startAt: number | undefined): Promise<void> {
    if (!polyfilled) {
      shaka.polyfill.installAll();
      polyfilled = true;
    }
    if (!shaka.Player.isBrowserSupported()) throw new Error('This browser build cannot play F1 TV streams.');

    const player = new shaka.Player();
    this.player = player;
    await player.attach(this.video);
    if (this.destroyed) {
      void player.destroy().catch(() => {});
      return;
    }

    player.addEventListener('error', (evt) => {
      void (async () => {
        const detail = (evt as unknown as { detail?: shaka.util.Error }).detail;
        if (this.destroyed || detail?.code === SHAKA_LOAD_DESTROYED) return;
        // Only critical errors end a stream: Shaka retries the rest by itself.
        if (detail && detail.severity !== shaka.util.Error.Severity.CRITICAL) return;
        // A second failure can land while this one is already being handled.
        if (this.status === 'resolving' || this.status === 'error') return;
        await this.fail(detail);
      })();
    });

    try {
      await this.load(player, playback.manifestUrl, playback.licenseUrl, playback.drmToken, startAt);
    } catch (e) {
      const code = (e as { code?: number })?.code;
      const canFallback = code === 6001 && playback.fallbackManifestUrl;
      if (!canFallback) throw e;
      await this.load(
        player,
        playback.fallbackManifestUrl!,
        playback.fallbackLicenseUrl ?? '',
        playback.fallbackDrmToken,
        startAt,
      );
    }
  }

  private configure(player: shaka.Player, licenseUrl: string): void {
    const config: shaka.extern.PlayerConfiguration | Record<string, unknown> = {
      streaming: {
        bufferingGoal: 12,
        rebufferingGoal: 3,
        bufferBehind: 15, // default 30s per tile adds up with many streams
        returnToEndOfLiveWindowWhenOutside: true,
        liveSync: { enabled: false },
        retryParameters: RETRY,
      },
      manifest: { retryParameters: RETRY },
      abr: { restrictions: { maxHeight: this.maxHeight ?? Infinity } },
      drm: {
        retryParameters: RETRY,
        ...(licenseUrl.trim() ? { servers: { 'com.widevine.alpha': licenseUrl } } : {}),
      },
    };
    player.configure(config as shaka.extern.PlayerConfiguration);
  }

  private async load(
    player: shaka.Player,
    manifestUrl: string,
    licenseUrl: string,
    drmToken: string | undefined,
    startAt: number | undefined,
  ): Promise<void> {
    this.configure(player, licenseUrl);

    const net = player.getNetworkingEngine();
    if (net) {
      net.clearAllRequestFilters();
      net.clearAllResponseFilters();
      const { MANIFEST, LICENSE } = shaka.net.NetworkingEngine.RequestType;
      const headers = drmHeaders(drmToken);
      net.registerRequestFilter((type, request) => {
        if (type === LICENSE) Object.assign(request.headers, headers);
      });
      if (!licenseUrl.trim()) {
        // Some recent replays are served in the clear yet still advertise DRM in the manifest.
        net.registerResponseFilter((type, response) => {
          if (type !== MANIFEST) return;
          const text = new TextDecoder().decode(response.data);
          const stripped = text.replace(/<ContentProtection[^>]*(?:\/>|>[\s\S]*?<\/ContentProtection>)/gi, '');
          response.data = new TextEncoder().encode(stripped).buffer;
        });
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void player.unload().catch(() => {});
        reject(new Error(LOAD_TIMEOUT_MESSAGE));
      }, LOAD_TIMEOUT_MS);
    });
    try {
      const load = startAt != null ? player.load(manifestUrl, startAt) : player.load(manifestUrl);
      await Promise.race([load, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private isLiveNow(): boolean {
    try {
      return !!this.player?.isLive();
    } catch {
      return false;
    }
  }

  /**
   * Live manifests can report a wall-clock timeline and no usable seek range right after load, and
   * one seek to an unbuffered position can leave a black paused frame, so this keeps trying until
   * playback really advances.
   */
  private async settleAt(targetIn: (range: { start: number; end: number }) => number): Promise<void> {
    const deadline = Date.now() + 10_000;
    let lastTime = -1;
    let progressTicks = 0;
    while (Date.now() < deadline && !this.destroyed) {
      const range = this.seekRange();
      if (range) {
        const target = targetIn(range);
        if (!Number.isFinite(this.video.currentTime) || Math.abs(this.video.currentTime - target) > LIVE_EDGE_TOLERANCE_SEC) {
          this.video.currentTime = target;
        }
        if (this.video.paused) await this.video.play().catch(() => {});
      }
      if (!this.video.paused && Number.isFinite(this.video.currentTime)) {
        if (lastTime >= 0 && this.video.currentTime > lastTime + 0.05) {
          progressTicks += 1;
          if (progressTicks >= 2) return;
        }
        lastTime = this.video.currentTime;
      }
      await sleep(300);
    }
  }

  /** The stream's own seek window: the full replay, or the DVR window when live. */
  seekRange(): { start: number; end: number } | null {
    try {
      const r = this.player?.seekRange();
      if (r && Number.isFinite(r.end) && r.end > r.start) return { start: r.start, end: r.end };
    } catch {
      // Not attached yet.
    }
    try {
      const s = this.video.seekable;
      if (s.length > 0) return { start: s.start(0), end: s.end(s.length - 1) };
    } catch {
      // Not attached yet.
    }
    return null;
  }

  /** UTC of the current frame from the DASH timeline, or null when the stream has no real clock. */
  wallClockMs(): number | null {
    try {
      const d = this.player?.getPlayheadTimeAsDate();
      if (d instanceof Date) {
        const ms = d.getTime();
        if (Number.isFinite(ms) && ms > WALL_CLOCK_MIN_MS) return ms;
      }
    } catch {
      // Not attached yet.
    }
    return null;
  }

  isLive(): boolean {
    return this.isLiveNow();
  }

  /** Cap quality to what the tile can show, so a small onboard does not pull 1080p. */
  setDisplayHeight(px: number): void {
    const tiers = [360, 540, 720, 1080];
    const want = Math.ceil(px * (window.devicePixelRatio || 1));
    const cap = tiers.find((t) => t >= want) ?? Infinity;
    if (cap === this.maxHeight) return;
    this.maxHeight = cap;
    this.player?.configure({ abr: { restrictions: { maxHeight: cap } } } as unknown as shaka.extern.PlayerConfiguration);
  }

  private async describeError(e: unknown): Promise<string> {
    const code = (e as { code?: number })?.code;
    if (code === 1001 || code === 6001 || code === 6007 || code === 6012) {
      const key = streamKeyOf(this.playback?.licenseUrl);
      const f1Message = await window.f1a.f1tv.lastLicenseError(key).catch(() => '');
      if (f1Message?.trim()) return `F1 TV: ${f1Message.trim()}`;
    }
    switch (code) {
      case 1001:
        return 'The stream could not be downloaded (network or session problem).';
      case 6001:
        return 'DRM is not available: the Widevine CDM may still be installing.';
      case 6007:
        return 'F1 TV refused the DRM license.';
      case 6012:
        return 'No license server is available for this stream.';
      default:
        break;
    }
    const message = e instanceof Error ? e.message : (e as { message?: string })?.message;
    // Electron wraps main-process errors in this prefix.
    const clean = message?.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '').trim();
    return clean || (code ? `Playback failed (Shaka ${code}).` : 'Playback failed.');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const { video, player } = this;
    this.player = null;
    try {
      video.pause();
    } catch {
      // Already torn down.
    }
    void player?.destroy().catch(() => {});
    video.removeAttribute('src');
    video.remove();
  }
}
