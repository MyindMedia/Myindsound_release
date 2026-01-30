import { Handler } from '@netlify/functions';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

// Supabase Admin Client (using service role key)
const supabase = createClient(
    process.env.VITE_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sig = event.headers['stripe-signature'] || '';
    let stripeEvent: Stripe.Event;

    try {
        stripeEvent = stripe.webhooks.constructEvent(event.body || '', sig, endpointSecret);
    } catch (err: any) {
        console.error('Webhook signature verification failed:', err.message);
        return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    if (stripeEvent.type === 'checkout.session.completed') {
        const session = stripeEvent.data.object as Stripe.Checkout.Session;
        const customerEmail = session.customer_details?.email;
        const customerName = session.customer_details?.name;

        if (customerEmail) {
            try {
                // 1. Get Line Items
                const lineItems = await stripe.checkout.sessions.listLineItems(session.id);

                // 2. Map Stripe Products to Supabase Products
                const purchasedStripeProductIds = lineItems.data.map(item => item.price?.product as string);

                // 3. Find matching products in Supabase
                const { data: products } = await supabase
                    .from('products')
                    .select('id, stripe_product_id')
                    .in('stripe_product_id', purchasedStripeProductIds);

                if (products && products.length > 0) {
                    // 4. Ensure User Exists in Supabase Auth
                    // We use admin.createUser to set up an account if it doesn't exist
                    // This will trigger an email if configured, or we can use magic links later.
                    const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
                        email: customerEmail,
                        email_confirm: true,
                        user_metadata: { full_name: customerName }
                    });

                    // If user already exists, authError will happen, we just fetch the user then
                    let userId = authUser?.user?.id;
                    if (authError || !userId) {
                        const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
                        if (!listError) {
                            userId = users.find(u => u.email === customerEmail)?.id;
                        }
                    }

                    if (userId) {
                        // 5. Grant Access in user_access table
                        const accessRecords = products.map(p => ({
                            user_id: userId,
                            product_id: p.id
                        }));

                        await supabase.from('user_access').upsert(accessRecords, { onConflict: 'user_id,product_id' });
                        console.log(`Access granted to ${customerEmail} for products: ${products.map(p => p.stripe_product_id).join(', ')}`);
                    }
                }

                // 6. Existing GHL Sync Logic
                const tags = ['LIT-Purchased'];
                if (purchasedStripeProductIds.includes('prod_TsqUkQtzNQ5Y3z')) {
                    tags.push('Source-Purchased');
                }

                const apiKey = process.env.GHL_API_KEY;
                const locationId = process.env.GHL_LOCATION_ID;

                if (apiKey && locationId) {
                    await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'Version': '2021-07-28',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            email: customerEmail,
                            locationId,
                            tags,
                            source: 'Stream Automation'
                        })
                    });
                }
            } catch (error) {
                console.error('Webhook Processing Error:', error);
            }
        }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
