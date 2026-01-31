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

// Handle physical merchandise orders
async function handlePhysicalOrder(
    session: Stripe.Checkout.Session,
    lineItems: Stripe.ApiList<Stripe.LineItem>,
    customerEmail: string,
    customerName: string | null | undefined
) {
    // Get or create Clerk user
    let clerkUser;
    const users = await clerk.users.getUserList({ emailAddress: [customerEmail] });

    if (users.data.length > 0) {
        clerkUser = users.data[0];
    } else {
        try {
            clerkUser = await clerk.users.createUser({
                emailAddress: [customerEmail],
                firstName: customerName?.split(' ')[0] || '',
                lastName: customerName?.split(' ').slice(1).join(' ') || '',
                skipPasswordRequirement: true,
            });
        } catch (e) {
            console.error('Clerk User Creation Error:', e);
        }
    }

    const clerkId = clerkUser?.id;
    if (!clerkId) {
        console.error('Could not get Clerk user ID for physical order');
        return;
    }

    // Create physical order record
    const shippingAddress = (session as any).shipping_details?.address;
    const { data: order, error: orderError } = await supabase
        .from('physical_orders')
        .insert({
            user_id: clerkId,
            stripe_payment_id: session.payment_intent as string,
            total_amount: session.amount_total,
            shipping_address: {
                name: (session as any).shipping_details?.name || customerName,
                line1: shippingAddress?.line1,
                line2: shippingAddress?.line2,
                city: shippingAddress?.city,
                state: shippingAddress?.state,
                postal_code: shippingAddress?.postal_code,
                country: shippingAddress?.country,
            },
            order_status: 'pending',
        })
        .select()
        .single();

    if (orderError) {
        console.error('Physical Order Creation Error:', orderError);
        return;
    }

    // Create order items
    const orderItems = lineItems.data.map(item => ({
        order_id: order.id,
        product_id: (item.price?.product as any)?.metadata?.product_id || item.description,
        product_name: item.description || 'Unknown Product',
        variant: (item.price?.product as any)?.metadata?.variant || null,
        quantity: item.quantity || 1,
        unit_price: item.price?.unit_amount || 0,
    }));

    const { error: itemsError } = await supabase
        .from('order_items')
        .insert(orderItems);

    if (itemsError) {
        console.error('Order Items Creation Error:', itemsError);
    }

    // Update profile
    await supabase.from('profiles').upsert({
        id: clerkId,
        email: customerEmail,
        full_name: customerName,
    }, { onConflict: 'id' });

    // Sync to GHL
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
                tags: ['Merch-Purchased'],
                source: 'Physical Store'
            })
        });
    }

    console.log(`Physical order created: ${order.id} for user ${clerkId}`);
}

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
        const orderType = session.metadata?.order_type;

        if (customerEmail) {
            try {
                // 1. Get Line Items
                const lineItems = await stripe.checkout.sessions.listLineItems(session.id);

                // Handle physical orders
                if (orderType === 'physical') {
                    await handlePhysicalOrder(session, lineItems, customerEmail, customerName);
                    return { statusCode: 200, body: JSON.stringify({ received: true }) };
                }

                // 2. Map Stripe Products to Supabase Products
                const purchasedStripeProductIds = lineItems.data.map(item => item.price?.product as string);

                // 3. Find matching products in Supabase
                const { data: products } = await supabase
                    .from('products')
                    .select('id, stripe_product_id, name')
                    .in('stripe_product_id', purchasedStripeProductIds);

                if (products && products.length > 0) {
                    // 4. Ensure User Exists in Clerk
                    let clerkUser;
                    const users = await clerk.users.getUserList({ emailAddress: [customerEmail] });

                    if (users.data.length > 0) {
                        clerkUser = users.data[0];
                    } else {
                        try {
                            clerkUser = await clerk.users.createUser({
                                emailAddress: [customerEmail],
                                firstName: customerName?.split(' ')[0] || '',
                                lastName: customerName?.split(' ').slice(1).join(' ') || '',
                                skipPasswordRequirement: true,
                            });
                        } catch (e) {
                            console.error('Clerk User Creation Error:', e);
                        }
                    }

                    const clerkId = clerkUser?.id;

                    if (clerkId) {
                        // 5. Grant Access in Supabase user_access table
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
                            console.log(`SUCCESS: Access granted to ${customerEmail} (Clerk: ${clerkId}) for: ${products.map(p => p.name).join(', ')}`);

                            // 6. Simulate Confirmation Email
                            console.log(`EMAIL SIMULATION: Sending confirmation to ${customerEmail}`);
                            // In a real app, use Resend/SendGrid here:
                            // await sendConfirmationEmail(customerEmail, products);
                        }

                        // 7. Update Profile in Supabase
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
