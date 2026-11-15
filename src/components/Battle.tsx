/**
 * Watching the fights on track: two onboards, and every fight at the playhead to pick from. Which fight
 * it shows is its own state, not a prop: it starts on the closest and the viewer picks another in the
 * tile, and its title bar says who it shows.
 */
import { useEffect, useMemo } from "react";
import Type from "typebox";
import {
  defineComponent,
  DriverCode,
  streamSlots,
  useLive,
  useSql,
  useStream,
  useTileHeader,
  useTileState,
  Video,
  type Stream,
} from "../host";
import type { Channel } from "../../shared/api";
import { ChartFrame } from "./charts/kit";
import {
  closest,
  fightsOf,
  ORDER_SQL,
  runningOrder,
  type Fight,
} from "./fights";

const NEEDS = ["timing" as const];

/** A driver's onboard feed, or null when the session has none for them. */
export const onboardOf = (
  feeds: readonly Channel[],
  driver: number,
): string | null =>
  feeds.find((c) => c.kind === "onboard" && c.number === driver)?.id ?? null;

type Pair = [number, number];
type Off = { a: boolean; b: boolean };
const BOTH_ON: Off = { a: false, b: false };

/** One of the two pictures: the onboard, or why there's none, with the driver and a switch to turn it off or on. */
function Picture({
  driver,
  stream,
  off,
  hasFeed,
  onToggle,
}: {
  driver: number | null;
  stream: Stream | null;
  off: boolean;
  hasFeed: boolean;
  onToggle: () => void;
}) {
  const why =
    driver === null
      ? "Pick a fight"
      : !hasFeed
        ? "No onboard"
        : off
          ? "Off"
          : null;
  return (
    <div className="battle-picture">
      {why ? (
        <div className="chart-message">{why}</div>
      ) : (
        <Video stream={stream} />
      )}
      {driver !== null ? (
        <div className="battle-picture-bar">
          <DriverCode number={driver} strong />
          {hasFeed ? (
            <button
              type="button"
              className="battle-switch"
              data-testid="battle-switch"
              onClick={onToggle}
              aria-label={off ? "Show this onboard" : "Turn this onboard off"}
            >
              {off ? "show" : "off"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FightList({
  fights,
  pair,
  aid,
  onPick,
}: {
  fights: Fight[];
  pair: Pair | null;
  aid: string;
  onPick: (f: Fight) => void;
}) {
  if (!fights.length)
    return <div className="chart-message">No car within {aid} range</div>;
  return (
    <ul className="battle-fights" data-testid="battle-fights">
      {fights.map((f) => {
        const on = pair !== null && pair[0] === f.ahead && pair[1] === f.behind;
        return (
          <li key={`${f.ahead}-${f.behind}`}>
            <button
              type="button"
              className={`battle-fight ${on ? "battle-fight-on" : ""}`}
              aria-pressed={on}
              onClick={() => onPick(f)}
            >
              <span className="battle-fight-pos">
                {f.position != null ? `P${f.position}` : ""}
              </span>
              <DriverCode number={f.ahead} strong={on} />
              <DriverCode number={f.behind} strong={on} />
              <span className="battle-fight-gap">{f.gap.toFixed(1)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Battle() {
  const view = useSql(ORDER_SQL);
  const aid = useLive((s) => s.spec.chaseAid);
  const feeds = useLive((s) => s.feeds);
  const fights = useMemo(
    () =>
      view.state === "ready"
        ? fightsOf(runningOrder(view.rows), aid.within)
        : [],
    [view, aid.within],
  );
  const [pair, setPair] = useTileState<Pair | null>("pair", null);
  const [off, setOff] = useTileState<Off>("off", BOTH_ON);

  // Until there's a fight to show, it takes the closest one as soon as there is.
  const first = closest(fights);
  useEffect(() => {
    if (pair === null && first) setPair([first.ahead, first.behind]);
  }, [pair, first, setPair]);

  const feedA = pair ? onboardOf(feeds, pair[0]) : null;
  const feedB = pair ? onboardOf(feeds, pair[1]) : null;
  const a = useStream(off.a ? null : feedA, { slot: "a" });
  const b = useStream(off.b ? null : feedB, { slot: "b" });
  useTileHeader({
    label: "Battle",
    drivers: pair ?? undefined,
    ...streamSlots(a, b),
  });

  const pick = (f: Fight) => {
    setPair([f.ahead, f.behind]);
    setOff(BOTH_ON);
  };
  return (
    <div className="battle-host">
      <div className="battle">
        <Picture
          driver={pair?.[0] ?? null}
          stream={a}
          off={off.a}
          hasFeed={feedA !== null}
          onToggle={() => setOff((o) => ({ ...o, a: !o.a }))}
        />
        <Picture
          driver={pair?.[1] ?? null}
          stream={b}
          off={off.b}
          hasFeed={feedB !== null}
          onToggle={() => setOff((o) => ({ ...o, b: !o.b }))}
        />
        <div className="battle-list">
          <ChartFrame needs={NEEDS} views={[view]}>
            {() => (
              <FightList
                fights={fights}
                pair={pair}
                aid={aid.label}
                onPick={pick}
              />
            )}
          </ChartFrame>
        </div>
      </div>
    </div>
  );
}

/** The fight list's width, in pixels. */
const LIST = 150;
/** Each picture's least size: below it an onboard is a thumbnail. */
const PICTURE = { width: 320, height: 180 };

export default defineComponent({
  name: "battle",
  title: "Battle",
  description: `Watching the fights on track: the onboards of the two cars in a fight, beside a list of every fight at the moment, cars within DRS range of the car ahead (Overtake from 2026). It starts on the closest fight and the viewer picks another in the tile, so it takes no drivers. Suggest it when the user wants to watch battles without naming who. For two named drivers, suggest their onboards instead, with gap_evolution for how their gap moves.`,
  args: Type.Object({}),
  sessions: ["race", "sprint"],
  needs: NEEDS,
  // Two pictures stacked beside the list.
  size: {
    aspect:
      Math.round(((PICTURE.width + LIST) / (PICTURE.height * 2)) * 100) / 100,
    min: { width: PICTURE.width + LIST, height: PICTURE.height * 2 },
  },
  // One battle at a time: it has no props to tell two apart.
  spec: () => ({ key: "battle", label: "Battle" }),
  View: Battle,
});
