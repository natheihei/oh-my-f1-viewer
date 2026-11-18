/**
 * Writes to the layout. A tile on screen is named by its id, as `live.layout.tiles` lists it. Components
 * are named by type and props, and matching "Hamilton" to a feed is up to the caller.
 */
import Type from 'typebox';
import { create } from 'zustand';
import { allTiles, findTile, tileWithKey } from '../layout/model';
import { layout, useLayout } from '../layout/store';
import { Item, specOf } from './components';
import { write } from './op';

const TileId = Type.String({ description: 'A tile id, such as "tile-3"' });

/** The tile the viewer is pointing at from the prompt, by id, which the grid outlines. */
export const usePointed = create<{ tile: string | null }>(() => ({ tile: null }));

export const layoutOps = {
  add: write(
    {
      description:
        "Put components on screen as individual tiles. Returns the id of the tile showing each, in order: one already on screen with the same key is not added again, and its id is returned. Fails when the grid has no room left for one, because every tile would then be too small to read: those before it stay added, and the user must close a tile first.",
      args: Type.Object({ items: Type.Array(Item) }),
    },
    ({ items }) => items.map((item) => layout.add(specOf(item))),
  ),
  remove: write(
    {
      description: 'Take tiles off screen by id. Returns the labels of those that were on screen.',
      args: Type.Object({ tiles: Type.Array(TileId) }),
    },
    ({ tiles }) => {
      const removed: string[] = [];
      for (const id of tiles) {
        const tile = findTile(useLayout.getState(), id);
        if (tile && layout.remove(id)) removed.push(tile.component.label);
      }
      return removed;
    },
  ),
  setProps: write(
    {
      description:
        "Give a tile on screen new props, in place of its old ones: it keeps its id and place, and its label follows the new props. Returns its new label, or null if the tile isn't on screen.",
      args: Type.Object({ tile: TileId, props: Item.properties.props }),
    },
    ({ tile, props }) => {
      const found = findTile(useLayout.getState(), tile);
      if (!found) return null;
      const spec = specOf({ type: found.component.type, props });
      const other = tileWithKey(useLayout.getState(), spec.key);
      if (other && other.id !== tile) throw new Error(`Already on screen: ${spec.label}`);
      layout.replace(tile, spec);
      return { label: spec.label };
    },
  ),
  autoLayout: write({ description: 'Re-tile the grid in the order tiles were added, discarding manual moves and resizes.' }, () => layout.autoLayout()),
  setMain: write(
    {
      description:
        'Give a tile the main place in auto-layout: top left, and as large as the other tiles allow. Null takes it from whichever tile has it, and every tile is then laid out by its own size. Returns whether the tile is on screen.',
      args: Type.Object({ tile: Type.Union([TileId, Type.Null()]) }),
    },
    ({ tile }) => {
      if (tile !== null && !findTile(useLayout.getState(), tile)) return false;
      layout.setMain(tile);
      return true;
    },
  ),
  move: write(
    {
      description: 'Move or resize a tile, in grid cells.',
      args: Type.Object({
        tile: TileId,
        rect: Type.Object({ x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() }),
      }),
    },
    ({ tile, rect }) => layout.mouseEdit(tile, rect),
  ),
  swap: write(
    { description: 'Swap the places of two tiles.', args: Type.Object({ a: TileId, b: TileId }) },
    ({ a, b }) => layout.swap(a, b),
  ),
  point: write(
    {
      description: 'Outline a tile on screen, as the viewer points at it from the prompt, or nothing. Returns whether the tile is on screen.',
      args: Type.Object({ tile: Type.Union([TileId, Type.Null()]) }),
    },
    ({ tile }) => {
      const on = tile !== null && findTile(useLayout.getState(), tile) != null;
      const next = on ? tile : null;
      if (usePointed.getState().tile !== next) usePointed.setState({ tile: next });
      return on;
    },
  ),
};

export const tilesOf = allTiles;
