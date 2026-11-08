// Downloads a session's commentary captions and reports how usable they are. See docs/CAPTIONS.md.
// Prints counts only, never caption text, because captions give away what happens in a race.
// Usage: node scripts/captions-check.mjs <contentId> [--lang eng] [--channel <id>] [--out cues.json]
// Without --channel it reads the feed F1 TV marks as default. --out holds the race's text: keep it out of the repo.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKERS = 8;
/** Pieces of one line that touch across a segment boundary. */
const MERGE_GAP_SEC = 0.5;
const LONG_GAP_SEC = 30;

const attr = (text, name) => text.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** "01:02:03.500" in seconds. Live hours run into the hundreds of thousands: they're Unix time. */
export function toSeconds(value) {
  const m = value?.match(/^(\d+):(\d+):(\d+)(?:\.(\d+))?$/);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +`0.${m[4]}` : 0) : null;
}

const decode = (text) =>
  text
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** Cues from a DASH `stpp` segment: one TTML document in the mdat of an fMP4 fragment. */
export function parseTtmlSegment(bytes) {
  const text = new TextDecoder().decode(bytes);
  const cues = [];
  for (const m of text.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const begin = toSeconds(attr(m[1], 'begin'));
    const end = toSeconds(attr(m[1], 'end'));
    const line = decode(m[2]);
    if (begin != null && line) cues.push({ begin, end: end ?? begin, text: line });
  }
  return cues;
}

/** Cues from an HLS WebVTT segment. */
export function parseVttSegment(text) {
  const cues = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const m = block.match(/(?:(\d+):)?(\d\d):(\d\d\.\d+) --> (?:(\d+):)?(\d\d):(\d\d\.\d+)[^\n]*\n([\s\S]*)/);
    if (!m) continue;
    const line = decode(m[7]);
    if (line) cues.push({ begin: +(m[1] ?? 0) * 3600 + +m[2] * 60 + +m[3], end: +(m[4] ?? 0) * 3600 + +m[5] * 60 + +m[6], text: line });
  }
  return cues;
}

/** The chosen language's `stpp` track of an MPD, with one URL per segment. */
export function dashTrack(mpd, manifestUrl, lang) {
  const sets = [...mpd.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g)];
  const isText = (m) => attr(m[1], 'codecs') === 'stpp';
  const set = sets.find((m) => isText(m) && attr(m[1], 'lang') === lang);
  const languages = sets.filter(isText).map((m) => attr(m[1], 'lang'));
  if (!set) return { languages, segments: [] };
  const rep = set[2].match(/<Representation\b[^>]*>/)?.[0] ?? '';
  const tpl = set[2].match(/<SegmentTemplate\b[^>]*>/)?.[0] ?? '';
  const media = attr(tpl, 'media').replace(/&amp;/g, '&');
  const timescale = Number(attr(tpl, 'timescale') ?? 1);
  const base = manifestUrl.split('?')[0].replace(/[^/]*$/, '');
  const query = manifestUrl.includes('?') ? `?${manifestUrl.split('?')[1]}` : '';
  const segments = [];
  let number = Number(attr(tpl, 'startNumber') ?? 1);
  let t = 0;
  for (const s of set[2].matchAll(/<S\b[^>]*\/?>/g)) {
    if (attr(s[0], 't') != null) t = Number(attr(s[0], 't'));
    const d = Number(attr(s[0], 'd'));
    const repeat = Number(attr(s[0], 'r') ?? 0);
    for (let i = 0; i <= repeat; i += 1) {
      const name = media
        .replace(/\$RepresentationID\$/g, attr(rep, 'id'))
        .replace(/\$Number(%\d+d)?\$/g, number)
        .replace(/\$Time\$/g, t);
      segments.push({ url: new URL(name, base).href + query, sec: t / timescale, dur: d / timescale });
      number += 1;
      t += d;
    }
  }
  const live = attr(mpd.match(/<MPD\b[^>]*>/)?.[0] ?? '', 'type') === 'dynamic';
  const availabilityStart = attr(mpd.match(/<MPD\b[^>]*>/)?.[0] ?? '', 'availabilityStartTime');
  return { languages, segments, live, unixOffsetSec: live ? Date.parse(availabilityStart) / 1000 : 0 };
}

/** Joins a line repeated across segment boundaries. */
export function mergeCues(cues) {
  const merged = [];
  for (const cue of [...cues].sort((a, b) => a.begin - b.begin)) {
    const prev = merged.at(-1);
    if (prev && prev.text === cue.text && cue.begin - prev.end < MERGE_GAP_SEC) {
      prev.end = Math.max(prev.end, cue.end);
    } else {
      merged.push({ ...cue });
    }
  }
  return merged;
}

/** What a cue list can do for us, without saying anything it contains. */
export function summarize(raw, merged) {
  const words = merged.reduce((n, c) => n + c.text.split(' ').length, 0);
  const letters = merged.map((c) => c.text).join('').replace(/[^a-zA-Z]/g, '');
  const gaps = merged.slice(1).map((c, i) => c.begin - merged[i].end);
  const durations = merged.map((c) => c.end - c.begin).sort((a, b) => a - b);
  const spanMin = merged.length ? (merged.at(-1).end - merged[0].begin) / 60 : 0;
  return {
    rawCues: raw.length,
    cues: merged.length,
    words,
    kb: Math.round(merged.reduce((n, c) => n + c.text.length, 0) / 1024),
    wordsPerMin: spanMin ? Math.round(words / spanMin) : 0,
    medianCueSec: +(durations[durations.length >> 1] ?? 0).toFixed(2),
    endsSentencePct: merged.length ? Math.round((100 * merged.filter((c) => /[.!?]["']?$/.test(c.text)).length) / merged.length) : 0,
    upperCasePct: letters ? Math.round((100 * letters.replace(/[^A-Z]/g, '').length) / letters.length) : 0,
    gapsOver30s: gaps.filter((g) => g > LONG_GAP_SEC).length,
    longestGapSec: gaps.length ? Math.round(Math.max(...gaps)) : 0,
  };
}

async function fetchAll(items, load) {
  const out = new Array(items.length);
  let next = 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        try {
          out[i] = await load(items[i]);
        } catch {
          out[i] = [];
          failed += 1;
        }
      }
    }),
  );
  return { cues: out.flat(), failed };
}

const fetchOk = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
};

async function readDash(manifest, manifestUrl, lang) {
  const track = dashTrack(manifest, manifestUrl, lang);
  if (!track.segments.length) return { format: 'dash', languages: track.languages };
  const { cues, failed } = await fetchAll(track.segments, async (s) =>
    parseTtmlSegment(new Uint8Array(await (await fetchOk(s.url)).arrayBuffer())),
  );
  // Live cues are stamped in Unix time. The video's timeline counts from availabilityStartTime.
  const timed = cues.map((c) => ({ ...c, begin: c.begin - track.unixOffsetSec, end: c.end - track.unixOffsetSec }));
  return { format: 'dash stpp', live: track.live, languages: track.languages, segments: track.segments.length, segmentSec: track.segments[0].dur, failed, cues: timed };
}

async function readHls(master, masterUrl, lang) {
  const media = [...master.matchAll(/#EXT-X-MEDIA:([^\n]*)/g)].map((m) => m[1]);
  const subtitles = media.filter((l) => /TYPE=SUBTITLES/.test(l));
  const embedded = media.filter((l) => /TYPE=CLOSED-CAPTIONS/.test(l)).length;
  const languages = subtitles.map((l) => l.match(/LANGUAGE="([^"]*)"/)?.[1]);
  const track = subtitles.find((l) => l.includes(`LANGUAGE="${lang}"`));
  if (!track) return { format: 'hls', languages, embeddedCaptionTracks: embedded };
  const playlistUrl = new URL(track.match(/URI="([^"]*)"/)[1], masterUrl).href;
  const playlist = await (await fetchOk(playlistUrl)).text();
  const names = playlist.split('\n').filter((l) => l && !l.startsWith('#'));
  const { cues, failed } = await fetchAll(names, async (n) => parseVttSegment(await (await fetchOk(new URL(n, playlistUrl).href)).text()));
  return { format: 'hls webvtt', languages, segments: names.length, failed, cues };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const contentId = Number(args[0]);
  if (!contentId) throw new Error('Usage: node scripts/captions-check.mjs <contentId> [--lang eng] [--channel <id>] [--out cues.json]');
  const lang = option('--lang') ?? 'eng';
  const channel = option('--channel');

  const { startApp } = await import('./harness.mjs');
  const { app, page, stop } = await startApp(5186);
  try {
    await page.evaluate((id) => window.f1a.f1tv.channels(id), contentId); // Waits for the client to sign in.
    const client = path.resolve('dist-electron/electron/vendor/f1ov/f1tvClient.js');
    // Follows the feed's play link, as channelIdForPlay does in the app: the world feed's link has no channelId.
    const play = await app.evaluate(
      async (_e, { client, contentId, channel }) => {
        const c = process.mainModule.require(client).getClient();
        const streams = (await c.contentVideo(contentId)).metadata?.additionalStreams ?? [];
        const stream = channel ? streams.find((s) => s.channelId === Number(channel)) : streams.find((s) => s.default === true);
        const channelId = stream && /channelId=/.test(stream.playbackUrl ?? '') ? stream.channelId : undefined;
        const res = await c.contentPlay(contentId, channelId, 'WEB_DASH');
        return { url: res.resultObj.url, feed: stream?.title ?? 'base' };
      },
      { client, contentId, channel },
    );
    await stop();

    const manifest = await (await fetchOk(play.url)).text();
    const started = Date.now();
    const read = manifest.includes('<MPD') ? await readDash(manifest, play.url, lang) : await readHls(manifest, play.url, lang);
    const { cues = [], ...info } = read;
    const merged = mergeCues(cues);
    console.log(JSON.stringify({ contentId, feed: play.feed, lang, ...info, tookSec: Math.round((Date.now() - started) / 1000), ...(cues.length ? summarize(cues, merged) : { usable: false }) }));
    const out = option('--out');
    if (out) writeFileSync(out, JSON.stringify(merged));
  } finally {
    await stop();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(String(e.message).split('?')[0]);
      process.exit(1);
    },
  );
}
