/** Every component a tile can show. Charts and other views get added here. */
import type { ComponentDefinition } from '../host';
import GapEvolution from './charts/GapEvolution';
import TimingTower from './charts/TimingTower';
import TyreStrategy from './charts/TyreStrategy';
import VideoTile from './VideoTile';

export const components: ComponentDefinition[] = [VideoTile, TimingTower, GapEvolution, TyreStrategy];
