/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import schema from './schema';

export const modules = import.meta.glob('./**/!(*.*.*)*.*s');

export function newTest() {
  return convexTest(schema, modules);
}

export const OWNER = { subject: 'user_owner', email: 'owner@example.test', name: 'Owner Test' };
export const STRANGER = { subject: 'user_stranger', email: 'stranger@example.test' };

type T = ReturnType<typeof newTest>;

// Seeds products, 6 LIT tracks, both users, and a LIT entitlement for OWNER.
export async function seedLitWithOwner(t: T, options: { uploaded?: boolean } = {}) {
  const uploaded = options.uploaded ?? true;
  return await t.run(async (ctx) => {
    const file = async (label: string) =>
      uploaded ? await ctx.storage.store(new Blob([label], { type: 'audio/mpeg' })) : undefined;
    const litId = await ctx.db.insert('products', {
      slug: 'lit',
      name: 'LIT',
      kind: 'digital',
      stripeProductIds: ['prod_lit'],
      downloadFile: await file('zip'),
      active: true,
    });
    const trackIds = [];
    for (let position = 1; position <= 6; position++) {
      trackIds.push(
        await ctx.db.insert('tracks', {
          productId: litId,
          position,
          title: `Track ${position}`,
          durationSeconds: 120 + position,
          format: 'mp3',
          streamFile: await file(`track ${position}`),
        }),
      );
    }
    const ownerId = await ctx.db.insert('users', {
      clerkId: OWNER.subject,
      email: OWNER.email,
      name: OWNER.name,
      isAdmin: false,
    });
    const strangerId = await ctx.db.insert('users', {
      clerkId: STRANGER.subject,
      email: STRANGER.email,
      isAdmin: false,
    });
    await ctx.db.insert('entitlements', {
      userId: ownerId,
      productId: litId,
      stripeSessionId: 'cs_test_owner',
      grantedAt: Date.now(),
    });
    return { litId, trackIds, ownerId, strangerId };
  });
}
