/**
 * Physical Merchandise Store
 * Handles product display, quick view, and cart integration
 */

import { initNavAuth } from './nav-auth';

// Product types
interface ProductVariant {
  name: string;
  available: boolean;
}

interface Product {
  id: string;
  name: string;
  price: number; // in cents
  description: string;
  image: string;
  category: 'apparel' | 'accessories' | 'collectibles';
  variants?: ProductVariant[];
  soldOut?: boolean;
}

// Cart item type
interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
  variant?: string;
  image: string;
}

// Product data
const PRODUCTS: Product[] = [
  // Apparel
  {
    id: 'lit-tee-black',
    name: 'LIT Album Tee - Black',
    price: 3500,
    description: 'Premium heavyweight cotton tee featuring the LIT album artwork. Oversized fit with ribbed crew neck.',
    image: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&q=80&w=800',
    category: 'apparel',
    variants: [
      { name: 'S', available: true },
      { name: 'M', available: true },
      { name: 'L', available: true },
      { name: 'XL', available: true },
      { name: 'XXL', available: false },
    ]
  },
  {
    id: 'lit-tee-white',
    name: 'LIT Album Tee - White',
    price: 3500,
    description: 'Premium heavyweight cotton tee in white featuring the LIT album artwork. Oversized fit with ribbed crew neck.',
    image: 'https://images.unsplash.com/photo-1583743814966-8936f5b7be1a?auto=format&fit=crop&q=80&w=800',
    category: 'apparel',
    variants: [
      { name: 'S', available: true },
      { name: 'M', available: true },
      { name: 'L', available: true },
      { name: 'XL', available: true },
      { name: 'XXL', available: true },
    ]
  },
  {
    id: 'myind-hoodie',
    name: 'Myind Sound Hoodie',
    price: 6500,
    description: 'Heavyweight fleece hoodie with embroidered Myind Sound logo. Features kangaroo pocket and ribbed cuffs.',
    image: 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?auto=format&fit=crop&q=80&w=800',
    category: 'apparel',
    variants: [
      { name: 'S', available: true },
      { name: 'M', available: true },
      { name: 'L', available: true },
      { name: 'XL', available: true },
    ]
  },
  // Accessories
  {
    id: 'myind-cap',
    name: 'Myind Sound Dad Cap',
    price: 2800,
    description: 'Classic dad cap with embroidered Myind Sound logo. Adjustable strap for perfect fit.',
    image: 'https://images.unsplash.com/photo-1588850561407-ed78c282e89b?auto=format&fit=crop&q=80&w=800',
    category: 'accessories',
  },
  {
    id: 'sticker-pack',
    name: 'Sticker Pack',
    price: 1200,
    description: 'Set of 5 premium vinyl stickers featuring Myind Sound and album artwork. Weather-resistant.',
    image: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?auto=format&fit=crop&q=80&w=800',
    category: 'accessories',
  },
  {
    id: 'tote-bag',
    name: 'Canvas Tote Bag',
    price: 2200,
    description: 'Heavy-duty canvas tote with screen-printed Myind Sound artwork. Perfect for everyday use.',
    image: 'https://images.unsplash.com/photo-1597633125097-5a9ae21ea4d3?auto=format&fit=crop&q=80&w=800',
    category: 'accessories',
  },
  // Collectibles
  {
    id: 'lit-poster',
    name: 'LIT Album Poster',
    price: 2500,
    description: '18x24 inch museum-quality poster printed on premium matte paper. Ships rolled in a protective tube.',
    image: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&q=80&w=800',
    category: 'collectibles',
  },
  {
    id: 'lit-vinyl',
    name: 'LIT Vinyl LP',
    price: 4500,
    description: 'Limited edition 180g vinyl pressing with gatefold sleeve and lyric insert. Includes download card.',
    image: 'https://images.unsplash.com/photo-1539375665275-f9de415ef9ac?auto=format&fit=crop&q=80&w=800',
    category: 'collectibles',
    soldOut: true,
  },
];

class PhysicalStore {
  private currentProduct: Product | null = null;
  private selectedVariant: string | null = null;
  private quantity: number = 1;
  private cart: CartItem[] = [];

  constructor() {
    this.loadCart();
    this.init();
  }

  private init() {
    this.renderProducts();
    this.setupCartModal();
    this.setupQuickViewModal();
    this.updateCartCount();
    initNavAuth();
  }

  private renderProducts() {
    const grid = document.getElementById('products-grid');
    if (!grid) return;

    // Hide loading, show grid
    const loading = document.getElementById('products-loading');
    if (loading) loading.style.display = 'none';
    grid.style.display = 'grid';

    grid.innerHTML = PRODUCTS.map(p => this.renderProductCard(p)).join('');
    this.attachCardListeners(grid);
  }

  private renderProductCard(product: Product): string {
    const price = (product.price / 100).toFixed(2);
    return `
      <div class="product-card" data-product-id="${product.id}">
        <div class="product-image">
          ${product.soldOut ? '<span class="sold-out-badge">Sold Out</span>' : ''}
          <img src="${product.image}" alt="${product.name}" loading="lazy" />
          <div class="product-overlay">
            <button class="quick-view-btn">QUICK VIEW</button>
          </div>
        </div>
        <div class="product-info">
          <h3 class="product-name">${product.name}</h3>
          <p class="product-price">$${price}</p>
        </div>
      </div>
    `;
  }

  private attachCardListeners(container: HTMLElement) {
    container.querySelectorAll('.product-card').forEach(card => {
      const productId = card.getAttribute('data-product-id');
      const product = PRODUCTS.find(p => p.id === productId);
      if (product) {
        card.addEventListener('click', () => this.openQuickView(product));
      }
    });
  }

  private setupCartModal() {
    const cartBtn = document.getElementById('cart-btn');
    const cartModal = document.getElementById('cart-modal');
    const closeCart = document.getElementById('close-cart');
    const continueShopping = document.getElementById('continue-shopping');
    const checkoutBtn = document.getElementById('checkout-btn');

    cartBtn?.addEventListener('click', () => this.openCart());
    closeCart?.addEventListener('click', () => this.closeCart());
    continueShopping?.addEventListener('click', () => this.closeCart());

    cartModal?.addEventListener('click', (e) => {
      if (e.target === cartModal) this.closeCart();
    });

    checkoutBtn?.addEventListener('click', () => this.checkout());
  }

  private openCart() {
    const modal = document.getElementById('cart-modal');
    if (modal) {
      modal.style.display = 'flex';
      this.renderCartItems();
    }
  }

  private closeCart() {
    const modal = document.getElementById('cart-modal');
    if (modal) modal.style.display = 'none';
  }

  private renderCartItems() {
    const itemsContainer = document.getElementById('cart-items');
    const emptyState = document.getElementById('cart-empty');
    const footer = document.getElementById('cart-footer');
    const subtotalEl = document.getElementById('cart-subtotal');

    if (!itemsContainer || !emptyState || !footer) return;

    if (this.cart.length === 0) {
      itemsContainer.innerHTML = '';
      emptyState.style.display = 'block';
      footer.style.display = 'none';
    } else {
      emptyState.style.display = 'none';
      footer.style.display = 'block';

      const subtotal = this.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      if (subtotalEl) subtotalEl.textContent = `$${(subtotal / 100).toFixed(2)}`;

      itemsContainer.innerHTML = this.cart.map(item => this.renderCartItem(item)).join('');

      // Attach listeners
      itemsContainer.querySelectorAll('.cart-item').forEach(itemEl => {
        const id = itemEl.getAttribute('data-id');
        const variant = itemEl.getAttribute('data-variant') || undefined;

        itemEl.querySelector('.qty-decrease')?.addEventListener('click', () => {
          this.updateCartQuantity(id!, variant, -1);
        });

        itemEl.querySelector('.qty-increase')?.addEventListener('click', () => {
          this.updateCartQuantity(id!, variant, 1);
        });

        itemEl.querySelector('.remove-item-btn')?.addEventListener('click', () => {
          this.removeFromCart(id!, variant);
        });
      });
    }
  }

  private renderCartItem(item: CartItem): string {
    const price = (item.price / 100).toFixed(2);
    return `
      <div class="cart-item" data-id="${item.id}" data-variant="${item.variant || ''}">
        <div class="cart-item-image">
          <img src="${item.image}" alt="${item.name}" />
        </div>
        <div class="cart-item-info">
          <h4 class="cart-item-name">${item.name}</h4>
          ${item.variant ? `<p class="cart-item-variant">Size: ${item.variant}</p>` : ''}
          <p class="cart-item-price">$${price}</p>
        </div>
        <div class="cart-item-actions">
          <div class="cart-item-qty">
            <button class="qty-decrease">-</button>
            <span>${item.quantity}</span>
            <button class="qty-increase">+</button>
          </div>
          <button class="remove-item-btn">REMOVE</button>
        </div>
      </div>
    `;
  }

  private updateCartCount() {
    const countEl = document.getElementById('cart-count');
    if (countEl) {
      const count = this.cart.reduce((sum, item) => sum + item.quantity, 0);
      countEl.textContent = count.toString();
      countEl.setAttribute('data-count', count.toString());
      countEl.style.display = count > 0 ? 'flex' : 'none';
    }
  }

  private setupQuickViewModal() {
    const modal = document.getElementById('quickview-modal');
    const closeBtn = document.getElementById('close-quickview');
    const qtyMinus = document.getElementById('qty-minus');
    const qtyPlus = document.getElementById('qty-plus');
    const addToCartBtn = document.getElementById('add-to-cart-btn');

    closeBtn?.addEventListener('click', () => this.closeQuickView());

    modal?.addEventListener('click', (e) => {
      if (e.target === modal) this.closeQuickView();
    });

    qtyMinus?.addEventListener('click', () => {
      if (this.quantity > 1) {
        this.quantity--;
        this.updateQuantityDisplay();
      }
    });

    qtyPlus?.addEventListener('click', () => {
      this.quantity++;
      this.updateQuantityDisplay();
    });

    addToCartBtn?.addEventListener('click', () => this.addToCart());
  }

  private openQuickView(product: Product) {
    this.currentProduct = product;
    this.selectedVariant = product.variants?.[0]?.available ? product.variants[0].name : null;
    this.quantity = 1;

    const modal = document.getElementById('quickview-modal');
    const img = document.getElementById('quickview-img') as HTMLImageElement;
    const name = document.getElementById('quickview-name');
    const price = document.getElementById('quickview-price');
    const desc = document.getElementById('quickview-desc');
    const variantsContainer = document.getElementById('quickview-variants');
    const variantOptions = document.getElementById('variant-options');
    const addBtn = document.getElementById('add-to-cart-btn');

    if (img) img.src = product.image;
    if (name) name.textContent = product.name;
    if (price) price.textContent = `$${(product.price / 100).toFixed(2)}`;
    if (desc) desc.textContent = product.description;

    // Handle variants
    if (product.variants && product.variants.length > 0 && variantsContainer && variantOptions) {
      variantsContainer.style.display = 'block';
      variantOptions.innerHTML = product.variants.map(v => `
        <button class="variant-option ${v.name === this.selectedVariant ? 'selected' : ''} ${!v.available ? 'disabled' : ''}"
                data-variant="${v.name}"
                ${!v.available ? 'disabled' : ''}>
          ${v.name}
        </button>
      `).join('');

      variantOptions.querySelectorAll('.variant-option:not(.disabled)').forEach(btn => {
        btn.addEventListener('click', () => {
          this.selectedVariant = btn.getAttribute('data-variant');
          variantOptions.querySelectorAll('.variant-option').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
        });
      });
    } else if (variantsContainer) {
      variantsContainer.style.display = 'none';
    }

    // Handle sold out
    if (addBtn) {
      if (product.soldOut) {
        addBtn.textContent = 'SOLD OUT';
        (addBtn as HTMLButtonElement).disabled = true;
      } else {
        addBtn.textContent = 'ADD TO CART';
        (addBtn as HTMLButtonElement).disabled = false;
      }
    }

    this.updateQuantityDisplay();

    if (modal) modal.style.display = 'flex';
  }

  private closeQuickView() {
    const modal = document.getElementById('quickview-modal');
    if (modal) modal.style.display = 'none';
    this.currentProduct = null;
    this.selectedVariant = null;
    this.quantity = 1;
  }

  private updateQuantityDisplay() {
    const qtyValue = document.getElementById('qty-value');
    if (qtyValue) qtyValue.textContent = this.quantity.toString();
  }

  private addToCart() {
    if (!this.currentProduct || this.currentProduct.soldOut) return;

    // Check if variant is required but not selected
    if (this.currentProduct.variants && this.currentProduct.variants.length > 0 && !this.selectedVariant) {
      alert('Please select a size');
      return;
    }

    const existingItem = this.cart.find(
      item => item.id === this.currentProduct!.id && item.variant === this.selectedVariant
    );

    if (existingItem) {
      existingItem.quantity += this.quantity;
    } else {
      this.cart.push({
        id: this.currentProduct.id,
        name: this.currentProduct.name,
        price: this.currentProduct.price,
        quantity: this.quantity,
        variant: this.selectedVariant || undefined,
        image: this.currentProduct.image,
      });
    }

    this.saveCart();
    this.updateCartCount();
    this.closeQuickView();
    this.openCart();
  }

  private updateCartQuantity(id: string, variant: string | undefined, delta: number) {
    const item = this.cart.find(i => i.id === id && i.variant === variant);
    if (!item) return;

    item.quantity += delta;

    if (item.quantity <= 0) {
      this.removeFromCart(id, variant);
    } else {
      this.saveCart();
      this.updateCartCount();
      this.renderCartItems();
    }
  }

  private removeFromCart(id: string, variant: string | undefined) {
    this.cart = this.cart.filter(item => !(item.id === id && item.variant === variant));
    this.saveCart();
    this.updateCartCount();
    this.renderCartItems();
  }

  private saveCart() {
    localStorage.setItem('physical-cart', JSON.stringify(this.cart));
  }

  private loadCart() {
    try {
      const saved = localStorage.getItem('physical-cart');
      if (saved) {
        this.cart = JSON.parse(saved);
      }
    } catch {
      this.cart = [];
    }
  }

  private async checkout() {
    if (this.cart.length === 0) return;

    const checkoutBtn = document.getElementById('checkout-btn') as HTMLButtonElement;
    if (checkoutBtn) {
      checkoutBtn.textContent = 'PROCESSING...';
      checkoutBtn.disabled = true;
    }

    try {
      const response = await fetch('/.netlify/functions/create-physical-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: this.cart }),
      });

      if (!response.ok) {
        throw new Error('Failed to create checkout session');
      }

      const { url } = await response.json();
      if (url) {
        // Clear cart after successful checkout creation
        this.cart = [];
        this.saveCart();
        window.location.href = url;
      }
    } catch (error) {
      console.error('Checkout error:', error);
      alert('There was an error processing your checkout. Please try again.');

      if (checkoutBtn) {
        checkoutBtn.textContent = 'CHECKOUT';
        checkoutBtn.disabled = false;
      }
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new PhysicalStore();
  });
} else {
  new PhysicalStore();
}
