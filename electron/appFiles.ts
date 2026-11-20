/**
 * Where the app's own files are, run from a checkout or packaged (see docs/RELEASE.md). main.ts imports this
 * first, because it also tells esbuild where its binary is, and that has to happen before anything requires esbuild.
 */
import { app } from 'electron';
import path from 'node:path';

/** The checkout, from `dist-electron/electron/`. Packaged, it's inside `app.asar`. */
const ROOT = path.join(__dirname, '..', '..');

/** Folders the mods code copies from, which ship next to `app.asar` in a packaged app (`extraResources`). */
const RESOURCES = app.isPackaged ? process.resourcesPath : null;

/** `dist-types`, from `npm run build:types`: the host's and kit's declarations, for the build agent. */
export const DECLARATIONS = RESOURCES ? path.join(RESOURCES, 'dist-types') : path.join(ROOT, 'dist-types');

/** The installed components' sources, which the build agent can read and fork. */
export const COMPONENTS = RESOURCES ? path.join(RESOURCES, 'components') : path.join(ROOT, 'src', 'components');

// esbuild spawns its native binary, and nothing can spawn a file inside app.asar. Packaging unpacks it
// (`asarUnpack`) into app.asar.unpacked, and esbuild reads this variable for where it went.
if (app.isPackaged && process.platform !== 'win32' && !process.env.ESBUILD_BINARY_PATH) {
  process.env.ESBUILD_BINARY_PATH = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@esbuild',
    `${process.platform}-${process.arch}`,
    'bin',
    'esbuild',
  );
}
