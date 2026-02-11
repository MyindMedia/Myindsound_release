# Ralph Fix Plan - Myind Sound Releases

## High Priority
- [ ] Fix TypeScript compilation errors (run `npx tsc --noEmit` and resolve)
- [ ] Complete and polish post-purchase animation flow (index → stream.html docking)
- [ ] Ensure CD player calibration spin and playback work smoothly on stream.html
- [ ] Fix any broken audio streaming (signed URL fetching from get-stream-urls)

## Medium Priority
- [ ] Physical merchandise store polish (physical.html + cart functionality)
- [ ] Dashboard page - show user purchases and order history
- [ ] Admin panel - display play stats and user analytics
- [ ] Success page - download link validation and UI
- [ ] Mobile responsiveness across all pages

## Low Priority
- [ ] Performance optimization (lazy loading, code splitting)
- [ ] Add email confirmation via Resend/SendGrid (currently console.log simulation in webhook)
- [ ] Stream app (React) - sync with main site features
- [ ] Add proper error states and loading indicators throughout

## Completed
- [x] Project enabled for Ralph
- [x] PWYW checkout flow with Stripe (upsell → email → payment)
- [x] Stripe webhook provisioning (Clerk user creation + Supabase access grants)
- [x] CD player with 5-layer PNG stack and GSAP spinning
- [x] Sticker peel animation on album art
- [x] Post-purchase animation controller (lift-off → peel → disc reveal)
- [x] Stream player with calibration spin sequence
- [x] Docking animation (animate_dock state param)
- [x] Clerk auth integration (login, sign-up, nav user button)
- [x] Supabase client with purchase checking
- [x] Physical checkout function
- [x] GHL CRM lead sync
- [x] Unicorn Studio WebGL background

## Notes
- Current uncommitted work: disk-player.ts, main.ts, purchase-animation.ts, stream.ts, style.css
- LIT Product ID: f67a66b8-59a0-413f-b943-8fbb9cdee876 (hardcoded in multiple files)
- GSAP is a CDN window global, not npm - use `(window as any).gsap`
- Audio files are in Supabase Storage bucket "LIT", served via 2hr signed URLs
