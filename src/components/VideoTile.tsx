/** A video feed in the layout. The stream itself belongs to the host. */
import { useEffect, useState } from 'react';
import Type from 'typebox';
import { defineComponent, read, useLive, Video } from '../host';

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
      {/* The label is on the title bar the grid draws. */}
      {audible ? <div className="tile-audio">♪</div> : null}
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

export default defineComponent({
  name: 'video',
  title: 'Video',
  description: 'One feed from the open session: the main broadcast, a driver onboard, the data channel or the tracker.',
  args: Type.Object({ feed: Type.String({ description: 'A feed id from live.feeds' }) }),
  // Keyed by feed, so a feed is on screen at most once.
  spec: ({ feed }) => {
    const channel = read().feeds.find((c) => c.id === feed);
    if (!channel) throw new Error(`Unknown feed: ${feed}`);
    return { key: feed, label: channel.label };
  },
  View: VideoTile,
});
