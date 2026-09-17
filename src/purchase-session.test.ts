import { describe, expect, test } from 'vitest';
import { forgetPurchase, purchaseSessionId, PURCHASE_WINDOW_MS, rememberPurchase } from './purchase-session';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
}

const SESSION = 'cs_test_a1B2c3';

describe('purchase session (24-hour unlock after paying)', () => {
  test('remembers the checkout session and gives it back until the window closes', () => {
    const store = memoryStorage();
    rememberPurchase(SESSION, 1_000, store);
    expect(purchaseSessionId(1_000, store)).toBe(SESSION);
    expect(purchaseSessionId(1_000 + PURCHASE_WINDOW_MS - 1, store)).toBe(SESSION);
    expect(purchaseSessionId(1_000 + PURCHASE_WINDOW_MS, store)).toBeNull();
  });

  test('an expired session is cleared, and rubbish is ignored', () => {
    const store = memoryStorage();
    rememberPurchase(SESSION, 0, store);
    expect(purchaseSessionId(PURCHASE_WINDOW_MS + 1, store)).toBeNull();
    expect(store.length).toBe(0);

    store.setItem('myind:purchase', 'not json');
    expect(purchaseSessionId(1, store)).toBeNull();
    rememberPurchase('pi_not_a_checkout', 1, store);
    expect(purchaseSessionId(1, store)).toBeNull();
  });

  test('forgetting drops it', () => {
    const store = memoryStorage();
    rememberPurchase(SESSION, 1, store);
    forgetPurchase(store);
    expect(purchaseSessionId(1, store)).toBeNull();
  });

  test('a storage that throws (private mode) never breaks the page', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(() => rememberPurchase(SESSION, 1, broken)).not.toThrow();
    expect(purchaseSessionId(1, broken)).toBeNull();
  });
});
