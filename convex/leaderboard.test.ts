import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { ANONYMOUS_NAME, nextTierFor, publicName, RETIRED_NAME, tierFor } from './leaderboard';
import { newTest, OWNER } from './test.setup';

type T = ReturnType<typeof newTest>;
type Status = 'active' | 'revoked' | 'retired';

async function product(t: T, slug: string, leaderboardSize?: number) {
  return await t.run((ctx) =>
    ctx.db.insert('products', {
      slug,
      name: slug.toUpperCase(),
      kind: 'digital',
      stripeProductIds: [],
      active: true,
      ...(leaderboardSize ? { leaderboardSize } : {}),
    }),
  );
}

async function user(t: T, clerkId: string, name?: string, leaderboardVisible?: boolean) {
  return await t.run((ctx) =>
    ctx.db.insert('users', {
      clerkId,
      email: `${clerkId}@example.test`,
      ...(name ? { name } : {}),
      isAdmin: false,
      ...(leaderboardVisible === undefined ? {} : { leaderboardVisible }),
    }),
  );
}

async function edition(t: T, productId: Id<'products'>, userId: Id<'users'> | undefined, editionNumber: number, status: Status = 'active') {
  await t.run((ctx) =>
    ctx.db.insert('entitlements', {
      ...(userId ? { userId } : {}),
      productId,
      grantedAt: editionNumber,
      editionNumber,
      status,
      source: 'admin',
      sourceRef: `audit_${productId}_${editionNumber}`,
    }),
  );
}

describe('pure rules', () => {
  test('LB-4 tiers: bronze 3, silver 7, gold 10', () => {
    expect([0, 2, 3, 6, 7, 9, 10, 25].map(tierFor)).toEqual([null, null, 'bronze', 'bronze', 'silver', 'silver', 'gold', 'gold']);
    expect(nextTierFor(0)).toEqual({ tier: 'bronze', needs: 3 });
    expect(nextTierFor(4)).toEqual({ tier: 'silver', needs: 3 });
    expect(nextTierFor(9)).toEqual({ tier: 'gold', needs: 1 });
    expect(nextTierFor(10)).toBeNull();
  });

  test('public name: first name and last initial, never more', () => {
    expect(publicName({ name: 'Lawrence Berment' })).toBe('Lawrence B.');
    expect(publicName({ name: '  Mary  Ann  de la Cruz ' })).toBe('Mary C.');
    expect(publicName({ name: 'Prince' })).toBe('Prince');
    expect(publicName({ name: undefined })).toBe('Collector');
    expect(publicName(null)).toBe('Collector');
  });
});

describe('leaderboard.forRelease (LB-1..3, LB-5)', () => {
  test('edition order; revoked removed so the next moves up; retired and anonymous labelled; isYou', async () => {
    const t = newTest();
    const lit = await product(t, 'lit', 3);
    const owner = await user(t, OWNER.subject, 'Owner Test');
    const hidden = await user(t, 'user_hidden', 'Hidden Person', false);
    const refunded = await user(t, 'user_refunded', 'Refund Guy');
    const late = await user(t, 'user_late', 'Late Comer');
    await edition(t, lit, owner, 1);
    await edition(t, lit, undefined, 2, 'retired');
    await edition(t, lit, refunded, 3, 'revoked');
    await edition(t, lit, hidden, 4);
    await edition(t, lit, late, 5);

    const board = await t.withIdentity(OWNER).query(api.leaderboard.forRelease, { slug: 'lit' });
    expect(board.leaderboardSize).toBe(3);
    expect(board.rows).toEqual([
      { rank: 1, editionNumber: 1, displayName: 'Owner T.', retired: false, anonymous: false, isYou: true, awardTier: null },
      { rank: 2, editionNumber: 2, displayName: RETIRED_NAME, retired: true, anonymous: false, isYou: false, awardTier: null },
      { rank: 3, editionNumber: 4, displayName: ANONYMOUS_NAME, retired: false, anonymous: true, isYou: false, awardTier: null },
    ]);
    const json = JSON.stringify(board);
    expect(json).not.toContain('@example.test');
    expect(json).not.toContain('Hidden');

    // limit trims, and never exceeds leaderboardSize; signed out works.
    expect((await t.query(api.leaderboard.forRelease, { slug: 'lit', limit: 1 })).rows).toHaveLength(1);
    expect((await t.query(api.leaderboard.forRelease, { slug: 'lit', limit: 50 })).rows).toHaveLength(3);
    await expect(t.query(api.leaderboard.forRelease, { slug: 'nope' })).rejects.toThrow(/NOT_FOUND/);
  });

  test('LB-2 opt out toggles the name', async () => {
    const t = newTest();
    const lit = await product(t, 'lit');
    const owner = await user(t, OWNER.subject, 'Owner Test');
    await edition(t, lit, owner, 1);
    expect(await t.withIdentity(OWNER).mutation(api.leaderboard.setLeaderboardVisible, { visible: false })).toEqual({
      leaderboardVisible: false,
    });
    expect((await t.query(api.leaderboard.forRelease, { slug: 'lit' })).rows[0].displayName).toBe(ANONYMOUS_NAME);
    expect((await t.withIdentity(OWNER).query(api.leaderboard.myAwards, {})).leaderboardVisible).toBe(false);
    await t.withIdentity(OWNER).mutation(api.leaderboard.setLeaderboardVisible, { visible: true });
    expect((await t.query(api.leaderboard.forRelease, { slug: 'lit' })).rows[0].displayName).toBe('Owner T.');
  });
});

describe('leaderboard.myAwards (LB-4, LB-5, LB-6)', () => {
  test('counts releases placed within leaderboardSize; revoked and out-of-board copies do not count', async () => {
    const t = newTest();
    const owner = await user(t, OWNER.subject, 'Owner Test');
    const early = await user(t, 'user_early', 'Early Bird');
    const releases = [];
    for (let i = 0; i < 9; i++) releases.push(await product(t, `r${i}`, 2));
    // r0..r6: owner is edition 1 (placed). r7: owner is edition 3 behind two others (outside a board of 2).
    // r8: owner's copy was refunded.
    for (let i = 0; i < 7; i++) await edition(t, releases[i], owner, 1);
    await edition(t, releases[7], early, 1);
    await edition(t, releases[7], await user(t, 'user_x'), 2);
    await edition(t, releases[7], owner, 3);
    await edition(t, releases[8], owner, 1, 'revoked');

    const awards = await t.withIdentity(OWNER).query(api.leaderboard.myAwards, {});
    expect(awards.topPlacements).toBe(7);
    expect(awards.tier).toBe('silver');
    expect(awards.nextTier).toEqual({ tier: 'gold', needs: 3 });
    expect(awards.placements.map((p) => p.slug)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect(awards.placements[0]).toEqual({ slug: 'r0', title: 'R0', rank: 1, editionNumber: 1 });

    // The tier shows on the owner's leaderboard rows too (LB-2, LB-6).
    const board = await t.query(api.leaderboard.forRelease, { slug: 'r0' });
    expect(board.rows[0].awardTier).toBe('silver');

    // Signed out: an empty result, not an error.
    expect(await t.query(api.leaderboard.myAwards, {})).toMatchObject({ topPlacements: 0, tier: null, placements: [] });
  });
});
