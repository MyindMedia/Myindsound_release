/**
 * The site is separate pages, so every link is a real page load and the screen would otherwise cut from
 * one to the next. `theme.css` fades each page up as it arrives; this fades the current one down before it
 * goes, so the two cross through black instead of snapping.
 *
 * Only plain left clicks on same-site links are held back, and only for the length of the fade. Anything
 * the browser should handle itself (new tab, download, another site, an anchor on this page) is left alone.
 */

const FADE_MS = 170;

function isPlainClick(event: MouseEvent): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function mountPageFade(): void {
  document.addEventListener('click', (event) => {
    if (!isPlainClick(event)) return;
    const link = (event.target as Element | null)?.closest?.('a');
    if (!(link instanceof HTMLAnchorElement)) return;
    if (link.target && link.target !== '_self') return;
    if (link.hasAttribute('download') || link.dataset.noFade === 'true') return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    // An anchor on the page this already is: nothing is loading, so nothing should fade.
    if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return;

    event.preventDefault();
    document.body.classList.add('page-leaving');
    window.setTimeout(() => {
      window.location.href = link.href;
    }, FADE_MS);
  });

  // Back from the cache: the page would otherwise still be wearing the fade it left on.
  window.addEventListener('pageshow', () => document.body.classList.remove('page-leaving'));
}

mountPageFade();
