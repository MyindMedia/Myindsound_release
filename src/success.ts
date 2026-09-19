/**
 * Success page: confirms the Stripe checkout through Convex and shows download links
 * (valid for 24 hours after payment), then offers sign-in for streaming.
 */
import { api, convexErrorMessage, getConvex } from './convex';
import { saveFromUrl } from './download';
import { getClerk, isClerkConfigured } from './clerk';
import { claimAccountFromCheckout } from './purchase-signin';
import { markOpened } from './playback-handoff';
import { mountIosShell } from './ios';

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

async function startStreamReveal(destination: string) {
  try {
    const { SuccessAnimationController } = await import('./success-animation');
    new SuccessAnimationController(destination).start('/assets/images/lit-poster.png');
  } catch (err) {
    console.error('Animation module failed:', err);
    document.getElementById('reveal-overlay')?.classList.add('active');
    setTimeout(() => (window.location.href = destination), 1500);
  }
}

/**
 * The account was made from the checkout email and has no password yet, so this is where they choose one.
 * Without it the only way back in is a code to that address, which is a poor deal for something they bought.
 */
function passwordSetup(): HTMLFormElement {
  const form = document.createElement('form');
  form.className = 'finish-account';
  form.noValidate = true;

  const label = document.createElement('label');
  label.className = 'finish-account__label';
  label.setAttribute('for', 'new-password');
  label.textContent = 'Choose a password';

  const field = document.createElement('input');
  field.type = 'password';
  field.id = 'new-password';
  field.name = 'new-password';
  field.autocomplete = 'new-password';
  field.minLength = 8;
  field.required = true;
  field.placeholder = 'At least 8 characters';
  field.className = 'primary-input';

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'primary-btn';
  save.textContent = 'SAVE PASSWORD';

  const note = document.createElement('p');
  note.className = 'finish-account__note';
  note.textContent = 'Skip it and you can still get in with an emailed code, or set a password later from your dashboard.';

  form.append(label, field, save, note);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (field.value.length < 8) {
      note.textContent = 'Passwords need at least 8 characters.';
      return;
    }
    save.disabled = true;
    save.textContent = 'SAVING...';
    try {
      const clerk = await getClerk();
      await clerk.user?.updatePassword({ newPassword: field.value, signOutOfOtherSessions: false });
      const done = Object.assign(document.createElement('p'), {
        className: 'finish-account__note finish-account__note--done',
        textContent: 'Login created. Your email and this password will get you back in any time.',
      });
      form.replaceChildren(done);
      form.parentElement?.appendChild(linkButton('MY DASHBOARD', 'dashboard-btn', '/dashboard'));
    } catch (err) {
      const clerkError = err as { errors?: { longMessage?: string; message?: string }[] };
      note.textContent =
        clerkError.errors?.[0]?.longMessage ?? clerkError.errors?.[0]?.message ?? 'That password was refused. Try another.';
      save.disabled = false;
      save.textContent = 'SAVE PASSWORD';
    }
  });
  return form;
}

/**
 * Paying is signing up: the checkout email already made the account, so this hands it over signed in and
 * points at the dashboard. Only if that can't be done does it fall back to asking them to sign in.
 */
async function offerAccount(sessionId: string) {
  if (!isClerkConfigured()) return;
  try {
    const signedIn = (await claimAccountFromCheckout(sessionId)) || Boolean((await getClerk()).user);
    const prompt = document.getElementById('signup-prompt');
    const container = document.getElementById('clerk-signup-container');
    if (!prompt || !container) return;
    show('signup-prompt');

    if (signedIn) {
      const clerk = await getClerk();
      const heading = prompt.querySelector('h2');
      const copy = prompt.querySelector('.description');
      const needsPassword = clerk.user?.passwordEnabled === false;

      if (needsPassword) {
        // The session lasts a day; a password is what gets them back in after that, so it goes first,
        // above the album itself, and the field is ready to type into.
        prompt.parentElement?.insertBefore(prompt, document.getElementById('download-links-container'));
        prompt.classList.add('finish-first');
        if (heading) heading.textContent = 'CREATE YOUR LOGIN';
        if (copy) {
          copy.textContent =
            'Your account is made and you are signed in for 24 hours. Choose a password now and it is yours for good; without one you will need an emailed code every time you come back.';
        }
        container.replaceChildren(passwordSetup());
        (container.querySelector('#new-password') as HTMLInputElement | null)?.focus();
        return;
      }

      if (heading) heading.textContent = 'YOUR ACCOUNT IS READY';
      if (copy) copy.textContent = 'Everything you have bought is in your dashboard.';
      container.replaceChildren(linkButton('MY DASHBOARD', 'dashboard-btn', '/dashboard'));
      return;
    }

    // Couldn't be signed in automatically: the account still exists, so they sign in with the same email.
    const clerk = await getClerk();
    clerk.mountSignIn(container as HTMLDivElement, { afterSignInUrl: '/dashboard', signUpUrl: '/login.html#sign-up' });
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
    const streamButton = linkButton('PLAY THE ALBUM', 'stream-btn');
    streamButton.addEventListener('click', (event) => {
      event.preventDefault();
      void startStreamReveal(`/?success=true&session_id=${encodeURIComponent(sessionId)}`);
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
    // They have paid: PLAY THE ALBUM goes straight into the player, unwrapped and already unlocked.
    markOpened();
    void offerAccount(sessionId);
  } catch (err) {
    console.error('Session verification failed:', convexErrorMessage(err, 'unknown error'));
    hide('loading-state');
    show('error-state');
  }
}

document.addEventListener('DOMContentLoaded', () => void init());

mountIosShell('Thank you');
