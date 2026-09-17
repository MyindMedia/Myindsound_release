const GHL_API = 'https://services.leadconnectorhq.com';

export function ghlConfigured(): boolean {
  return Boolean(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID);
}

function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
  };
}

export async function upsertGhlContact(args: { email: string; tags: string[]; source: string }): Promise<void> {
  const response = await fetch(`${GHL_API}/contacts/upsert`, {
    method: 'POST',
    headers: ghlHeaders(),
    body: JSON.stringify({
      email: args.email,
      locationId: process.env.GHL_LOCATION_ID,
      tags: args.tags,
      source: args.source,
    }),
  });
  if (!response.ok) throw new Error(`GHL upsert failed (${response.status})`);
}

export async function deleteGhlContactByEmail(email: string): Promise<boolean> {
  const params = new URLSearchParams({ locationId: process.env.GHL_LOCATION_ID ?? '', email });
  const lookup = await fetch(`${GHL_API}/contacts/search/duplicate?${params}`, { headers: ghlHeaders() });
  if (!lookup.ok) return false;
  const body = (await lookup.json()) as { contact?: { id?: string } | null };
  const contactId = body.contact?.id;
  if (!contactId) return true;
  const removal = await fetch(`${GHL_API}/contacts/${encodeURIComponent(contactId)}`, {
    method: 'DELETE',
    headers: ghlHeaders(),
  });
  return removal.ok;
}
