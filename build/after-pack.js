/**
 * electron-builder afterPack hook:
 * 1. On macOS, rebuilds Squirrel.framework's ShipIt with Squirrel.Mac#331 before any signing seals it.
 * 2. On macOS, VMP-signs the app through castLabs' EVS (before electron-builder's Apple signature).
 */
const { patchSquirrelShipIt } = require('./patch-squirrel-shipit');
const { vmpSign } = require('./vmp-sign');

exports.default = async (context) => {
  await patchSquirrelShipIt(context);
  await vmpSign(context, 'darwin');
};
