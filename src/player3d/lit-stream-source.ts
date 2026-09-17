import type { StreamAccess, TrackList, TrackSource } from './track-source';

/**
 * The stream page for everyone. LIT owners hear the full songs (Convex checks the purchase and returns the
 * storage links); everyone else hears the 30-second previews, and so does an owner if the full-song service
 * can't be reached, so the player never goes dead. Dependencies are passed in (see src/stream.ts).
 */
export class LitStreamSource implements TrackSource {
  readonly label = 'lit';
  access: StreamAccess = { mode: 'preview', reason: 'signed-out' };
  private readonly full: TrackSource;
  private readonly previews: TrackSource;
  private readonly signedIn: () => Promise<boolean>;
  private readonly errorCode: (err: unknown) => string | null;

  constructor(options: {
    full: TrackSource;
    previews: TrackSource;
    signedIn: () => Promise<boolean>;
    errorCode: (err: unknown) => string | null;
  }) {
    this.full = options.full;
    this.previews = options.previews;
    this.signedIn = options.signedIn;
    this.errorCode = options.errorCode;
  }

  async list(): Promise<TrackList> {
    if (!(await this.signedIn())) {
      this.access = { mode: 'preview', reason: 'signed-out' };
      return this.previews.list();
    }
    try {
      const list = await this.full.list();
      this.access = { mode: 'full' };
      return list;
    } catch (err) {
      const code = this.errorCode(err);
      this.access = { mode: 'preview', reason: code === 'NOT_ENTITLED' ? 'not-owner' : 'unavailable' };
      if (code !== 'NOT_ENTITLED') console.warn('Full songs unavailable, playing previews:', code ?? err);
      return this.previews.list();
    }
  }

  async logPlay(trackId: string): Promise<void> {
    if (this.access.mode === 'full') await this.full.logPlay(trackId);
  }
}
