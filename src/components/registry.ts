/** Every component a tile can show. Charts and other views get added here. */
import type { ComponentDefinition } from '../host';
import GapEvolution from './charts/GapEvolution';
import LapTimeCompare from './charts/LapTimeCompare';
import PitStops from './charts/PitStops';
import PitWindow from './charts/PitWindow';
import PitWindows from './charts/PitWindows';
import RaceControl from './charts/RaceControl';
import RaceTrace from './charts/RaceTrace';
import SectorDelta from './charts/SectorDelta';
import SpeedRibbon from './charts/SpeedRibbon';
import SpeedTrace from './charts/SpeedTrace';
import FieldPace from './charts/FieldPace';
import CarTelemetry from './charts/CarTelemetry';
import PedalBarcode from './charts/PedalBarcode';
import TimingTower from './charts/TimingTower';
import TrackMap from './charts/TrackMap';
import TyreStrategy from './charts/TyreStrategy';
import Weather from './charts/Weather';
import VideoTile from './VideoTile';

export const components: ComponentDefinition[] = [
  VideoTile,
  TimingTower,
  RaceTrace,
  GapEvolution,
  LapTimeCompare,
  TyreStrategy,
  FieldPace,
  PitWindow,
  PitWindows,
  SectorDelta,
  PitStops,
  RaceControl,
  Weather,
  TrackMap,
  SpeedTrace,
  CarTelemetry,
  PedalBarcode,
  SpeedRibbon,
];
