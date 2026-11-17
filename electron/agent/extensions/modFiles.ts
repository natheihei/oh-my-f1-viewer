/**
 * The build agent's own tools: read, write, edit, ls, grep and find, kept inside the mods folder, and
 * ours for forking an installed component, deleting, a mod's status, and a picture of a draft. They run here, not in the renderer, and
 * reach nothing outside the mods folder. They use only plain fs calls. See docs/BUILD_MODE.md.
 *
 * The six file tools were pi-coding-agent's, wrapped. They are ours now, and answer the model in pi's
 * words: the same descriptions, schemas, results, notices and errors, so a build reads as it did.
 */
import { constants, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';
import type { Context } from '@earendil-works/chord/context' with { 'resolution-mode': 'import' };
import type { Extension, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable' with { 'resolution-mode': 'import' };
import { describePlace, notDrawing, type PlaceHealth } from '../../../shared/health';
import type { ModLogLine, ModStatus } from '../../../shared/mods';
import type { Fork } from '../../mods';

/**
 * What the extension needs of pi-durable. pi-durable is ESM only, and this file compiles to CommonJS, so
 * the caller passes the module it imported.
 */
export type Durable = Pick<typeof import('@earendil-works/pi-durable', { with: { 'resolution-mode': 'import' } }), 'defineExtension' | 'defineTool'>;

/** What the tools need from the app. */
export interface ModFilesHost {
  /** The mods folder. */
  dir: string;
  /** Waits for a mod's last save to load or fail. Null when the folder isn't a mod. */
  settled(name: string): Promise<ModStatus | null>;
  logs(name: string): ModLogLine[];
  /** A PNG of a component as it shows now, in the strip or on the grid, or null if it's on neither. */
  picture(name: string): Promise<Buffer | null>;
  /** How every tile and draft is drawing, once each has drawn with its latest code. Null when the app can't say. */
  health(): Promise<PlaceHealth[] | null>;
  /** Copies a component, installed or a mod, into a new mod with a name and title of its own. */
  fork(component: string, name: string, title: string, label?: string): Promise<Fork>;
}

/** Told about each call as it ends, with a line for the palette when there's one to show. */
export type ModToolReport = (name: string, ok: boolean, note: string | null) => void;

const LOG_LINES = 40;
const WRITTEN = new Set(['mod.error', 'mod.log']);

/** pi's DEFAULT_MAX_LINES and DEFAULT_MAX_BYTES: what read, ls, grep and find show at most. */
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
/** Above ours, so pi-durable's own cut never drops the notice that says how to see more. */
const OUTPUT_LIMITS = { maxLines: MAX_LINES + 10, maxBytes: MAX_BYTES + 1024 };
const LS_LIMIT = 500;
const FIND_LIMIT = 1000;
const GREP_LIMIT = 100;
const GREP_LINE = 500;
/** Bigger files aren't searched. */
const GREP_FILE_BYTES = 1024 * 1024;
/** pi asked for strict JSON from providers that offer it, for read, write and edit. */
const STRICT = { type: 'json_schema', strict: 'prefer' } as const;

/** Our own tools' schemas: no field the schema doesn't name. */
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
/** A schema as pi's TypeBox objects serialized: required first, and other fields allowed. */
const piObject = (properties: Record<string, unknown>, required?: string[]) => (required ? { type: 'object', required, properties } : { type: 'object', properties });
const string = (description: string) => ({ type: 'string', description });
const number = (description: string) => ({ type: 'number', description });
const boolean = (description: string) => ({ type: 'boolean', description });

type Output = NonNullable<ToolExecutionResult['output']>;
const text = (value: string): Output => [{ type: 'text', text: value }];

/** Where a path points, or an error if it leaves the mods folder. */
export function resolveInside(dir: string, given: string): string {
  const target = path.resolve(dir, given || '.');
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error(`"${given}" is outside the mods folder. Paths are relative to it, like "my_mod/main.tsx".`);
  return target;
}

/** Refuses anything a build shouldn't write: files the app owns, and files that aren't inside a mod. */
function writable(dir: string, given: string): { file: string; mod: string; rel: string } {
  const file = resolveInside(dir, given);
  const parts = path.relative(dir, file).split(path.sep);
  const rel = parts.join('/');
  if (parts.length < 2) throw new Error('Write inside a mod\'s folder, like "my_mod/main.tsx".');
  if (parts[0] === '.installed') {
    throw new Error(`"${rel}" is an installed component's source, which can't be changed. To change ${parts[2] ? `${parts[2]}, fork it` : 'one, fork it'} with fork_component and edit the fork.`);
  }
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) throw new Error(`"${rel}" is the app's, and can't be written.`);
  if (parts.length === 2 && WRITTEN.has(parts[1])) throw new Error(`The app writes ${parts[1]} itself.`);
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(parts[0])) throw new Error(`"${parts[0]}" can't be a mod's name: use lower-case letters, digits, _ and -, starting with a letter.`);
  return { file, mod: parts[0], rel };
}

function stopIfAborted(context: Context): void {
  if (context.abortSignal?.aborted) throw new Error('Operation aborted');
}

const exists = (p: string) =>
  fsp.access(p, constants.F_OK).then(
    () => true,
    () => false,
  );

/*
 * Paths, as pi's resolveToCwd and resolveReadPathAsync took them (utils/paths.js, core/tools/path-utils.js).
 * The checks then run on the absolute path that comes out, so a refusal names that path, as it did.
 */

const UNICODE_SPACES = /[  -   　]/g;

/** A path the model gave, made absolute: Unicode spaces made plain, a leading @ dropped, ~ and file:// expanded. */
function resolveToDir(given: string, dir: string): string {
  let p = given.replace(UNICODE_SPACES, ' ');
  if (p.startsWith('@')) p = p.slice(1);
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  else if (/^file:\/\//.test(p)) p = fileURLToPath(p);
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(dir, p);
}

/**
 * The file read opens: the path, or the spelling macOS gives a screenshot's name when only that exists
 * (a narrow space before AM/PM, NFD, a curly apostrophe). Variants are tried only inside the folder.
 */
async function resolveReadPath(given: string, dir: string): Promise<string> {
  const resolved = resolveToDir(given, dir);
  if (!isInside(dir, resolved) || (await exists(resolved))) return resolved;
  const nfd = resolved.normalize('NFD');
  const curly = (p: string) => p.replace(/'/g, '’');
  for (const variant of [resolved.replace(/ (AM|PM)\./gi, ' $1.'), nfd, curly(resolved), curly(nfd)]) {
    if (variant !== resolved && isInside(dir, variant) && (await exists(variant))) return variant;
  }
  return resolved;
}

const isInside = (dir: string, p: string) => p === dir || p.startsWith(dir + path.sep);

/*
 * Output limits, ported from pi's core/tools/truncate.js.
 */

const formatSize = (bytes: number) => (bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`);

interface Truncation {
  content: string;
  truncated: boolean;
  truncatedBy: 'lines' | 'bytes' | null;
  outputLines: number;
  firstLineExceedsLimit: boolean;
}

/** The whole lines of content that fit MAX_LINES and MAX_BYTES, as pi's truncateHead keeps them. */
function truncateHead(content: string, maxLines = MAX_LINES): Truncation {
  const lines = content.length === 0 ? [] : content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  if (lines.length <= maxLines && Buffer.byteLength(content, 'utf-8') <= MAX_BYTES) return { content, truncated: false, truncatedBy: null, outputLines: lines.length, firstLineExceedsLimit: false };
  if (Buffer.byteLength(lines[0], 'utf-8') > MAX_BYTES) return { content: '', truncated: true, truncatedBy: 'bytes', outputLines: 0, firstLineExceedsLimit: true };
  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const size = Buffer.byteLength(lines[i], 'utf-8') + (i > 0 ? 1 : 0);
    if (bytes + size > MAX_BYTES) {
      truncatedBy = 'bytes';
      break;
    }
    kept.push(lines[i]);
    bytes += size;
  }
  if (kept.length >= maxLines && bytes <= MAX_BYTES) truncatedBy = 'lines';
  return { content: kept.join('\n'), truncated: true, truncatedBy, outputLines: kept.length, firstLineExceedsLimit: false };
}

/** A grep line cut to GREP_LINE characters, without splitting a surrogate pair. */
function truncateLine(line: string): { text: string; wasTruncated: boolean } {
  if (line.length <= GREP_LINE) return { text: line, wasTruncated: false };
  const high = (c: number) => c >= 0xd800 && c <= 0xdbff;
  const low = (c: number) => c >= 0xdc00 && c <= 0xdfff;
  const head = high(line.charCodeAt(GREP_LINE - 1)) && low(line.charCodeAt(GREP_LINE)) ? line.slice(0, GREP_LINE - 1) : line.slice(0, GREP_LINE);
  return { text: `${head}... [truncated]`, wasTruncated: true };
}

/** Text with its notices in brackets after it, as pi's tools print them. */
const withNotices = (body: string, notices: string[]) => (notices.length ? `${body}\n\n[${notices.join('. ')}]` : body);

/**
 * Everything under a folder, in name order, for find and grep. Dot folders like .types are in. Links
 * aren't followed, so the walk stays in the folder, and node_modules and .git are left out.
 */
async function* walk(root: string, rel = ''): AsyncGenerator<{ rel: string; folder: boolean; file: boolean }> {
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    const folder = entry.isDirectory();
    yield { rel: child, folder, file: entry.isFile() };
    if (folder) yield* walk(root, child);
  }
}

/** Whether a path matches a glob. A pattern without / matches names at any depth, as in pi. */
function globMatcher(pattern: string): (rel: string, folder: boolean) => boolean {
  const options = { dot: true, matchBase: !pattern.includes('/') };
  return (rel, folder) => minimatch(rel, pattern, options) || (folder && minimatch(`${rel}/`, pattern, options));
}

interface ReadArgs {
  path: string;
  offset?: number;
  limit?: number;
}

/** A text file from offset, as pi's read showed it: its lines cut to fit, and how to read on. */
function readText(content: string, { path: given, offset, limit }: ReadArgs): string {
  const allLines = content.split('\n');
  const total = allLines.length;
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const first = startLine + 1;
  const endLine = limit === undefined ? undefined : Math.min(startLine + limit, total);
  const truncation = truncateHead(allLines.slice(startLine, endLine).join('\n'));
  if (startLine >= total) throw new Error(`Offset ${offset} is beyond end of file (${total} lines total)`);
  if (truncation.firstLineExceedsLimit) {
    const size = formatSize(Buffer.byteLength(allLines[startLine] ?? '', 'utf-8'));
    return `[Line ${first} is ${size}, exceeds ${formatSize(MAX_BYTES)} limit. Use bash: sed -n '${first}p' ${given} | head -c ${MAX_BYTES}]`;
  }
  if (truncation.truncated) {
    const last = first + truncation.outputLines - 1;
    const limitNote = truncation.truncatedBy === 'lines' ? '' : ` (${formatSize(MAX_BYTES)} limit)`;
    return `${truncation.content}\n\n[Showing lines ${first}-${last} of ${total}${limitNote}. Use offset=${last + 1} to continue.]`;
  }
  const userLimitedLines = limit === undefined ? undefined : Math.min(startLine + limit, total) - startLine;
  if (userLimitedLines !== undefined && startLine + userLimitedLines < total) {
    return `${truncation.content}\n\n[${total - (startLine + userLimitedLines)} more lines in file. Use offset=${startLine + userLimitedLines + 1} to continue.]`;
  }
  return truncation.content;
}

interface Edit {
  oldText: string;
  newText: string;
}

/*
 * Edit matching, ported from pi's core/tools/edit-diff.js (normalizeToLF, applyReplacementsToOriginal,
 * getLineEndingAt, normalizeForFuzzyMatch, fuzzyFindText, widenReplacementsToLines and
 * applyEditsToNormalizedContent) and utils/text.js (splitBom), so an edit matches and writes as pi's did.
 */

const splitBom = (content: string) => (content.startsWith('﻿') ? { bom: '﻿', text: content.slice(1) } : { bom: '', text: content });
const normalizeToLF = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

interface Replacement {
  matchIndex: number;
  matchLength: number;
  newText: string;
}

/**
 * The ending of the line holding offset: its own LF or CRLF, or the line before's for an unterminated last
 * line. A lone CR counts only in a file with no LF at all.
 */
function getLineEndingAt(content: string, offset: number): string {
  let lineFeed = content.indexOf('\n', offset);
  if (lineFeed === -1) lineFeed = content.lastIndexOf('\n', offset);
  if (lineFeed === -1) return content.includes('\r') ? '\r' : '\n';
  return content[lineFeed - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * Replacements matched in the LF text, made in the original: the rest keeps its bytes and line endings, and
 * line breaks in new text take the ending of the line the replacement starts on.
 */
function applyReplacementsToOriginal(originalContent: string, replacements: Replacement[]): string {
  // Only a CRLF changes length when normalized, so a normalized offset plus the CRLFs before it is the original offset.
  let crlfBefore = 0;
  let nextCrlf = originalContent.indexOf('\r\n');
  const toOriginal = (offset: number) => {
    while (nextCrlf !== -1 && nextCrlf - crlfBefore < offset) {
      crlfBefore++;
      nextCrlf = originalContent.indexOf('\r\n', nextCrlf + 2);
    }
    return offset + crlfBefore;
  };
  const parts: string[] = [];
  let endsWithCr = false;
  const push = (part: string) => {
    if (part.length === 0) return;
    // A CR before a seam and an LF after it would merge into one CRLF; an added LF keeps them two breaks.
    if (endsWithCr && part[0] === '\n') parts.push('\n');
    parts.push(part);
    endsWithCr = part[part.length - 1] === '\r';
  };
  let position = 0;
  for (const replacement of replacements) {
    const start = toOriginal(replacement.matchIndex);
    push(originalContent.slice(position, start));
    const ending = getLineEndingAt(originalContent, start);
    push(ending === '\n' ? replacement.newText : replacement.newText.replaceAll('\n', ending));
    position = toOriginal(replacement.matchIndex + replacement.matchLength);
  }
  push(originalContent.slice(position));
  return parts.join('');
}

/**
 * Text as a fuzzy match sees it: NFKC, no trailing whitespace on a line, and smart quotes, Unicode dashes and
 * special spaces as their ASCII kin.
 */
function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize('NFKC')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[  -   　]/g, ' ');
}

/** Where oldText is: an exact match first, else a fuzzy one, whose offsets are in the normalized content. */
function fuzzyFindText(content: string, oldText: string): { index: number; matchLength: number; usedFuzzyMatch: boolean } | null {
  const exact = content.indexOf(oldText);
  if (exact !== -1) return { index: exact, matchLength: oldText.length, usedFuzzyMatch: false };
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzy = normalizeForFuzzyMatch(content).indexOf(fuzzyOldText);
  return fuzzy === -1 ? null : { index: fuzzy, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}

/** Counted fuzzily, so text that matches exactly once but fuzzily twice is still ambiguous. */
const countOccurrences = (content: string, oldText: string) => normalizeForFuzzyMatch(content).split(normalizeForFuzzyMatch(oldText)).length - 1;

const splitLinesWithEndings = (content: string) => content.match(/[^\n]*\n|[^\n]+/g) ?? [];

function getLineSpans(content: string): { start: number; end: number }[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(lines: { start: number; end: number }[], replacement: Replacement): { startLine: number; endLine: number } {
  const start = replacement.matchIndex;
  const end = replacement.matchIndex + replacement.matchLength;
  const startLine = lines.findIndex((line) => start >= line.start && start < line.end);
  if (startLine === -1) throw new Error('Replacement range is outside the base content.');
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < end) endLine++;
  if (endLine >= lines.length) throw new Error('Replacement range is outside the base content.');
  return { startLine, endLine: endLine + 1 };
}

/** Replacements sorted by position, made from the last so earlier offsets hold. */
function applyReplacements(content: string, replacements: Replacement[], offset = 0): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { matchIndex, matchLength, newText } = replacements[i];
    const at = matchIndex - offset;
    result = result.substring(0, at) + newText + result.substring(at + matchLength);
  }
  return result;
}

/**
 * Replacements matched in the fuzzy-normalized content, as replacements of the original that rewrite only
 * the lines they touch: every other line keeps its text, trailing spaces and smart quotes included.
 */
function widenReplacementsToLines(originalContent: string, baseContent: string, replacements: Replacement[]): Replacement[] {
  const originalLines = getLineSpans(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) throw new Error('Cannot preserve unchanged lines because the base content has a different line count.');
  const groups: { startLine: number; endLine: number; replacements: Replacement[] }[] = [];
  for (const replacement of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups.at(-1);
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
    } else groups.push({ ...range, replacements: [replacement] });
  }
  return groups.map((group) => {
    const from = baseLines[group.startLine].start;
    const to = baseLines[group.endLine - 1].end;
    const originalStart = originalLines[group.startLine].start;
    return {
      matchIndex: originalStart,
      matchLength: originalLines[group.endLine - 1].end - originalStart,
      newText: applyReplacements(baseContent.slice(from, to), group.replacements, from),
    };
  });
}

/**
 * Every edit made to LF content, or pi's error naming the edit that can't be: each must match once, exactly
 * or else fuzzily, and none may overlap. Nothing is made unless all can be.
 */
function applyEditsToNormalizedContent(content: string, given: readonly Edit[], name: string): { newContent: string; replacements: Replacement[] } {
  const edits = given.map((edit) => ({ oldText: normalizeToLF(edit.oldText), newText: normalizeToLF(edit.newText) }));
  const one = edits.length === 1;
  edits.forEach((edit, i) => {
    if (!edit.oldText) throw new Error(one ? `oldText must not be empty in ${name}.` : `edits[${i}].oldText must not be empty in ${name}.`);
  });
  // One fuzzy match moves every edit to the normalized content, so all offsets are in one space.
  const usedFuzzyMatch = edits.some((edit) => fuzzyFindText(content, edit.oldText)?.usedFuzzyMatch);
  const base = usedFuzzyMatch ? normalizeForFuzzyMatch(content) : content;
  const matched = edits.map((edit, i) => {
    const match = fuzzyFindText(base, edit.oldText);
    if (!match)
      throw new Error(
        one
          ? `Could not find the exact text in ${name}. The old text must match exactly including all whitespace and newlines.`
          : `Could not find edits[${i}] in ${name}. The oldText must match exactly including all whitespace and newlines.`,
      );
    const occurrences = countOccurrences(base, edit.oldText);
    if (occurrences > 1)
      throw new Error(
        one
          ? `Found ${occurrences} occurrences of the text in ${name}. The text must be unique. Please provide more context to make it unique.`
          : `Found ${occurrences} occurrences of edits[${i}] in ${name}. Each oldText must be unique. Please provide more context to make it unique.`,
      );
    return { editIndex: i, matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText };
  });
  matched.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matched.length; i++) {
    const [previous, current] = [matched[i - 1], matched[i]];
    if (previous.matchIndex + previous.matchLength > current.matchIndex)
      throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${name}. Merge them into one edit or target disjoint regions.`);
  }
  const replacements = usedFuzzyMatch ? widenReplacementsToLines(content, base, matched) : matched;
  const newContent = applyReplacements(content, replacements);
  if (newContent === content)
    throw new Error(
      one
        ? `No changes made to ${name}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
        : `No changes made to ${name}. The replacements produced identical content.`,
    );
  return { newContent, replacements };
}

/** Repairs edit arguments models often get wrong, as pi's edit did: edits as a JSON string, or one edit given at the top. */
function prepareEditArguments(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const args = { ...(input as Record<string, unknown>) };
  const single = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Edit).oldText === 'string' && typeof (v as Edit).newText === 'string';
  if (typeof args.edits === 'string') {
    try {
      const parsed: unknown = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
      else if (single(parsed)) args.edits = [parsed];
    } catch {
      // Left as it is, for validation to refuse.
    }
  } else if (single(args.edits)) args.edits = [args.edits];
  if (typeof args.oldText !== 'string' || typeof args.newText !== 'string') return args;
  const { oldText, newText, ...rest } = args;
  return { ...rest, edits: [...(Array.isArray(args.edits) ? args.edits : []), { oldText, newText }] };
}

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

/** The pattern as a RegExp, or an error that says why it isn't one. */
function grepRegex({ pattern, literal, ignoreCase }: GrepArgs): RegExp {
  const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
  const flags = ignoreCase ? 'i' : '';
  try {
    return new RegExp(source, `${flags}u`);
  } catch {
    try {
      return new RegExp(source, flags);
    } catch (e) {
      throw new Error(`${JSON.stringify(pattern)} isn't a valid JavaScript regular expression: ${e instanceof Error ? e.message : String(e)}. Set literal to true to search for the text as written.`);
    }
  }
}

/**
 * grep in JavaScript, so the build agent needs no ripgrep. It prints what pi's grep printed: "file:line: text"
 * for a match and "file-line- text" around it, with pi's limits and notices. A file whose content has a NUL
 * byte is taken for binary and skipped, like ripgrep does.
 */
async function grep(target: string, args: GrepArgs, context: Context): Promise<string> {
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat) throw new Error(`Path not found: ${target}`);
  const regex = grepRegex(args);
  const around = args.context && args.context > 0 ? Math.floor(args.context) : 0;
  const limit = Math.max(1, Math.floor(args.limit ?? GREP_LIMIT));

  // A folder's files are shown relative to it, and one file by its name.
  const files: { file: string; shown: string }[] = [];
  if (stat.isDirectory()) {
    const filter = args.glob?.replace(/^(!?)(?:\.\/)+/, '$1');
    const negated = !!filter?.startsWith('!');
    const matches = filter ? globMatcher(negated ? filter.slice(1) : filter) : null;
    for await (const entry of walk(target)) {
      if (entry.file && (!matches || matches(entry.rel, false) !== negated)) files.push({ file: path.join(target, entry.rel), shown: entry.rel });
    }
  } else {
    files.push({ file: target, shown: path.basename(target) });
  }

  const lines: string[] = [];
  let count = 0;
  let more = false;
  let longLines = false;
  for (const { file, shown } of files) {
    stopIfAborted(context);
    if ((await fsp.stat(file)).size > GREP_FILE_BYTES) continue;
    const content = await fsp.readFile(file).catch(() => null);
    if (!content || content.includes(0)) continue;
    const all = content.toString('utf8').split('\n');
    if (all.at(-1) === '') all.pop();
    const hits = all.flatMap((line, i) => (regex.test(line.replace(/\r$/, '')) ? [i] : []));
    if (!hits.length) continue;
    // Past the limit, one more match only says the limit cut results off.
    if (count >= limit) {
      more = true;
      break;
    }
    const kept = hits.slice(0, limit - count);
    count += kept.length;
    if (hits.length > kept.length) more = true;
    const shownLines = new Set<number>();
    for (const hit of kept) for (let i = Math.max(0, hit - around); i <= Math.min(all.length - 1, hit + around); i++) shownLines.add(i);
    const isKept = new Set(kept);
    for (const i of [...shownLines].sort((a, b) => a - b)) {
      const { text: line, wasTruncated } = truncateLine(all[i].replace(/\r$/, ''));
      if (wasTruncated) longLines = true;
      lines.push(isKept.has(i) ? `${shown}:${i + 1}: ${line}` : `${shown}-${i + 1}- ${line}`);
    }
    if (more) break;
  }

  if (count === 0) return 'No matches found';
  const truncation = truncateHead(lines.join('\n'), Number.MAX_SAFE_INTEGER);
  const notices: string[] = [];
  if (more) notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
  if (truncation.truncated) notices.push(`${formatSize(MAX_BYTES)} limit reached`);
  if (longLines) notices.push(`Some lines truncated to ${GREP_LINE} chars. Use read tool to see full lines`);
  return withNotices(truncation.content, notices);
}

function describeStatus(name: string, status: ModStatus | null): string {
  if (!status) return `${name} isn't a mod yet: it needs a main.tsx.`;
  if (status.state === 'ready') return `${name} loaded.`;
  if (status.state === 'failed') return `${name} did not load:\n${status.error ?? 'unknown error'}${status.version > 0 ? '\nThe last version that loaded is still running.' : ''}`;
  return `${name} is still loading.`;
}

const PATH = 'Relative to the mods folder, like "my_mod/main.tsx".';
const FOLDER = 'A folder, relative to the mods folder, like "my_mod" or ".types". Leave out for the whole mods folder.';

/** How a tool's work ended: what the model sees, and the palette's line. A throw is an error the model sees as written. */
interface Done {
  output: Output;
  isError?: boolean;
  note?: string | null;
}

interface Spec {
  name: string;
  description: string;
  parameters: object;
  constrainedSampling?: typeof STRICT;
  executionMode?: 'sequential';
  outputLimits?: typeof OUTPUT_LIMITS;
  prepareArguments?: (args: unknown) => unknown;
}

/**
 * `durable` is pi-durable itself, passed in because this file can't import its values (see Durable).
 * `told` hears what a save's result said isn't drawing, so the agent isn't told of it again as its turn ends.
 */
export function modFilesExtension(durable: Durable, host: () => ModFilesHost, report: ModToolReport, told: (places: PlaceHealth[]) => void = () => {}): Extension {
  /**
   * A tool that reports how each call went. What its work throws becomes an error result with the message
   * as written, rather than pi-durable's wrapping of a throw.
   */
  const tool = <A>(spec: Spec, work: (args: A, context: Context) => Promise<Done>): ToolRegistration =>
    durable.defineTool({
      ...spec,
      // The Harness checks the arguments against the schema before execute, so they have its shape.
      execute: async (args, _api, context) => {
        try {
          const { output, isError = false, note = null } = await work(args as A, context);
          report(spec.name, !isError, note);
          return { output, isError };
        } catch (e) {
          report(spec.name, false, null);
          return { output: text(e instanceof Error ? e.message : String(e)), isError: true };
        }
      },
    });

  /** Whether a save loaded, for the model and for the palette. */
  const loaded = async (verb: string, mod: string, rel: string) => {
    const status = await host().settled(mod);
    const outcome = !status ? 'not a mod yet' : status.state === 'ready' ? 'loaded' : status.state === 'failed' ? "didn't load" : 'loading';
    // What loaded may still not draw: a save says so for this mod's own tiles and draft.
    const broken = status?.state === 'ready' ? notDrawing(await placesOf(mod)) : [];
    told(broken);
    const problems = broken.map(describePlace);
    return { line: [describeStatus(mod, status), ...problems].join(' '), note: `${verb} ${rel} · ${outcome}${problems.length ? ' · not drawing' : ''}` };
  };

  /** Where a mod shows, and how each place stands. Nothing when the app can't say. */
  const placesOf = async (mod: string): Promise<PlaceHealth[]> => ((await host().health().catch(() => null)) ?? []).filter((p) => p.type === mod);

  const files: ToolRegistration[] = [
    tool<ReadArgs>(
      {
        name: 'read',
        description:
          "In the mods folder: a mod's source, its mod.error or mod.log, the types under .types, or an installed component's source under .installed. Read the contents of a file as text, images and binary files too. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
        parameters: piObject({ path: string(PATH), offset: number('Line number to start reading from (1-indexed)'), limit: number('Maximum number of lines to read') }, ['path']),
        constrainedSampling: STRICT,
        outputLimits: OUTPUT_LIMITS,
      },
      async (args, context) => {
        const { dir } = host();
        stopIfAborted(context);
        const file = resolveInside(dir, await resolveReadPath(args.path, dir));
        await fsp.access(file, constants.R_OK);
        // Every file as text, as the description says: the wrapped pi read had no image detection, though its description claimed it.
        const content = await fsp.readFile(file);
        return { output: text(readText(content.toString('utf-8'), args)) };
      },
    ),
    tool<{ path: string; content: string }>(
      {
        name: 'write',
        description:
          "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories. Only inside a mod's folder. Waits for the app to compile and load the mod, and says whether it did.",
        parameters: piObject({ path: string(PATH), content: string('Content to write to the file') }, ['path', 'content']),
        constrainedSampling: STRICT,
        executionMode: 'sequential',
      },
      async (args, context) => {
        const { dir } = host();
        stopIfAborted(context);
        const { file, mod, rel } = writable(dir, resolveToDir(args.path, dir));
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, args.content);
        stopIfAborted(context);
        const { line, note } = await loaded('wrote', mod, rel);
        return { output: [...text(`Successfully wrote to ${args.path}`), ...text(line)], note };
      },
    ),
    tool<{ path: string; edits: Edit[] }>(
      {
        name: 'edit',
        description:
          "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes. Only inside a mod's folder. Waits for the mod to load and says whether it did, like write.",
        parameters: piObject(
          {
            path: string(PATH),
            edits: {
              type: 'array',
              items: piObject(
                {
                  oldText: string('Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.'),
                  newText: string('Replacement text for this targeted edit.'),
                },
                ['oldText', 'newText'],
              ),
              description:
                'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
            },
          },
          ['path', 'edits'],
        ),
        constrainedSampling: STRICT,
        executionMode: 'sequential',
        prepareArguments: prepareEditArguments,
      },
      async ({ path: given, edits }, context) => {
        const { dir } = host();
        if (!Array.isArray(edits) || edits.length === 0) throw new Error('Edit tool input is invalid. edits must contain at least one replacement.');
        stopIfAborted(context);
        const { file, mod, rel } = writable(dir, resolveToDir(given, dir));
        try {
          await fsp.access(file, constants.R_OK | constants.W_OK);
        } catch (error) {
          stopIfAborted(context);
          const reason = error instanceof Error && 'code' in error ? `Error code: ${(error as NodeJS.ErrnoException).code}` : String(error);
          throw new Error(`Could not edit file: ${given}. ${reason}.`);
        }
        stopIfAborted(context);
        const raw = (await fsp.readFile(file)).toString('utf-8');
        stopIfAborted(context);
        // Matched without the BOM and on LF text; the rest of the file keeps its BOM and its line endings.
        const { bom, text: content } = splitBom(raw);
        const normalized = normalizeToLF(content);
        const { newContent, replacements } = applyEditsToNormalizedContent(normalized, edits, given);
        stopIfAborted(context);
        await fsp.writeFile(file, bom + (content === normalized ? newContent : applyReplacementsToOriginal(content, replacements)));
        stopIfAborted(context);
        const { line, note } = await loaded('edited', mod, rel);
        return { output: [...text(`Successfully replaced ${edits.length} block(s) in ${given}.`), ...text(line)], note };
      },
    ),
    tool<{ path?: string; limit?: number }>(
      {
        name: 'ls',
        description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${LS_LIMIT} entries or ${MAX_BYTES / 1024}KB (whichever is hit first).`,
        parameters: piObject({ path: string(FOLDER), limit: number(`Maximum number of entries to return (default: ${LS_LIMIT})`) }),
        outputLimits: OUTPUT_LIMITS,
      },
      async (args, context) => {
        const { dir } = host();
        stopIfAborted(context);
        const folder = resolveInside(dir, resolveToDir(args.path || '.', dir));
        const limit = Math.max(1, Math.floor(args.limit ?? LS_LIMIT));
        if (!(await exists(folder))) throw new Error(`Path not found: ${folder}`);
        if (!(await fsp.stat(folder)).isDirectory()) throw new Error(`Not a directory: ${folder}`);
        let entries: string[];
        try {
          entries = (await fsp.readdir(folder)).map(String);
        } catch (e) {
          throw new Error(`Cannot read directory: ${e instanceof Error ? e.message : String(e)}`);
        }
        entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        const listed: string[] = [];
        let more = false;
        for (const entry of entries) {
          if (listed.length >= limit) {
            more = true;
            break;
          }
          // A link to a folder lists as a folder. One that can't be followed is left out.
          const stat = await fsp.stat(path.join(folder, entry)).catch(() => null);
          if (stat) listed.push(stat.isDirectory() ? `${entry}/` : entry);
        }
        if (!listed.length) return { output: text('(empty directory)') };
        const truncation = truncateHead(listed.join('\n'), Number.MAX_SAFE_INTEGER);
        const notices: string[] = [];
        if (more) notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`);
        if (truncation.truncated) notices.push(`${formatSize(MAX_BYTES)} limit reached`);
        return { output: text(withNotices(truncation.content, notices)) };
      },
    ),
    tool<GrepArgs>(
      {
        name: 'grep',
        description: `Search the contents of files under the mods folder for a JavaScript regular expression, or for plain text with literal. Returns matching lines as file:line: text, with paths relative to the folder searched. Includes dot folders like .types and .installed, and skips node_modules, binary files and files over 1 MB. Output is truncated to ${GREP_LIMIT} matches or ${MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_LINE} chars.`,
        parameters: piObject(
          {
            pattern: string('A JavaScript regular expression, or plain text when literal is true.'),
            path: string(`${FOLDER} Or one file.`),
            glob: string("Filter files by glob pattern, relative to path, e.g. '*.ts', 'src/**/*.ts' or '**/*.spec.ts'. A pattern without '/' matches file names at any depth"),
            ignoreCase: boolean('Case-insensitive search (default: false)'),
            literal: boolean('Treat pattern as literal string instead of regex (default: false)'),
            context: number('Number of lines to show before and after each match (default: 0)'),
            limit: number(`Maximum number of matches to return (default: ${GREP_LIMIT})`),
          },
          ['pattern'],
        ),
        outputLimits: OUTPUT_LIMITS,
      },
      async (args, context) => {
        const { dir } = host();
        return { output: text(await grep(resolveInside(dir, resolveToDir(args.path || '.', dir)), args, context)) };
      },
    ),
    tool<{ pattern: string; path?: string; limit?: number }>(
      {
        name: 'find',
        description:
          "Find files and folders by glob pattern, like '*.tsx' or 'my_mod/**/*.ts'. A pattern without '/' matches names at any depth. Returns paths relative to the folder searched, with '/' after folders. Includes dot folders like .types and .installed, and skips node_modules. Output is truncated to 1000 results.",
        parameters: piObject(
          {
            pattern: string("Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'"),
            path: string(FOLDER),
            limit: number(`Maximum number of results (default: ${FIND_LIMIT})`),
          },
          ['pattern'],
        ),
        outputLimits: OUTPUT_LIMITS,
      },
      async (args, context) => {
        const { dir } = host();
        stopIfAborted(context);
        const folder = resolveInside(dir, resolveToDir(args.path || '.', dir));
        const limit = Math.max(1, Math.floor(args.limit ?? FIND_LIMIT));
        if (!(await exists(folder))) throw new Error(`Path not found: ${folder}`);
        stopIfAborted(context);
        // One result past the limit tells exactly the limit apart from more.
        const matches = globMatcher(args.pattern);
        const found: string[] = [];
        for await (const entry of walk(folder)) {
          if (found.length > limit) break;
          if (matches(entry.rel, entry.folder)) found.push(entry.folder ? `${entry.rel}/` : entry.rel);
        }
        stopIfAborted(context);
        if (!found.length) return { output: text('No files found matching pattern') };
        const truncation = truncateHead(found.slice(0, limit).join('\n'), Number.MAX_SAFE_INTEGER);
        const notices: string[] = [];
        if (found.length > limit) notices.push(`${limit} results limit reached`);
        if (truncation.truncated) notices.push(`${formatSize(MAX_BYTES)} limit reached`);
        return { output: text(withNotices(truncation.content, notices)) };
      },
    ),
  ];

  const ours: ToolRegistration[] = [
    tool<{ component: string; name: string; title: string; label?: string }>(
      {
        name: 'fork_component',
        description:
          "Copy a component into a new mod, to change it: an installed one, whose source is under .installed and can't be changed, or another mod. The copy gets the new name everywhere the old one was a string (its name and its keys), the new title, and a new label for its tiles' title bars, so they can be told from the original's, and its main file says what it was forked from. The original stays as it is. Waits for the fork to load, like write.",
        parameters: object(
          {
            component: string('The component to copy, by name: an installed one, or a mod\'s folder name.'),
            name: string('The new mod\'s name, which is also its folder: lower-case letters, digits, _ and -, starting with a letter. Say what the fork changes, like "timing_tower_pits".'),
            title: string('The new component\'s title, close to the original\'s so the user knows it, like "Timing · pits".'),
            label: string('What its tiles\' title bars show, short and different from the original\'s, like "Timing · pits". Leave out to use the title.'),
          },
          ['component', 'name', 'title'],
        ),
        executionMode: 'sequential',
      },
      async ({ component, name, title, label }) => {
        const fork = await host().fork(component, name, title, label);
        const { line, note } = await loaded(`forked ${component} as`, name, name);
        const titled = fork.oldTitle !== null ? ` Its title was "${fork.oldTitle}" and is now "${title}".` : ` It had no title the fork could find: set title in its defineComponent.`;
        const labelled =
          fork.oldLabel !== null
            ? ` Its tiles' label was "${fork.oldLabel}" and is now "${label ?? title}".`
            : ` Its spec's label isn't plain text, so its tiles may show the same label as the original's: change it so they can be told apart.`;
        return {
          output: text(
            `Forked ${component} from ${fork.from} into ${name}: ${fork.files.join(', ')}. ${fork.renamed} string(s) naming ${component} now name ${name}.${titled}${labelled} ${component} is unchanged. Edit the fork now. ${line}`,
          ),
          note,
        };
      },
    ),
    tool<{ path: string }>(
      {
        name: 'delete_path',
        description: "Delete a file in a mod's folder, or a whole mod by its folder name: that removes the component and takes its tiles off screen.",
        parameters: object({ path: string('A mod\'s folder, like "lap_stepper", or a file in one.') }, ['path']),
        executionMode: 'sequential',
      },
      async ({ path: given }) => {
        const { dir } = host();
        const target = resolveInside(dir, given);
        const parts = path.relative(dir, target).split(path.sep);
        if (!parts[0] || parts.some((p) => p.startsWith('.'))) throw new Error(`"${given}" can't be deleted.`);
        if (parts.length === 1) {
          if (!(await fsp.stat(target).catch(() => null))?.isDirectory()) throw new Error(`There is no mod "${parts[0]}".`);
          await fsp.rm(target, { recursive: true, force: true });
          await host().settled(parts[0]);
          return { output: text(`Removed the mod ${parts[0]}.`), note: `removed ${parts[0]}` };
        }
        await fsp.rm(target, { recursive: true });
        const rel = parts.join('/');
        const { line, note } = await loaded('deleted', parts[0], rel);
        return { output: text(`Deleted ${rel}. ${line}`), note };
      },
    ),
    tool<{ mod: string }>(
      {
        name: 'mod_status',
        description: "Whether a mod's latest save loaded, its error if not, how each of its tiles and its draft is drawing, and the last lines of its log: what it printed to the console, and errors thrown while drawing.",
        parameters: object({ mod: string("The mod's folder name.") }, ['mod']),
      },
      async ({ mod }) => {
        const status = await host().settled(mod);
        const log = host()
          .logs(mod)
          .slice(-LOG_LINES)
          .map((l) => `${l.level} ${l.text}`);
        const places = (await placesOf(mod)).map(describePlace);
        return { output: text(`${describeStatus(mod, status)}\n\nOn screen:\n${places.join('\n') || '(nowhere)'}\n\nLog:\n${log.join('\n') || '(nothing)'}`) };
      },
    ),
    tool<{ mod: string }>(
      {
        name: 'look_at',
        description: "A picture of a mod's component as it shows right now: its tile on the grid, or its preview in the strip. To check how it looks.",
        parameters: object({ mod: string("The mod's folder name.") }, ['mod']),
      },
      async ({ mod }) => {
        await host().settled(mod);
        const png = await host().picture(mod);
        if (!png) return { output: text(`${mod} isn't showing: it's on neither the grid nor the strip.`), isError: true };
        return { output: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }], note: `looked at ${mod}` };
      },
    ),
  ];

  return durable.defineExtension({ name: 'mod-files', tools: [...files, ...ours] });
}

export const MOD_FILE_TOOLS = ['read', 'write', 'edit', 'ls', 'grep', 'find', 'fork_component', 'delete_path', 'mod_status', 'look_at'];
