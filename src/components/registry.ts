/** Every component type a tile can show. Charts and other views get added here. */
import type { TileComponent } from '../layout/Stage';
import { VideoTile } from './VideoTile';

export const componentRegistry: Record<string, TileComponent> = {
  video: VideoTile,
};
