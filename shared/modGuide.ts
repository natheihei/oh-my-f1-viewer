/**
 * What anyone writing a mod needs to know: what a mod is, the host, and the rules for a component. The
 * build agent gets it in its prompt. docs/COMPONENTS.md is where the conventions are decided and explained:
 * a change there is adopted here by hand, as a rule without its reasons.
 */

export const MOD_GUIDE = `What a mod is:
- One folder in the mods folder, named in lower-case letters, digits, _ and -, starting with a letter. Its main.tsx default-exports defineComponent({ ... }), and the component's name must be the folder's name. It may import other files in its own folder.
- A mod may import only: "omfv" (the host), "omfv/kit" (what the app's charts are drawn with), "react", "typebox", and its own files. Anything else fails to compile.
- The app compiles a mod on every save and reloads it while the session keeps playing. A save that does not compile leaves the last version running and writes the error to mod.error in the mod's folder. What the component logs or throws goes to mod.log there.
- Paths here are relative to the mods folder: "lap_stepper/main.tsx". The types are there to read: ".types/src/host/index.d.ts" for the host and ".types/src/kit/index.d.ts" for the kit. Read them before using something you are not sure of. Existing mods are there to read too, and the installed components' sources under ".installed/builtin/<name>/".

A complete mod:

import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useSql } from 'omfv';
import { ChartCanvas, ChartFrame, text, type Box } from 'omfv/kit';

const SQL = 'SELECT COUNT(*) AS laps FROM laps';

function draw(ctx: CanvasRenderingContext2D, laps: number, box: Box) {
  text(ctx, \`\${laps} laps so far\`, 8, box.height / 2, { size: 13 });
}

function LapCount() {
  const view = useSql(SQL); // as of the playhead
  const laps = useMemo(() => (view.state === 'ready' ? Number(view.rows[0]?.laps) : 0), [view]);
  return (
    <ChartFrame needs={['timing']} views={[view]}>
      {() => <ChartCanvas model={laps} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'lap_count', // the folder's name
  title: 'Lap count',
  description: 'How many laps have been timed so far.',
  args: Type.Object({}),
  needs: ['timing'],
  size: { aspect: 2.5, min: { width: 300, height: 90 } }, // one short line: wide and low
  spec: () => ({ key: 'lap_count', label: 'Lap count' }),
  View: LapCount,
});

The host, from "omfv":
- useLive((s) => s.clock.timeSec) re-renders when the selected value changes; read() returns the same state once. The selector must return a value or an existing reference, never a new object. State includes session, clock (timeSec, playing), sessionData (state, and when 'ready': drivers, playheadMs, lapCount), feeds, layout.
- useSql(sql, params?) runs a SELECT on the open session and again as the playhead moves. It returns { state: 'loading' | 'failed' | 'ready' }, with rows and columns when ready. It reads only what the feed had revealed at the frame on screen, and car_data and location up to the frame's own time. It runs again about once a second, and whenever params change: sessionData.playheadMs moves ten times a second, so pass it only to a query that follows telemetry, bounded by date on both sides, and its samples, about four a second, show as the car reaches them.
- useSql(sql, params, { asOf: 'session' }) reads the whole session, including what the viewer has not watched. Use it only when the tile cannot work otherwise, like a control that jumps to the next lap, which has not happened yet at the playhead.
- looksAhead: true in defineComponent, beside needs, says the component reads or acts on what the viewer has not watched. The app then covers each tile of it with a warning and does not draw the view until the viewer allows that tile. The app draws the warning itself. Nothing sets it for you: a component without it is drawn at once, whatever it reads.
- host.playback.seekToDate({ dateMs }) moves playback to a moment from a date column. Also host.playback.play(), pause(), seekBy({ seconds }).
- Video: const stream = useStream(feedId, { slot }) holds one video of a feed while the view is drawn; useStream(null) holds none, for a picture with nothing to show. <Video stream={stream} /> draws it, filling its box, with its own loading status, and a click on it makes it the one heard. <Video feed={id} /> does both. Each call is its own stream from the CDN, so hold only what is on screen. A feed can show in two places at once. Feeds are in live.feeds: a driver's onboard is the one with kind 'onboard' and their car number as number, and some sessions lack one. With more than one picture, give each a slot name, like 'a' and 'b'.
- useTileHeader({ label, drivers, status, audio }) says what the tile's title bar shows instead of the spec's label and drivers. A component with videos always calls it with ...streamSlots(...its streams), so the bar says when they load and which is heard.
- useTileState(key, initial) is useState kept with the tile: it survives the mod being saved and drawn again. Use it for what the viewer picks in the tile.
- A view is a plain React component: ({ props, label }) => .... It fills its tile, so make its root fill the space (width and height 100%). ChartFrame and ChartCanvas are optional: a control can be plain elements with inline styles.

Rules for what you build:
- Declare the props the component needs, and never pick a driver from the data yourself: the app's agent fills the props in from what the user said when it suggests the tile. Only a component whose job is to follow someone, like the leader, picks them, and then its label says so.
- Driver props are named for what they hold, and the agent fills them in by name. driver: the one driver it is about, as a car number, Driver('The driver'). driver_a and driver_b: the two a comparison is about. drivers: those to highlight among everyone drawn, Highlighted(). drivers_to_display: those to draw, when it can show just some, Displayed(); left out, everyone. Driver, DriverList, Highlighted and Displayed come from "omfv". Make a prop required when the component is about that driver, and optional otherwise. Another prop about drivers starts its name with driver_ (one) or drivers_ (a list).
- What the viewer picks inside the tile, like which fight to show, is state from useTileState, not props, and the component names what it shows with useTileHeader.
- Put every prop in spec's key, like "duel:44-4", so two tiles with different props can be on screen together. keyPart(value) from "omfv" writes a driver prop for a key.
- A tile already has a title bar showing the spec's label, so never draw a title, heading or caption of your own. The first thing in the view is the content.
- Always declare size: { aspect, min: { width, height } }. aspect is the shape it reads best in, its width over its height. min is the least room its content reads in, in pixels, not counting the tile's title bar: the smallest size at which everything it draws is still legible. The app arranges tiles by these: a tall one goes beside the main video and a wide one below it, and each stays at its least size while there is room. A list or table is tall, like { aspect: 0.7, min: { width: 300, height: 320 } }. A chart over time is { aspect: 16 / 9, min: { width: 400, height: 220 } }. A row of buttons is wide and low, like { aspect: 3, min: { width: 300, height: 90 } }. Do not ask for more than it needs: a least size much over 480 by 400 cannot be met beside a video. Change it when an edit changes what the component needs.
- Tiles get small. The preview in the strip is 260 pixels wide and between 100 and 180 high, following aspect, and the user can drag a tile below its min, or put more tiles on screen than fit at theirs. At that size the view must still show its most important thing, like the newest row of a list: keep padding tight, and put what matters most at the top.
- A component queries for itself. Never write race data into a mod's source: lap times, results, who pitted when. The same mod runs on other sessions.
- A tile that only shows what has happened uses plain useSql and does not set looksAhead. Reach for asOf 'session' only as above, and show nothing from it that the viewer has not seen: use it to act, like seeking.
- Any component that uses asOf 'session', or that could take the viewer or show them past the playhead, must set looksAhead: true. Add it when an edit makes a component look ahead, and remove it when an edit stops it.
- Keep a mod to one component. To change a mod, edit it, and to remove one, delete its folder. An installed component can't be changed or removed: fork it to change it.

How it looks:
- The app is dark and square: a black background, text #e7e7e7, secondary text #8a8a8a, lines #2c2c2c, a monospace font the view inherits. No rounded corners, shadows or gradients. In a canvas, colors() from the kit gives these.
- Red means an error, a spoiler warning or a live session, and yellow marks build mode. Do not use either for emphasis. Show emphasis with full-strength text and weight. Tyre colours are for tyres and team colours for drivers. The exceptions are the pedals, the throttle and brake colours, a muted green and a muted red, as the broadcast has them, and flags, drawn as a small flag in the same muted green and red and a muted yellow and blue. Faster and slower, when one time is compared with another, are the gain and loss colours, a muted green and a muted yellow, always beside a − or + sign.
- Fit the tile as far as you can. Content that can outgrow it, like a list, goes in an element with overflowY 'auto', flex 1 and minHeight 0, so it scrolls. Never hide overflow on content the user would want to reach.
- When the view can't get any smaller, let its content run past the bottom or right of the tile. The app marks that with a faded edge and "more". Never draw a note or a count of your own for what is hidden.
- Below the least size it reads at, don't drop rows or columns or shrink text past readable: let the content run on. ChartCanvas takes an extent prop for this, (model, box) => ({ width, height }), the size it draws at in a tile of that box, and the canvas runs past the tile by that much.
- In a crowded chart, label only what answers its question and name the rest when the pointer is on them. ChartCanvas takes an onPointer prop, (point) => void, with { x, y } in the pixels it draws in or null when the pointer leaves: keep it in the model you draw from, and draw the name of the mark under it.`;
