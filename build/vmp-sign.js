/**
 * electron-builder's afterPack: VMP-signs the Mac app through castLabs' EVS, before electron-builder signs it for Apple.
 *
 * castLabs' Electron carries a development VMP signature, and F1 TV's licence server refuses it for a DRM stream, which
 * every live session is: "Widevine license generation failed (DEVELOPMENT_CERTIFICATE_NOT_ALLOWED)". EVS replaces it
 * with a production one. It has to come before the Apple signature, which seals it. Linux has no VMP.
 *
 * It signs as the EVS account in EVS_ACCOUNT_NAME and EVS_PASSWD, or as the one `castlabs_evs.account` last signed in
 * on this machine. Without either it warns and leaves the app as it is, unless VMP_REQUIRED is `true`, as it is for
 * a release. EVS_PYTHON names the python that has castlabs-evs, when it isn't `python3`. See docs/RELEASE.md.
 */
const { execFileSync } = require('node:child_process');

const HOW = 'See "VMP-sign the Mac build" in docs/RELEASE.md.';

exports.default = async function vmpSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const python = process.env.EVS_PYTHON || 'python3';
  const evs = (args) =>
    execFileSync(python, ['-m', 'castlabs_evs.vmp', ...args], {
      stdio: 'inherit',
      // Never stop to ask for a password: a build without a sign-in fails here instead.
      env: { ...process.env, EVS_NO_ASK: '1' },
    });
  const { EVS_ACCOUNT_NAME: account, EVS_PASSWD: password } = process.env;
  const signIn = account && password ? ['-A', account, '-P', password] : [];
  try {
    // The folder holding the .app, not the .app itself.
    evs(['sign-pkg', ...signIn, context.appOutDir]);
    evs(['verify-pkg', context.appOutDir]);
  } catch (e) {
    // The command line holds the password, so the error's own message isn't repeated.
    const why = e.code === 'ENOENT' ? `${python} isn't installed` : 'castlabs_evs failed, as above';
    if (process.env.VMP_REQUIRED === 'true') throw new Error(`The Mac app isn't VMP-signed: ${why}. ${HOW}`);
    console.warn(`\n  ! Not VMP-signed (${why}): this Mac app won't play live sessions or other DRM streams. ${HOW}\n`);
  }
};
