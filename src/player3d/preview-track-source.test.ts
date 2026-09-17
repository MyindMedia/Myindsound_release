import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import litTracks from '../../scripts/lit-tracks.json';
import { PreviewTrackSource } from './preview-track-source';

describe('PreviewTrackSource', () => {
  test('every LIT track plays its own 30-second preview', async () => {
    const { tracks } = await new PreviewTrackSource().list();
    expect(tracks.map((track) => track.title)).toEqual(litTracks.tracks.map((track) => track.title));
    expect(new Set(tracks.map((track) => track.streamUrl)).size).toBe(tracks.length);
    for (const track of tracks) {
      expect(track.streamUrl).toMatch(/^\/assets\/audio\/lit-previews\/.+\.mp3$/);
      expect(existsSync(resolve('public', `.${track.streamUrl}`))).toBe(true);
      expect(track.durationSeconds).toBeGreaterThan(25);
      expect(track.durationSeconds).toBeLessThanOrEqual(31);
    }
  });
});
