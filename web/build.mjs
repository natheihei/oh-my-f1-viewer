// Builds the browser version into dist-web/, a folder Chrome loads as an unpacked extension:
//   node web/build.mjs [--dev]
// The renderer is built by Vite from the same src/. The main-process code (electron/) is bundled by
// esbuild for the page, with Node's and Electron's modules swapped for the shims in web/shims.
// See docs/WEB.md.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'dist-web');
const dev = process.argv.includes('--dev');
const require = createRequire(path.join(root, 'package.json'));
const shim = (file) => path.join(root, 'web/shims', file);

/** Node and Electron modules with a shim of their own. */
const SHIMS = {
  electron: shim('electron.ts'),
  fs: shim('fs.ts'),
  'fs/promises': shim('fs-promises.ts'),
  os: shim('os.ts'),
  crypto: shim('crypto.ts'),
  zlib: shim('zlib.ts'),
  undici: shim('undici.ts'),
  ws: shim('ws.ts'),
  child_process: shim('child_process.ts'),
  http: shim('http.ts'),
  worker_threads: shim('worker_threads.ts'),
  sqlite: shim('sqlite.ts'),
  'timers/promises': shim('timers-promises.ts'),
  url: shim('url.ts'),
  esbuild: shim('esbuild.ts'),
  process: shim('process.ts'),
  // Packages that do the same job as a Node module, written for browsers. The trailing slash keeps Node
  // from resolving its own module of that name.
  path: require.resolve('path-browserify'),
  events: require.resolve('events/'),
  buffer: shim('buffer.ts'),
  'f1a-npm:buffer': require.resolve('buffer/'),
  stream: require.resolve('readable-stream'),
  string_decoder: require.resolve('string_decoder/'),
};
const builtins = new Set(builtinModules);
const asked = {};
const HIDDEN_IMPORT = '=> import(__rewriteRelativeImportExtension(specifier));';

function nodeShims() {
  return {
    name: 'f1a-node-shims',
    setup(build) {
      build.onResolve({ filter: /^[@a-z]/ }, (args) => {
        // A trailing slash asks for the package of that name, which is the same stand-in here.
        const name = args.path.startsWith('f1a-npm:') ? args.path : args.path.replace(/^node:/, '').replace(/\/$/, '');
        const known = SHIMS[name];
        const builtin = args.path.startsWith('node:') || builtins.has(name) || builtins.has(name.split('/')[0]);
        if (process.env.F1A_LIST_SHIMS && (known || builtin)) {
          const from = args.importer.replace(root + '/', '').replace(/node_modules\/((@[^/]+\/)?[^/]+)\/.*/, '$1').replace(/^(electron|web)\/.*/, '$1');
          (asked[name] ??= new Set()).add(from);
        }
        if (known) return { path: known };
        // A Node module nothing here stands in for: importing it is fine, and calling it says which it was.
        if (builtin) return { path: name, namespace: 'f1a-empty' };
        return undefined;
      });
      // pi-ai imports three Node modules by a name it builds at run time: see web/backend/piRuntime.ts.
      build.onLoad({ filter: /node_modules\/@earendil-works\/pi-ai\/.*\.js$/ }, (args) => {
        const text = readFileSync(args.path, 'utf8');
        if (!text.includes(HIDDEN_IMPORT)) return undefined;
        return { contents: text.replaceAll(HIDDEN_IMPORT, '=> globalThis.__f1aNodeImport(specifier);'), loader: 'js' };
      });
      build.onLoad({ filter: /.*/, namespace: 'f1a-empty' }, (args) => ({
        contents: `module.exports = require(${JSON.stringify(shim('empty.ts'))}).emptyModule(${JSON.stringify(args.path)});`,
        resolveDir: root,
      }));
    },
  };
}

const common = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  // Names appear in errors the agent and the user read.
  keepNames: true,
  logLevel: 'warning',
  inject: [shim('globals.ts')],
  define: { __dirname: '"/app"', __filename: '"/app/main.js"', 'process.env.NODE_ENV': '"production"' },
  conditions: ['browser', 'import', 'default'],
  mainFields: ['browser', 'module', 'main'],
  loader: { '.node': 'empty', '.md': 'text' },
  plugins: [nodeShims()],
  logOverride: { 'commonjs-variable-in-esm': 'silent', 'require-resolve-not-external': 'silent' },
};

/** The host's and kit's declarations, which a mod's author reads, as one JSON file the page writes into its volume. */
function modTypes() {
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.types.json'], { cwd: root, stdio: 'inherit' });
  const from = path.join(root, 'dist-types');
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.d.ts')) files[path.relative(from, full)] = readFileSync(full, 'utf8');
    }
  };
  walk(from);
  writeFileSync(path.join(out, 'mod-types.json'), JSON.stringify(files));
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await viteBuild({ configFile: path.join(root, 'vite.web.config.ts'), logLevel: 'warn', build: { minify: !dev, sourcemap: dev ? 'inline' : false } });

await Promise.all([
  esbuild.build({ ...common, entryPoints: [path.join(root, 'web/backend/main.ts')], outfile: path.join(out, 'backend.js') }),
  esbuild.build({ ...common, entryPoints: [path.join(root, 'web/timing-worker.ts')], outfile: path.join(out, 'timing-worker.js') }),
  esbuild.build({ ...common, inject: [], plugins: [], entryPoints: [path.join(root, 'web/sw.ts')], outfile: path.join(out, 'sw.js') }),
  esbuild.build({ ...common, inject: [], plugins: [], format: 'iife', entryPoints: [path.join(root, 'web/key.ts')], outfile: path.join(out, 'key.js') }),
  esbuild.build({ ...common, inject: [], plugins: [], format: 'iife', entryPoints: [path.join(root, 'web/signin.ts')], outfile: path.join(out, 'signin.js') }),
  esbuild.build({ ...common, inject: [], plugins: [], format: 'iife', entryPoints: [path.join(root, 'web/folder.ts')], outfile: path.join(out, 'folder.js') }),
]);

modTypes();
for (const file of ['manifest.json', 'key.html', 'signin.html', 'folder.html']) cpSync(path.join(root, 'web', file), path.join(out, file));
mkdirSync(path.join(out, 'icons'));
for (const file of readdirSync(path.join(root, 'web/icons'))) if (file.endsWith('.png')) cpSync(path.join(root, 'web/icons', file), path.join(out, 'icons', file));
cpSync(require.resolve('esbuild-wasm/esbuild.wasm'), path.join(out, 'esbuild.wasm'));
const sqlite = path.dirname(require.resolve('@sqlite.org/sqlite-wasm/package.json'));
for (const file of ['sqlite3.wasm', 'sqlite3-opfs-async-proxy.js']) cpSync(path.join(sqlite, 'dist', file), path.join(out, file));

if (process.env.F1A_LIST_SHIMS) for (const [name, from] of Object.entries(asked).sort()) console.log(name.padEnd(20), SHIMS[name] ? 'shim ' : 'EMPTY', [...from].join(', '));
console.log(`Built ${path.relative(root, out)}/. Load it in chrome://extensions with "Load unpacked".`);
