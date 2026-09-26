import type { BridgeEvent, BridgeEventMap, Unsubscribe } from './types';
import { assertEvent } from './validate';

type Handler<E extends BridgeEvent> = (payload: BridgeEventMap[E]) => void;

/** A deep-frozen copy: every handler of one emit shares it, and none can change what the next one sees. */
export function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (node: unknown) => {
    if (typeof node !== 'object' || node === null || Object.isFrozen(node)) return;
    Object.freeze(node);
    for (const child of Object.values(node)) freeze(child);
  };
  freeze(copy);
  return copy;
}

/**
 * The event side of every bridge (client, web adapter, mock). Unknown events throw on subscribe; a handler that
 * throws (including by writing to the frozen payload) is reported and never stops the others.
 */
export class BridgeEmitter {
  private readonly handlers = new Map<BridgeEvent, Set<Handler<BridgeEvent>>>();
  private readonly onHandlerError: (event: BridgeEvent, err: unknown) => void;

  constructor(onHandlerError?: (event: BridgeEvent, err: unknown) => void) {
    this.onHandlerError = onHandlerError ?? ((event, err) => console.error(`Bridge "${event}" handler failed:`, err));
  }

  on<E extends BridgeEvent>(event: E, handler: Handler<E>): Unsubscribe {
    assertEvent(event);
    if (typeof handler !== 'function') throw new TypeError('Bridge handler must be a function');
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    // Wrapped so subscribing the same function twice gives two independent subscriptions.
    const entry: Handler<BridgeEvent> = (payload) => (handler as Handler<BridgeEvent>)(payload);
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  emit<E extends BridgeEvent>(event: E, payload: BridgeEventMap[E]): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    const shared = frozenCopy(payload);
    for (const handler of [...set]) {
      try {
        handler(shared);
      } catch (err) {
        this.onHandlerError(event, err);
      }
    }
  }

  listenerCount(event: BridgeEvent): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  clear(): void {
    this.handlers.clear();
  }
}
