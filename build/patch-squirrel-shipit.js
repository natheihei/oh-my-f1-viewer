/**
 * Rebuilds Squirrel.framework's ShipIt binary on macOS with Squirrel/Squirrel.Mac#331 applied
 * (https://github.com/Squirrel/Squirrel.Mac/pull/331), so ShipIt removes its own launchd job when
 * an update finishes instead of leaving a stale background item in the macOS Dock after quit.
 *
 * Runs during electron-builder's afterPack (before VMP signing and Apple codesign/notarization) so
 * the patched ShipIt binary is sealed with the rest of the app bundle. Remove this script and
 * build/patches/squirrel-mac-331.patch once our Electron version includes Squirrel.Mac#331.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Exact commits matching Electron v45.2.1's Squirrel.Mac (fffea30e4a + PR #335 backport = 5c9e2133c0)
// and its Mantle / ReactiveObjC header deps from Electron's DEPS.
const REPOS = {
  squirrel: {
    url: 'https://github.com/Squirrel/Squirrel.Mac.git',
    sha: '5c9e2133c09d6f8e2e3c5a45c5b0ffc00448c58a',
  },
  reactiveObjC: {
    url: 'https://github.com/ReactiveCocoa/ReactiveObjC.git',
    sha: '74ab5baccc6f7202c8ac69a8d1e152c29dc1ea76',
  },
  mantle: {
    url: 'https://github.com/Mantle/Mantle.git',
    sha: '2a8e2123a3931038179ee06105c9e6ec336b12ea',
  },
};

// Matches the `squirrel_shipit` executable target in Squirrel.Mac's BUILD.gn.
const SHIPIT_SOURCES = [
  'Squirrel/NSBundle+SQRLVersionExtensions.m',
  'Squirrel/NSError+SQRLVerbosityExtensions.m',
  'Squirrel/NSProcessInfo+SQRLVersionExtensions.m',
  'Squirrel/RACSignal+SQRLTransactionExtensions.m',
  'Squirrel/SQRLCodeSignature.m',
  'Squirrel/SQRLInstaller.m',
  'Squirrel/SQRLInstallerOwnedBundle.m',
  'Squirrel/SQRLShipItRequest.m',
  'Squirrel/SQRLTerminationListener.m',
  'Squirrel/ShipIt-main.m',
];

const PATCH_PATH = path.join(__dirname, 'patches', 'squirrel-mac-331.patch');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/** Ensures a cached checkout of `url` at exact commit `sha` exists in `dir`. */
function ensureRepoAtSha(dir, url, sha) {
  const head = path.join(dir, '.git');
  if (fs.existsSync(head)) {
    try {
      const current = run('git', ['rev-parse', 'HEAD'], { cwd: dir }).trim();
      if (current === sha) return;
    } catch {
      // Corrupted cache entry; re-fetch below.
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  run('git', ['init', '-q'], { cwd: dir });
  run('git', ['fetch', '--depth', '1', url, sha], { cwd: dir });
  run('git', ['checkout', '-q', '--force', 'FETCH_HEAD'], { cwd: dir });
}

function copyHeaders(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.h')) {
      fs.copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
    }
  }
}

/**
 * Replaces Squirrel.framework's ShipIt in the packed macOS .app with a freshly compiled binary
 * that includes Squirrel/Squirrel.Mac#331. Does nothing on non-macOS builds.
 */
async function patchSquirrelShipIt(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.platform !== 'darwin') {
    throw new Error('Patching Squirrel.Mac ShipIt requires building on macOS (clang + macOS SDK).');
  }

  const productName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productName}.app`);
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  const shipItPath = path.join(frameworksDir, 'Squirrel.framework', 'Versions', 'A', 'Resources', 'ShipIt');

  if (!fs.existsSync(shipItPath)) {
    throw new Error(`Expected Squirrel ShipIt binary at ${shipItPath}`);
  }

  const archs = run('lipo', ['-archs', shipItPath]).trim().split(/\s+/).filter(Boolean);
  if (archs.length === 0) {
    throw new Error(`Could not determine architecture(s) of ${shipItPath}`);
  }

  const cacheRoot = path.join(process.env.OMFV_SHIPIT_CACHE || path.join(os.homedir(), '.cache', 'omfv-shipit-src'));
  const squirrelCache = path.join(cacheRoot, `squirrel-${REPOS.squirrel.sha.slice(0, 12)}`);
  const racCache = path.join(cacheRoot, `reactiveobjc-${REPOS.reactiveObjC.sha.slice(0, 12)}`);
  const mantleCache = path.join(cacheRoot, `mantle-${REPOS.mantle.sha.slice(0, 12)}`);

  console.log(`  • patching Squirrel.Mac ShipIt with PR #331 (${archs.join(', ')})`);
  ensureRepoAtSha(squirrelCache, REPOS.squirrel.url, REPOS.squirrel.sha);
  ensureRepoAtSha(racCache, REPOS.reactiveObjC.url, REPOS.reactiveObjC.sha);
  ensureRepoAtSha(mantleCache, REPOS.mantle.url, REPOS.mantle.sha);

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omfv-shipit-build-'));
  try {
    // Stage a clean copy of Squirrel/ so applying the patch never mutates the cache.
    fs.cpSync(path.join(squirrelCache, 'Squirrel'), path.join(stageDir, 'Squirrel'), { recursive: true });
    run('git', ['apply', '--verbose', PATCH_PATH], { cwd: stageDir });

    // Electron strips Headers/ from the bundled frameworks, so stage ReactiveObjC & Mantle headers.
    const includeDir = path.join(stageDir, 'include');
    const racInclude = path.join(includeDir, 'ReactiveObjC');
    const mantleInclude = path.join(includeDir, 'Mantle');
    copyHeaders(path.join(racCache, 'ReactiveObjC'), racInclude);
    copyHeaders(path.join(racCache, 'ReactiveObjC', 'extobjc'), racInclude);
    copyHeaders(path.join(mantleCache, 'Mantle', 'include'), mantleInclude);

    const outBinary = path.join(stageDir, 'ShipIt');
    const archFlags = archs.flatMap((arch) => ['-arch', arch]);
    const sourceFiles = SHIPIT_SOURCES.map((rel) => path.join(stageDir, rel));

    run('clang', [
      '-O2',
      '-fobjc-arc',
      '-fobjc-weak',
      '-Wno-unknown-warning-option',
      '-Wno-deprecated-declarations',
      '-Wno-block-capture-autoreleasing',
      '-mmacosx-version-min=11.0',
      ...archFlags,
      '-I', includeDir,
      '-I', racInclude,
      '-F', frameworksDir,
      ...sourceFiles,
      '-framework', 'AppKit',
      '-framework', 'Foundation',
      '-framework', 'IOKit',
      '-framework', 'Security',
      '-framework', 'ServiceManagement',
      '-framework', 'Mantle',
      '-framework', 'ReactiveObjC',
      '-Wl,-rpath,@executable_path/../..',
      '-Wl,-rpath,@executable_path/../../../..',
      '-o', outBinary,
    ]);

    // Sanity-check that SMJobRemove is linked and framework install names match Electron's layout.
    const symbols = run('nm', ['-u', outBinary]);
    if (!symbols.includes('_SMJobRemove')) {
      throw new Error('Compiled ShipIt does not reference _SMJobRemove; PR #331 patch may not have taken effect.');
    }
    const deps = run('otool', ['-L', outBinary]);
    for (const expected of [
      '@rpath/Mantle.framework/Mantle',
      '@rpath/ReactiveObjC.framework/ReactiveObjC',
      'ServiceManagement.framework',
    ]) {
      if (!deps.includes(expected)) {
        throw new Error(`Compiled ShipIt is missing expected link dependency: ${expected}\n${deps}`);
      }
    }

    fs.copyFileSync(outBinary, shipItPath);
    fs.chmodSync(shipItPath, 0o755);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

exports.patchSquirrelShipIt = patchSquirrelShipIt;
exports.REPOS = REPOS;
exports.PATCH_PATH = PATCH_PATH;
