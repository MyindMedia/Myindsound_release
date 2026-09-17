import { Raycaster, Vector2, type Object3D } from 'three';
import type { Deck } from './deck';
import type { PlayerScene } from './scene';
import { KEY_ORDER, type KeyId } from './state';

export type KeyCommand = KeyId | 'toggle' | 'insert' | 'repeat';

const PRESS_HOLD_MS = 140;
const LATCHED_DEPTH = 0.6;

const LABELS: Record<KeyId, string> = {
  pause: 'Pause',
  stop: 'Stop',
  prev: 'Previous track',
  next: 'Next track',
  play: 'Play',
  red: 'Eject',
};

const LATCHING: ReadonlySet<KeyId> = new Set(['pause', 'play']);

/** Pointer, keyboard and screen-reader input for the deck keys, plus their press animation. */
export class KeyController {
  private pressedUntil = new Map<KeyId, number>();
  private latches: Record<KeyId, boolean> = { pause: false, stop: false, prev: false, next: false, play: false, red: false };
  private buttons = new Map<KeyId, HTMLButtonElement>();
  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private inspecting = false;
  private readonly deck: Deck | null;
  private readonly scene: PlayerScene | null;
  private readonly onCommand: (command: KeyCommand) => void;

  constructor(options: {
    deck: Deck | null;
    scene: PlayerScene | null;
    canvas: HTMLCanvasElement | null;
    buttonsHost: HTMLElement;
    onCommand: (command: KeyCommand) => void;
  }) {
    this.deck = options.deck;
    this.scene = options.scene;
    this.onCommand = options.onCommand;
    this.buildButtons(options.buttonsHost);
    if (options.canvas && this.deck && this.scene) this.bindPointer(options.canvas);
    document.addEventListener('keydown', (event) => this.onKeyDown(event));
  }

  private buildButtons(host: HTMLElement): void {
    for (const id of KEY_ORDER) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `p3d-key p3d-key--${id}`;
      button.textContent = LABELS[id];
      if (LATCHING.has(id)) button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => this.trigger(id));
      host.appendChild(button);
      this.buttons.set(id, button);
    }
  }

  private hit(event: PointerEvent, canvas: HTMLCanvasElement): Object3D | null {
    const rect = canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.scene!.camera);
    const hits = this.raycaster.intersectObjects(this.deck!.hitTargets, false);
    return hits[0]?.object ?? null;
  }

  private bindPointer(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (event) => {
      if (this.inspecting) return;
      const keyId = this.hit(event, canvas)?.userData.keyId as KeyId | undefined;
      if (keyId) this.trigger(keyId);
    });
    let lastMove = 0;
    canvas.addEventListener('pointermove', (event) => {
      const now = performance.now();
      if (this.inspecting || now - lastMove < 60) return;
      lastMove = now;
      canvas.style.cursor = this.hit(event, canvas)?.userData.keyId ? 'pointer' : '';
    });
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, button, a, [contenteditable]')) return;
    const map: Record<string, KeyCommand> = {
      ' ': 'toggle',
      ArrowLeft: 'prev',
      ArrowRight: 'next',
      s: 'stop',
      S: 'stop',
      e: 'red',
      E: 'red',
      r: 'repeat',
      R: 'repeat',
    };
    const command = map[event.key];
    // While the cartridge is out, arrows belong to the inspector; only play/insert and repeat remain.
    if (!command || (this.inspecting && command !== 'toggle' && command !== 'repeat')) return;
    event.preventDefault();
    if (command === 'toggle' || command === 'repeat') this.onCommand(command);
    else this.trigger(command as KeyId);
  }

  /** Visual press + command. Used by pointer, keyboard and the hidden buttons. */
  trigger(id: KeyId): void {
    this.press(id);
    this.onCommand(id);
  }

  /** While the cartridge is in the eject inspector, canvas drags and arrow keys go to the inspector. */
  setInspecting(inspecting: boolean): void {
    this.inspecting = inspecting;
  }

  press(id: KeyId): void {
    this.pressedUntil.set(id, performance.now() + PRESS_HOLD_MS);
  }

  setLatches(latches: Record<KeyId, boolean>): void {
    this.latches = latches;
    for (const id of LATCHING) this.buttons.get(id)?.setAttribute('aria-pressed', String(latches[id]));
  }

  update(): void {
    if (!this.deck) return;
    const now = performance.now();
    for (const id of KEY_ORDER) {
      const pressed = (this.pressedUntil.get(id) ?? 0) > now;
      this.deck.setKeyTarget(id, pressed ? 1 : this.latches[id] ? LATCHED_DEPTH : 0);
    }
  }
}
