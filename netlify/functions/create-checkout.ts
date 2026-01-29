import { Handler } from '@netlify/functions';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { amount, withUpsell, email } = JSON.parse(event.body || '{}');

        const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
            {
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'LIT (Digital Release)',
                        description: 'Your pay-what-you-want digital EP',
                    },
                    unit_amount: Math.round(amount * 100), // convert to cents
                },
                quantity: 1,
            },
        ];

        if (withUpsell) {
            lineItems.push({
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'THE SOURCE (Presale)',
                        description: 'Exclusive pre-save of THE SOURCE EP',
                    },
                    unit_amount: 900,
                },
                quantity: 1,
            });
        }

        const session = await stripe.checkout.sessions.create({
            line_items: lineItems,
            mode: 'payment',
            customer_email: email,
            success_url: `${process.env.URL || 'http://localhost:8888'}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.URL || 'http://localhost:8888'}/`,
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ id: session.id }),
        };
    } catch (error: any) {
        console.error('Stripe Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message }),
        };
    }
};
