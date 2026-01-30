/**
 * Supabase Client Module
 * Provides Supabase client for main site pages
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = (import.meta as any).env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = (import.meta as any).env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing Supabase environment variables');
}

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Type definitions for database tables
export interface Product {
  id: string;
  name: string;
  description: string;
  cover_url: string;
  audio_url: string;
  stripe_product_id: string;
}

export interface UserAccess {
  user_id: string;
  product_id: string;
  created_at: string;
  products?: Product;
}

export interface PhysicalOrder {
  id: string;
  user_id: string;
  stripe_payment_id: string;
  total_amount: number;
  shipping_address: {
    name: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postal_code: string;
    country: string;
  };
  order_status: 'pending' | 'processing' | 'shipped' | 'delivered';
  tracking_number?: string;
  created_at: string;
  updated_at: string;
  order_items?: OrderItem[];
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  variant?: string;
  quantity: number;
  unit_price: number;
}

/**
 * Fetch user's digital purchases
 */
export async function getUserPurchases(userId: string): Promise<Product[]> {
  const { data, error } = await supabase
    .from('user_access')
    .select('products(*)')
    .eq('user_id', userId);

  if (error) {
    console.error('Error fetching purchases:', error);
    return [];
  }

  return (data || [])
    .map((item: any) => item.products)
    .filter(Boolean);
}

/**
 * Fetch user's physical orders
 */
export async function getUserOrders(userId: string): Promise<PhysicalOrder[]> {
  const { data, error } = await supabase
    .from('physical_orders')
    .select('*, order_items(*)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching orders:', error);
    return [];
  }

  return data || [];
}

/**
 * Check if user has access to a specific product
 */
export async function hasProductAccess(userId: string, productId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_access')
    .select('product_id')
    .eq('user_id', userId)
    .eq('product_id', productId)
    .single();

  return !error && !!data;
}
