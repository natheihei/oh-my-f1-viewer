/**
 * VMP-signs the app through castLabs' EVS: the Mac app as electron-builder's afterPack, before electron-builder signs
 * it for Apple, and the Windows app as its afterSign, through build/vmp-sign-win.js.
 *
 * castLabs' Electron carries a development VMP signature, and F1 TV's licence server refuses it for a DRM stream, which
 * every live session is: "Widevine license generation failed (DEVELOPMENT_CERTIFICATE_NOT_ALLOWED)". EVS replaces it
 * with a production one. On a Mac it has to come before the Apple signature, which seals it. On Windows it's a .sig
 * file beside the .exe, made from the .exe as it is, so it has to come after electron-builder edits the .exe's icon
 * and details, and after any Authenticode signature. Linux has no VMP.
 *
 * It signs as the EVS account in EVS_ACCOUNT_NAME and EVS_PASSWD, or as the one `castlabs_evs.account` last signed in
 * on this machine. Without either it warns and leaves the app as it is, unless VMP_REQUIRED is `true`, as it is for
 * a release. EVS_PYTHON names the python that has castlabs-evs, when it isn't `python3` (`python` on Windows). See
 * docs/RELEASE.md.
 */
const { execFileSync } = require('node:child_process');

const HOW = 'See "VMP-sign the app" in docs/RELEASE.md.';

/** Signs the app in context.appOutDir for `platform`: `darwin` or `win32`, and does nothing for any other. */
async function vmpSign(context, platform) {
  if (context.electronPlatformName !== platform) return;
  const what = platform === 'darwin' ? 'Mac' : 'Windows';
  const python = process.env.EVS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const evs = (args) =>
    execFileSync(python, ['-m', 'castlabs_evs.vmp', ...args], {
      stdio: 'inherit',
      // Never stop to ask for a password: a build without a sign-in fails here instead.
      env: { ...process.env, EVS_NO_ASK: '1' },
    });
  const { EVS_ACCOUNT_NAME: account, EVS_PASSWD: password } = process.env;
  const signIn = account && password ? ['-A', account, '-P', password] : [];
  try {
    // The folder holding the .app or the .exe, not the app itself.
    evs(['sign-pkg', ...signIn, context.appOutDir]);
    evs(['verify-pkg', context.appOutDir]);
  } catch (e) {
    // The command line holds the password, so the error's own message isn't repeated.
    const why = e.code === 'ENOENT' ? `${python} isn't installed` : 'castlabs_evs failed, as above';
    if (process.env.VMP_REQUIRED === 'true') throw new Error(`The ${what} app isn't VMP-signed: ${why}. ${HOW}`);
    console.warn(`\n  ! Not VMP-signed (${why}): this ${what} app won't play live sessions or other DRM streams. ${HOW}\n`);
  }
}

exports.vmpSign = vmpSign;
exports.default = (context) => vmpSign(context, 'darwin');
