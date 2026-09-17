import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { fail } from './errors';

export async function getViewer(ctx: QueryCtx): Promise<Doc<'users'> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query('users')
    .withIndex('by_clerkId', (q) => q.eq('clerkId', identity.subject))
    .unique();
}

export async function requireViewer(ctx: QueryCtx): Promise<Doc<'users'>> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) fail('UNAUTHENTICATED', 'Sign in to continue.');
  const user = await getViewer(ctx);
  if (!user) fail('UNAUTHENTICATED', 'Your account is still being set up. Refresh and try again.');
  return user;
}

// Mutations may create the row on first contact, so a signed-in visitor
// never hits a missing-profile error.
export async function ensureViewer(ctx: MutationCtx): Promise<Doc<'users'>> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) fail('UNAUTHENTICATED', 'Sign in to continue.');
  const existing = await getViewer(ctx);
  const email = identity.email ?? existing?.email ?? '';
  const name = identity.name ?? existing?.name;
  if (existing) {
    if (existing.email !== email || existing.name !== name) {
      await ctx.db.patch(existing._id, { email, name });
    }
    return (await ctx.db.get(existing._id))!;
  }
  const id = await ctx.db.insert('users', {
    clerkId: identity.subject,
    email,
    name,
    isAdmin: false,
  });
  return (await ctx.db.get(id))!;
}

/** Admin = users.isAdmin, or the verified Clerk email listed in the ADMIN_EMAILS env var. */
export function isAdminUser(user: Doc<'users'>, identityEmail?: string): boolean {
  if (user.isAdmin) return true;
  const allowed = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const email = (identityEmail ?? '').toLowerCase();
  return email !== '' && allowed.includes(email);
}

export async function requireAdmin(ctx: QueryCtx): Promise<Doc<'users'>> {
  const user = await requireViewer(ctx);
  const identity = await ctx.auth.getUserIdentity();
  if (!isAdminUser(user, identity?.email)) fail('FORBIDDEN', 'Admins only.');
  return user;
}
