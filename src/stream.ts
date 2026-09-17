/**
 * Stream page: the 3D MiniDisc deck (src/player3d).
 * Signed-in LIT owners stream through Convex; `npm run dev` + `?mock=1` runs the deck on a local demo clip.
 * A build with VITE_PLAYER_DEMO=1 (Netlify draft previews only, never set on the site) always runs the demo:
 * no sign-in, and only the public demo clip, so no paid audio is reachable.
 */
import './style.css';
import './player3d/hud.css';
import './nav-auth';
import { isClerkConfigured, requireAuth } from './clerk';
import { PlayerApp } from './player3d/player-app';
import { ConvexTrackSource, MockTrackSource } from './player3d/track-source';

async function start(): Promise<void> {
  const root = document.getElementById('player-root');
  if (!root) return;

  const demoBuild = import.meta.env.VITE_PLAYER_DEMO === '1';
  const mock = demoBuild || (import.meta.env.DEV && new URLSearchParams(window.location.search).has('mock'));
  if (!mock) {
    if (!isClerkConfigured()) {
      root.textContent = 'Sign-in is not configured.';
      return;
    }
    if (!(await requireAuth())) return;
  }

  await new PlayerApp(root, mock ? new MockTrackSource() : new ConvexTrackSource('lit')).mount();
}

void start();
