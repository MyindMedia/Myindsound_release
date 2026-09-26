import { describe, expect, test } from 'vitest';
import { computeWear } from '../packages/wear/src/index';
import { api, internal } from './_generated/api';
import { dueToGoLive, ownershipOf } from './app';
import { newTest, OWNER, seedLitWithOwner, STRANGER } from './test.setup';

const HOUR = 60 * 60 * 1000;
type T = ReturnType<typeof newTest>;

async function seed(t: T) {
  const seeded = await seedLitWithOwner(t);
  await t.mutation(internal.migrations.assignEditions, {});
  return seeded;
}

async function addSource(t: T, fields: { dropAt?: number; status?: 'draft' | 'scheduled' | 'live'; active?: boolean }) {
  return await t.run((ctx) =>
    ctx.db.insert('products', {
      slug: 'the-source',
      name: 'THE SOURCE',
      kind: 'digital',
      stripeProductIds: ['prod_source'],
      active: fields.active ?? true,
      ...(fields.dropAt !== undefined ? { dropAt: fields.dropAt } : {}),
      ...(fields.status ? { status: fields.status } : {}),
    }),
  );
}

/** Every storage id in the database, to prove none leaks into an app response. */
async function storageIds(t: T): Promise<string[]> {
  return await t.run(async (ctx) => {
    const ids: string[] = [];
    for (const track of await ctx.db.query('tracks').collect()) {
      if (track.streamFile) ids.push(track.streamFile);
      if (track.originalFile) ids.push(track.originalFile);
    }
    for (const product of await ctx.db.query('products').collect()) if (product.downloadFile) ids.push(product.downloadFile);
    return ids;
  });
}

describe('ownership', () => {
  test('owned wins, then lent, then locked before the drop, else preview', () => {
    const now = 1_000_000;
    expect(ownershipOf({ dropAt: now + 1 }, true, false, now)).toBe('owned');
    expect(ownershipOf({ dropAt: now + 1 }, false, true, now)).toBe('lent');
    expect(ownershipOf({ dropAt: now + 1 }, false, false, now)).toBe('locked');
    expect(ownershipOf({ dropAt: now }, false, false, now)).toBe('preview');
    expect(ownershipOf({}, false, false, now)).toBe('preview');
    expect(ownershipOf({ status: 'scheduled' }, false, false, now)).toBe('locked');
  });
});

describe('app.context', () => {
  test('owner: owned, edition, wear from computeWear, public name, never a storage id', async () => {
    const t = newTest();
    await seed(t);
    const context = await t.withIdentity(OWNER).query(api.app.context, { slug: 'lit' });
    const row = await t.run(async (ctx) => (await ctx.db.query('entitlements').first())!);
    expect(context).toMatchObject({
      slug: 'lit',
      ownership: 'owned',
      editionNumber: 1,
      ownerDisplayName: 'Owner T.',
      unwrapped: false,
      dropAt: 0,
      lend: null,
    });
    expect(context.wear).toEqual(computeWear(row.wearSeed!, row.wearStats!, row.wearModelVersion!));
    expect(context.wearInputs).toEqual({ seed: row.wearSeed, stats: row.wearStats, version: 1 });
    expect(Math.abs(context.serverNow - Date.now())).toBeLessThan(5000);
    const json = JSON.stringify(context);
    for (const id of await storageIds(t)) expect(json).not.toContain(id);
  });

  test('stranger after the drop: preview, no wear, no edition; signed out too', async () => {
    const t = newTest();
    await seed(t);
    for (const caller of [t.withIdentity(STRANGER), t]) {
      const context = await caller.query(api.app.context, { slug: 'lit' });
      expect(context).toMatchObject({ ownership: 'preview', editionNumber: null, wear: null, ownerDisplayName: null, unwrapped: false });
    }
  });

  test('before the drop a non-owner is locked; dropAt and serverNow come from the server', async () => {
    const t = newTest();
    await seed(t);
    const dropAt = Date.now() + 24 * HOUR;
    await addSource(t, { dropAt, status: 'scheduled' });
    const context = await t.withIdentity(STRANGER).query(api.app.context, { slug: 'the-source' });
    expect(context).toMatchObject({ ownership: 'locked', dropAt, status: 'scheduled' });
    await expect(t.query(api.app.context, { slug: 'nope' })).rejects.toThrow(/NOT_FOUND|No release/);
  });

  test('a refunded licence is no longer owned', async () => {
    const t = newTest();
    await seed(t);
    await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_test_owner' });
    const context = await t.withIdentity(OWNER).query(api.app.context, { slug: 'lit' });
    expect(context.ownership).toBe('preview');
  });
});

describe('app.library', () => {
  test('owned releases, then upcoming locked ones; drafts and live unowned releases are left out', async () => {
    const t = newTest();
    await seed(t);
    const dropAt = Date.now() + 2 * HOUR;
    await addSource(t, { dropAt, status: 'scheduled' });
    await t.run((ctx) =>
      ctx.db.insert('products', { slug: 'secret', name: 'SECRET', kind: 'digital', stripeProductIds: [], active: true, status: 'draft', dropAt }),
    );
    const owner = await t.withIdentity(OWNER).query(api.app.library, {});
    expect(owner.releases.map((r) => [r.slug, r.ownership])).toEqual([
      ['lit', 'owned'],
      ['the-source', 'locked'],
    ]);
    expect(owner.releases[0]).toMatchObject({ editionNumber: 1, unwrapped: false, status: 'live', bundle: null, lend: null });
    expect(owner.releases[1]).toMatchObject({ dropAt, editionNumber: null });

    const stranger = await t.withIdentity(STRANGER).query(api.app.library, {});
    expect(stranger.releases.map((r) => r.slug)).toEqual(['the-source']);
    const signedOut = await t.query(api.app.library, {});
    expect(signedOut.releases.map((r) => r.slug)).toEqual(['the-source']);
    const json = JSON.stringify(owner);
    for (const id of await storageIds(t)) expect(json).not.toContain(id);
  });
});

describe('app.tracks', () => {
  test('ids, titles, durations and positions only', async () => {
    const t = newTest();
    const { trackIds } = await seed(t);
    const tracks = await t.query(api.app.tracks, { slug: 'lit' });
    expect(tracks).toHaveLength(6);
    expect(tracks[0]).toEqual({ id: trackIds[0], position: 1, title: 'Track 1', durationSeconds: 121 });
    const json = JSON.stringify(tracks);
    for (const id of await storageIds(t)) expect(json).not.toContain(id);
  });
});

describe('app.markUnwrapped (RACK-3)', () => {
  test('sets unwrappedAt once; strangers are refused', async () => {
    const t = newTest();
    await seed(t);
    const first = await t.withIdentity(OWNER).mutation(api.app.markUnwrapped, { slug: 'lit' });
    expect(first.alreadyUnwrapped).toBe(false);
    const second = await t.withIdentity(OWNER).mutation(api.app.markUnwrapped, { slug: 'lit' });
    expect(second).toEqual({ unwrappedAt: first.unwrappedAt, alreadyUnwrapped: true });
    expect((await t.withIdentity(OWNER).query(api.app.context, { slug: 'lit' })).unwrapped).toBe(true);
    expect((await t.withIdentity(OWNER).query(api.app.library, {})).releases[0].unwrapped).toBe(true);
    await expect(t.withIdentity(STRANGER).mutation(api.app.markUnwrapped, { slug: 'lit' })).rejects.toThrow(/NOT_ENTITLED|No license/);
  });
});

describe('app.recordCartridgeEvent', () => {
  test('counts a load and an eject, rate limits a second load within 2 s, and is idempotent by key', async () => {
    const t = newTest();
    await seed(t);
    const owner = t.withIdentity(OWNER);
    expect(await owner.mutation(api.app.recordCartridgeEvent, { slug: 'lit', kind: 'load' })).toEqual({
      counted: true,
      duplicate: false,
      limitedBy: null,
    });
    expect(await owner.mutation(api.app.recordCartridgeEvent, { slug: 'lit', kind: 'load' })).toMatchObject({
      counted: false,
      limitedBy: 'rate_limited',
    });
    const eject = { slug: 'lit', kind: 'eject' as const, idempotencyKey: 'eject-0000-0001' };
    expect((await owner.mutation(api.app.recordCartridgeEvent, eject)).counted).toBe(true);
    expect(await owner.mutation(api.app.recordCartridgeEvent, eject)).toMatchObject({ counted: false, duplicate: true });
    const row = await t.run(async (ctx) => (await ctx.db.query('entitlements').first())!);
    expect(row.wearStats).toMatchObject({ loads: 1, ejects: 1, playSeconds: 0 });
    await expect(
      t.withIdentity(STRANGER).mutation(api.app.recordCartridgeEvent, { slug: 'lit', kind: 'load' }),
    ).rejects.toThrow(/NOT_ENTITLED|No license/);
  });
});

describe('drops (DROP-1, DROP-7)', () => {
  test('dueToGoLive: scheduled with dropAt <= now only', () => {
    const now = 5_000;
    const products = [
      { id: 'due', status: 'scheduled' as const, dropAt: now },
      { id: 'past', status: 'scheduled' as const, dropAt: now - 1 },
      { id: 'future', status: 'scheduled' as const, dropAt: now + 1 },
      { id: 'draft', status: 'draft' as const, dropAt: now - 1 },
      { id: 'live', status: 'live' as const, dropAt: now - 1 },
      { id: 'no-drop', status: 'scheduled' as const },
    ];
    expect(dueToGoLive(products, now).map((p) => p.id)).toEqual(['due', 'past']);
  });

  test('flipDueDrops flips due releases to live and leaves the rest', async () => {
    const t = newTest();
    await seed(t);
    const sourceId = await addSource(t, { dropAt: Date.now() - 1000, status: 'scheduled' });
    const laterId = await t.run((ctx) =>
      ctx.db.insert('products', {
        slug: 'later',
        name: 'LATER',
        kind: 'digital',
        stripeProductIds: [],
        active: true,
        status: 'scheduled',
        dropAt: Date.now() + HOUR,
      }),
    );
    expect(await t.mutation(internal.app.flipDueDrops, {})).toEqual({ flipped: 1 });
    expect((await t.run((ctx) => ctx.db.get(sourceId)))!.status).toBe('live');
    expect((await t.run((ctx) => ctx.db.get(laterId)))!.status).toBe('scheduled');
    expect(await t.mutation(internal.app.flipDueDrops, {})).toEqual({ flipped: 0 });
  });
});
