import previews from './lit-previews.json';
import type { StreamAccess, TrackList, TrackSource } from './track-source';

/**
 * Public demo (`?mock=1` in dev, or a VITE_PLAYER_DEMO build): a 30-second preview of each LIT track, cut by
 * `npm run previews`. The full songs stay paid, streamed through Convex + R2.
 */
export class PreviewTrackSource implements TrackSource {
  readonly label = 'preview';
  readonly access: StreamAccess = { mode: 'preview', reason: 'signed-out' };

  async list(): Promise<TrackList> {
    return {
      expiresAt: Date.now() + 2 * 60 * 60_000,
      tracks: previews.tracks.map((track) => ({
        id: `preview-${track.position}`,
        position: track.position,
        title: track.title,
        durationSeconds: track.durationSeconds,
        format: 'mp3',
        streamUrl: track.streamUrl,
      })),
    };
  }

  async logPlay(): Promise<void> {}
}
