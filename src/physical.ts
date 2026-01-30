/**
 * Physical Merchandise Store
 * Handles Shopify product display, quick view, and cart integration
 */

import {
  fetchProducts,
  createCheckout,
  formatPrice,
  getProductImage,
  hasVariants,
  getAvailableVariants,
  type ShopifyProduct
} from './shopify';
import { initNavAuth } from './nav-auth';

// Local cart item type
interface LocalCartItem {
  variantId: string;
  productId: string;
  name: string;
  variantTitle: string;
  price: number;
  quantity: number;
  image: string;
}

class PhysicalStore {
  private products: ShopifyProduct[] = [];
  private currentProduct: ShopifyProduct | null = null;
  private selectedVariantId: string | null = null;
  private quantity: number = 1;
  private cart: LocalCartItem[] = [];

  constructor() {
    this.loadCart();
    this.init();
  }

  private async init() {
    this.showLoading(true);

    try {
      // Fetch products from Shopify
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

    // Initialize nav auth
    initNavAuth();
  }

  private showLoading(show: boolean) {
    const loading = document.getElementById('products-loading');
    const grid = document.getElementById('products-grid');

    if (loading) {
      loading.style.display = show ? 'flex' : 'none';
    }

    if (grid) {
      grid.style.display = show ? 'none' : 'grid';
    }
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
    const price = formatPrice(product.priceRange.minVariantPrice.amount);
    const image = getProductImage(product);
    const soldOut = !product.variants.edges.some(v => v.node.availableForSale);

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
      const productId = card.getAttribute('data-product-id');
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

      const subtotal = this.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      if (subtotalEl) subtotalEl.textContent = formatPrice(subtotal.toString());

      itemsContainer.innerHTML = this.cart.map(item => this.renderCartItem(item)).join('');

      // Attach listeners
      itemsContainer.querySelectorAll('.cart-item').forEach(itemEl => {
        const variantId = itemEl.getAttribute('data-variant-id');

        itemEl.querySelector('.qty-decrease')?.addEventListener('click', () => {
          this.updateCartQuantity(variantId!, -1);
        });

        itemEl.querySelector('.qty-increase')?.addEventListener('click', () => {
          this.updateCartQuantity(variantId!, 1);
        });

        itemEl.querySelector('.remove-item-btn')?.addEventListener('click', () => {
          this.removeFromCart(variantId!);
        });
      });
    }
  }

  private renderCartItem(item: LocalCartItem): string {
    const price = formatPrice(item.price.toString());
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
    if (price) price.textContent = formatPrice(product.priceRange.minVariantPrice.amount);
    if (desc) desc.textContent = product.description;

    // Handle variants
    if (hasVariants(product) && variantsContainer && variantOptions) {
      variantsContainer.style.display = 'block';
      variantOptions.innerHTML = product.variants.edges.map(v => {
        const variant = v.node;
        return `
          <button class="variant-option ${variant.id === this.selectedVariantId ? 'selected' : ''} ${!variant.availableForSale ? 'disabled' : ''}"
                  data-variant-id="${variant.id}"
                  ${!variant.availableForSale ? 'disabled' : ''}>
            ${variant.title}
          </button>
        `;
      }).join('');

      variantOptions.querySelectorAll('.variant-option:not(.disabled)').forEach(btn => {
        btn.addEventListener('click', () => {
          this.selectedVariantId = btn.getAttribute('data-variant-id');
          variantOptions.querySelectorAll('.variant-option').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');

          // Update price for selected variant
          const variant = product.variants.edges.find(v => v.node.id === this.selectedVariantId);
          if (variant && price) {
            price.textContent = formatPrice(variant.node.price.amount);
          }
        });
      });
    } else if (variantsContainer) {
      variantsContainer.style.display = 'none';
    }

    // Handle sold out
    const soldOut = !product.variants.edges.some(v => v.node.availableForSale);
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

    const variant = this.currentProduct.variants.edges.find(
      v => v.node.id === this.selectedVariantId
    );

    if (!variant || !variant.node.availableForSale) return;

    const existingItem = this.cart.find(item => item.variantId === this.selectedVariantId);

    if (existingItem) {
      existingItem.quantity += this.quantity;
    } else {
      this.cart.push({
        variantId: this.selectedVariantId,
        productId: this.currentProduct.id,
        name: this.currentProduct.title,
        variantTitle: variant.node.title,
        price: parseFloat(variant.node.price.amount),
        quantity: this.quantity,
        image: getProductImage(this.currentProduct),
      });
    }

    this.saveCart();
    this.updateCartCount();
    this.closeQuickView();
    this.openCart();
  }

  private updateCartQuantity(variantId: string, delta: number) {
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

  private removeFromCart(variantId: string) {
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

  private async checkout() {
    if (this.cart.length === 0) return;

    const checkoutBtn = document.getElementById('checkout-btn') as HTMLButtonElement;
    if (checkoutBtn) {
      checkoutBtn.textContent = 'PROCESSING...';
      checkoutBtn.disabled = true;
    }

    try {
      const items = this.cart.map(item => ({
        variantId: item.variantId,
        quantity: item.quantity,
      }));

      const checkoutUrl = await createCheckout(items);

      // Clear cart after successful checkout creation
      this.cart = [];
      this.saveCart();
      this.updateCartCount();

      // Redirect to Shopify checkout
      window.location.href = checkoutUrl;
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
