import { Handler } from '@netlify/functions';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

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

    console.log('Received Stripe event type:', stripeEvent.type);

    if (stripeEvent.type === 'checkout.session.completed') {
        const session = stripeEvent.data.object as Stripe.Checkout.Session;
        const customerEmail = session.customer_details?.email;

        if (customerEmail) {
            try {
                // Determine tags based on what was purchased
                const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
                const tags = ['LIT-Purchased'];

                const hasSource = lineItems.data.some(item =>
                    item.description?.includes('THE SOURCE')
                );

                if (hasSource) {
                    tags.push('Source-Purchased');
                }

                // Update GHL
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
                            source: 'LIT Checkout Success'
                        })
                    });
                    console.log(`GHL Tags updated for ${customerEmail}: ${tags.join(', ')}`);
                }
            } catch (error) {
                console.error('Error updating GHL on purchase:', error);
            }
        }
    }

    return {
        statusCode: 200,
        body: JSON.stringify({ received: true }),
    };
};
