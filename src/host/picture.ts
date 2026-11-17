/**
 * A picture of a component as it shows now, for the build agent's look_at: its tile if it has one, else its
 * draft in the strip. Taken with Element Capture, which records the window restricted to one element and
 * what's inside it, so the palette floating over a tile isn't in it, and nothing on screen has to change.
 * The main process grants the window a recording of itself only. See docs/BUILD_MODE.md.
 */
import { modsLink, type PictureResult } from '../data/mods';

// Element Capture and MediaStreamTrackProcessor aren't in TypeScript's DOM types yet.
interface RestrictableTrack extends MediaStreamTrack {
  restrictTo(target: unknown): Promise<void>;
}
declare const RestrictionTarget: { fromElement(el: Element): Promise<unknown> };
declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };

/** How long to wait for a frame of the element alone. */
const FRAME_TIMEOUT_MS = 3000;

const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([promise, new Promise<never>((_, fail) => setTimeout(() => fail(new Error(`${what} timed out`)), ms))]);

/** The element a component shows in: its tile on the grid, else its draft in the strip. */
function placeOf(type: string): Element | null {
  const name = CSS.escape(type);
  return document.querySelector(`[data-tile-type="${name}"]`) ?? document.querySelector(`[data-draft-type="${name}"]`);
}

/**
 * A PNG of `type` as it shows now. `{ png: null }` when it's on neither the grid nor the strip. Element Capture
 * needs the element to be a stacking context: tiles and drafts are isolated in styles.css for it.
 */
export async function takePicture(type: string): Promise<PictureResult> {
  const el = placeOf(type);
  const box = el?.getBoundingClientRect();
  if (!el || !box || box.width <= 0 || box.height <= 0) return { png: null };
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, preferCurrentTab: true, selfBrowserSurface: 'include' } as DisplayMediaStreamOptions);
  const [track] = stream.getVideoTracks() as RestrictableTrack[];
  try {
    await track.restrictTo(await RestrictionTarget.fromElement(el));
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    // A frame from before the restriction may still be queued: the first one the element's size is of it alone.
    const width = Math.round(box.width * devicePixelRatio);
    const height = Math.round(box.height * devicePixelRatio);
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    try {
      for (;;) {
        const { value: frame } = await within(reader.read(), Math.max(0, deadline - Date.now()), 'A frame of it');
        if (!frame) throw new Error('The recording ended before a frame of it');
        if (Math.abs(frame.displayWidth - width) > 2 || Math.abs(frame.displayHeight - height) > 2) {
          frame.close();
          continue;
        }
        const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
        canvas.getContext('2d')!.drawImage(frame, 0, 0);
        frame.close();
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        return { png: new Uint8Array(await blob.arrayBuffer()) };
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}

/** Answers the main process when it asks for a picture, for the build agent. Call it once, at start. */
export function startPictures(): () => void {
  return modsLink.onPictureAsked(({ id, type }) => {
    void takePicture(type).then(
      (result) => modsLink.picture(id, result),
      (e: unknown) => modsLink.picture(id, { error: e instanceof Error ? e.message : String(e) }),
    );
  });
}
