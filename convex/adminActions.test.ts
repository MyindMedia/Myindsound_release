import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import * as adminModule from './admin';
import * as adminActionsModule from './adminActions';
import { validateReleasePatch } from './adminActions';
import { newTest, OWNER, seedLitWithOwner, STRANGER } from './test.setup';

/** ADM-1..7: the admin tool. Every action is admin only, needs a reason and leaves one audit row. */

type T = ReturnType<typeof newTest>;

const ADMIN = { subject: 'user_admin', email: 'admin@example.test' };
const THIRD = { subject: 'user_third', email: 'third@example.test' };
const SEED = '0123456789abcdef0123456789abcdef';
const STATS = { playSeconds: 3600, loads: 4, ejects: 3, lentPlaySeconds: 120 };
const REASON = 'Support ticket 42';

/** LIT with OWNER holding edition 1 (seeded, with wear), an admin, and a third account. */
async function seed(t: T) {
  const base = await seedLitWithOwner(t);
  return await t.run(async (ctx) => {
    const adminId = await ctx.db.insert('users', { clerkId: ADMIN.subject, email: ADMIN.email, isAdmin: true });
    const thirdId = await ctx.db.insert('users', { clerkId: THIRD.subject, email: THIRD.email, isAdmin: false });
    const [row] = await ctx.db
      .query('entitlements')
      .withIndex('by_user_product', (q) => q.eq('userId', base.ownerId).eq('productId', base.litId))
      .collect();
    await ctx.db.patch(row._id, {
      editionNumber: 1,
      status: 'active',
      source: 'stripe',
      sourceRef: 'cs_test_owner',
      wearSeed: SEED,
      wearStats: STATS,
      wearModelVersion: 1,
      unwrappedAt: 1_000,
    });
    return { ...base, adminId, thirdId, ownerCopy: row._id };
  });
}

async function insertLend(
  t: T,
  entitlementId: Id<'entitlements'>,
  lenderUserId: Id<'users'>,
  borrowerUserId: Id<'users'>,
  status: 'offered' | 'active' = 'active',
) {
  return await t.run((ctx) =>
    ctx.db.insert('lends', {
      entitlementId,
      lenderUserId,
      ...(status === 'active' ? { borrowerUserId, claimedAt: Date.now(), expiresAt: Date.now() + 86_400_000 } : {}),
      claimToken: `tok${Math.random().toString(36).slice(2)}`.padEnd(22, 'x').slice(0, 22),
      channel: 'link',
      status,
      playsAllowed: 10,
      playsUsed: 2,
      offeredAt: Date.now(),
    }),
  );
}

const auditRows = (t: T) => t.run((ctx) => ctx.db.query('auditLog').collect());
const admin = (t: T) => t.withIdentity(ADMIN);

describe('access (ADM-1)', () => {
  test('non-admins and signed-out callers are refused by every admin function, and nothing is logged', async () => {
    const t = newTest();
    const { ownerCopy } = await seed(t);
    const lendId = await t.run(async (ctx) => {
      const [owner, stranger] = await Promise.all([
        ctx.db.query('users').withIndex('by_clerkId', (q) => q.eq('clerkId', OWNER.subject)).unique(),
        ctx.db.query('users').withIndex('by_clerkId', (q) => q.eq('clerkId', STRANGER.subject)).unique(),
      ]);
      return { owner: owner!._id, stranger: stranger!._id };
    });
    const lend = await insertLend(t, ownerCopy, lendId.owner, lendId.stranger);
    const calls = (as: ReturnType<T['withIdentity']> | T) => [
      () => as.query(api.admin.stats, {}),
      () => as.query(api.admin.lookup, { email: OWNER.email }),
      () => as.query(api.admin.lookup, { slug: 'lit', editionNumber: 1 }),
      () => as.query(api.admin.auditLog, { paginationOpts: { numItems: 10, cursor: null } }),
      () => as.query(api.admin.releases, {}),
      () => as.mutation(api.adminActions.grant, { email: STRANGER.email, slug: 'lit', reason: REASON }),
      () => as.mutation(api.adminActions.transfer, { entitlementId: ownerCopy, to: STRANGER.email, reason: REASON }),
      () => as.mutation(api.adminActions.revokeEntitlement, { entitlementId: ownerCopy, reason: REASON }),
      () => as.mutation(api.adminActions.revokeLend, { lendId: lend, reason: REASON }),
      () => as.mutation(api.adminActions.resetUnwrap, { entitlementId: ownerCopy, reason: REASON }),
      () => as.mutation(api.adminActions.resetWear, { entitlementId: ownerCopy, reason: REASON }),
      () => as.mutation(api.adminActions.disableNfcTag, { uid: '04AABBCCDD', reason: REASON }),
      () => as.mutation(api.adminActions.updateRelease, { slug: 'lit', reason: REASON, leaderboardSize: 50 }),
    ];
    for (const who of [t.withIdentity(STRANGER), t.withIdentity(OWNER)]) {
      for (const call of calls(who)) await expect(call()).rejects.toThrow(/FORBIDDEN|Admins only/);
    }
    for (const call of calls(t)) await expect(call()).rejects.toThrow(/UNAUTHENTICATED|Sign in/);
    expect(await auditRows(t)).toEqual([]);
    const row = await t.run((ctx) => ctx.db.get(ownerCopy));
    expect(row).toMatchObject({ status: 'active', wearStats: STATS, unwrappedAt: 1_000 });
  });

  test('ADMIN_EMAILS admins can act too', async () => {
    const t = newTest();
    await seed(t);
    process.env.ADMIN_EMAILS = THIRD.email;
    try {
      const result = await t.withIdentity(THIRD).mutation(api.adminActions.grant, {
        email: STRANGER.email,
        slug: 'lit',
        reason: REASON,
      });
      expect(result.status).toBe('granted');
    } finally {
      delete process.env.ADMIN_EMAILS;
    }
  });
});

describe('reasons (ADM-6)', () => {
  test('a missing or blank reason is rejected by every action and nothing changes', async () => {
    const t = newTest();
    const { ownerCopy, ownerId, strangerId } = await seed(t);
    const lend = await insertLend(t, ownerCopy, ownerId, strangerId);
    await expect(
      // @ts-expect-error reason is required
      admin(t).mutation(api.adminActions.grant, { email: STRANGER.email, slug: 'lit' }),
    ).rejects.toThrow(/reason/);
    for (const reason of ['', '   ', '\n\t']) {
      const calls = [
        () => admin(t).mutation(api.adminActions.grant, { email: STRANGER.email, slug: 'lit', reason }),
        () => admin(t).mutation(api.adminActions.transfer, { entitlementId: ownerCopy, to: STRANGER.email, reason }),
        () => admin(t).mutation(api.adminActions.revokeEntitlement, { entitlementId: ownerCopy, reason }),
        () => admin(t).mutation(api.adminActions.revokeLend, { lendId: lend, reason }),
        () => admin(t).mutation(api.adminActions.resetUnwrap, { entitlementId: ownerCopy, reason }),
        () => admin(t).mutation(api.adminActions.resetWear, { entitlementId: ownerCopy, reason }),
        () => admin(t).mutation(api.adminActions.disableNfcTag, { uid: '04AA', reason }),
        () => admin(t).mutation(api.adminActions.updateRelease, { slug: 'lit', reason, leaderboardSize: 50 }),
      ];
      for (const call of calls) await expect(call()).rejects.toThrow(/A reason is required/);
    }
    expect(await auditRows(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(lend))).toMatchObject({ status: 'active' });
    expect(await t.run((ctx) => ctx.db.get(ownerCopy))).toMatchObject({ userId: ownerId, wearStats: STATS });
  });
});

describe('audit log (ADM-6)', () => {
  test('every action writes one row with actor, target, before, after, reason and time', async () => {
    const t = newTest();
    const { ownerCopy, ownerId, strangerId, adminId, litId } = await seed(t);
    const lend = await insertLend(t, ownerCopy, ownerId, strangerId);
    await admin(t).mutation(api.adminActions.revokeLend, { lendId: lend, reason: 'r1' });
    await admin(t).mutation(api.adminActions.resetUnwrap, { entitlementId: ownerCopy, reason: 'r2' });
    await admin(t).mutation(api.adminActions.resetWear, { entitlementId: ownerCopy, reason: 'r3' });
    await admin(t).mutation(api.adminActions.updateRelease, { slug: 'lit', reason: 'r4', leaderboardSize: 50 });
    await admin(t).mutation(api.adminActions.grant, { email: STRANGER.email, slug: 'lit', reason: 'r5' });
    await admin(t).mutation(api.adminActions.transfer, { entitlementId: ownerCopy, to: THIRD.email, reason: 'r6' });
    await admin(t).mutation(api.adminActions.revokeEntitlement, { entitlementId: ownerCopy, reason: 'r7' });
    await admin(t).mutation(api.adminActions.grant, { email: 'nobody.yet@example.test', slug: 'lit', reason: 'r8' });

    const rows = await auditRows(t);
    expect(rows.map((row) => [row.action, row.reason])).toEqual([
      ['lend.revoke', 'r1'],
      ['entitlement.resetUnwrap', 'r2'],
      ['entitlement.resetWear', 'r3'],
      ['release.update', 'r4'],
      ['grant', 'r5'],
      ['entitlement.transfer', 'r6'],
      ['entitlement.revoke', 'r7'],
      ['grant.pending', 'r8'],
    ]);
    for (const row of rows) {
      expect(row.actorUserId).toBe(adminId);
      expect(row.at).toBeGreaterThan(0);
      expect(row).toHaveProperty('before');
      expect(row.after).not.toBeNull();
      expect(row.target).toMatch(/^(entitlement|lend|product|pending|user):/);
    }
    const [lendRow, unwrap, wear, release] = rows;
    expect(lendRow.before).toMatchObject({ status: 'active' });
    expect(lendRow.after).toMatchObject({ status: 'revoked' });
    expect(unwrap.before).toMatchObject({ unwrappedAt: 1_000 });
    expect(unwrap.after).toMatchObject({ unwrappedAt: null });
    expect(wear.before).toMatchObject({ wearStats: STATS });
    expect(wear.after).toMatchObject({ wearStats: { playSeconds: 0, loads: 0, ejects: 0, lentPlaySeconds: 0 }, wearSeed: SEED });
    expect(release.before).toMatchObject({ leaderboardSize: null });
    expect(release.after).toMatchObject({ leaderboardSize: 50 });
    expect(rows[5].before).toMatchObject({ userId: ownerId });
    expect(rows[6].after).toMatchObject({ status: 'revoked' });
    // No email ever reaches the log (ADM-1).
    expect(JSON.stringify(rows)).not.toContain('@');
    expect(await t.run((ctx) => ctx.db.get(litId))).toMatchObject({ leaderboardSize: 50 });
  });

  test('is paginated newest first and has no writers exported', async () => {
    const t = newTest();
    const { ownerCopy } = await seed(t);
    for (const reason of ['a', 'b', 'c']) {
      await admin(t).mutation(api.adminActions.resetUnwrap, { entitlementId: ownerCopy, reason });
    }
    const first = await admin(t).query(api.admin.auditLog, { paginationOpts: { numItems: 2, cursor: null } });
    expect(first.page.map((row) => row.reason)).toEqual(['c', 'b']);
    expect(first.isDone).toBe(false);
    const second = await admin(t).query(api.admin.auditLog, {
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page.map((row) => row.reason)).toEqual(['a']);
    const byTarget = await admin(t).query(api.admin.auditLog, {
      paginationOpts: { numItems: 10, cursor: null },
      target: `entitlement:${ownerCopy}`,
    });
    expect(byTarget.page).toHaveLength(3);
    // Read only: nothing in either admin module updates or deletes an audit row.
    const exported = [...Object.keys(adminActionsModule), ...Object.keys(adminModule)];
    expect(exported.filter((name) => /audit/i.test(name))).toEqual(['auditLog']);
  });
});

describe('grant (ADM-3)', () => {
  test('goes through the grant path, is numbered, and is idempotent', async () => {
    const t = newTest();
    const { strangerId, litId } = await seed(t);
    const first = await admin(t).mutation(api.adminActions.grant, { email: STRANGER.email, slug: 'lit', reason: REASON });
    expect(first).toMatchObject({ status: 'granted', editionNumber: 2 });
    const again = await admin(t).mutation(api.adminActions.grant, {
      email: ` ${STRANGER.email.toUpperCase()} `,
      slug: 'lit',
      reason: REASON,
    });
    expect(again).toMatchObject({ status: 'already_owned', editionNumber: 2, entitlementId: first.status === 'granted' ? first.entitlementId : null });

    const { rows, counter, refs } = await t.run(async (ctx) => ({
      rows: await ctx.db
        .query('entitlements')
        .withIndex('by_user_product', (q) => q.eq('userId', strangerId).eq('productId', litId))
        .collect(),
      counter: await ctx.db.query('releaseCounters').first(),
      refs: await ctx.db.query('entitlementRefs').withIndex('by_ref', (q) => q.eq('source', 'admin')).collect(),
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'admin', sourceRef: first.auditId, editionNumber: 2, status: 'active' });
    expect(rows[0].wearSeed).toMatch(/^[0-9a-f]{32}$/);
    expect(counter?.nextEdition).toBe(3);
    expect(refs).toHaveLength(1);
    const [grantRow, repeatRow] = await auditRows(t);
    expect(grantRow).toMatchObject({ action: 'grant', target: `entitlement:${rows[0]._id}`, before: null });
    expect(grantRow.after).toMatchObject({ editionNumber: 2, outcome: 'created', sourceRef: first.auditId });
    expect(repeatRow.before).toEqual(repeatRow.after);
  });

  test('is refused before the drop (ED-3) and leaves no trace', async () => {
    const t = newTest();
    const { litId } = await seed(t);
    await t.run((ctx) => ctx.db.patch(litId, { dropAt: Date.now() + 3_600_000, status: 'scheduled' }));
    await expect(
      admin(t).mutation(api.adminActions.grant, { email: STRANGER.email, slug: 'lit', reason: REASON }),
    ).rejects.toThrow(/NOT_YET_LIVE|not out yet/);
    expect(await auditRows(t)).toEqual([]);
  });
});

describe('pending grants (ENT-2)', () => {
  const NEW_FAN = { subject: 'user_new_fan', email: 'New.Fan@example.test', name: 'New Fan' };

  test('are held without the email and claimed at sign in by a verified email only', async () => {
    const t = newTest();
    const { litId } = await seed(t);
    const held = await admin(t).mutation(api.adminActions.grant, {
      email: 'new.fan@example.test',
      slug: 'lit',
      reason: REASON,
    });
    expect(held).toMatchObject({ status: 'pending', alreadyPending: false, editionNumber: null });
    const repeat = await admin(t).mutation(api.adminActions.grant, {
      email: 'NEW.FAN@example.test',
      slug: 'lit',
      reason: REASON,
    });
    expect(repeat).toMatchObject({ status: 'pending', alreadyPending: true });
    const pendingRows = await t.run((ctx) => ctx.db.query('pendingGrants').collect());
    expect(pendingRows).toHaveLength(1);
    expect(JSON.stringify(pendingRows)).not.toContain('@');

    // Unverified email, or a verified different email: nothing is claimed.
    await t.withIdentity({ ...NEW_FAN, emailVerified: false }).mutation(api.users.ensure, {});
    await t
      .withIdentity({ subject: 'user_other', email: 'other@example.test', emailVerified: true })
      .mutation(api.users.ensure, {});
    const owns = async (subject: string) =>
      t.run(async (ctx) => {
        const user = await ctx.db.query('users').withIndex('by_clerkId', (q) => q.eq('clerkId', subject)).unique();
        return user
          ? await ctx.db
              .query('entitlements')
              .withIndex('by_user_product', (q) => q.eq('userId', user._id).eq('productId', litId))
              .collect()
          : [];
      });
    expect(await owns(NEW_FAN.subject)).toEqual([]);
    expect(await owns('user_other')).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(pendingRows[0]._id)))?.status).toBe('pending');

    // Verified: claimed through the grant path, keyed on the grant's audit id, exactly once.
    await t.withIdentity({ ...NEW_FAN, emailVerified: true }).mutation(api.users.ensure, {});
    await t.withIdentity({ ...NEW_FAN, emailVerified: true }).mutation(api.users.ensure, {});
    const claimed = await owns(NEW_FAN.subject);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ source: 'admin', sourceRef: held.auditId, editionNumber: 2 });
    expect(await t.run((ctx) => ctx.db.get(pendingRows[0]._id))).toMatchObject({
      status: 'claimed',
      entitlementId: claimed[0]._id,
    });
    const claimRows = (await auditRows(t)).filter((row) => row.action === 'grant.claim');
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0].after).toMatchObject({ status: 'claimed', editionNumber: 2 });
    expect(JSON.stringify(await auditRows(t))).not.toContain('@');
  });

  test('a grant for a release that has not dropped stays pending until it has', async () => {
    const t = newTest();
    const { litId } = await seed(t);
    await admin(t).mutation(api.adminActions.grant, { email: NEW_FAN.email, slug: 'lit', reason: REASON });
    await t.run((ctx) => ctx.db.patch(litId, { dropAt: Date.now() + 3_600_000 }));
    await t.withIdentity({ ...NEW_FAN, emailVerified: true }).mutation(api.users.ensure, {});
    expect((await t.run((ctx) => ctx.db.query('pendingGrants').first()))?.status).toBe('pending');
    await t.run((ctx) => ctx.db.patch(litId, { dropAt: Date.now() - 1 }));
    await t.withIdentity({ ...NEW_FAN, emailVerified: true }).mutation(api.users.ensure, {});
    expect((await t.run((ctx) => ctx.db.query('pendingGrants').first()))?.status).toBe('claimed');
  });
});

describe('transfer (ADM-4)', () => {
  test('keeps edition, seed and stats, so the wear descriptor is unchanged, and returns the lends (§11.6 test 7)', async () => {
    const t = newTest();
    const { ownerCopy, ownerId, thirdId, strangerId } = await seed(t);
    const lend = await insertLend(t, ownerCopy, ownerId, thirdId);
    const before = await t.withIdentity(OWNER).query(api.app.context, { slug: 'lit' });
    expect(before.ownership).toBe('owned');
    expect(before.wear?.level).toBeGreaterThan(0);

    const result = await admin(t).mutation(api.adminActions.transfer, {
      entitlementId: ownerCopy,
      to: STRANGER.email,
      reason: REASON,
    });
    expect(result).toMatchObject({ fromUserId: ownerId, toUserId: strangerId, editionNumber: 1, lendsEnded: 1 });

    const after = await t.withIdentity(STRANGER).query(api.app.context, { slug: 'lit' });
    expect(after.ownership).toBe('owned');
    expect(after.editionNumber).toBe(1);
    expect(after.wear).toEqual(before.wear);
    expect(after.wearInputs).toEqual({ seed: SEED, stats: STATS, version: 1 });
    expect((await t.withIdentity(OWNER).query(api.app.context, { slug: 'lit' })).ownership).not.toBe('owned');
    expect(await t.run((ctx) => ctx.db.get(lend))).toMatchObject({ status: 'returned', endReason: 'called_back' });
  });

  test('is refused when the target already owns the release (ENT-5), or the copy is not active', async () => {
    const t = newTest();
    const { ownerCopy, thirdId } = await seed(t);
    await admin(t).mutation(api.adminActions.grant, { email: THIRD.email, slug: 'lit', reason: REASON });
    await expect(
      admin(t).mutation(api.adminActions.transfer, { entitlementId: ownerCopy, to: thirdId, reason: REASON }),
    ).rejects.toThrow(/ALREADY_OWNED/);
    await expect(
      admin(t).mutation(api.adminActions.transfer, { entitlementId: ownerCopy, to: 'nobody@example.test', reason: REASON }),
    ).rejects.toThrow(/NOT_FOUND/);
    await admin(t).mutation(api.adminActions.revokeEntitlement, { entitlementId: ownerCopy, reason: REASON });
    await expect(
      admin(t).mutation(api.adminActions.transfer, { entitlementId: ownerCopy, to: STRANGER.email, reason: REASON }),
    ).rejects.toThrow(/Only an active licence/);
    expect(await t.run((ctx) => ctx.db.get(ownerCopy))).toMatchObject({ editionNumber: 1 });
  });
});

describe('revoke and resets (ADM-5)', () => {
  test('revoking a licence goes through the payment revoke path and revokes its lends (LEND-10)', async () => {
    const t = newTest();
    const { ownerCopy, ownerId, strangerId } = await seed(t);
    const lend = await insertLend(t, ownerCopy, ownerId, strangerId);
    const result = await admin(t).mutation(api.adminActions.revokeEntitlement, { entitlementId: ownerCopy, reason: REASON });
    expect(result).toMatchObject({ editionNumber: 1, lendsRevoked: 1 });
    expect(await t.run((ctx) => ctx.db.get(ownerCopy))).toMatchObject({ status: 'revoked', editionNumber: 1 });
    expect(await t.run((ctx) => ctx.db.get(lend))).toMatchObject({ status: 'revoked' });
    const refs = await t.run((ctx) => ctx.db.query('entitlementRefs').collect());
    expect(refs.map((ref) => ref.status)).toEqual(['refunded']);
    await expect(
      admin(t).mutation(api.adminActions.revokeEntitlement, { entitlementId: ownerCopy, reason: REASON }),
    ).rejects.toThrow(/already revoked/);
  });

  test('revoke lend, reset unwrap, reset wear (WEAR-5), and the NFC stub', async () => {
    const t = newTest();
    const { ownerCopy, ownerId, strangerId } = await seed(t);
    const lend = await insertLend(t, ownerCopy, ownerId, strangerId, 'offered');
    await admin(t).mutation(api.adminActions.revokeLend, { lendId: lend, reason: REASON });
    expect(await t.run((ctx) => ctx.db.get(lend))).toMatchObject({ status: 'revoked' });
    await expect(admin(t).mutation(api.adminActions.revokeLend, { lendId: lend, reason: REASON })).rejects.toThrow(
      /already ended/,
    );

    await admin(t).mutation(api.adminActions.resetUnwrap, { entitlementId: ownerCopy, reason: REASON });
    expect((await t.withIdentity(OWNER).query(api.app.context, { slug: 'lit' })).unwrapped).toBe(false);

    await admin(t).mutation(api.adminActions.resetWear, { entitlementId: ownerCopy, reason: REASON });
    const row = await t.run((ctx) => ctx.db.get(ownerCopy));
    expect(row).toMatchObject({ wearSeed: SEED, editionNumber: 1, wearStats: { playSeconds: 0, loads: 0, ejects: 0, lentPlaySeconds: 0 } });

    await expect(admin(t).mutation(api.adminActions.disableNfcTag, { uid: '04AA', reason: REASON })).rejects.toThrow(
      /NOT_CONFIGURED/,
    );
    expect((await auditRows(t)).map((r) => r.action)).toEqual([
      'lend.revoke',
      'entitlement.resetUnwrap',
      'entitlement.resetWear',
    ]);
  });
});

describe('lookup (ADM-2)', () => {
  test('by email and by edition: account, licences, wear, lends, plays and refs, and no stored email', async () => {
    const t = newTest();
    const { ownerCopy, ownerId, strangerId, trackIds } = await seed(t);
    await insertLend(t, ownerCopy, ownerId, strangerId);
    await t.run(async (ctx) => {
      await ctx.db.insert('plays', { userId: ownerId, trackId: trackIds[0], playedAt: 5_000 });
      for (const [i, kind] of (['play', 'play', 'load'] as const).entries()) {
        await ctx.db.insert('playEvents', {
          idempotencyKey: `k${i}`,
          entitlementId: ownerCopy,
          actorUserId: ownerId,
          ...(kind === 'play' ? { trackId: trackIds[0] } : {}),
          kind,
          startedAtClient: 10_000 + i,
          receivedAt: 20_000 + i,
          playedSec: kind === 'play' ? 100 : 0,
          countedSec: kind === 'play' ? 100 : 0,
          counted: true,
        });
      }
      await ctx.db.insert('orders', {
        userId: ownerId,
        stripeSessionId: 'cs_test_order',
        totalCents: 4500,
        currency: 'usd',
        shipping: { name: 'Owner Test', line1: '1 Street', city: 'Town', postalCode: '00000', country: 'US' },
        status: 'paid',
        createdAt: 6_000,
      });
    });

    const byEmail = await admin(t).query(api.admin.lookup, { email: OWNER.email.toUpperCase() });
    expect(byEmail.found).toBe(true);
    expect(byEmail.account).toMatchObject({ id: ownerId, displayName: OWNER.name });
    const [copy] = byEmail.entitlements;
    expect(copy).toMatchObject({
      id: ownerCopy,
      slug: 'lit',
      editionNumber: 1,
      status: 'active',
      source: 'stripe',
      wearStats: STATS,
      unwrappedAt: 1_000,
      playEvents: { play: 2, load: 1, eject: 0, lastPlayedAt: 10_001 },
    });
    expect(copy.wearLevel).toBeGreaterThan(0);
    expect(copy.wearLevel).toBeLessThanOrEqual(1);
    expect(copy.lends).toHaveLength(1);
    expect(copy.lends[0]).toMatchObject({ status: 'active', borrowerUserId: strangerId });
    expect(byEmail.websitePlays).toMatchObject({ count: 1, lastPlayedAt: 5_000 });
    expect(byEmail.orders).toEqual([expect.objectContaining({ stripeSessionId: 'cs_test_order', totalCents: 4500 })]);
    const json = JSON.stringify(byEmail);
    expect(json).not.toContain('@');
    expect(json).not.toContain('1 Street');

    const byEdition = await admin(t).query(api.admin.lookup, { slug: 'lit', editionNumber: 1 });
    expect(byEdition).toMatchObject({ found: true, matchedEntitlementId: ownerCopy, account: { id: ownerId } });
    expect(JSON.stringify(byEdition)).not.toContain('@');

    const borrower = await admin(t).query(api.admin.lookup, { email: STRANGER.email });
    expect(borrower.borrowing).toEqual([expect.objectContaining({ slug: 'lit', editionNumber: 1, status: 'active' })]);

    expect(await admin(t).query(api.admin.lookup, { email: 'nobody@example.test' })).toMatchObject({ found: false });
    expect(await admin(t).query(api.admin.lookup, { slug: 'lit', editionNumber: 99 })).toMatchObject({ found: false });
    await expect(admin(t).query(api.admin.lookup, {})).rejects.toThrow(/INVALID_INPUT/);
  });

  test('a retired edition shows the copy without an account', async () => {
    const t = newTest();
    const { ownerCopy } = await seed(t);
    await t.run((ctx) => ctx.db.patch(ownerCopy, { userId: undefined, status: 'retired' }));
    expect(await admin(t).query(api.admin.lookup, { slug: 'lit', editionNumber: 1 })).toMatchObject({
      found: true,
      account: null,
      entitlements: [{ id: ownerCopy, status: 'retired' }],
    });
  });
});

describe('release management (ADM-7)', () => {
  const SHA = 'a'.repeat(64);
  const future = () => Date.now() + 86_400_000;

  test('sets every field and logs before and after', async () => {
    const t = newTest();
    const { litId } = await seed(t);
    const dropAt = future();
    await admin(t).mutation(api.adminActions.updateRelease, {
      slug: 'lit',
      reason: REASON,
      dropAt,
      status: 'scheduled',
      bundleVersion: '1.3.0',
      bundleUrl: 'https://releases.myindsound.com/lit/1.3.0.zip',
      bundleSha256: SHA.toUpperCase(),
      appStoreProductIds: ['com.myindsound.lit.tier1', 'com.myindsound.lit.tier1', 'com.myindsound.lit.tier2'],
      leaderboardSize: 100,
      theme: { accent: 'pink', accent2: '#9FD8FF', backdropImage: 'assets/city-comic.webp' },
    });
    expect(await t.run((ctx) => ctx.db.get(litId))).toMatchObject({
      dropAt,
      status: 'scheduled',
      bundleVersion: '1.3.0',
      bundleSha256: SHA,
      appStoreProductIds: ['com.myindsound.lit.tier1', 'com.myindsound.lit.tier2'],
      leaderboardSize: 100,
      theme: { accent: 'pink' },
    });
    const releases = await admin(t).query(api.admin.releases, {});
    expect(releases).toEqual([expect.objectContaining({ slug: 'lit', name: 'LIT', bundleVersion: '1.3.0' })]);
  });

  test('refuses bad input', async () => {
    const t = newTest();
    await seed(t);
    const bad = [
      { bundleVersion: '1.0.0', bundleUrl: 'https://x.test/a.zip', bundleSha256: 'xyz' },
      { bundleVersion: '1.0.0', bundleUrl: 'http://x.test/a.zip', bundleSha256: SHA },
      { bundleVersion: '1.0.0', bundleUrl: 'javascript:alert(1)', bundleSha256: SHA },
      { bundleVersion: '1.0.0' },
      { bundleVersion: 'latest', bundleUrl: 'https://x.test/a.zip', bundleSha256: SHA },
      { status: 'scheduled' as const },
      { status: 'scheduled' as const, dropAt: Date.now() - 1000 },
      { status: 'live' as const, dropAt: future() },
      { dropAt: 1.5 },
      { leaderboardSize: 0 },
      { appStoreProductIds: ['bad id'] },
      { theme: { accent: 'red;}', accent2: 'ice', backdropImage: 'city.webp' } },
      { theme: { accent: 'pink', accent2: 'ice', backdropImage: '../secrets' } },
      {},
    ];
    for (const patch of bad) {
      await expect(
        admin(t).mutation(api.adminActions.updateRelease, { slug: 'lit', reason: REASON, ...patch }),
      ).rejects.toThrow(/INVALID_INPUT/);
    }
    await expect(
      admin(t).mutation(api.adminActions.updateRelease, { slug: 'nope', reason: REASON, leaderboardSize: 5 }),
    ).rejects.toThrow(/NOT_FOUND/);
    expect(await auditRows(t)).toEqual([]);
  });

  test('validateReleasePatch: scheduling rules use the merged state', () => {
    const now = 1_000_000;
    expect(() => validateReleasePatch({ status: 'scheduled', dropAt: now + 10 }, { dropAt: now - 10 }, now)).toThrow(
      /future/,
    );
    expect(validateReleasePatch({ status: 'draft' }, { dropAt: now - 10 }, now)).toEqual({ dropAt: now - 10 });
    expect(validateReleasePatch({ dropAt: now + 10 }, { status: 'scheduled' }, now)).toEqual({ status: 'scheduled' });
    expect(validateReleasePatch({ status: 'live', dropAt: now + 10 }, { leaderboardSize: 20 }, now)).toEqual({
      leaderboardSize: 20,
    });
  });
});
