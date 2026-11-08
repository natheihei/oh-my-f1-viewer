/** Writes to the layout. Feeds are named by id: matching a name like "Hamilton" is up to the caller. */
import Type from 'typebox';
import { useSession } from '../data/session';
import type { ComponentSpec } from '../layout/model';
import { allTiles } from '../layout/model';
import { layout } from '../layout/store';
import { write } from './op';
import { videoSpec } from './viewing';

const Feeds = Type.Array(Type.String(), { description: 'Feed ids' });
const Target = Type.String({ description: 'A tile key, group id or group title' });

function specOf(feed: string): ComponentSpec {
  const channel = useSession.getState().channels.find((c) => c.id === feed);
  if (!channel) throw new Error(`Unknown feed: ${feed}`);
  return videoSpec(channel.id, channel.label);
}

export const layoutOps = {
  add: write(
    { description: 'Put feeds on screen as individual tiles.', args: Type.Object({ feeds: Feeds }) },
    ({ feeds }) => {
      for (const spec of feeds.map(specOf)) layout.add(spec);
    },
  ),
  remove: write(
    { description: 'Take feeds off screen, whether they are tiles or inside a group.', args: Type.Object({ feeds: Feeds }) },
    ({ feeds }) => {
      for (const feed of feeds) layout.remove(feed);
    },
  ),
  group: write(
    {
      description: 'Show feeds side by side as one group. Returns the group id.',
      args: Type.Object({ feeds: Feeds, title: Type.Optional(Type.String()) }),
    },
    ({ feeds, title }) => layout.group(feeds.map(specOf), title),
  ),
  closeGroup: write(
    { description: 'Close a group and take its tiles off screen. Returns their labels, or null if no group matches.', args: Type.Object({ group: Target }) },
    ({ group }) => layout.closeGroup(group)?.map((c) => c.label) ?? null,
  ),
  ungroup: write(
    { description: 'Dissolve a group but keep its tiles. Returns whether a group matched.', args: Type.Object({ group: Target }) },
    ({ group }) => layout.ungroup(group),
  ),
  focus: write(
    { description: 'Make a tile or group the largest thing on screen. Returns whether it matched.', args: Type.Object({ target: Target }) },
    ({ target }) => layout.focus(target),
  ),
  reset: write({ description: 'Re-tile into the default arrangement, discarding manual moves and resizes.' }, () => layout.reset()),
  move: write(
    {
      description: 'Move or resize a tile or group.',
      args: Type.Object({
        tile: Type.String(),
        rect: Type.Object({ x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() }),
      }),
    },
    ({ tile, rect }) => layout.mouseEdit(tile, rect),
  ),
  swap: write(
    { description: 'Swap the places of two tiles or groups.', args: Type.Object({ a: Type.String(), b: Type.String() }) },
    ({ a, b }) => layout.swap(a, b),
  ),
};

export const tilesOf = allTiles;
