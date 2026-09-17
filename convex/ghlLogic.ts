// Pure tag rules for Go High Level. Marketing tags require recorded consent.

export function purchaseTags(args: { slugs: string[]; physical: boolean; consent: boolean }): string[] {
  const tags: string[] = [];
  if (args.slugs.includes('lit')) tags.push('LIT-Purchased');
  if (args.slugs.includes('the-source')) tags.push('Source-Purchased');
  if (args.physical) tags.push('Merch-Purchased');
  if (args.consent) tags.push('Marketing-OptIn');
  return tags;
}

export function leadTags(consent: boolean): string[] {
  return consent ? ['LIT-Lead', 'Marketing-OptIn'] : [];
}

export const GHL_RETRY_DELAYS_MS = [30_000, 120_000, 600_000];
