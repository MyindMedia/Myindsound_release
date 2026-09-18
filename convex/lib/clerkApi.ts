import { fail } from './errors';

const CLERK_API = 'https://api.clerk.com/v1';

function clerkHeaders() {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) fail('NOT_CONFIGURED', 'Accounts are not connected yet.');
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

type ClerkUser = { id: string };

// Buyers get a passwordless Clerk account keyed by the checkout email,
// matching what the Netlify webhook did before.
export async function findOrCreateClerkUser(email: string, fullName?: string): Promise<string> {
  const headers = clerkHeaders();
  const search = await fetch(`${CLERK_API}/users?email_address=${encodeURIComponent(email)}`, { headers });
  if (!search.ok) throw new Error(`Clerk user lookup failed (${search.status})`);
  const found = (await search.json()) as ClerkUser[];
  if (found.length > 0) return found[0].id;

  const [firstName, ...rest] = (fullName ?? '').trim().split(/\s+/);
  const create = await fetch(`${CLERK_API}/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email_address: [email],
      first_name: firstName || undefined,
      last_name: rest.join(' ') || undefined,
      skip_password_requirement: true,
    }),
  });
  if (!create.ok) throw new Error(`Clerk user creation failed (${create.status})`);
  return ((await create.json()) as ClerkUser).id;
}

/**
 * A one-shot ticket that signs a buyer straight into their new account (Clerk's sign-in tokens). The site
 * hands it to `signIn.create({ strategy: 'ticket' })`, so paying and typing an email is all it takes to
 * reach the dashboard. Short-lived by design: it is minted only for a checkout that Stripe says is paid.
 */
export async function createSignInTicket(clerkId: string, expiresInSeconds = 600): Promise<string> {
  const response = await fetch(`${CLERK_API}/sign_in_tokens`, {
    method: 'POST',
    headers: clerkHeaders(),
    body: JSON.stringify({ user_id: clerkId, expires_in_seconds: expiresInSeconds }),
  });
  if (!response.ok) throw new Error(`Clerk sign-in token failed (${response.status})`);
  const { token } = (await response.json()) as { token?: string };
  if (!token) throw new Error('Clerk sign-in token came back empty');
  return token;
}

export async function deleteClerkUser(clerkId: string): Promise<boolean> {
  const response = await fetch(`${CLERK_API}/users/${encodeURIComponent(clerkId)}`, {
    method: 'DELETE',
    headers: clerkHeaders(),
  });
  return response.ok || response.status === 404;
}
