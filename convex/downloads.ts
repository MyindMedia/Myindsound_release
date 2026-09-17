import { v } from 'convex/values';
import { internal } from './_generated/api';
import { action } from './_generated/server';
import { fail } from './lib/errors';
import { fileUrl } from './lib/storage';

export const mine = action({
  args: { product: v.string() },
  handler: async (ctx, { product }): Promise<{ url: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) fail('UNAUTHENTICATED', 'Sign in to download.');
    const access = await ctx.runQuery(internal.entitlements.check, { clerkId: identity.subject, slug: product });
    if (!access) fail('NOT_ENTITLED', 'No license found for this release.');
    if (!access.downloadFile) fail('NOT_FOUND', 'No download is available for this release yet.');
    return { url: await fileUrl(ctx, access.downloadFile) };
  },
});
