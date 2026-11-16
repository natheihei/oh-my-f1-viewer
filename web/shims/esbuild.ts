/**
 * `esbuild` in the browser: its WebAssembly build, reading files from the in-memory volume. A plugin
 * added last resolves and loads what the caller's own plugins leave alone, in the `file` namespace, so
 * paths in errors and source maps read as they do on disk.
 */
import * as wasm from 'esbuild-wasm/esm/browser.js';
import fs from 'node:fs';
import path from 'node:path';

const LOADERS: Record<string, wasm.Loader> = { '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js', '.json': 'json', '.css': 'css', '.txt': 'text' };
const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.json', '.css'];

let ready: Promise<void> | null = null;
/** In this thread, not esbuild's own worker: that one starts from a blob URL, which an extension page's policy refuses. */
const init = (): Promise<void> => (ready ??= wasm.initialize({ wasmURL: new URL('esbuild.wasm', location.href).href, worker: false }));

const isFile = (file: string) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;

function findFile(target: string): string | null {
  if (isFile(target)) return target;
  for (const extension of EXTENSIONS) if (isFile(target + extension)) return target + extension;
  for (const extension of EXTENSIONS) if (isFile(path.join(target, 'index' + extension))) return path.join(target, 'index' + extension);
  return null;
}

function volumeFiles(workingDir: string): wasm.Plugin {
  return {
    name: 'f1a-volume',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.namespace !== 'file' && args.namespace !== '') return undefined;
        if (!args.path.startsWith('.') && !path.isAbsolute(args.path)) return { errors: [{ text: `Could not resolve "${args.path}"` }] };
        const found = findFile(path.resolve(args.kind === 'entry-point' ? workingDir : args.resolveDir, args.path));
        return found ? { path: found, namespace: 'file' } : { errors: [{ text: `Could not resolve "${args.path}"` }] };
      });
      build.onLoad({ filter: /.*/, namespace: 'file' }, (args) => {
        const loader = LOADERS[path.extname(args.path)];
        if (!loader) return { errors: [{ text: `No loader is configured for "${path.extname(args.path)}" files: ${args.path}` }] };
        return { contents: fs.readFileSync(args.path) as unknown as Uint8Array, loader, resolveDir: path.dirname(args.path) };
      });
    },
  };
}

const withVolume = <T extends wasm.BuildOptions>(options: T): T => ({
  ...options,
  plugins: [...(options.plugins ?? []), volumeFiles(options.absWorkingDir ?? '/')],
});

export async function context(options: wasm.BuildOptions): Promise<wasm.BuildContext> {
  await init();
  return wasm.context(withVolume(options));
}

export async function build(options: wasm.BuildOptions): Promise<wasm.BuildResult> {
  await init();
  return wasm.build(withVolume(options));
}

export async function transform(input: string, options?: wasm.TransformOptions): Promise<wasm.TransformResult> {
  await init();
  return wasm.transform(input, options);
}

export async function formatMessages(messages: wasm.PartialMessage[], options: wasm.FormatMessagesOptions): Promise<string[]> {
  await init();
  return wasm.formatMessages(messages, options);
}

/** The page keeps the compiler for its whole life. */
export async function stop(): Promise<void> {}

export const version = wasm.version;
export type { BuildContext, BuildOptions, BuildResult, Loader, Message, Plugin } from 'esbuild-wasm/esm/browser.js';
