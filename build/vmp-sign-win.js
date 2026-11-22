/**
 * electron-builder's afterSign: VMP-signs the Windows app, once its .exe has its icon and details and any Authenticode
 * signature, since the VMP signature is made from the .exe as it is. See build/vmp-sign.js and docs/RELEASE.md.
 */
const { vmpSign } = require('./vmp-sign');

exports.default = (context) => vmpSign(context, 'win32');
