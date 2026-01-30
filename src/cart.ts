/**
 * Shopping Cart Module
 * Manages cart state with localStorage persistence
 */

export interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
  variant?: string;
  image: string;
}

const CART_KEY = 'myind_cart';

class Cart {
  private items: CartItem[] = [];
  private listeners: Set<(items: CartItem[]) => void> = new Set();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const saved = localStorage.getItem(CART_KEY);
      if (saved) {
        this.items = JSON.parse(saved);
      }
    } catch (e) {
      console.error('Failed to load cart:', e);
      this.items = [];
    }
  }

  private save(): void {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(this.items));
      this.notifyListeners();
    } catch (e) {
      console.error('Failed to save cart:', e);
    }
  }

  private notifyListeners(): void {
    this.listeners.forEach(callback => callback(this.items));
  }

  /**
   * Subscribe to cart changes
   */
  subscribe(callback: (items: CartItem[]) => void): () => void {
    this.listeners.add(callback);
    // Immediately call with current state
    callback(this.items);
    // Return unsubscribe function
    return () => this.listeners.delete(callback);
  }

  /**
   * Get all items in cart
   */
  getItems(): CartItem[] {
    return [...this.items];
  }

  /**
   * Get total item count
   */
  getItemCount(): number {
    return this.items.reduce((total, item) => total + item.quantity, 0);
  }

  /**
   * Get cart subtotal in cents
   */
  getSubtotal(): number {
    return this.items.reduce((total, item) => total + (item.price * item.quantity), 0);
  }

  /**
   * Get formatted subtotal string
   */
  getFormattedSubtotal(): string {
    return `$${(this.getSubtotal() / 100).toFixed(2)}`;
  }

  /**
   * Add item to cart
   */
  addItem(item: Omit<CartItem, 'quantity'>, quantity: number = 1): void {
    const existingIndex = this.items.findIndex(
      i => i.id === item.id && i.variant === item.variant
    );

    if (existingIndex >= 0) {
      this.items[existingIndex].quantity += quantity;
    } else {
      this.items.push({ ...item, quantity });
    }

    this.save();
  }

  /**
   * Update item quantity
   */
  updateQuantity(id: string, variant: string | undefined, quantity: number): void {
    const index = this.items.findIndex(
      i => i.id === id && i.variant === variant
    );

    if (index >= 0) {
      if (quantity <= 0) {
        this.items.splice(index, 1);
      } else {
        this.items[index].quantity = quantity;
      }
      this.save();
    }
  }

  /**
   * Remove item from cart
   */
  removeItem(id: string, variant?: string): void {
    this.items = this.items.filter(
      i => !(i.id === id && i.variant === variant)
    );
    this.save();
  }

  /**
   * Clear all items
   */
  clear(): void {
    this.items = [];
    this.save();
  }

  /**
   * Check if cart is empty
   */
  isEmpty(): boolean {
    return this.items.length === 0;
  }
}

// Export singleton instance
export const cart = new Cart();
