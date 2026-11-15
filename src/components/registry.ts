/** Every component a tile can show: video, charts, and views that mix them. Each is added here. */
import type { ComponentDefinition } from '../host';
import GapEvolution from './charts/GapEvolution';
import PitWindow from './charts/PitWindow';
import PitWindows from './charts/PitWindows';
import RaceControl from './charts/RaceControl';
import RaceStatus from './charts/RaceStatus';
import SectorTable from './charts/SectorTable';
import SpeedRibbon from './charts/SpeedRibbon';
import CarTelemetry from './charts/CarTelemetry';
import PedalBarcode from './charts/PedalBarcode';
import TimingTower from './charts/TimingTower';
import TrackMap from './charts/TrackMap';
import TyreDeg from './charts/TyreDeg';
import TyreStrategy from './charts/TyreStrategy';
import Battle from './Battle';
import Chase from './Chase';
import VideoTile from './VideoTile';

export const components: ComponentDefinition[] = [
  VideoTile,
  Battle,
  Chase,
  TimingTower,
  GapEvolution,
  TyreStrategy,
  TyreDeg,
  PitWindow,
  PitWindows,
  SectorTable,
  RaceControl,
  RaceStatus,
  TrackMap,
  CarTelemetry,
  PedalBarcode,
  SpeedRibbon,
];
