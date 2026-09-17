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
