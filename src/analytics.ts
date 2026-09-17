/**
 * PostHog Analytics Module
 * Handles: init, page views, button clicks, form submissions,
 * scroll depth (25/50/75/100%), user identification, feature flags / A/B tests
 */
import posthog from 'posthog-js';

const POSTHOG_KEY = (import.meta as any).env.VITE_POSTHOG_KEY || '';
const POSTHOG_HOST = (import.meta as any).env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com';

let initialized = false;

// ─── Init ────────────────────────────────────────────────────────────────────

export function initAnalytics(): void {
  if (!POSTHOG_KEY) {
    console.warn('[Analytics] VITE_POSTHOG_KEY not set — PostHog disabled');
    return;
  }
  if (initialized) return;

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    capture_pageview: true,          // auto page view on init
    capture_pageleave: true,         // track bounces
    autocapture: false,              // we handle clicks/forms manually for precision
    persistence: 'localStorage+cookie',
    loaded: (ph) => {
      console.log('[Analytics] PostHog ready — distinct_id:', ph.get_distinct_id());
    },
  });

  initialized = true;

  setupButtonTracking();
  setupFormTracking();
  setupScrollDepthTracking();
}

// ─── Page View ───────────────────────────────────────────────────────────────

export function trackPageView(pageName?: string): void {
  if (!initialized) return;
  posthog.capture('$pageview', {
    page: pageName || document.title,
    url: window.location.href,
    path: window.location.pathname,
  });
}

// ─── Button Click Tracking ───────────────────────────────────────────────────

function setupButtonTracking(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest('button, [role="button"], .primary-btn, .secondary-btn, .card-play-btn, .control-btn, .nav-link');
    if (!btn) return;

    const el = btn as HTMLElement;
    posthog.capture('button_clicked', {
      button_id: el.id || null,
      button_text: el.innerText?.trim().slice(0, 100) || null,
      button_class: el.className || null,
      page: window.location.pathname,
    });
  }, { capture: true });
}

// Explicit button tracking with context
export function trackButtonClick(buttonId: string, properties: Record<string, unknown> = {}): void {
  if (!initialized) return;
  posthog.capture('button_clicked', {
    button_id: buttonId,
    page: window.location.pathname,
    ...properties,
  });
}

// ─── Form Submission Tracking ─────────────────────────────────────────────────

function setupFormTracking(): void {
  document.addEventListener('submit', (e) => {
    const form = e.target as HTMLFormElement;
    posthog.capture('form_submitted', {
      form_id: form.id || null,
      form_action: form.action || null,
      form_name: form.name || null,
      page: window.location.pathname,
    });
  }, { capture: true });
}

// Explicit form submission event (for dynamic/non-native forms like the checkout modal)
export function trackFormSubmit(formName: string, properties: Record<string, unknown> = {}): void {
  if (!initialized) return;
  posthog.capture('form_submitted', {
    form_name: formName,
    page: window.location.pathname,
    ...properties,
  });
}

// ─── Scroll Depth ─────────────────────────────────────────────────────────────

const SCROLL_DEPTHS = [25, 50, 75, 100];
const firedDepths = new Set<number>();

function setupScrollDepthTracking(): void {
  const onScroll = () => {
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const docHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    if (docHeight <= 0) return;

    const pct = Math.round((scrollTop / docHeight) * 100);

    for (const depth of SCROLL_DEPTHS) {
      if (pct >= depth && !firedDepths.has(depth)) {
        firedDepths.add(depth);
        posthog.capture('scroll_depth', {
          depth_percent: depth,
          page: window.location.pathname,
          page_title: document.title,
        });
      }
    }

    // Unregister after all depths fired
    if (firedDepths.size === SCROLL_DEPTHS.length) {
      window.removeEventListener('scroll', onScroll, { capture: true });
    }
  };

  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
}

// ─── Custom Event ─────────────────────────────────────────────────────────────

export function track(event: string, properties: Record<string, unknown> = {}): void {
  if (!initialized) return;
  posthog.capture(event, { page: window.location.pathname, ...properties });
}

// ─── User Identity ────────────────────────────────────────────────────────────

export function identifyUser(userId: string, properties: { email?: string; name?: string; [key: string]: unknown } = {}): void {
  if (!initialized) return;
  posthog.identify(userId, properties);
}

export function resetUser(): void {
  if (!initialized) return;
  posthog.reset();
}

// ─── Feature Flags / A/B Tests ────────────────────────────────────────────────

/**
 * Get a feature flag value. Returns string variant, boolean, or null.
 * Usage: const variant = getFeatureFlag('homepage-cta')  // 'control' | 'variant-a' | true | false
 */
export function getFeatureFlag(flagKey: string): string | boolean | undefined {
  if (!initialized) return undefined;
  return posthog.getFeatureFlag(flagKey) as string | boolean | undefined;
}

/**
 * Apply A/B test variants to DOM elements.
 * Reads data-posthog-flag and data-posthog-variant attributes.
 * Elements with matching variant are shown; others are hidden.
 *
 * HTML usage:
 *   <div data-posthog-flag="homepage-cta" data-posthog-variant="control">Original CTA</div>
 *   <div data-posthog-flag="homepage-cta" data-posthog-variant="variant-a">New CTA</div>
 */
export function applyFeatureFlagVariants(): void {
  if (!initialized) return;

  posthog.onFeatureFlags(() => {
    const elements = document.querySelectorAll<HTMLElement>('[data-posthog-flag]');
    elements.forEach((el) => {
      const flagKey = el.dataset.posthogFlag!;
      const targetVariant = el.dataset.posthogVariant;
      const activeVariant = posthog.getFeatureFlag(flagKey);

      // Show element if variant matches, hide otherwise
      const isMatch = String(activeVariant) === String(targetVariant);
      el.style.display = isMatch ? '' : 'none';
    });
  });
}

/**
 * Run a callback only when a feature flag matches a specific variant.
 * Usage: onFeatureFlagVariant('price-test', 'higher-price', () => setPriceDisplay('$9'))
 */
export function onFeatureFlagVariant(flagKey: string, variant: string, callback: () => void): void {
  if (!initialized) return;

  posthog.onFeatureFlags(() => {
    if (posthog.getFeatureFlag(flagKey) === variant) {
      callback();
    }
  });
}

/**
 * Check if a boolean feature flag is enabled.
 */
export function isFeatureEnabled(flagKey: string): boolean {
  if (!initialized) return false;
  return posthog.isFeatureEnabled(flagKey) ?? false;
}

export { posthog };
