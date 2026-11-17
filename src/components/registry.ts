/** Every component a tile can show: video, charts, and views that mix them. Each is added here. */
import type { ComponentDefinition } from '../host';
import GapEvolution from './gap_evolution/main';
import PitWindow from './pit_window/main';
import PitWindows from './pit_windows/main';
import RaceControl from './race_control/main';
import RaceStatus from './race_status/main';
import SectorTable from './sector_table/main';
import SpeedRibbon from './speed_ribbon/main';
import CarTelemetry from './car_telemetry/main';
import PedalBarcode from './pedal_barcode/main';
import TimingTower from './timing_tower/main';
import TrackMap from './track_map/main';
import TyreDeg from './tyre_deg/main';
import TyreStrategy from './tyre_strategy/main';
import Battle from './battle/main';
import Chase from './chase/main';
import VideoTile from './video/main';

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
