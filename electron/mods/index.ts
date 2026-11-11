/**
 * Mods: plugins in folders under the app's data folder, each defining one tile component for now. This
 * watches the folder, compiles each mod with esbuild on save and serves the build to the renderer, which imports and registers it. The
 * renderer reports back whether it loaded. See docs/MODS.md.
 */
import { existsSync, promises as fsp, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { SHARED_MODULES, type ModLogLine, type ModStatus } from '../../shared/mods';

export const MOD_SCHEME = 'f1a-mod';
const ENTRIES = ['main.tsx', 'main.ts', 'main.jsx', 'main.js'];
/** The files the app writes into a mod's folder, which mustn't start a build. */
const WRITTEN = new Set(['mod.error', 'mod.log']);
/** A component name: what the folder is called. */
const NAME = /^[a-z][a-z0-9_-]{0,47}$/;
/** Editors and agents often write a temp file and rename it, or save several files at once. */
const DEBOUNCE_MS = 120;
const MAX_LOG_LINES = 300;

interface Mod {
  name: string;
  dir: string;
  entry: string | null;
  context: esbuild.BuildContext | null;
  status: ModStatus;
  code: string | null;
  log: ModLogLine[];
  timer: NodeJS.Timeout | null;
  logTimer: NodeJS.Timeout | null;
  building: Promise<void> | null;
  /** A save arrived during a build: build again when it's done. */
  again: boolean;
}

const urlOf = (name: string, version: number) => `${MOD_SCHEME}://mods/${name}/main.js?v=${version}`;
const inside = (file: string, dir: string) => file === dir || file.startsWith(dir + path.sep);

function entryOf(dir: string): string | null {
  return ENTRIES.find((name) => existsSync(path.join(dir, name))) ?? null;
}

/** Keeps a mod's imports to the modules it shares with the app and its own files. */
function sharedModules(dir: string): esbuild.Plugin {
  return {
    name: 'f1a-shared',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        if ((SHARED_MODULES as readonly string[]).includes(args.path)) return { path: args.path, namespace: 'f1a-shared' };
        if (args.path.startsWith('.') || path.isAbsolute(args.path)) {
          const target = path.resolve(args.resolveDir, args.path);
          if (inside(target, dir)) return undefined;
          return { errors: [{ text: `A mod can only import files in its own folder, not "${args.path}".` }] };
        }
        return { errors: [{ text: `"${args.path}" isn't available to mods. They can import ${SHARED_MODULES.join(', ')} and their own files.` }] };
      });
      // The app's own copy, which src/main.tsx hands over, so hooks and schemas work across the boundary.
      build.onLoad({ filter: /.*/, namespace: 'f1a-shared' }, (args) => ({
        contents: `module.exports = globalThis.__f1aShared[${JSON.stringify(args.path)}];`,
        loader: 'js',
      }));
    },
  };
}

async function formatErrors(e: unknown): Promise<string> {
  const errors = (e as { errors?: esbuild.Message[] })?.errors;
  if (Array.isArray(errors) && errors.length) {
    const lines = await esbuild.formatMessages(errors, { kind: 'error', color: false });
    return lines.join('\n').trim();
  }
  return e instanceof Error ? e.message : String(e);
}

/** Where the app keeps what a mod's types come from: the host's and kit's declarations, and its packages. */
export interface TypeSources {
  /** `dist-types`, from `npm run build:types`. */
  declarations: string;
  nodeModules: string;
}

export class Mods {
  private readonly mods = new Map<string, Mod>();
  private watcher: FSWatcher | null = null;
  private scanTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly dir: string,
    private readonly onChange: (list: ModStatus[]) => void,
    private readonly types: TypeSources | null = null,
  ) {}

  async start(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    if (this.types) await this.writeTypes(this.types).catch((e: Error) => console.warn('[mods] types:', e.message));
    await this.scan();
    this.watcher = watch(this.dir, { recursive: true }, (_event, file) => this.changed(file ? String(file) : null));
    this.watcher.on('error', (e) => console.warn('[mods] watcher:', e.message));
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
    await Promise.all([...this.mods.values()].map((m) => m.context?.dispose()));
    await esbuild.stop();
  }

  /**
   * Copies the declarations into `.types` and writes a `tsconfig.json` that finds them, and React and
   * TypeBox in the app's packages, so `tsc -p <mods folder>` checks every mod without the app running.
   */
  private async writeTypes({ declarations, nodeModules }: TypeSources): Promise<void> {
    const target = path.join(this.dir, '.types');
    await fsp.rm(target, { recursive: true, force: true });
    if (existsSync(declarations)) await fsp.cp(declarations, target, { recursive: true });
    else console.warn('[mods] no declarations at', declarations, ': run npm run build:types');
    const config = {
      '//': 'Written by f1a on every start: edits are lost. See docs/MODS.md.',
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        esModuleInterop: true,
        isolatedModules: true,
        types: [],
        paths: {
          f1a: ['./.types/src/host/index.d.ts'],
          'f1a/kit': ['./.types/src/components/charts/kit/index.d.ts'],
          // Type packages first: `react` itself ships JavaScript only.
          '*': [path.join(nodeModules, '@types', '*'), path.join(nodeModules, '*')],
        },
      },
      include: ['*/**/*.ts', '*/**/*.tsx'],
    };
    await fsp.writeFile(path.join(this.dir, 'tsconfig.json'), JSON.stringify(config, null, 2) + '\n');
  }

  list(): ModStatus[] {
    return [...this.mods.values()].map((m) => m.status).sort((a, b) => a.name.localeCompare(b.name));
  }

  status(name: string): ModStatus | null {
    return this.mods.get(name)?.status ?? null;
  }

  logs(name: string): ModLogLine[] {
    return this.mods.get(name)?.log ?? [];
  }

  /** Serves `f1a-mod://mods/<name>/main.js`: the latest build that compiled. */
  serve(request: Request): Response {
    const url = new URL(request.url);
    const [, name, file] = url.pathname.split('/');
    const mod = url.host === 'mods' && file === 'main.js' ? this.mods.get(name) : undefined;
    if (!mod?.code) return new Response('Not found', { status: 404 });
    return new Response(mod.code, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  /** The renderer's report on a build: it loaded and registered, or `error` says why not. */
  loaded(name: string, version: number, error: string | null): void {
    const mod = this.mods.get(name);
    if (!mod || mod.status.version !== version) return;
    mod.status = { ...mod.status, state: error ? 'failed' : 'ready', error };
    void this.writeError(mod);
    this.publish();
  }

  /** A line of a mod's console output or a render error, from the renderer. */
  log(name: string, line: ModLogLine): void {
    const mod = this.mods.get(name);
    if (!mod) return;
    mod.log.push({ at: Number(line.at) || Date.now(), level: line.level, text: String(line.text).slice(0, 4000) });
    if (mod.log.length > MAX_LOG_LINES) mod.log.splice(0, mod.log.length - MAX_LOG_LINES);
    if (mod.logTimer) return;
    mod.logTimer = setTimeout(() => {
      mod.logTimer = null;
      const text = mod.log.map((l) => `${new Date(l.at).toISOString()} ${l.level} ${l.text}`).join('\n') + '\n';
      fsp.writeFile(path.join(mod.dir, 'mod.log'), text).catch(() => {});
    }, 500);
  }

  private changed(file: string | null): void {
    const parts = file ? file.split(path.sep) : [];
    // At the top level: a folder came or went, or the app wrote its own files there.
    if (parts.length < 2) return this.scheduleScan();
    if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) return;
    if (parts.length === 2 && WRITTEN.has(parts[1])) return;
    const mod = this.mods.get(parts[0]);
    if (mod) this.scheduleBuild(mod);
    else this.scheduleScan();
  }

  private scheduleScan(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      void this.scan().finally(() => (this.scanTimer = null));
    }, DEBOUNCE_MS);
  }

  private scheduleBuild(mod: Mod): void {
    if (mod.timer) clearTimeout(mod.timer);
    mod.timer = setTimeout(() => {
      mod.timer = null;
      this.build(mod);
    }, DEBOUNCE_MS);
  }

  /** Finds mods that appeared or went. A folder is a mod once it has a `main` file. */
  private async scan(): Promise<void> {
    const names = await fsp.readdir(this.dir).catch(() => [] as string[]);
    const present = new Set<string>();
    for (const name of names) {
      const dir = path.join(this.dir, name);
      if (name.startsWith('.') || !statSync(dir, { throwIfNoEntry: false })?.isDirectory() || !entryOf(dir)) continue;
      present.add(name);
      if (this.mods.has(name)) continue;
      const mod: Mod = {
        name,
        dir,
        entry: null,
        context: null,
        status: { name, state: 'loading', version: 0, url: null, error: null },
        code: null,
        log: [],
        timer: null,
        logTimer: null,
        building: null,
        again: false,
      };
      this.mods.set(name, mod);
      if (!NAME.test(name)) {
        mod.status = { ...mod.status, state: 'failed', error: `"${name}" can't be a mod's name: use lower-case letters, digits, _ and -, starting with a letter.` };
        void this.writeError(mod);
        continue;
      }
      this.build(mod);
    }
    let removed = false;
    for (const [name, mod] of this.mods) {
      if (present.has(name)) continue;
      this.mods.delete(name);
      if (mod.timer) clearTimeout(mod.timer);
      void mod.context?.dispose();
      removed = true;
    }
    if (removed) this.publish();
  }

  private build(mod: Mod): void {
    if (!NAME.test(mod.name)) return;
    if (mod.building) {
      mod.again = true;
      return;
    }
    mod.building = (async () => {
      do {
        mod.again = false;
        await this.buildOnce(mod);
      } while (mod.again);
    })().finally(() => {
      mod.building = null;
    });
  }

  private async buildOnce(mod: Mod): Promise<void> {
    const entry = entryOf(mod.dir);
    if (!entry) return this.scheduleScan();
    try {
      if (!mod.context || mod.entry !== entry) {
        await mod.context?.dispose();
        mod.entry = entry;
        mod.context = await esbuild.context({
          entryPoints: [path.join(mod.dir, entry)],
          absWorkingDir: mod.dir,
          bundle: true,
          format: 'esm',
          platform: 'browser',
          target: 'es2022',
          write: false,
          outfile: path.join(mod.dir, 'main.js'),
          jsx: 'automatic',
          sourcemap: 'inline',
          logLevel: 'silent',
          // Its console writes to mod.log as well as the app's.
          banner: { js: `const console = globalThis.__f1aModConsole(${JSON.stringify(mod.name)});` },
          plugins: [sharedModules(mod.dir)],
        });
      }
      const result = await mod.context.rebuild();
      const output = result.outputFiles?.find((f) => f.path.endsWith('.js'));
      if (!output) throw new Error('The build produced no JavaScript.');
      mod.code = output.text;
      const version = mod.status.version + 1;
      mod.status = { name: mod.name, state: 'loading', version, url: urlOf(mod.name, version), error: null };
    } catch (e) {
      mod.status = { ...mod.status, state: 'failed', error: await formatErrors(e) };
      await this.writeError(mod);
    }
    this.publish();
  }

  private async writeError(mod: Mod): Promise<void> {
    const file = path.join(mod.dir, 'mod.error');
    if (mod.status.state === 'failed' && mod.status.error) await fsp.writeFile(file, mod.status.error + '\n').catch(() => {});
    else await fsp.rm(file, { force: true }).catch(() => {});
  }

  private publish(): void {
    this.onChange(this.list());
  }
}
