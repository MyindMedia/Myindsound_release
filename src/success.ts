/**
 * Success page: confirms the Stripe checkout through Convex and shows download links
 * (valid for 24 hours after payment), then offers sign-in for streaming.
 */
import { api, convexErrorMessage, getConvex } from './convex';
import { saveFromUrl } from './download';
import { getClerk, isClerkConfigured } from './clerk';

function show(id: string, display = 'block') {
  const element = document.getElementById(id);
  if (element) element.style.display = display;
}

function hide(id: string) {
  const element = document.getElementById(id);
  if (element) element.style.display = 'none';
}

function linkButton(label: string, className: string, href = '#'): HTMLAnchorElement {
  const button = document.createElement('a');
  button.href = href;
  button.className = `primary-btn ${className}`;
  button.style.textDecoration = 'none';
  button.textContent = label;
  return button;
}

async function startStreamReveal() {
  try {
    const { SuccessAnimationController } = await import('./success-animation');
    new SuccessAnimationController().start('/assets/images/lit-poster.png');
  } catch (err) {
    console.error('Animation module failed:', err);
    document.getElementById('reveal-overlay')?.classList.add('active');
    setTimeout(() => (window.location.href = '/stream.html?state=reveal_ui'), 1500);
  }
}

async function offerSignIn() {
  if (!isClerkConfigured()) return;
  try {
    const clerk = await getClerk();
    if (clerk.user) return;
    const container = document.getElementById('clerk-signup-container');
    if (!container) return;
    show('signup-prompt');
    // The checkout already created the account, so buyers sign in with their checkout email.
    clerk.mountSignIn(container as HTMLDivElement, { afterSignInUrl: '/stream.html', signUpUrl: '/login.html#sign-up' });
  } catch (err) {
    console.error('Clerk load error:', err);
  }
}

async function init() {
  const sessionId = new URLSearchParams(window.location.search).get('session_id');
  if (!sessionId) {
    hide('loading-state');
    show('error-state');
    return;
  }

  try {
    const data = await getConvex().action(api.payments.downloadsForCheckoutSession, { sessionId });
    if (data.downloads.length === 0) throw new Error('No downloads found for this session');

    const nameSpan = document.getElementById('customer-name');
    if (nameSpan) nameSpan.textContent = data.firstName ? data.firstName.toUpperCase() : '';

    const container = document.getElementById('download-links-container');
    const streamButton = linkButton('STREAM NOW', 'stream-btn');
    streamButton.addEventListener('click', (event) => {
      event.preventDefault();
      void startStreamReveal();
    });
    container?.appendChild(streamButton);

    for (const download of data.downloads) {
      const button = linkButton(`DOWNLOAD "${download.name}"`, 'download-btn', download.url);
      if (download.type === 'standard') {
        // Storage links carry no filename; save it as a proper zip.
        button.addEventListener('click', (event) => {
          event.preventDefault();
          void saveFromUrl(download.url, `${download.name}.zip`);
        });
      } else {
        button.target = '_blank';
        button.rel = 'noopener';
      }
      container?.appendChild(button);
    }

    hide('loading-state');
    show('success-content');
    void offerSignIn();
  } catch (err) {
    console.error('Session verification failed:', convexErrorMessage(err, 'unknown error'));
    hide('loading-state');
    show('error-state');
  }
}

document.addEventListener('DOMContentLoaded', () => void init());
