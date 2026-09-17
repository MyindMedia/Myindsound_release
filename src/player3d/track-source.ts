import type { Id } from '../../convex/_generated/dataModel';
import { api, connectConvexAuth, getConvex } from '../convex';

export interface PlayerTrack {
  id: string;
  position: number;
  title: string;
  durationSeconds: number;
  format: string;
  streamUrl: string;
}

export interface TrackList {
  tracks: PlayerTrack[];
  expiresAt: number;
}

export interface TrackSource {
  readonly label: string;
  list(): Promise<TrackList>;
  logPlay(trackId: string): Promise<void>;
}

/** Paid tracks from Convex: entitlement-checked, R2 links signed for 2 hours. */
export class ConvexTrackSource implements TrackSource {
  readonly label = 'convex';
  private readonly product: string;

  constructor(product = 'lit') {
    this.product = product;
  }

  async list(): Promise<TrackList> {
    await connectConvexAuth();
    const result = await getConvex().action(api.tracks.listForPlayer, { product: this.product });
    return { expiresAt: result.expiresAt, tracks: result.tracks.map((track) => ({ ...track, id: track.id })) };
  }

  async logPlay(trackId: string): Promise<void> {
    await getConvex().mutation(api.plays.log, { trackId: trackId as Id<'tracks'> });
  }
}

const MOCK_TITLES = ['L.I.T. (Living In Truth)', 'G. O. D.', 'Victory In the Valley', 'Tired', 'Let Him Cook', 'Faith'];
const MOCK_DURATIONS = [191.84, 224.96, 157.89, 141.64, 139.24, 182.53];

/** Dev-only source (`?mock=1` under `npm run dev`): the public demo clip for every track. */
export class MockTrackSource implements TrackSource {
  readonly label = 'mock';

  async list(): Promise<TrackList> {
    return {
      expiresAt: Date.now() + 2 * 60 * 60_000,
      tracks: MOCK_TITLES.map((title, index) => ({
        id: `mock-${index + 1}`,
        position: index + 1,
        title,
        durationSeconds: MOCK_DURATIONS[index],
        format: 'mp3',
        streamUrl: '/assets/audio/Cook-Demo.mp3',
      })),
    };
  }

  async logPlay(): Promise<void> {}
}
