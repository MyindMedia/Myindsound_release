import { describe, expect, test, vi } from 'vitest';
import { LitStreamSource } from './lit-stream-source';
import type { TrackList, TrackSource } from './track-source';

const list = (label: string): TrackList => ({
  expiresAt: 0,
  tracks: [{ id: `${label}-1`, position: 1, title: 'L.I.T.', durationSeconds: 1, format: 'mp3', streamUrl: `/${label}.mp3` }],
});

function fakes(fullResult: TrackList | Error, purchaseResult?: TrackList | Error) {
  const full: TrackSource = {
    label: 'convex',
    list: vi.fn(async () => {
      if (fullResult instanceof Error) throw fullResult;
      return fullResult;
    }),
    logPlay: vi.fn(async () => {}),
  };
  const previews: TrackSource = { label: 'preview', list: vi.fn(async () => list('preview')), logPlay: vi.fn(async () => {}) };
  const errorCode = (err: unknown) => (err instanceof Error && err.message.startsWith('CODE:') ? err.message.slice(5) : null);
  const purchaseSource: TrackSource = {
    label: 'purchase',
    list: vi.fn(async () => {
      if (purchaseResult instanceof Error) throw purchaseResult;
      return purchaseResult ?? list('purchase');
    }),
    logPlay: vi.fn(async () => {}),
  };
  const purchase = () => (purchaseResult === undefined ? null : purchaseSource);
  return { full, previews, errorCode, purchase, purchaseSource };
}

describe('LitStreamSource', () => {
  test('signed out: previews, without asking Convex', async () => {
    const { full, previews, errorCode } = fakes(list('full'));
    const source = new LitStreamSource({ full, previews, errorCode, signedIn: async () => false });
    expect((await source.list()).tracks[0].streamUrl).toBe('/preview.mp3');
    expect(source.access).toEqual({ mode: 'preview', reason: 'signed-out' });
    expect(full.list).not.toHaveBeenCalled();
  });

  test('a LIT owner gets the full songs, and plays are logged', async () => {
    const { full, previews, errorCode } = fakes(list('full'));
    const source = new LitStreamSource({ full, previews, errorCode, signedIn: async () => true });
    expect((await source.list()).tracks[0].streamUrl).toBe('/full.mp3');
    expect(source.access).toEqual({ mode: 'full', via: 'account' });
    await source.logPlay('full-1');
    expect(full.logPlay).toHaveBeenCalledWith('full-1');
  });

  test('signed in without a purchase: previews, marked not-owner, plays not logged', async () => {
    const { full, previews, errorCode } = fakes(new Error('CODE:NOT_ENTITLED'));
    const source = new LitStreamSource({ full, previews, errorCode, signedIn: async () => true });
    expect((await source.list()).tracks[0].streamUrl).toBe('/preview.mp3');
    expect(source.access).toEqual({ mode: 'preview', reason: 'not-owner' });
    await source.logPlay('preview-1');
    expect(full.logPlay).not.toHaveBeenCalled();
  });

  test('just paid, not signed in: the checkout session unlocks the full songs, and plays are not logged', async () => {
    const { full, previews, errorCode, purchase, purchaseSource } = fakes(list('full'), list('purchase'));
    const source = new LitStreamSource({ full, previews, errorCode, purchase, signedIn: async () => false });
    expect((await source.list()).tracks[0].streamUrl).toBe('/purchase.mp3');
    expect(source.access).toEqual({ mode: 'full', via: 'purchase' });
    expect(full.list).not.toHaveBeenCalled();
    await source.logPlay('purchase-1');
    expect(purchaseSource.logPlay).not.toHaveBeenCalled();
  });

  test('signed in as someone else after paying: the checkout session still unlocks it', async () => {
    const { full, previews, errorCode, purchase } = fakes(new Error('CODE:NOT_ENTITLED'), list('purchase'));
    const source = new LitStreamSource({ full, previews, errorCode, purchase, signedIn: async () => true });
    expect((await source.list()).tracks[0].streamUrl).toBe('/purchase.mp3');
    expect(source.access).toEqual({ mode: 'full', via: 'purchase' });
  });

  test('an expired or rejected checkout session falls back to previews', async () => {
    const { full, previews, errorCode, purchase } = fakes(list('full'), new Error('CODE:DOWNLOAD_WINDOW_CLOSED'));
    const source = new LitStreamSource({ full, previews, errorCode, purchase, signedIn: async () => false });
    expect((await source.list()).tracks[0].streamUrl).toBe('/preview.mp3');
    expect(source.access).toEqual({ mode: 'preview', reason: 'signed-out' });
  });

  test('when the full-song service fails, previews still play', async () => {
    for (const failure of [new Error('CODE:NOT_CONFIGURED'), new Error('CODE:UNAUTHENTICATED'), new Error('network down')]) {
      const { full, previews, errorCode } = fakes(failure);
      const source = new LitStreamSource({ full, previews, errorCode, signedIn: async () => true });
      expect((await source.list()).tracks[0].streamUrl).toBe('/preview.mp3');
      expect(source.access).toEqual({ mode: 'preview', reason: 'unavailable' });
    }
  });
});
