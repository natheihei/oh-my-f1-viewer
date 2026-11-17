/** What charts share, and what components share: "omfv/kit". See docs/ARCHITECTURE.md, "Charts". */
export { ChartCanvas, COMPACT_BELOW, compactSmall, type Box, type Draw, type Extent, type Pointer } from './ChartCanvas';
export { ChartFrame } from './ChartFrame';
export { codeOf, useDriverStyles } from '../host';
export * from './codes';
export { colors, DASH, tyreColour } from './colors';
export { displayed, useDriverSet } from './drivers';
export { driverStyles, styleOf, type DriverStyle } from '../host';
export * from './draw';
export * from './laps';
export { spreadLabels } from './labels';
export { circuitMessage } from './status';
export { linear, niceCeil, niceStep, ticks, type Scale } from './scale';
export * from './track';
export * from './values';
// Models more than one built-in component shares: the running order and fights, race control's messages, and a pit stop played out.
export * from './fights';
export * from './pitWindow';
export * from './raceControl';
