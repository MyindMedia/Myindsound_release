import type { Id } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';
import { fail } from './errors';

/**
 * The full songs and album download live in Convex file storage. Their URLs are long random links; the
 * functions that return them check the purchase first, so only buyers ever receive one.
 */

/** How long the player treats a set of links as fresh before asking again. */
export const LINK_REFRESH_MS = 6 * 60 * 60 * 1000;

export async function fileUrl(ctx: Pick<ActionCtx, 'storage'>, id: Id<'_storage'> | undefined): Promise<string> {
  const url = id ? await ctx.storage.getUrl(id) : null;
  if (!url) fail('NOT_CONFIGURED', 'The audio has not been uploaded yet.');
  return url;
}
