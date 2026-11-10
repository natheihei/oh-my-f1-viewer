/** Every component a tile can show. Charts and other views get added here. */
import type { ComponentDefinition } from '../host';
import BattleCard from './charts/BattleCard';
import GapEvolution from './charts/GapEvolution';
import LapTimeCompare from './charts/LapTimeCompare';
import PitStops from './charts/PitStops';
import PitWindow from './charts/PitWindow';
import PositionChart from './charts/PositionChart';
import RaceControl from './charts/RaceControl';
import RaceTrace from './charts/RaceTrace';
import SectorDelta from './charts/SectorDelta';
import StintPace from './charts/StintPace';
import TimingTower from './charts/TimingTower';
import TyreDegradation from './charts/TyreDegradation';
import TyreStrategy from './charts/TyreStrategy';
import Weather from './charts/Weather';
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
  PitWindow,
  BattleCard,
  SectorDelta,
  PitStops,
  RaceControl,
  Weather,
];
