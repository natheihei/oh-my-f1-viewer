/**
 * Following one driver on the road: their onboard, with the car ahead of them and the interval to it,
 * as of the playhead. Who is ahead is worked out each time the order changes, not asked for.
 */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, Driver, DriverCode, streamSlots, useLive, useSql, useStream, useTileHeader, Video } from 'omfv';
import { aheadOf, onboardOf, ORDER_SQL, runningOrder } from 'omfv/kit';

const NEEDS = ['timing' as const];

function Chase({ props }: { props: { driver: number } }) {
  const { driver } = props;
  const view = useSql(ORDER_SQL);
  const aid = useLive((s) => s.spec.chaseAid);
  const feed = useLive((s) => onboardOf(s.feeds, driver));
  const stream = useStream(feed);
  useTileHeader(streamSlots(stream));
  const ahead = useMemo(() => (view.state === 'ready' ? aheadOf(runningOrder(view.rows), driver) : null), [view, driver]);
  const close = ahead?.gap != null && ahead.gap < aid.within;
  return (
    <div className="tile">
      {feed ? <Video stream={stream} /> : <div className="chart-message">No onboard for this driver</div>}
      {ahead ? (
        <div className={`chase-ahead ${close ? 'chase-ahead-close' : ''}`} data-testid="chase-ahead">
          <span className="chase-ahead-word">ahead</span>
          <DriverCode number={ahead.driver} strong />
          <span className="chase-ahead-gap">{ahead.gap != null ? `+${ahead.gap.toFixed(1)}` : ''}</span>
          {close ? <span className="chase-ahead-aid">{aid.label}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export default defineComponent({
  name: 'chase',
  title: 'Chase',
  description:
    "Following one driver's chase of whoever is ahead on the road: their onboard, with the car ahead and the interval to it, marked when it is within DRS range (Overtake from 2026). Suggest it in place of the driver's onboard when the user wants to follow them hunting the car in front. For how the gap between two named drivers moves over laps, suggest gap_evolution.",
  args: Type.Object({ driver: Driver('The driver to follow') }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  fit: { aspect: 16 / 9 },
  size: { aspect: 16 / 9, min: { width: 320, height: 180 } },
  spec: ({ driver }) => ({ key: `chase:${driver}`, label: 'Chase', drivers: [driver] }),
  View: Chase,
});
