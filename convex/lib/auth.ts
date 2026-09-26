import { internal } from '../_generated/api';
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
  let user: Doc<'users'>;
  if (existing) {
    if (existing.email !== email || existing.name !== name) {
      await ctx.db.patch(existing._id, { email, name });
    }
    user = (await ctx.db.get(existing._id))!;
  } else {
    const id = await ctx.db.insert('users', {
      clerkId: identity.subject,
      email,
      name,
      isAdmin: false,
    });
    user = (await ctx.db.get(id))!;
  }
  // ENT-2 (AUTH-2): admin grants held for this email are claimed, but only with a verified Clerk email.
  if (identity.emailVerified === true && email) await claimPendingGrants(ctx, user, email);
  return user;
}

/** SHA-256 hex of the trimmed, lowercased email: how `pendingGrants` holds an address without storing it. */
export async function emailHash(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** One indexed read per sign in; the claim itself runs only when something is waiting (adminActions.ts). */
async function claimPendingGrants(ctx: MutationCtx, user: Doc<'users'>, email: string): Promise<void> {
  const hash = await emailHash(email);
  const waiting = await ctx.db
    .query('pendingGrants')
    .withIndex('by_email_status', (q) => q.eq('emailHash', hash).eq('status', 'pending'))
    .first();
  if (waiting) await ctx.runMutation(internal.adminActions.claimPendingGrants, { userId: user._id, emailHash: hash });
}

/** Admin = users.isAdmin, or the verified Clerk email listed in the ADMIN_EMAILS env var. */
export function isAdminUser(user: Doc<'users'>, identityEmail?: string): boolean {
  if (user.isAdmin) return true;
  return isAdminEmail(identityEmail);
}

/** Whether an email is in ADMIN_EMAILS (case-insensitive). */
export function isAdminEmail(email?: string | null): boolean {
  const allowed = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const normalised = (email ?? '').trim().toLowerCase();
  return normalised !== '' && allowed.includes(normalised);
}

export async function requireAdmin(ctx: QueryCtx): Promise<Doc<'users'>> {
  const user = await requireViewer(ctx);
  const identity = await ctx.auth.getUserIdentity();
  if (!isAdminUser(user, identity?.email)) fail('FORBIDDEN', 'Admins only.');
  return user;
}
