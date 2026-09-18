import { track, trackFormSubmit, trackButtonClick } from './analytics';
import { api, convexErrorMessage, getConvex } from './convex';

interface CheckoutData {
  amount: number;
  withUpsell: boolean;
}

export class CheckoutFlow {
  private modal: HTMLElement | null;
  private modalBody: HTMLElement | null;
  private data: CheckoutData;

  constructor() {
    this.modal = document.getElementById('checkout-modal');
    this.modalBody = document.getElementById('modal-body');
    this.data = { amount: 5, withUpsell: false };

    document.getElementById('close-modal')?.addEventListener('click', () => this.hide());
  }

  /** GET LIT: the pay-what-you-want amount, then the upsell and the email. */
  public startPayWhatYouWant(initial = 5) {
    if (!this.modalBody) return;
    this.data.amount = initial;
    track('checkout_opened', { amount: initial });
    this.show();
    this.modalBody.innerHTML = `
            <h2 class="modal-step-title">Pay what you want</h2>
            <p class="modal-step-note">The whole album, yours. Minimum $1.00.</p>
            <div class="purchase-box" style="margin-top: 0;">
                <div class="price-input-wrapper">
                    <span class="currency">$</span>
                    <input type="number" id="pwyw-amount" value="${initial.toFixed(2)}" min="1.00" step="1.00" />
                </div>
                <button id="pwyw-continue" class="primary-btn">CONTINUE</button>
            </div>
        `;
    const input = document.getElementById('pwyw-amount') as HTMLInputElement | null;
    const go = () => {
      const amount = Number.parseFloat(input?.value ?? '');
      if (!Number.isFinite(amount) || amount < 1) {
        input?.focus();
        return;
      }
      this.start(amount);
    };
    document.getElementById('pwyw-continue')?.addEventListener('click', go);
    input?.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') go();
    });
    input?.focus();
  }

  public start(amount: number) {
    this.data.amount = amount;
    track('checkout_started', { amount });
    this.showUpsell();
    this.show();
  }

  private show() {
    if (!this.modal) return;
    this.modal.classList.remove('is-closing');
    this.modal.style.display = 'flex';
  }

  /** Fades out before it goes, so the page doesn't snap back (`theme.css`, `.is-closing`). */
  public hide() {
    const modal = this.modal;
    if (!modal) return;
    modal.classList.add('is-closing');
    window.setTimeout(() => {
      // Reopened while it was fading: leave it alone.
      if (!modal.classList.contains('is-closing')) return;
      modal.style.display = 'none';
      modal.classList.remove('is-closing');
    }, 220);
  }

  private showUpsell() {
    if (!this.modalBody) return;

    this.modalBody.innerHTML = `
            <h2 class="modal-step-title">Wait, Before You Go!</h2>
            <div class="upsell-card">
                <img src="/assets/images/thesource-poster.png" class="upsell-img" alt="The Source" />
                <div class="upsell-info">
                    <h3>THE SOURCE (Exclusive Pre-save)</h3>
                    <p>Add to your order for just <span class="upsell-price">$9.00</span></p>
                </div>
            </div>
            <div class="modal-actions">
                <button id="upsell-yes" class="primary-btn">YES, ADD TO ORDER</button>
                <button id="upsell-no" class="secondary-btn">NO THANKS, JUST LIT</button>
            </div>
        `;

    document.getElementById('upsell-yes')?.addEventListener('click', () => {
      this.data.withUpsell = true;
      trackButtonClick('upsell-yes', { upsell_accepted: true, amount: this.data.amount });
      this.showIdentity();
    });

    document.getElementById('upsell-no')?.addEventListener('click', () => {
      this.data.withUpsell = false;
      trackButtonClick('upsell-no', { upsell_accepted: false, amount: this.data.amount });
      this.showIdentity();
    });
  }

  private showIdentity() {
    if (!this.modalBody) return;

    this.modalBody.innerHTML = `
            <h2 class="modal-step-title">Where should we send your download?</h2>
            <div class="purchase-box" style="margin-top: 0;">
                <input type="email" id="customer-email" placeholder="Email Address" class="primary-input" style="width: 100%; margin-bottom: 1rem; background: #111; border: 1px solid var(--border-color); color: white; padding: 1rem; border-radius: 4px;" />
                <label class="consent-row" style="display: flex; gap: 0.6rem; align-items: flex-start; margin-bottom: 1rem; font-size: 0.85rem; color: #bbb; text-align: left; cursor: pointer;">
                    <input type="checkbox" id="marketing-consent" style="margin-top: 0.2rem; accent-color: #FDB913;" />
                    <span>Send me new releases and drops from Myind Sound. Unsubscribe anytime.</span>
                </label>
                <button id="continue-checkout" class="primary-btn">CONTINUE TO PAYMENT</button>
            </div>
        `;

    document.getElementById('continue-checkout')?.addEventListener('click', async () => {
      const email = (document.getElementById('customer-email') as HTMLInputElement).value;
      if (email) {
        trackFormSubmit('checkout_email', {
          with_upsell: this.data.withUpsell,
          amount: this.data.amount,
        });
        // Lead capture only runs with an explicit opt-in (fire and forget, never blocks checkout).
        const marketingConsent = (document.getElementById('marketing-consent') as HTMLInputElement | null)?.checked ?? false;
        if (marketingConsent) {
          getConvex()
            .action(api.leads.capture, { email, marketingConsent })
            .catch((err) => console.error('Lead capture failed:', err));
        }

        this.initiateStripe();
      } else {
        alert('Please enter your email');
      }
    });
  }

  private async initiateStripe() {
    const email = (document.getElementById('customer-email') as HTMLInputElement).value;
    const marketingConsent = (document.getElementById('marketing-consent') as HTMLInputElement | null)?.checked ?? false;

    try {
      const { url } = await getConvex().action(api.payments.createDigitalSession, {
        amountCents: Math.round(this.data.amount * 100),
        withUpsell: this.data.withUpsell,
        email,
        marketingConsent,
      });
      track('checkout_redirected_to_stripe', {
        amount: this.data.amount,
        with_upsell: this.data.withUpsell,
      });
      window.location.href = url;
      return;
    } catch (error) {
      console.error('Checkout Error:', error);
      alert(`Checkout Error: ${convexErrorMessage(error, 'There was an error starting checkout. Please try again.')}`);
    }

    this.hide();
  }
}
