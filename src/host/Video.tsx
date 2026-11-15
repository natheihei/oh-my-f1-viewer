/**
 * Shows a feed, the way a Herdr mod shows a live terminal. `useStream` holds one video of a feed:
 * each call is its own video and stream, so a feed can show in several places at once, and they play
 * independently. `<Video stream />` draws one, with its own status while it isn't ready, and a click
 * on it makes it the one video heard. Inside a `PreviewScope` the video is quiet: it's never heard.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { sessionControl } from '../data/session';
import type { StreamStatus } from '../data/stream';
import { useLive } from './live';
import { useTilePlace, type TileHeader } from './tile';

const Preview = createContext(false);

/** Marks what's inside as a preview: it shows feeds without taking their audio. */
export function PreviewScope({ children }: { children: ReactNode }) {
  return <Preview.Provider value={true}>{children}</Preview.Provider>;
}

/** One video of a feed, as `useStream` holds it. Plain data: pass it to `<Video stream />` to draw it. */
export interface Stream {
  /** The video's id, as `live.streams` and `live.audio` name it. Null until it starts, or with no session open. */
  id: string | null;
  feed: string;
  /** The feed's name, such as "F1 Live" or "Lewis Hamilton". */
  label: string;
  status: StreamStatus;
  error: string | null;
  /** This video is the one heard: 'on', or 'muted' while the volume is 0. Null when it isn't heard. */
  heard: 'on' | 'muted' | null;
  /** A preview's video, which is never heard. */
  quiet: boolean;
}

/**
 * Holds one video of a feed while the component is drawn, and gives it back after. Null or no feed
 * holds nothing: that picture is empty. `slot` names which of the component's pictures this is, so when
 * a picture that's heard switches feed, the sound stays with it.
 */
export function useStream(feed: string | null | undefined, { slot }: { slot?: string } = {}): Stream | null {
  const quiet = useContext(Preview);
  const place = useTilePlace();
  const tile = place?.where === 'tile' ? place.scope : null;
  const session = useLive((s) => s.session?.contentId ?? null);
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    if (!feed || session == null) return;
    const handle = sessionControl.acquire(feed, { quiet, tile, slot: slot ?? null });
    setId(handle?.id ?? null);
    if (!handle) return;
    return () => sessionControl.release(handle);
  }, [feed, quiet, tile, slot, session]);

  const view = useLive((s) => (id != null ? s.streams[id] : undefined));
  const heard = useLive((s) => id != null && s.audio === id);
  const muted = useLive((s) => s.volume === 0);
  const label = useLive((s) => s.feeds.find((c) => c.id === feed)?.label ?? feed ?? '');
  // The video still named is the last feed's until the new one starts.
  const current = view && view.feed === feed ? view : undefined;
  return useMemo(
    () =>
      feed
        ? {
            id: current?.id ?? null,
            feed,
            label,
            status: current?.status ?? 'resolving',
            error: current?.error ?? null,
            heard: current && heard ? (muted ? 'muted' : 'on') : null,
            quiet,
          }
        : null,
    [feed, label, current, heard, muted, quiet],
  );
}

/** How many videos that can be heard each place draws, so a picture says it's the one heard where that isn't obvious. */
const useVideoCounts = create<{ counts: Record<string, number> }>(() => ({ counts: {} }));

function countVideo(scope: string, by: number): void {
  useVideoCounts.setState((s) => ({ counts: { ...s.counts, [scope]: Math.max(0, (s.counts[scope] ?? 0) + by) } }));
}

const STATUS_TEXT: Partial<Record<StreamStatus, string>> = { resolving: 'connecting…', loading: 'loading…', syncing: 'syncing…' };

/**
 * Draws a video: `stream` from `useStream`, or `feed` to hold one itself. It fills the box it's given
 * and letterboxes the picture. Until the video is ready it shows the feed's name and status instead;
 * once shown, it stays through seeks. A click makes it the video heard, and brings the volume back if
 * it's at 0. A preview's video takes no clicks: a click there adds the tile.
 */
export function Video(props: { stream: Stream | null; className?: string } | { feed: string; slot?: string; className?: string }) {
  if ('feed' in props) return <OwnVideo feed={props.feed} slot={props.slot} className={props.className} />;
  return <StreamVideo stream={props.stream} className={props.className} />;
}

function OwnVideo({ feed, slot, className }: { feed: string; slot?: string; className?: string }) {
  const stream = useStream(feed, { slot });
  return <StreamVideo stream={stream} className={className} />;
}

function StreamVideo({ stream, className = '' }: { stream: Stream | null; className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const id = stream?.id ?? null;
  const ready = stream?.status === 'ready';
  const [revealed, setRevealed] = useState<string | null>(null);
  const scope = useTilePlace()?.scope ?? null;
  const counted = stream != null && !stream.quiet && scope != null;
  // With two pictures or more in a tile, the one heard says so on itself; with one, the title bar does.
  const many = useVideoCounts((s) => scope != null && (s.counts[scope] ?? 0) > 1);

  useEffect(() => {
    if (!counted || scope == null) return;
    countVideo(scope, 1);
    return () => countVideo(scope, -1);
  }, [counted, scope]);

  useEffect(() => {
    if (id != null && ready) setRevealed(id);
  }, [id, ready]);

  useEffect(() => {
    const handle = id != null ? sessionControl.video(id) : undefined;
    const host = hostRef.current;
    if (!handle || !host) return;
    host.appendChild(handle.video);
    const observer = new ResizeObserver(([entry]) => handle.setDisplayHeight(entry.contentRect.height));
    observer.observe(host);
    return () => {
      observer.disconnect();
      if (handle.video.parentElement === host) handle.video.remove();
    };
  }, [id]);

  if (!stream) return <div className={`video video-off ${className}`} data-testid="video-off" />;
  const shown = revealed != null && revealed === id;
  const failed = stream.status === 'error';
  const text = failed ? stream.error || 'playback failed' : (STATUS_TEXT[stream.status] ?? '');
  const hear = () => {
    if (id == null || stream.quiet) return;
    sessionControl.setAudio(id);
    if (stream.heard === 'muted') sessionControl.toggleMute();
  };
  return (
    <div
      className={`video ${stream.quiet ? '' : 'video-hearable'} ${many ? 'video-many' : ''} ${className}`}
      data-testid="video"
      data-feed={stream.feed}
      data-video={id ?? undefined}
      data-status={stream.status}
      data-heard={stream.heard ?? undefined}
      onClick={stream.quiet ? undefined : hear}
    >
      <div ref={hostRef} className={`video-picture ${shown ? '' : 'video-picture-hidden'}`} />
      {text && (failed || !shown) ? (
        <div className={`tile-status ${failed ? 'tile-status-error' : ''}`} data-testid="tile-status">
          <span className="tile-status-name">{stream.label}</span> {text}
        </div>
      ) : null}
      {stream.quiet ? null : (
        <span className="video-sound" aria-hidden>
          {stream.heard === 'on' ? 'aud' : stream.heard === 'muted' ? 'mute' : 'hear'}
        </span>
      )}
    </div>
  );
}

/**
 * The title bar's stream slots for a component's videos: the worst status among them, and the sound if
 * one of them is heard. Spread it into `useTileHeader`.
 */
export function streamSlots(...streams: (Stream | null | undefined)[]): Pick<TileHeader, 'status' | 'audio'> {
  const shown = streams.filter((s): s is Stream => s != null);
  const out: Pick<TileHeader, 'status' | 'audio'> = {};
  if (shown.some((s) => s.status === 'error')) out.status = 'error';
  else if (shown.some((s) => s.status === 'resolving' || s.status === 'loading')) out.status = 'load';
  else if (shown.some((s) => s.status === 'syncing')) out.status = 'sync';
  const heard = shown.find((s) => s.heard != null);
  if (heard?.heard) out.audio = heard.heard;
  return out;
}
