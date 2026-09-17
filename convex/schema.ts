import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export const shippingValidator = v.object({
  name: v.string(),
  line1: v.string(),
  line2: v.optional(v.string()),
  city: v.string(),
  state: v.optional(v.string()),
  postalCode: v.string(),
  country: v.string(),
});

export default defineSchema({
  products: defineTable({
    slug: v.string(),
    name: v.string(),
    kind: v.union(v.literal('digital'), v.literal('physical')),
    stripeProductIds: v.array(v.string()),
    coverUrl: v.optional(v.string()),
    downloadKey: v.optional(v.string()),
    active: v.boolean(),
  }).index('by_slug', ['slug']),

  tracks: defineTable({
    productId: v.id('products'),
    position: v.number(),
    title: v.string(),
    durationSeconds: v.number(),
    format: v.literal('mp3'),
    streamKey: v.string(),
    originalKey: v.string(),
  }).index('by_product_position', ['productId', 'position']),

  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    isAdmin: v.boolean(),
    marketingConsentAt: v.optional(v.number()),
  })
    .index('by_clerkId', ['clerkId'])
    .index('by_email', ['email']),

  entitlements: defineTable({
    userId: v.id('users'),
    productId: v.id('products'),
    stripeSessionId: v.string(),
    grantedAt: v.number(),
  })
    .index('by_user_product', ['userId', 'productId'])
    .index('by_session', ['stripeSessionId']),

  orders: defineTable({
    userId: v.id('users'),
    stripeSessionId: v.string(),
    totalCents: v.number(),
    currency: v.string(),
    shipping: v.optional(shippingValidator),
    status: v.union(v.literal('paid'), v.literal('fulfilled'), v.literal('cancelled')),
    createdAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_session', ['stripeSessionId']),

  orderItems: defineTable({
    orderId: v.id('orders'),
    productId: v.optional(v.id('products')),
    description: v.string(),
    variant: v.optional(v.string()),
    quantity: v.number(),
    unitCents: v.number(),
  }).index('by_order', ['orderId']),

  plays: defineTable({
    userId: v.id('users'),
    trackId: v.id('tracks'),
    playedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_playedAt', ['playedAt']),

  stripeEvents: defineTable({
    eventId: v.string(),
    type: v.string(),
    processedAt: v.number(),
  }).index('by_eventId', ['eventId']),
});
