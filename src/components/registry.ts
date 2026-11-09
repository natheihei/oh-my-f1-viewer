/** Every component a tile can show. Charts and other views get added here. */
import type { ComponentDefinition } from '../host';
import GapEvolution from './charts/GapEvolution';
import LapTimeCompare from './charts/LapTimeCompare';
import PositionChart from './charts/PositionChart';
import RaceTrace from './charts/RaceTrace';
import StintPace from './charts/StintPace';
import TimingTower from './charts/TimingTower';
import TyreDegradation from './charts/TyreDegradation';
import TyreStrategy from './charts/TyreStrategy';
import VideoTile from './VideoTile';

export const components: ComponentDefinition[] = [
  VideoTile,
  TimingTower,
  RaceTrace,
  PositionChart,
  GapEvolution,
  LapTimeCompare,
  TyreStrategy,
  TyreDegradation,
  StintPace,
];
