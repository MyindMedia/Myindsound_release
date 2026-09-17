import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import { newTest, OWNER } from './test.setup';

describe('users', () => {
  test('me is null when signed out', async () => {
    const t = newTest();
    expect(await t.query(api.users.me, {})).toBeNull();
  });

  test('ensure creates the row once and updates it later', async () => {
    const t = newTest();
    const owner = t.withIdentity(OWNER);
    await owner.mutation(api.users.ensure, {});
    await t.withIdentity({ ...OWNER, name: 'Renamed' }).mutation(api.users.ensure, {});
    const rows = await t.run((ctx) => ctx.db.query('users').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Renamed');
    expect(await owner.query(api.users.me, {})).toMatchObject({ clerkId: OWNER.subject, isAdmin: false });
  });

  test('ensure rejects signed-out callers', async () => {
    const t = newTest();
    await expect(t.mutation(api.users.ensure, {})).rejects.toThrow(/UNAUTHENTICATED|Sign in/);
  });

  test('setAdmin flips the flag', async () => {
    const t = newTest();
    await t.withIdentity(OWNER).mutation(api.users.ensure, {});
    await t.mutation(internal.users.setAdmin, { clerkId: OWNER.subject, isAdmin: true });
    expect(await t.withIdentity(OWNER).query(api.users.me, {})).toMatchObject({ isAdmin: true });
  });
});

describe('seed.products', () => {
  test('is idempotent', async () => {
    const t = newTest();
    await t.mutation(internal.seed.products, {});
    const second = await t.mutation(internal.seed.products, {});
    expect(second.created).toBe(0);
    const rows = await t.run((ctx) => ctx.db.query('products').collect());
    expect(rows.map((r) => r.slug).sort()).toEqual(['lit', 'the-source']);
  });
});
