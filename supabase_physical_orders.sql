-- Physical Orders Schema for Myind Sound Releases
-- Run this in Supabase SQL Editor

-- Physical orders table
CREATE TABLE IF NOT EXISTS physical_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,  -- Clerk user ID
  stripe_payment_id TEXT,
  total_amount INTEGER,  -- in cents
  shipping_address JSONB,
  order_status TEXT DEFAULT 'pending' CHECK (order_status IN ('pending', 'processing', 'shipped', 'delivered')),
  tracking_number TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Order items table
CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES physical_orders(id) ON DELETE CASCADE,
  product_id TEXT,
  product_name TEXT NOT NULL,
  variant TEXT,  -- size, color, etc.
  quantity INTEGER DEFAULT 1,
  unit_price INTEGER  -- in cents
);

-- Add indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_physical_orders_user ON physical_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_physical_orders_status ON physical_orders(order_status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- Enable Row Level Security
ALTER TABLE physical_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

-- RLS Policies for physical_orders
-- Allow users to read their own orders
CREATE POLICY "Users can view own orders" ON physical_orders
  FOR SELECT USING (true);  -- Note: In production, use Clerk JWT verification

-- Allow service role to insert/update
CREATE POLICY "Service role can manage orders" ON physical_orders
  FOR ALL USING (true);

-- RLS Policies for order_items
CREATE POLICY "Users can view order items" ON order_items
  FOR SELECT USING (true);

CREATE POLICY "Service role can manage order items" ON order_items
  FOR ALL USING (true);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for physical_orders
DROP TRIGGER IF EXISTS update_physical_orders_updated_at ON physical_orders;
CREATE TRIGGER update_physical_orders_updated_at
  BEFORE UPDATE ON physical_orders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
