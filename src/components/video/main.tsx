/** A video feed in the layout: one picture, which the title bar names. */
import Type from 'typebox';
import { defineComponent, read, streamSlots, useStream, useTileHeader, Video } from 'omfv';

function VideoTile({ props }: { props: { feed: string }; label: string }) {
  const stream = useStream(props.feed);
  // The label and drivers come from the spec. Whether it's loading, catching up or heard comes from the video.
  useTileHeader(streamSlots(stream));
  return (
    <div className="tile">
      <Video stream={stream} />
    </div>
  );
}

export default defineComponent({
  name: 'video',
  title: 'Video',
  description: 'One feed from the open session: the main broadcast, a driver onboard, the data channel or the tracker.',
  args: Type.Object({ feed: Type.String({ description: 'A feed id from live.feeds' }) }),
  // Every feed is 16:9, letterboxed in whatever room it gets: the tile keeps only the picture.
  fit: { aspect: 16 / 9 },
  // Below this a picture is a thumbnail.
  size: { aspect: 16 / 9, min: { width: 320, height: 180 } },
  // Keyed by feed, so one video tile shows a feed. Other components may show it too.
  spec: ({ feed }) => {
    const channel = read().feeds.find((c) => c.id === feed);
    if (!channel) throw new Error(`Unknown feed: ${feed}`);
    // An onboard names its car, so the title draws its code like any tile about a driver.
    return channel.kind === 'onboard' && channel.number != null ? { key: feed, label: '', drivers: [channel.number] } : { key: feed, label: channel.label };
  },
  View: VideoTile,
});
