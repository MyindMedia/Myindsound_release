/**
 * Physical Merchandise Store
 * Fetches products from Shopify and handles cart/checkout
 */

import {
  fetchProducts,
  createCheckoutUrl,
  formatPrice,
  getProductImage,
  hasVariants,
  getAvailableVariants,
  isSoldOut,
  stripHtml,
  type ShopifyProduct
} from './shopify';
import { initNavAuth } from './nav-auth';

// Cart item type
interface CartItem {
  variantId: number;
  productId: number;
  name: string;
  variantTitle: string;
  price: string;
  quantity: number;
  image: string;
}

class PhysicalStore {
  private products: ShopifyProduct[] = [];
  private currentProduct: ShopifyProduct | null = null;
  private selectedVariantId: number | null = null;
  private quantity: number = 1;
  private cart: CartItem[] = [];

  constructor() {
    this.loadCart();
    this.init();
  }

  private async init() {
    this.showLoading(true);

    try {
      this.products = await fetchProducts();
      this.renderProducts();
    } catch (error) {
      console.error('Failed to load products:', error);
      this.showError('Failed to load products. Please try again later.');
    }

    this.showLoading(false);
    this.setupCartModal();
    this.setupQuickViewModal();
    this.updateCartCount();
    initNavAuth();
  }

  private showLoading(show: boolean) {
    const loading = document.getElementById('products-loading');
    const grid = document.getElementById('products-grid');

    if (loading) loading.style.display = show ? 'flex' : 'none';
    if (grid) grid.style.display = show ? 'none' : 'grid';
  }

  private showError(message: string) {
    const grid = document.getElementById('products-grid');
    if (grid) {
      grid.innerHTML = `
        <div class="error-state" style="grid-column: 1 / -1; text-align: center; padding: 4rem 2rem;">
          <p style="color: #888; margin-bottom: 1rem;">${message}</p>
          <button onclick="location.reload()" class="primary-btn">Retry</button>
        </div>
      `;
      grid.style.display = 'block';
    }
  }

  private renderProducts() {
    const grid = document.getElementById('products-grid');
    if (!grid) return;

    if (this.products.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1; text-align: center; padding: 4rem 2rem;">
          <p style="color: #888;">No products available yet. Check back soon!</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = this.products.map(p => this.renderProductCard(p)).join('');
    this.attachCardListeners(grid);
  }

  private renderProductCard(product: ShopifyProduct): string {
    const price = formatPrice(product.variants[0]?.price || '0');
    const image = getProductImage(product);
    const soldOut = isSoldOut(product);

    return `
      <div class="product-card" data-product-id="${product.id}">
        <div class="product-image">
          ${soldOut ? '<span class="sold-out-badge">Sold Out</span>' : ''}
          <img src="${image}" alt="${product.title}" loading="lazy" />
          <div class="product-overlay">
            <button class="quick-view-btn">QUICK VIEW</button>
          </div>
        </div>
        <div class="product-info">
          <h3 class="product-name">${product.title}</h3>
          <p class="product-price">${price}</p>
        </div>
      </div>
    `;
  }

  private attachCardListeners(container: HTMLElement) {
    container.querySelectorAll('.product-card').forEach(card => {
      const productId = parseInt(card.getAttribute('data-product-id') || '0');
      const product = this.products.find(p => p.id === productId);
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

      const subtotal = this.cart.reduce((sum, item) => sum + (parseFloat(item.price) * item.quantity), 0);
      if (subtotalEl) subtotalEl.textContent = formatPrice(subtotal.toString());

      itemsContainer.innerHTML = this.cart.map(item => this.renderCartItem(item)).join('');

      // Attach listeners
      itemsContainer.querySelectorAll('.cart-item').forEach(itemEl => {
        const variantId = parseInt(itemEl.getAttribute('data-variant-id') || '0');

        itemEl.querySelector('.qty-decrease')?.addEventListener('click', () => {
          this.updateCartQuantity(variantId, -1);
        });

        itemEl.querySelector('.qty-increase')?.addEventListener('click', () => {
          this.updateCartQuantity(variantId, 1);
        });

        itemEl.querySelector('.remove-item-btn')?.addEventListener('click', () => {
          this.removeFromCart(variantId);
        });
      });
    }
  }

  private renderCartItem(item: CartItem): string {
    const price = formatPrice(item.price);
    return `
      <div class="cart-item" data-variant-id="${item.variantId}">
        <div class="cart-item-image">
          <img src="${item.image}" alt="${item.name}" />
        </div>
        <div class="cart-item-info">
          <h4 class="cart-item-name">${item.name}</h4>
          ${item.variantTitle !== 'Default Title' ? `<p class="cart-item-variant">${item.variantTitle}</p>` : ''}
          <p class="cart-item-price">${price}</p>
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

  private openQuickView(product: ShopifyProduct) {
    this.currentProduct = product;
    const availableVariants = getAvailableVariants(product);
    this.selectedVariantId = availableVariants[0]?.id || null;
    this.quantity = 1;

    const modal = document.getElementById('quickview-modal');
    const img = document.getElementById('quickview-img') as HTMLImageElement;
    const name = document.getElementById('quickview-name');
    const price = document.getElementById('quickview-price');
    const desc = document.getElementById('quickview-desc');
    const variantsContainer = document.getElementById('quickview-variants');
    const variantOptions = document.getElementById('variant-options');
    const addBtn = document.getElementById('add-to-cart-btn');

    if (img) img.src = getProductImage(product);
    if (name) name.textContent = product.title;
    if (price) price.textContent = formatPrice(product.variants[0]?.price || '0');
    if (desc) desc.textContent = stripHtml(product.body_html).substring(0, 200) + '...';

    // Handle variants
    if (hasVariants(product) && variantsContainer && variantOptions) {
      variantsContainer.style.display = 'block';
      variantOptions.innerHTML = product.variants.map(v => `
        <button class="variant-option ${v.id === this.selectedVariantId ? 'selected' : ''} ${!v.available ? 'disabled' : ''}"
                data-variant-id="${v.id}"
                data-price="${v.price}"
                ${!v.available ? 'disabled' : ''}>
          ${v.title}
        </button>
      `).join('');

      variantOptions.querySelectorAll('.variant-option:not(.disabled)').forEach(btn => {
        btn.addEventListener('click', () => {
          this.selectedVariantId = parseInt(btn.getAttribute('data-variant-id') || '0');
          const variantPrice = btn.getAttribute('data-price');
          variantOptions.querySelectorAll('.variant-option').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');

          // Update price
          if (variantPrice && price) {
            price.textContent = formatPrice(variantPrice);
          }
        });
      });
    } else if (variantsContainer) {
      variantsContainer.style.display = 'none';
    }

    // Handle sold out
    const soldOut = isSoldOut(product);
    if (addBtn) {
      if (soldOut) {
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
    this.selectedVariantId = null;
    this.quantity = 1;
  }

  private updateQuantityDisplay() {
    const qtyValue = document.getElementById('qty-value');
    if (qtyValue) qtyValue.textContent = this.quantity.toString();
  }

  private addToCart() {
    if (!this.currentProduct || !this.selectedVariantId) return;

    const variant = this.currentProduct.variants.find(v => v.id === this.selectedVariantId);
    if (!variant || !variant.available) return;

    const existingItem = this.cart.find(item => item.variantId === this.selectedVariantId);

    if (existingItem) {
      existingItem.quantity += this.quantity;
    } else {
      this.cart.push({
        variantId: this.selectedVariantId,
        productId: this.currentProduct.id,
        name: this.currentProduct.title,
        variantTitle: variant.title,
        price: variant.price,
        quantity: this.quantity,
        image: getProductImage(this.currentProduct),
      });
    }

    this.saveCart();
    this.updateCartCount();
    this.closeQuickView();
    this.openCart();
  }

  private updateCartQuantity(variantId: number, delta: number) {
    const item = this.cart.find(i => i.variantId === variantId);
    if (!item) return;

    item.quantity += delta;

    if (item.quantity <= 0) {
      this.removeFromCart(variantId);
    } else {
      this.saveCart();
      this.updateCartCount();
      this.renderCartItems();
    }
  }

  private removeFromCart(variantId: number) {
    this.cart = this.cart.filter(item => item.variantId !== variantId);
    this.saveCart();
    this.updateCartCount();
    this.renderCartItems();
  }

  private saveCart() {
    localStorage.setItem('shopify-cart', JSON.stringify(this.cart));
  }

  private loadCart() {
    try {
      const saved = localStorage.getItem('shopify-cart');
      if (saved) {
        this.cart = JSON.parse(saved);
      }
    } catch {
      this.cart = [];
    }
  }

  private checkout() {
    if (this.cart.length === 0) return;

    // Create Shopify cart URL and redirect
    const items = this.cart.map(item => ({
      variantId: item.variantId,
      quantity: item.quantity,
    }));

    const checkoutUrl = createCheckoutUrl(items);

    // Clear cart
    this.cart = [];
    this.saveCart();
    this.updateCartCount();

    // Redirect to Shopify checkout
    window.location.href = checkoutUrl;
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
