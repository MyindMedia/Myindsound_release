/**
 * Home page: the MiniDisc arrives shrink-wrapped with the LIT poster on it, alone on black. Unwrap it
 * (double-click), load the disc, and listen: 30-second previews for everyone,
 * the full album for buyers (their account, or their checkout session for 24 hours after paying).
 * `npm run dev` + `?mock=1` skips sign-in and Convex and plays the previews only.
 */
import './style.css';
import './player3d/hud.css';
import './nav-auth';
import { initAnalytics, track } from './analytics';
import { mountNavReveal } from './nav-reveal';
import { CheckoutFlow } from './checkout';
import { getClerk, isClerkConfigured } from './clerk';
import { convexErrorCode, isConvexConfigured } from './convex';
import { LitStreamSource } from './player3d/lit-stream-source';
import { PlayerApp } from './player3d/player-app';
import { PreviewTrackSource } from './player3d/preview-track-source';
import { CheckoutSessionTrackSource, ConvexTrackSource } from './player3d/track-source';
import { purchaseSessionId, rememberPurchase } from './purchase-session';

const PRODUCT = 'lit';

async function signedIn(): Promise<boolean> {
  if (!isClerkConfigured() || !isConvexConfigured()) return false;
  try {
    return Boolean((await getClerk()).user);
  } catch {
    return false;
  }
}

/** Stripe returns buyers to `/?success=true&session_id=...`: remember the session, then tidy the URL. */
function readCheckoutReturn(): { paid: boolean } {
  const params = new URLSearchParams(window.location.search);
  const paid = params.get('success') === 'true';
  const sessionId = params.get('session_id');
  // Only a checkout we were actually returned from, never a pasted link.
  if (paid && sessionId) rememberPurchase(sessionId);
  if (paid || sessionId || params.has('cancel')) {
    window.history.replaceState({}, '', window.location.pathname);
  }
  return { paid };
}

async function start(): Promise<void> {
  // The checkout session is a 24-hour key to the full album: it comes out of the URL before anything
  // (analytics included) can see it.
  const { paid } = readCheckoutReturn();
  initAnalytics();
  if (paid) track('purchase_completed', { product_id: PRODUCT });
  // style.css hides overflow for the old one-screen layout; this page scrolls.
  document.documentElement.style.overflow = 'auto';
  document.body.style.overflow = 'auto';
  // The nav stays out of the deck's way until the pointer goes looking for it.
  mountNavReveal();
  const root = document.getElementById('player-root');
  if (!root) return;
  // Sealed from the first paint: black, with nothing on it until the packaging is off.
  root.classList.add('p3d', 'p3d--intro');
  document.body.classList.add('p3d-sealed');

  const checkout = new CheckoutFlow();
  const previews = new PreviewTrackSource();
  const mock = import.meta.env.DEV && new URLSearchParams(window.location.search).has('mock');
  const source = mock
    ? previews
    : new LitStreamSource({
        full: new ConvexTrackSource(PRODUCT),
        previews,
        signedIn,
        errorCode: convexErrorCode,
        purchase: () => {
          const sessionId = purchaseSessionId();
          return sessionId ? new CheckoutSessionTrackSource(sessionId, PRODUCT) : null;
        },
      });

  // The page opens on the shrink-wrapped cartridge (player3d/wrap.ts); unwrapping it brings the page up.
  const app = new PlayerApp(root, source, { wrapped: true, onGetLit: () => checkout.startPayWhatYouWant() });
  await app.mount();
  // Straight back from a purchase: open it for them. Loading the disc stays a tap, which is also what lets
  // the browser start the audio.
  if (paid) app.openPackage();
}

void start();
