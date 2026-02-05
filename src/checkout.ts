import { loadStripe } from '@stripe/stripe-js';

// Use Vite environment variable for the publishable key
const STRIPE_PUBLISHABLE_KEY = (import.meta as any).env.VITE_STRIPE_PUBLISHABLE_KEY || 'pk_test_your_key_here';

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

  public start(amount: number) {
    this.data.amount = amount;
    this.showUpsell();
    this.show();
  }

  private show() {
    if (this.modal) this.modal.style.display = 'flex';
  }

  public hide() {
    if (this.modal) this.modal.style.display = 'none';
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
      this.showIdentity();
    });

    document.getElementById('upsell-no')?.addEventListener('click', () => {
      this.data.withUpsell = false;
      this.showIdentity();
    });
  }

  private showIdentity() {
    if (!this.modalBody) return;

    this.modalBody.innerHTML = `
            <h2 class="modal-step-title">Where should we send your download?</h2>
            <div class="purchase-box" style="margin-top: 0;">
                <input type="email" id="customer-email" placeholder="Email Address" class="primary-input" style="width: 100%; margin-bottom: 1rem; background: #111; border: 1px solid var(--border-color); color: white; padding: 1rem; border-radius: 4px;" />
                <button id="continue-checkout" class="primary-btn">CONTINUE TO PAYMENT</button>
            </div>
        `;

    document.getElementById('continue-checkout')?.addEventListener('click', async () => {
      const email = (document.getElementById('customer-email') as HTMLInputElement).value;
      if (email) {
        // Trigger Lead Capture in GHL (Fire and forget, don't block checkout)
        fetch('/.netlify/functions/ghl-lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        }).catch(err => console.error('GHL Lead Capture failed:', err));

        this.initiateStripe();
      } else {
        alert('Please enter your email');
      }
    });
  }

  private async initiateStripe() {
    if (STRIPE_PUBLISHABLE_KEY === 'pk_test_your_key_here') {
      console.warn("Stripe Publishable Key is using the placeholder. Please set VITE_STRIPE_PUBLISHABLE_KEY.");
    }

    const stripe = await loadStripe(STRIPE_PUBLISHABLE_KEY);
    if (!stripe) {
      alert('Failed to load Stripe. Please check your internet connection or browser settings.');
      return;
    }

    const email = (document.getElementById('customer-email') as HTMLInputElement).value;
    // const total = this.data.amount + (this.data.withUpsell ? 9 : 0);



    try {
      const response = await fetch('/.netlify/functions/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: this.data.amount,
          withUpsell: this.data.withUpsell,
          email: email
        }),
      }).catch(err => {
        console.error('Checkout error:', err);
        throw new Error('Network error or endpoint not found. Ensure Netlify Functions are active.');
      });

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        console.error('Non-JSON response from server:', text);
        throw new Error('Server returned a non-JSON response. Please ensure Netlify Functions are running (use "netlify dev").');
      }

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Server responded with ${response.status}`);
      }

      const session = await response.json();

      if (session.error) {
        throw new Error(session.error);
      }

      // Use direct redirect as redirectToCheckout is deprecated
      if (session.url) {
        window.location.href = session.url;
      } else {
        throw new Error('No checkout URL received from server');
      }

    } catch (error: any) {
      console.error('Checkout Error:', error);
      alert(`Checkout Error: ${error.message || 'There was an error initiating checkout. Please try again.'}`);
    }

    this.hide();
  }
}
