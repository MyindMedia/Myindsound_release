import type { StreamAccess, TrackList, TrackSource } from './track-source';

/**
 * The player for everyone. LIT owners hear the full songs (Convex checks the purchase and returns the storage
 * links); so does someone who has just paid, through their Stripe checkout session, for 24 hours. Everyone
 * else hears the 30-second previews, and so does an owner if the full-song service can't be reached, so the
 * player never goes dead. Dependencies are passed in (see src/home.ts).
 */
export class LitStreamSource implements TrackSource {
  readonly label = 'lit';
  access: StreamAccess = { mode: 'preview', reason: 'signed-out' };
  private readonly full: TrackSource;
  private readonly previews: TrackSource;
  private readonly purchase: () => TrackSource | null;
  private readonly signedIn: () => Promise<boolean>;
  private readonly errorCode: (err: unknown) => string | null;

  constructor(options: {
    full: TrackSource;
    previews: TrackSource;
    signedIn: () => Promise<boolean>;
    errorCode: (err: unknown) => string | null;
    /** The buyer's checkout session, while it's still inside its window. */
    purchase?: () => TrackSource | null;
  }) {
    this.full = options.full;
    this.previews = options.previews;
    this.signedIn = options.signedIn;
    this.errorCode = options.errorCode;
    this.purchase = options.purchase ?? (() => null);
  }

  async list(): Promise<TrackList> {
    let reason: 'signed-out' | 'not-owner' | 'unavailable' = 'signed-out';
    if (await this.signedIn()) {
      try {
        const list = await this.full.list();
        this.access = { mode: 'full', via: 'account' };
        return list;
      } catch (err) {
        const code = this.errorCode(err);
        reason = code === 'NOT_ENTITLED' ? 'not-owner' : 'unavailable';
        if (code !== 'NOT_ENTITLED') console.warn('Full songs unavailable:', code ?? err);
      }
    }

    // Just paid in this browser: the checkout session unlocks the full songs without an account.
    const purchase = this.purchase();
    if (purchase) {
      try {
        const list = await purchase.list();
        this.access = { mode: 'full', via: 'purchase' };
        return list;
      } catch (err) {
        console.warn('Purchase unlock failed, playing previews:', this.errorCode(err) ?? err);
      }
    }

    this.access = { mode: 'preview', reason };
    return this.previews.list();
  }

  async logPlay(trackId: string): Promise<void> {
    if (this.access.mode === 'full' && this.access.via === 'account') await this.full.logPlay(trackId);
  }
}
