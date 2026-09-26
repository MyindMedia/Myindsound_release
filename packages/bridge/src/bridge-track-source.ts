import { BridgeError, type BridgeContext, type MyindBridge } from './types';

/**
 * BUN-0: the bridge as the player's TrackSource, in place of `LitStreamSource`. The shapes below are copied from
 * `src/player3d/track-source.ts` (this package can't import the site, which pulls in Convex); the conformance
 * test checks both directions of assignability, so a change on either side fails the build.
 */
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

export type StreamAccess =
  | { mode: 'full'; via: 'account' | 'purchase' }
  | { mode: 'preview'; reason: 'signed-out' | 'not-owner' | 'unavailable' };

export interface TrackSource {
  readonly label: string;
  readonly access?: StreamAccess;
  list(): Promise<TrackList>;
  logPlay(trackId: string): Promise<void>;
}

/**
 * The player hands `streamUrl` to its audio engine. Inside the app there is no URL (audio stays native, ARCH-2),
 * so the track source hands out this placeholder and `BridgeAudioEngine` turns it back into a trackId.
 */
const TRACK_URL_PREFIX = 'myind-bridge://track/';

export function bridgeTrackUrl(trackId: string): string {
  return `${TRACK_URL_PREFIX}${encodeURIComponent(trackId)}`;
}

export function trackIdFromUrl(url: string): string | null {
  if (!url.startsWith(TRACK_URL_PREFIX)) return null;
  const id = decodeURIComponent(url.slice(TRACK_URL_PREFIX.length));
  return id.length > 0 ? id : null;
}

/**
 * Bridge links never expire, but the player schedules a refresh from `expiresAt` with setTimeout, which fires at
 * once past 2^31 ms. A day keeps it well inside that; the refresh just re-reads the tracklist.
 */
export const BRIDGE_LIST_TTL_MS = 24 * 60 * 60_000;

export interface BridgeTrackSourceOptions {
  /** Shown on the LCD format readout. [DECIDE] the native codec; the site's files are MP3. */
  format?: string;
  now?: () => number;
}

export function accessFor(ownership: BridgeContext['ownership']): StreamAccess {
  return ownership === 'owned' || ownership === 'lent'
    ? { mode: 'full', via: 'account' }
    : { mode: 'preview', reason: 'not-owner' };
}

export class BridgeTrackSource implements TrackSource {
  readonly label = 'bridge';
  access: StreamAccess = { mode: 'preview', reason: 'unavailable' };
  /** The context read by the last `list()`, for the bundle's edition badge, lender name and wear. */
  context: BridgeContext | null = null;
  private readonly bridge: MyindBridge;
  private readonly format: string;
  private readonly now: () => number;

  constructor(bridge: MyindBridge, options: BridgeTrackSourceOptions = {}) {
    this.bridge = bridge;
    this.format = options.format ?? 'mp3';
    this.now = options.now ?? Date.now;
  }

  async list(): Promise<TrackList> {
    const [context, tracks] = await Promise.all([this.bridge.getContext(), this.bridge.getTracks()]);
    this.context = context;
    this.access = accessFor(context.ownership);
    if (tracks.length === 0) throw new BridgeError('E_NOT_ALLOWED', 'No tracks for this copy yet', 'getTracks');
    return {
      expiresAt: this.now() + BRIDGE_LIST_TTL_MS,
      tracks: [...tracks]
        .sort((a, b) => a.position - b.position)
        .map((track) => ({
          id: track.id,
          position: track.position,
          title: track.title,
          durationSeconds: track.durationSeconds,
          format: this.format,
          streamUrl: bridgeTrackUrl(track.id),
        })),
    };
  }

  /** Native records play events itself (WEAR-6, with idempotency keys and the offline queue), so this is a no-op. */
  async logPlay(): Promise<void> {}
}
