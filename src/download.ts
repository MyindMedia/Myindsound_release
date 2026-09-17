/**
 * Saves a file from a Convex storage link under a real filename. Browsers ignore `download` on links to
 * another domain, so the file is fetched (the storage allows this site's origin) and saved from a blob.
 * Falls back to opening the link if the fetch fails.
 */
export async function saveFromUrl(url: string, filename: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}
