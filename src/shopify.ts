/**
 * Shopify Public API Client
 * Fetches products from public JSON endpoint (no auth required)
 */

const SHOPIFY_STORE_DOMAIN = 'royalty-vibes-shop-97xx5.myshopify.com';

// Types based on Shopify's public JSON format
export interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  vendor: string;
  product_type: string;
  images: Array<{
    id: number;
    src: string;
    alt: string | null;
  }>;
  variants: Array<{
    id: number;
    title: string;
    price: string;
    available: boolean;
  }>;
}

/**
 * Fetch all products from Shopify store (public endpoint)
 */
export async function fetchProducts(): Promise<ShopifyProduct[]> {
  try {
    const response = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/products.json`);

    if (!response.ok) {
      throw new Error(`Failed to fetch products: ${response.status}`);
    }

    const data = await response.json();
    return data.products || [];
  } catch (error) {
    console.error('Error fetching products:', error);
    throw error;
  }
}

/**
 * Create a Shopify checkout URL with cart items
 */
export function createCheckoutUrl(items: Array<{ variantId: number; quantity: number }>): string {
  // Build the cart permalink
  const cartItems = items.map(item => `${item.variantId}:${item.quantity}`).join(',');
  return `https://${SHOPIFY_STORE_DOMAIN}/cart/${cartItems}`;
}

/**
 * Helper to format price
 */
export function formatPrice(price: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(parseFloat(price));
}

/**
 * Helper to get first image URL from product
 */
export function getProductImage(product: ShopifyProduct): string {
  return product.images[0]?.src || 'https://via.placeholder.com/400x400?text=No+Image';
}

/**
 * Helper to check if product has multiple variants
 */
export function hasVariants(product: ShopifyProduct): boolean {
  return product.variants.length > 1 ||
    (product.variants.length === 1 && product.variants[0].title !== 'Default Title');
}

/**
 * Helper to get available variants
 */
export function getAvailableVariants(product: ShopifyProduct): Array<{ id: number; title: string; price: string; available: boolean }> {
  return product.variants.filter(v => v.available);
}

/**
 * Helper to check if product is sold out
 */
export function isSoldOut(product: ShopifyProduct): boolean {
  return !product.variants.some(v => v.available);
}

/**
 * Strip HTML from description
 */
export function stripHtml(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}
