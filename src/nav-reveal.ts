/**
 * The home page's nav is parked above the top of the screen so the deck has the whole window; all that
 * shows is a small pill with a downward arrow in it (`hud.css`, `.nav-peek`).
 *
 * Bring the pointer into the top strip, or tap the pill, and the bar drops into place with the pill riding
 * down under it and its arrow turning over. Five seconds after the last interaction up there it parks
 * itself again. It stays put while the pointer is over it or something in it has focus, and while the
 * package is still wrapped it never opens at all.
 */

/** How far down the top of the window counts as "the nav's area" while it is closed. */
const REVEAL_ZONE = 88;
/** The pointer has left the nav's area: it retracts almost at once, with just enough grace to cross a gap. */
const LEAVE_MS = 450;
/** Opened by a tap or the keyboard, where there is no pointer to leave: it goes on its own after this. */
const HIDE_AFTER_MS = 5000;

export function mountNavReveal(): void {
  const nav = document.querySelector<HTMLElement>('.main-nav');
  const peek = document.querySelector<HTMLButtonElement>('.nav-peek');
  if (!nav || !peek) return;

  let open = false;
  let timer = 0;

  /** While the packaging is on, the page is black and nothing else is on it. */
  const sealed = (): boolean => document.body.classList.contains('p3d-sealed');
  const hold = (): void => {
    window.clearTimeout(timer);
    timer = 0;
  };

  const close = (): void => {
    hold();
    if (!open) return;
    open = false;
    document.body.classList.remove('nav-open');
    peek.setAttribute('aria-expanded', 'false');
  };

  const countdown = (delay = HIDE_AFTER_MS): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(close, delay);
  };

  const show = (): void => {
    if (open || sealed()) return;
    open = true;
    // Measured, so the pill always lands just under the bar however tall it is.
    document.body.style.setProperty('--nav-peek-drop', `${nav.offsetHeight + 10}px`);
    document.body.classList.add('nav-open');
    peek.setAttribute('aria-expanded', 'true');
  };

  /** Open, the whole bar and the pill under it count as the area; closed, it's the top strip. */
  const area = (): number => (open ? nav.offsetHeight + peek.offsetHeight + 24 : REVEAL_ZONE);

  document.addEventListener(
    'pointermove',
    (event) => {
      if (event.pointerType === 'touch') return; // A finger uses the pill, not the strip.
      if (event.clientY <= area()) {
        show();
        hold();
      } else if (open && !timer) {
        // The pointer has moved off the nav: retract rather than sitting there for five seconds.
        countdown(LEAVE_MS);
      }
    },
    { passive: true },
  );

  // Off the window entirely (or into another tab): let it park itself.
  document.documentElement.addEventListener('pointerleave', () => open && countdown(LEAVE_MS));
  window.addEventListener('blur', () => open && countdown(LEAVE_MS));

  peek.addEventListener('click', () => {
    if (open) close();
    else {
      show();
      countdown(); // A tap has no hover to keep it up, so the clock starts straight away.
    }
  });

  // Keyboard: tabbing into the nav brings it down and keeps it there.
  nav.addEventListener('focusin', () => {
    show();
    hold();
  });
  nav.addEventListener('focusout', () => open && countdown());
  peek.addEventListener('focus', show);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) close();
  });
}
