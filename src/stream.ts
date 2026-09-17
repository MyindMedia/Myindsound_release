/**
 * Stream page: the 3D MiniDisc deck (src/player3d), open to everyone.
 * Signed-in LIT owners hear the full songs from Convex storage; everyone else hears 30-second previews.
 * `npm run dev` + `?mock=1` skips sign-in and Convex and plays the previews only.
 */
import './style.css';
import './player3d/hud.css';
import './nav-auth';
import { getClerk, isClerkConfigured } from './clerk';
import { convexErrorCode, isConvexConfigured } from './convex';
import { PlayerApp } from './player3d/player-app';
import { LitStreamSource } from './player3d/lit-stream-source';
import { PreviewTrackSource } from './player3d/preview-track-source';
import { ConvexTrackSource } from './player3d/track-source';

async function signedIn(): Promise<boolean> {
  if (!isClerkConfigured() || !isConvexConfigured()) return false;
  try {
    return Boolean((await getClerk()).user);
  } catch {
    return false;
  }
}

async function start(): Promise<void> {
  const root = document.getElementById('player-root');
  if (!root) return;

  const previews = new PreviewTrackSource();
  const mock = import.meta.env.DEV && new URLSearchParams(window.location.search).has('mock');
  const source = mock
    ? previews
    : new LitStreamSource({ full: new ConvexTrackSource('lit'), previews, signedIn, errorCode: convexErrorCode });
  await new PlayerApp(root, source).mount();
}

void start();
