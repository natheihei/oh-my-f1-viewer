/**
 * A video feed in the layout: one picture, which the title bar names. Given a place in the running
 * order as `driver` instead, it shows the onboard of whoever holds it, and switches as the order does.
 */
import Type from 'typebox';
import { defineComponent, Driver, read, streamSlots, useLive, useStream, useTileHeader, Video } from 'omfv';
import { onboardOf } from 'omfv/kit';

function VideoTile({ props }: { props: { feed?: string; driver?: number }; label: string }) {
  const { driver } = props;
  // The host gives a place's holder as `driver`. When it changes, this tile lets go of the old onboard
  // and takes the new one in the same render, so two tiles whose cars swap take over each other's video.
  const onboard = useLive((s) => (driver != null ? onboardOf(s.feeds, driver) : null));
  const feed = driver != null ? onboard : props.feed;
  const stream = useStream(feed);
  // The label and drivers come from the spec. Whether it's loading, catching up or heard comes from the video.
  useTileHeader(streamSlots(stream));
  return <div className="tile">{feed ? <Video stream={stream} /> : <div className="chart-message">No onboard for this driver</div>}</div>;
}

export default defineComponent({
  name: 'video',
  title: 'Video',
  description: 'One feed from the open session: the main broadcast, a driver onboard, the data channel or the tracker.',
  args: Type.Object({
    feed: Type.Optional(Type.String({ description: 'A feed id from live.feeds' })),
    driver: Type.Optional(Driver('A place to follow, such as "P1": the onboard of whoever holds it. For one car, give its onboard as feed')),
  }),
  // Every feed is 16:9, letterboxed in whatever room it gets: the tile keeps only the picture.
  fit: { aspect: 16 / 9 },
  // Below this a picture is a thumbnail.
  size: { aspect: 16 / 9, min: { width: 320, height: 180 } },
  // Keyed by feed, so one video tile shows a feed. Other components may show it too. One following a
  // place is keyed by the place.
  spec: ({ feed, driver }) => {
    if (driver != null) return { key: `onboard:${driver}`, label: '', drivers: [driver] };
    if (feed == null) throw new Error('video needs a feed, or a place to follow as driver');
    const channel = read().feeds.find((c) => c.id === feed);
    if (!channel) throw new Error(`Unknown feed: ${feed}`);
    // An onboard names its car, so the title draws its code like any tile about a driver.
    return channel.kind === 'onboard' && channel.number != null ? { key: feed, label: '', drivers: [channel.number] } : { key: feed, label: channel.label };
  },
  View: VideoTile,
});
