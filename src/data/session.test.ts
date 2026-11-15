import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, SessionInfo } from '../../shared/api';

// A stand-in for the player: each video is a plain object that never loads.
vi.mock('./stream', () => ({
  LIVE_EDGE_OFFSET_SEC: 8,
  LIVE_START_MARGIN_SEC: 5,
  StreamHandle: class {
    status = 'resolving';
    error = null;
    hasMedia = false;
    destroyed = false;
    video = { muted: true, volume: 1, currentTime: 0, pause() {}, remove() {} };
    constructor(
      readonly id: string,
      readonly channel: Channel,
    ) {}
    start() {}
    destroy() {
      this.destroyed = true;
    }
  },
}));
vi.mock('./sessionData', () => ({ openSessionData: () => ({ update() {}, destroy() {}, videoTimeOf: () => null }) }));

const { openSession, closeSession, sessionControl, useSession } = await import('./session');

const channel = (id: string, kind: Channel['kind']): Channel => ({ id, contentId: 1, channelId: 0, kind, label: id, title: id });
const channels = [channel('main', 'main'), channel('ham', 'onboard'), channel('nor', 'onboard'), channel('ver', 'onboard')];
const session = { contentId: 1, title: 'Race', type: 'race', status: 'replay' } as SessionInfo;

const heard = () => useSession.getState().audioVideoId;
const videos = () => Object.values(useSession.getState().streams);
/** Lets go of what was released in the moment just past. */
const settle = () => vi.advanceTimersByTime(1);

beforeEach(async () => {
  vi.useFakeTimers();
  (globalThis as { window?: unknown }).window = { f1a: { f1tv: { channels: async () => channels } } };
  await openSession(session);
});

afterEach(() => {
  closeSession();
  vi.useRealTimers();
});

describe('videos', () => {
  it('are one per holder, so a feed can show in two places', () => {
    const a = sessionControl.acquire('ham', { tile: 'tile-1' })!;
    const b = sessionControl.acquire('ham', { tile: 'tile-2' })!;
    expect(a.id).not.toBe(b.id);
    expect(videos().map((v) => [v.feed, v.tile])).toEqual([
      ['ham', 'tile-1'],
      ['ham', 'tile-2'],
    ]);
  });

  it('carry on with a new holder of the same feed that takes hold in the same moment', () => {
    const preview = sessionControl.acquire('ham', { quiet: true })!;
    sessionControl.release(preview);
    const tile = sessionControl.acquire('ham', { tile: 'tile-1' })!;
    settle();
    expect(tile).toBe(preview);
    expect(videos()).toEqual([expect.objectContaining({ id: preview.id, tile: 'tile-1', quiet: false })]);
  });

  it('stop once nothing takes them over', () => {
    const a = sessionControl.acquire('ham', { tile: 'tile-1' })!;
    sessionControl.release(a);
    expect(videos()).toHaveLength(1);
    settle();
    expect(videos()).toEqual([]);
    expect((a as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });
});

describe('the sound', () => {
  it('starts on the main feed', () => {
    sessionControl.acquire('ham', { tile: 'tile-2' });
    expect(heard()).toBeNull();
    const main = sessionControl.acquire('main', { tile: 'tile-1' })!;
    expect(heard()).toBe(main.id);
  });

  it('belongs to one video, never a preview', () => {
    const a = sessionControl.acquire('ham', { tile: 'tile-1' })!;
    const b = sessionControl.acquire('ham', { tile: 'tile-2' })!;
    const preview = sessionControl.acquire('ham', { quiet: true })!;
    sessionControl.setAudio(b.id);
    expect(heard()).toBe(b.id);
    expect([a.video.muted, b.video.muted]).toEqual([true, false]);
    expect(() => sessionControl.setAudio(preview.id)).toThrow('A preview is never heard.');
    expect(() => sessionControl.setAudio('v0')).toThrow(/No video v0/);
  });

  it('moves to another video of the same feed when its video goes', () => {
    sessionControl.acquire('main', { tile: 'tile-1' });
    const a = sessionControl.acquire('ham', { tile: 'tile-2' })!;
    const b = sessionControl.acquire('ham', { tile: 'tile-3' })!;
    sessionControl.setAudio(a.id);
    sessionControl.release(a);
    settle();
    expect(heard()).toBe(b.id);
  });

  it('stays in a tile that switches its pictures, with the same picture first', () => {
    sessionControl.acquire('main', { tile: 'tile-1' });
    const nor = sessionControl.acquire('nor', { tile: 'tile-2', slot: 'a' })!;
    const ver = sessionControl.acquire('ver', { tile: 'tile-2', slot: 'b' })!;
    sessionControl.setAudio(nor.id);
    // The tile shows another fight: both pictures switch in one render.
    sessionControl.release(nor);
    sessionControl.release(ver);
    const rus = sessionControl.acquire('ver', { tile: 'tile-2', slot: 'b' })!;
    const ham = sessionControl.acquire('ham', { tile: 'tile-2', slot: 'a' })!;
    settle();
    // VER's picture was taken over by slot b, so it stays; NOR's went, and its slot's new picture is heard.
    expect(rus).toBe(ver);
    expect(heard()).toBe(ham.id);
  });

  it('falls back to the main feed, then to none', () => {
    const main = sessionControl.acquire('main', { tile: 'tile-1' })!;
    const ham = sessionControl.acquire('ham', { tile: 'tile-2' })!;
    sessionControl.setAudio(ham.id);
    sessionControl.release(ham);
    settle();
    expect(heard()).toBe(main.id);
    sessionControl.release(main);
    settle();
    expect(heard()).toBeNull();
  });

  it('leaves a heard video that a preview takes over', () => {
    const main = sessionControl.acquire('main', { tile: 'tile-1' })!;
    const ham = sessionControl.acquire('ham', { tile: 'tile-2' })!;
    sessionControl.setAudio(ham.id);
    sessionControl.release(ham);
    expect(sessionControl.acquire('ham', { quiet: true })).toBe(ham);
    expect(heard()).toBe(main.id);
  });
});
