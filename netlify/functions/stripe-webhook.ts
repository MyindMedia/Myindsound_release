import { Handler } from '@netlify/functions';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { createClerkClient } from '@clerk/backend';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

// Clerk Admin Client
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// Supabase Admin Client
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
                    // 4. Ensure User Exists in Clerk
                    let clerkUser;
                    const users = await clerk.users.getUserList({ emailAddress: [customerEmail] });

                    if (users.data.length > 0) {
                        clerkUser = users.data[0];
                    } else {
                        // Create user in Clerk if they don't exist
                        // Note: For PWYW, we might want to just invite them or allow them to sign up with the same email.
                        // Clerk invitation is often cleaner for "pre-created" accounts.
                        try {
                            clerkUser = await clerk.users.createUser({
                                emailAddress: [customerEmail],
                                firstName: customerName?.split(' ')[0] || '',
                                lastName: customerName?.split(' ').slice(1).join(' ') || '',
                                // Use a random password or rely on invitation/magic link
                                // Since we haven't asked for a password, invitation is better but Clerk's createUser requires some fields.
                                skipPasswordRequirement: true,
                            });
                        } catch (e) {
                            console.error('Clerk User Creation Error:', e);
                        }
                    }

                    const clerkId = clerkUser?.id;

                    if (clerkId) {
                        // 5. Grant Access in Supabase user_access table using Clerk ID
                        const accessRecords = products.map(p => ({
                            user_id: clerkId,
                            product_id: p.id
                        }));

                        const { error: accessError } = await supabase
                            .from('user_access')
                            .upsert(accessRecords, { onConflict: 'user_id,product_id' });

                        if (accessError) {
                            console.error('Supabase Access Grant Error:', accessError);
                        } else {
                            console.log(`Access granted to Clerk User ${clerkId} (${customerEmail}) for products: ${products.map(p => p.stripe_product_id).join(', ')}`);
                        }

                        // 6. Update Profile in Supabase (optional, keeping it in sync)
                        await supabase.from('profiles').upsert({
                            id: clerkId,
                            email: customerEmail,
                            full_name: customerName,
                        }, { onConflict: 'id' });
                    }
                }

                // 7. Existing GHL Sync Logic
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
