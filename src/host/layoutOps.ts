/** Writes to the layout. Feeds are named by id and components by name: matching "Hamilton" to a feed is up to the caller. */
import Type from 'typebox';
import { allTiles, findTile } from '../layout/model';
import { layout, useLayout } from '../layout/store';
import { Item, specOf } from './components';
import { write } from './op';

const Feeds = Type.Array(Type.String(), { description: 'Feed ids' });
const Target = Type.String({ description: 'A tile key, group id or group title' });

const videoOf = (feed: string) => specOf({ type: 'video', props: { feed } });

export const layoutOps = {
  add: write(
    { description: 'Put components on screen as individual tiles.', args: Type.Object({ items: Type.Array(Item) }) },
    ({ items }) => {
      for (const spec of items.map(specOf)) layout.add(spec);
    },
  ),
  remove: write(
    {
      description: 'Take tiles off screen by key, whether they stand alone or are inside a group. Returns the labels of those that were on screen.',
      args: Type.Object({ keys: Type.Array(Type.String(), { description: "Tile keys: a video tile's is its feed id" }) }),
    },
    ({ keys }) => {
      const removed: string[] = [];
      for (const key of keys) {
        const found = findTile(useLayout.getState(), key);
        if (!found) continue;
        layout.remove(key);
        removed.push(found.tile.component.label);
      }
      return removed;
    },
  ),
  setProps: write(
    {
      description:
        "Give a tile on screen new props, in place of its old ones: it keeps its place, and its key and label follow the new props. Returns its new key and label, or null if the key isn't on screen.",
      args: Type.Object({ key: Type.String({ description: "A tile key: a video tile's is its feed id" }), props: Item.properties.props }),
    },
    ({ key, props }) => {
      const found = findTile(useLayout.getState(), key);
      if (!found) return null;
      const spec = specOf({ type: found.tile.component.type, props });
      if (spec.key !== key && findTile(useLayout.getState(), spec.key)) throw new Error(`Already on screen: ${spec.label}`);
      layout.replace(key, spec);
      return { key: spec.key, label: spec.label };
    },
  ),
  close: write(
    { description: 'Take one tile off screen by its tile id. Returns whether it matched.', args: Type.Object({ tile: Type.String() }) },
    ({ tile }) => layout.close(tile),
  ),
  group: write(
    {
      description: 'Show feeds side by side as one group. Returns the group id.',
      args: Type.Object({ feeds: Feeds, title: Type.Optional(Type.String()) }),
    },
    ({ feeds, title }) => layout.group(feeds.map(videoOf), title),
  ),
  closeGroup: write(
    { description: 'Close a group and take its tiles off screen. Returns their labels, or null if no group matches.', args: Type.Object({ group: Target }) },
    ({ group }) => layout.closeGroup(group)?.map((c) => c.label) ?? null,
  ),
  ungroup: write(
    { description: 'Dissolve a group but keep its tiles. Returns whether a group matched.', args: Type.Object({ group: Target }) },
    ({ group }) => layout.ungroup(group),
  ),
  autoLayout: write({ description: 'Re-tile the grid in the order tiles were added, discarding manual moves and resizes.' }, () => layout.autoLayout()),
  setMain: write(
    {
      description:
        'Give a tile the main place in auto-layout: top left, and as large as the other tiles allow. Null takes it from whichever tile has it, and every tile is then laid out by its own size. Returns whether the key is on screen.',
      args: Type.Object({ key: Type.Union([Type.String({ description: "A tile key: a video tile's is its feed id" }), Type.Null()]) }),
    },
    ({ key }) => {
      if (key !== null && !findTile(useLayout.getState(), key)) return false;
      layout.setMain(key);
      return true;
    },
  ),
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
