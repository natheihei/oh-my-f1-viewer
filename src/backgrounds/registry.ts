/** Every background the settings panel offers, in its order. */
import type { BackgroundDefinition } from '../host';
import grid from './grid';
import stars from './stars';
import streaks from './streaks';
import timing from './timing';
import track from './track';

export const backgrounds: BackgroundDefinition[] = [grid, stars, track, streaks, timing];
