/** A video stream in the layout. The element itself belongs to the data layer. */
import { useEffect, useRef, useState } from 'react';
import { sessionControl, useSession } from '../data/session';
import type { ComponentSpec } from '../layout/model';

export function videoSpec(channelId: string, label: string): ComponentSpec {
  return { type: 'video', key: channelId, label, props: { channelId } };
}

export function VideoTile({ spec }: { spec: ComponentSpec }) {
  const channelId = String(spec.props.channelId);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const view = useSession((s) => s.streams[channelId]);
  const audible = useSession((s) => s.audioChannelId === channelId);
  // Once shown, a tile stays visible through seeks: its status line says when it is catching up.
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const handle = sessionControl.acquire(channelId);
    const host = hostRef.current;
    if (!handle || !host) return;
    host.appendChild(handle.video);
    const observer = new ResizeObserver(([entry]) => handle.setDisplayHeight(entry.contentRect.height));
    observer.observe(host);
    return () => {
      observer.disconnect();
      sessionControl.release(channelId);
    };
  }, [channelId]);

  useEffect(() => {
    if (view?.status === 'ready') setRevealed(true);
  }, [view?.status]);

  const status = view?.status ?? 'resolving';
  const statusText =
    status === 'error'
      ? view?.error || 'playback failed'
      : status === 'resolving'
        ? 'connecting…'
        : status === 'loading'
          ? 'loading…'
          : status === 'syncing'
            ? 'syncing…'
            : '';

  return (
    <div className="tile" data-status={status}>
      <div ref={hostRef} className={`tile-video ${revealed ? '' : 'tile-video-hidden'}`} />
      <div className="tile-label">
        {spec.label}
        {audible ? <span className="tile-audio"> ♪</span> : null}
      </div>
      {statusText && (status === 'error' || !revealed) ? (
        <div className={`tile-status ${status === 'error' ? 'tile-status-error' : ''}`} data-testid="tile-status">
          <span className="tile-status-name">{spec.label}</span> {statusText}
        </div>
      ) : statusText ? (
        <div className="tile-resync">{statusText}</div>
      ) : null}
    </div>
  );
}
