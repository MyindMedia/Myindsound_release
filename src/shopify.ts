/**
 * Shopify Storefront API Client
 * Handles product fetching and checkout creation
 */

const SHOPIFY_STORE_DOMAIN = (import.meta as any).env.VITE_SHOPIFY_STORE_DOMAIN;
const SHOPIFY_STOREFRONT_TOKEN = (import.meta as any).env.VITE_SHOPIFY_STOREFRONT_TOKEN;

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_STOREFRONT_TOKEN) {
  console.error('Missing Shopify environment variables');
}

const STOREFRONT_API_URL = `https://${SHOPIFY_STORE_DOMAIN}/api/2024-01/graphql.json`;

// Types
export interface ShopifyProduct {
  id: string;
  title: string;
  description: string;
  handle: string;
  productType: string;
  priceRange: {
    minVariantPrice: {
      amount: string;
      currencyCode: string;
    };
  };
  images: {
    edges: Array<{
      node: {
        url: string;
        altText: string | null;
      };
    }>;
  };
  variants: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        availableForSale: boolean;
        price: {
          amount: string;
          currencyCode: string;
        };
      };
    }>;
  };
}

export interface CartItem {
  variantId: string;
  quantity: number;
}

/**
 * Make a GraphQL request to Shopify Storefront API
 */
async function shopifyFetch<T>(query: string, variables?: Record<string, any>): Promise<T> {
  const response = await fetch(STOREFRONT_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status}`);
  }

  const json = await response.json();

  if (json.errors) {
    console.error('Shopify GraphQL errors:', json.errors);
    throw new Error(json.errors[0]?.message || 'GraphQL error');
  }

  return json.data;
}

/**
 * Fetch all products from Shopify store
 */
export async function fetchProducts(): Promise<ShopifyProduct[]> {
  const query = `
    query GetProducts($first: Int!) {
      products(first: $first) {
        edges {
          node {
            id
            title
            description
            handle
            productType
            priceRange {
              minVariantPrice {
                amount
                currencyCode
              }
            }
            images(first: 1) {
              edges {
                node {
                  url
                  altText
                }
              }
            }
            variants(first: 20) {
              edges {
                node {
                  id
                  title
                  availableForSale
                  price {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyFetch<{
    products: { edges: Array<{ node: ShopifyProduct }> };
  }>(query, { first: 50 });

  return data.products.edges.map(edge => edge.node);
}

/**
 * Fetch products by collection handle
 */
export async function fetchProductsByCollection(collectionHandle: string): Promise<ShopifyProduct[]> {
  const query = `
    query GetCollection($handle: String!, $first: Int!) {
      collection(handle: $handle) {
        products(first: $first) {
          edges {
            node {
              id
              title
              description
              handle
              productType
              priceRange {
                minVariantPrice {
                  amount
                  currencyCode
                }
              }
              images(first: 1) {
                edges {
                  node {
                    url
                    altText
                  }
                }
              }
              variants(first: 20) {
                edges {
                  node {
                    id
                    title
                    availableForSale
                    price {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyFetch<{
    collection: { products: { edges: Array<{ node: ShopifyProduct }> } } | null;
  }>(query, { handle: collectionHandle, first: 50 });

  if (!data.collection) {
    return [];
  }

  return data.collection.products.edges.map(edge => edge.node);
}

/**
 * Create a Shopify checkout with cart items
 */
export async function createCheckout(items: CartItem[]): Promise<string> {
  const query = `
    mutation CreateCheckout($input: CheckoutCreateInput!) {
      checkoutCreate(input: $input) {
        checkout {
          id
          webUrl
        }
        checkoutUserErrors {
          code
          field
          message
        }
      }
    }
  `;

  const lineItems = items.map(item => ({
    variantId: item.variantId,
    quantity: item.quantity,
  }));

  const data = await shopifyFetch<{
    checkoutCreate: {
      checkout: { id: string; webUrl: string } | null;
      checkoutUserErrors: Array<{ message: string }>;
    };
  }>(query, {
    input: { lineItems },
  });

  if (data.checkoutCreate.checkoutUserErrors.length > 0) {
    throw new Error(data.checkoutCreate.checkoutUserErrors[0].message);
  }

  if (!data.checkoutCreate.checkout) {
    throw new Error('Failed to create checkout');
  }

  return data.checkoutCreate.checkout.webUrl;
}

/**
 * Get a single product by handle
 */
export async function fetchProductByHandle(handle: string): Promise<ShopifyProduct | null> {
  const query = `
    query GetProduct($handle: String!) {
      product(handle: $handle) {
        id
        title
        description
        handle
        productType
        priceRange {
          minVariantPrice {
            amount
            currencyCode
          }
        }
        images(first: 5) {
          edges {
            node {
              url
              altText
            }
          }
        }
        variants(first: 20) {
          edges {
            node {
              id
              title
              availableForSale
              price {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyFetch<{
    product: ShopifyProduct | null;
  }>(query, { handle });

  return data.product;
}

/**
 * Helper to format price from Shopify
 */
export function formatPrice(amount: string, currencyCode: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
  }).format(parseFloat(amount));
}

/**
 * Helper to get first image URL from product
 */
export function getProductImage(product: ShopifyProduct): string {
  return product.images.edges[0]?.node.url || 'https://via.placeholder.com/400x400?text=No+Image';
}

/**
 * Helper to check if product has variants (beyond default)
 */
export function hasVariants(product: ShopifyProduct): boolean {
  const variants = product.variants.edges;
  return variants.length > 1 || (variants.length === 1 && variants[0].node.title !== 'Default Title');
}

/**
 * Helper to get available variants
 */
export function getAvailableVariants(product: ShopifyProduct): Array<{ id: string; title: string; price: string }> {
  return product.variants.edges
    .filter(edge => edge.node.availableForSale)
    .map(edge => ({
      id: edge.node.id,
      title: edge.node.title,
      price: edge.node.price.amount,
    }));
}
