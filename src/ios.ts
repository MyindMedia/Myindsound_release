/**
 * The phone shell: the bar at the top and the tab bar at the bottom.
 *
 * On a phone these pages are an app, not a narrow website (`ios.css`): a translucent bar whose compact
 * title appears as the large title scrolls away, and a tab bar with the now-playing bar docked above it.
 * Both are built on every page that calls this and shown only at the phone breakpoint, so rotating or
 * resizing needs no rebuild. The player is left alone: it is a full-screen surface with its own chrome.
 */
import './ios.css';

const ICONS = {
  listen:
    '<path d="M12 3v11.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="9" cy="16.5" r="3.2" stroke="currentColor" stroke-width="1.7"/><path d="M12 5.5l5.5-1.7v3.4L12 8.9" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  store:
    '<path d="M5 8h14l-1 11.5a1.6 1.6 0 0 1-1.6 1.5H7.6A1.6 1.6 0 0 1 6 19.5L5 8Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  library:
    '<rect x="3.5" y="4.5" width="7" height="7" rx="1.6" stroke="currentColor" stroke-width="1.7"/><rect x="13.5" y="4.5" width="7" height="7" rx="1.6" stroke="currentColor" stroke-width="1.7"/><rect x="3.5" y="14.5" width="7" height="5.5" rx="1.6" stroke="currentColor" stroke-width="1.7"/><rect x="13.5" y="14.5" width="7" height="5.5" rx="1.6" stroke="currentColor" stroke-width="1.7"/>',
};

type Tab = { href: string; label: string; icon: keyof typeof ICONS; match: (path: string) => boolean };

const TABS: Tab[] = [
  { href: '/', label: 'LISTEN', icon: 'listen', match: (path) => path === '/' || path === '/index' },
  { href: '/physical', label: 'STORE', icon: 'store', match: (path) => path.startsWith('/physical') },
  { href: '/dashboard', label: 'LIBRARY', icon: 'library', match: (path) => path.startsWith('/dashboard') },
];

const svg = (icon: keyof typeof ICONS): string =>
  `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">${ICONS[icon]}</svg>`;

/** How far the page has to move before the large title hands over to the bar. */
const HANDOVER_PX = 26;

function buildNav(title: string): HTMLElement {
  const nav = document.createElement('div');
  nav.className = 'ios-nav';
  nav.innerHTML = `<span class="ios-nav__title">${title}</span><span class="ios-nav__slot"></span>`;

  // The cart and the account button live in the site nav, which the tab bar replaces: bring them up here.
  const slot = nav.querySelector('.ios-nav__slot')!;
  const carried = document.querySelector('.top-nav .nav-right') ?? document.getElementById('nav-user');
  if (carried) slot.appendChild(carried);
  return nav;
}

function buildTabBar(): HTMLElement {
  const bar = document.createElement('nav');
  bar.className = 'ios-tabbar';
  bar.setAttribute('aria-label', 'Sections');
  const path = window.location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  bar.innerHTML = TABS.map((tab) => {
    const active = tab.match(path);
    return `<a class="ios-tab${active ? ' ios-tab--active' : ''}" href="${tab.href}"${active ? ' aria-current="page"' : ''}>
      ${svg(tab.icon)}<span>${tab.label}</span>
    </a>`;
  }).join('');
  return bar;
}

export function mountIosShell(title: string): void {
  if (document.querySelector('.ios-tabbar')) return;
  document.body.classList.add('ios-app');
  document.body.appendChild(buildNav(title));
  document.body.appendChild(buildTabBar());

  // The compact title takes over as the large one goes under the bar.
  const onScroll = (): void => {
    document.body.classList.toggle('ios-scrolled', window.scrollY > HANDOVER_PX);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}
