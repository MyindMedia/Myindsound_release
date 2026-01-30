import { Handler } from '@netlify/functions';
import Stripe from 'stripe';

// Stripe Product IDs
const STRIPE_PRODUCTS = {
    LIT: 'prod_TsqOvYycMrdhnl',
    THE_SOURCE: 'prod_TsqUkQtzNQ5Y3z',
};

export const handler: Handler = async (event) => {
    // Check for Stripe key first
    if (!process.env.STRIPE_SECRET_KEY) {
        console.error('Missing STRIPE_SECRET_KEY environment variable');
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Stripe configuration error. STRIPE_SECRET_KEY not set.' }),
        };
    }

    // Initialize Stripe with the secret key
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { amount, withUpsell, email } = JSON.parse(event.body || '{}');

        // Validate input
        if (!amount || amount < 1) {
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Invalid amount. Minimum is $1.00' }),
            };
        }

        if (!email) {
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Email is required' }),
            };
        }

        const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
            {
                price_data: {
                    currency: 'usd',
                    product: STRIPE_PRODUCTS.LIT,
                    unit_amount: Math.round(amount * 100), // convert to cents
                },
                quantity: 1,
            },
        ];

        if (withUpsell) {
            lineItems.push({
                price_data: {
                    currency: 'usd',
                    product: STRIPE_PRODUCTS.THE_SOURCE,
                    unit_amount: 900, // $9.00
                },
                quantity: 1,
            });
        }

        const session = await stripe.checkout.sessions.create({
            line_items: lineItems,
            mode: 'payment',
            customer_email: email,
            metadata: {
                products: withUpsell ? 'LIT,THE_SOURCE' : 'LIT',
                lit_amount: amount.toString(),
            },
            success_url: `${process.env.URL || 'http://localhost:8888'}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.URL || 'http://localhost:8888'}/`,
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: session.id }),
        };
    } catch (error: any) {
        console.error('Stripe Error:', error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: error.message || 'Failed to create checkout session' }),
        };
    }
};
