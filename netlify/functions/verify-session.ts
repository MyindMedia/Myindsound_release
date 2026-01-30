import { Handler } from '@netlify/functions';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

export const handler: Handler = async (event) => {
    const sessionId = event.queryStringParameters?.session_id;

    if (!sessionId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Missing session_id' }),
        };
    }

    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
            expand: ['line_items'],
        });

        if (!session || session.payment_status !== 'paid') {
            return {
                statusCode: 403,
                body: JSON.stringify({ error: 'Session not paid or not found' }),
            };
        }

        const lineItems = session.line_items?.data || [];
        const purchasedItems = lineItems.map(item => item.description);

        // Check for specific products
        const hasLit = purchasedItems.some(desc => desc?.includes('LIT'));
        const hasSource = purchasedItems.some(desc => desc?.includes('THE SOURCE'));

        const downloads = [];

        if (hasLit) {
            downloads.push({
                name: 'LIT (Digital EP)',
                url: process.env.LIT_DOWNLOAD_URL || 'https://luowwakouydxyzfnsyki.supabase.co/storage/v1/object/public/LIT/LIT_Digital_EP.zip',
                type: 'standard'
            });
        }

        if (hasSource) {
            downloads.push({
                name: 'THE SOURCE (Presale EP)',
                url: process.env.UNTITLED_LINK_SOURCE || 'https://untitled.stream/library/project/PLACEHOLDER_SOURCE',
                type: 'upsell'
            });
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                customer: session.customer_details?.name,
                downloads
            }),
        };
    } catch (error: any) {
        console.error('Session Verification Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal Server Error' }),
        };
    }
};
