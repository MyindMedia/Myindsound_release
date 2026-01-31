/**
 * Supabase Client Module
 * Provides Supabase client for main site pages
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = (import.meta as any).env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = (import.meta as any).env.VITE_SUPABASE_ANON_KEY;

/**
 * Check if Supabase is properly configured
 */
export function isSupabaseConfigured(): boolean {
  return !!SUPABASE_URL && !!SUPABASE_ANON_KEY &&
    SUPABASE_URL !== 'your_supabase_url_here' &&
    SUPABASE_ANON_KEY !== 'your_supabase_anon_key_here';
}

/**
 * Get missing configuration message
 */
export function getSupabaseConfigError(): string | null {
  if (!SUPABASE_URL) return 'VITE_SUPABASE_URL is not configured';
  if (!SUPABASE_ANON_KEY) return 'VITE_SUPABASE_ANON_KEY is not configured';
  return null;
}

// Create client only if configured, otherwise create a dummy that will fail gracefully
export const supabase: SupabaseClient = isSupabaseConfigured()
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : createClient('https://placeholder.supabase.co', 'placeholder');

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

/**
 * Check if the current user is an admin
 */
export async function isAdmin(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', userId)
    .single();

  return !error && !!data?.is_admin;
}

export interface TrackPlay {
  id?: string;
  user_id?: string;
  product_id: string;
  track_name: string;
  played_at?: string;
}

/**
 * Log a track play event
 */
export async function logTrackPlay(trackName: string, productId: string, userId?: string): Promise<void> {
  if (!isSupabaseConfigured()) return;

  const { error } = await supabase
    .from('track_plays')
    .insert({
      track_name: trackName,
      product_id: productId,
      user_id: userId || null
    });

  if (error) {
    console.error('Error logging play:', error);
  }
}

/**
 * Fetch play stats (Admin only)
 */
export async function getAdminStats(): Promise<any> {
  const { data: plays, error: playsError } = await supabase
    .from('track_plays')
    .select('*, products(name)')
    .order('played_at', { ascending: false });

  const { data: users, error: usersError } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false });

  const { data: access, error: accessError } = await supabase
    .from('user_access')
    .select('*, products(name)')
    .order('created_at', { ascending: false });

  return {
    plays: plays || [],
    users: users || [],
    purchases: access || [],
    errors: { playsError, usersError, accessError }
  };
}
