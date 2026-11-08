/** A video feed in the layout. The stream itself belongs to the host. */
import { useEffect, useState } from 'react';
import { defineComponent, useLive, Video } from '../host';

function VideoTile({ props, label }: { props: { feed: string }; label: string }) {
  const { feed } = props;
  const view = useLive((s) => s.streams[feed]);
  const audible = useLive((s) => s.audio === feed);
  // Once shown, a tile stays visible through seeks: its status line says when it is catching up.
  const [revealed, setRevealed] = useState(false);

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
      <Video feed={feed} className={`tile-video ${revealed ? '' : 'tile-video-hidden'}`} />
      <div className="tile-label">
        {label}
        {audible ? <span className="tile-audio"> ♪</span> : null}
      </div>
      {statusText && (status === 'error' || !revealed) ? (
        <div className={`tile-status ${status === 'error' ? 'tile-status-error' : ''}`} data-testid="tile-status">
          <span className="tile-status-name">{label}</span> {statusText}
        </div>
      ) : statusText ? (
        <div className="tile-resync">{statusText}</div>
      ) : null}
    </div>
  );
}

export default defineComponent({ name: 'video', View: VideoTile });
