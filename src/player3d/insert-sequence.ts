import type { Vector3 } from 'three';
import type { Deck } from './deck';
import type { CartridgeInspector } from './inspect';
import type { PlayerScene } from './scene';

// GSAP is loaded from the CDN on stream.html (window.gsap).
type Tween = Record<string, unknown>;
interface Timeline {
  set(target: object, vars: Tween, position?: number): Timeline;
  to(target: object, vars: Tween, position?: number): Timeline;
  call(callback: () => void, params: unknown[] | null, position: number): Timeline;
  kill(): void;
}
interface Gsap {
  timeline(vars?: Tween): Timeline;
}

function getGsap(): Gsap | null {
  return ((window as unknown as { gsap?: Gsap }).gsap ?? null) as Gsap | null;
}

export interface InsertHooks {
  onInserted(): void;
  onReady(): void;
}

export const PLAY_RPM = 300;

/**
 * Cartridge flies from wherever it floats in the inspector → slot → seat → spin-up (about 2.6 s).
 * Reduced motion (or no GSAP) seats the cartridge immediately.
 */
export function runInsertSequence(deck: Deck, scene: PlayerScene, hooks: InsertHooks): { cancel(): void } {
  const gsap = getGsap();
  const seated = deck.cartridge.userData.seated as Vector3;

  if (scene.reducedMotion || !gsap) {
    deck.seatCartridge();
    deck.setSpindleEngaged(true, true);
    deck.forceDiscRpm(PLAY_RPM);
    hooks.onInserted();
    hooks.onReady();
    return { cancel() {} };
  }

  const cart = deck.cartridge;
  // Clear the top face before moving into depth, so the cartridge never cuts through the front.
  const hoverY = deck.bodyTop + deck.cartridgeHeight / 2 + 0.03;
  const camera = { dolly: scene.getDolly(), look: scene.getLookOffset() };
  const spin = { rpm: 0 };
  const applyCamera = () => {
    scene.setDolly(camera.dolly);
    scene.setLookOffset(camera.look);
  };

  deck.forceDiscRpm(0);
  cart.visible = true;

  const tl = gsap.timeline();
  tl.to(camera, { dolly: 1.3, look: 0.45, duration: 0.9, ease: 'sine.inOut', onUpdate: applyCamera }, 0)
    .to(cart.position, { x: seated.x, duration: 1.0, ease: 'power2.out' }, 0)
    .to(cart.position, { y: hoverY, duration: 0.75, ease: 'power2.out' }, 0)
    .to(cart.position, { z: seated.z, duration: 1.0, ease: 'power2.in' }, 0)
    .to(cart.rotation, { x: 0, y: 0, z: 0, duration: 1.0, ease: 'power3.out' }, 0)
    .to(deck.doorPivot.rotation, { x: -1.35, duration: 0.25, ease: 'power2.out' }, 0.9)
    .to(cart.position, { y: seated.y - 0.014, duration: 0.6, ease: 'power2.in' }, 1.15)
    .to(cart.position, { y: seated.y, duration: 0.2, ease: 'back.out(3)' }, 1.75)
    .to(deck.glare, { opacity: 0.55, duration: 0.08 }, 1.75)
    .to(deck.glare, { opacity: 0.14, duration: 0.45 }, 1.83)
    .to(deck.doorPivot.rotation, { x: 0, duration: 0.22, ease: 'power2.in' }, 1.8)
    .to(camera, { dolly: 1, look: 0, duration: 1.1, ease: 'sine.inOut', onUpdate: applyCamera }, 1.25)
    // Seated: the spindle rises into the hub before the motor spins it up.
    .call(() => deck.setSpindleEngaged(true), null, 1.8)
    .call(() => hooks.onInserted(), null, 1.8)
    .to(spin, { rpm: PLAY_RPM, duration: 0.8, ease: 'power2.in', onUpdate: () => deck.forceDiscRpm(spin.rpm) }, 1.8)
    .call(() => hooks.onReady(), null, 2.6);

  return { cancel: () => tl.kill() };
}

/**
 * Page open: the cartridge drifts in from the lower right and settles into the inspector, floating
 * in front of the empty deck (about 1.6 s, after the boot overlay starts fading).
 */
export function runFloatInSequence(deck: Deck, scene: PlayerScene, inspector: CartridgeInspector): { cancel(): void } {
  const gsap = getGsap();
  const cart = deck.cartridge;
  cart.visible = true;
  inspector.takeCartridge();
  inspector.setPresent(true);

  if (scene.reducedMotion || !gsap) {
    cart.position.set(0, 0, 0);
    cart.rotation.set(0, 0, 0);
    return { cancel() {} };
  }

  // Inspector space: +x right, -y down, -z further from the camera.
  cart.position.set(0.9, -0.55, -1.2);
  cart.rotation.set(0.5, -1.4, 0.25);
  const tl = gsap.timeline({ delay: 0.35 });
  tl.to(cart.position, { x: 0, y: 0, z: 0, duration: 1.4, ease: 'power3.out' }, 0).to(
    cart.rotation,
    { x: 0, y: 0, z: 0, duration: 1.6, ease: 'power3.out' },
    0,
  );
  return { cancel: () => tl.kill() };
}

export interface EjectHooks {
  onEjected(): void;
}

/** How long the disc takes to wind down after the red key, before the cartridge is released. */
export const EJECT_SPIN_DOWN_SECONDS = 3;

/**
 * Spin-down (about 3 s) → door opens → spring pops the cartridge up out of the slot → it flies forward
 * into the inspector with one full turn (about 4.7 s in all). Reduced motion (or no GSAP) presents it
 * immediately.
 */
export function runEjectSequence(
  deck: Deck,
  scene: PlayerScene,
  inspector: CartridgeInspector,
  hooks: EjectHooks,
): { cancel(): void } {
  const gsap = getGsap();
  const cart = deck.cartridge;
  const seated = cart.userData.seated as Vector3;

  if (scene.reducedMotion || !gsap) {
    deck.forceDiscRpm(0);
    deck.setSpindleEngaged(false, true);
    deck.seatCartridge();
    inspector.takeCartridge();
    cart.position.set(0, 0, 0);
    cart.rotation.set(0, 0, 0);
    inspector.setPresent(true);
    hooks.onEjected();
    return { cancel() {} };
  }

  const hoverY = deck.bodyTop + deck.cartridgeHeight / 2 + 0.03;
  const spin = { rpm: deck.getDiscRpm() };
  // The mechanism waits for the disc to wind down, then releases it.
  const release = EJECT_SPIN_DOWN_SECONDS - 0.2;
  const tl = gsap.timeline();
  tl.to(
    spin,
    { rpm: 0, duration: EJECT_SPIN_DOWN_SECONDS, ease: 'power1.out', onUpdate: () => deck.forceDiscRpm(spin.rpm) },
    0,
  )
    // Once stopped, the spindle drops clear of the hub, then the door opens.
    .call(() => deck.setSpindleEngaged(false), null, release - 0.25)
    .to(deck.doorPivot.rotation, { x: -1.35, duration: 0.22, ease: 'power2.out' }, release)
    // Push-to-release catch, then the spring throws it clear of the slot.
    .to(cart.position, { y: seated.y - 0.012, duration: 0.1, ease: 'power2.in' }, release + 0.15)
    .to(deck.glare, { opacity: 0.5, duration: 0.08 }, release + 0.25)
    .to(deck.glare, { opacity: 0.14, duration: 0.4 }, release + 0.33)
    .to(cart.position, { y: hoverY, duration: 0.45, ease: 'power3.out' }, release + 0.25)
    .to(deck.doorPivot.rotation, { x: 0, duration: 0.22, ease: 'power2.in' }, release + 0.75)
    // Same start time, inserted after the handoff: tweens read their start values once the
    // cartridge is in the inspector's space.
    .call(
      () => {
        inspector.takeCartridge();
        inspector.setPresent(true);
      },
      null,
      release + 0.7,
    )
    .to(cart.position, { x: 0, y: 0, z: 0, duration: 1.0, ease: 'power3.inOut' }, release + 0.7)
    .to(
      cart.rotation,
      { x: 0, y: Math.PI * 2, z: 0, duration: 1.1, ease: 'power2.inOut', onComplete: () => cart.rotation.set(0, 0, 0) },
      release + 0.7,
    )
    .call(() => hooks.onEjected(), null, release + 1.85);

  return { cancel: () => tl.kill() };
}
