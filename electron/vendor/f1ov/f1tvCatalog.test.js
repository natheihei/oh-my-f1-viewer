import { describe, expect, it } from 'vitest';
import catalog from './f1tvCatalog.js';

const { channelIdForPlay } = catalog;

// Shape of a real CONTENT/VIDEO response: only the world feed's link leaves out the channel.
const streams = [
  { channelId: 1033, title: 'F1 LIVE', playbackUrl: 'CONTENT/PLAY?channelId=1033&contentId=5' },
  { channelId: 1025, title: 'INTERNATIONAL', playbackUrl: 'CONTENT/PLAY?contentId=5' },
  { channelId: 1009, title: 'VER', playbackUrl: 'CONTENT/PLAY?contentId=5&channelId=1009' },
];

describe('channelIdForPlay', () => {
  it('sends no channel for a feed whose play link has none', () => {
    expect(channelIdForPlay(streams, 1025)).toBeUndefined();
    expect(channelIdForPlay(streams, '1025')).toBeUndefined();
  });

  it('keeps the channel when the play link has one, wherever it sits in the link', () => {
    expect(channelIdForPlay(streams, 1033)).toBe(1033);
    expect(channelIdForPlay(streams, 1009)).toBe(1009);
  });

  it('keeps a channel it knows nothing about, or that has no link', () => {
    expect(channelIdForPlay(streams, 4242)).toBe(4242);
    expect(channelIdForPlay([{ channelId: 7 }], 7)).toBe(7);
    expect(channelIdForPlay(undefined, 7)).toBe(7);
  });

  it('leaves a request for no channel alone', () => {
    expect(channelIdForPlay(streams, undefined)).toBeUndefined();
    expect(channelIdForPlay([{ title: 'no id', playbackUrl: 'CONTENT/PLAY?contentId=5' }], undefined)).toBeUndefined();
  });
});
