import { Handler } from '@netlify/functions';

/**
 * ghl-lead.ts
 * Captures email leads and sends them to Go High Level with a "LIT-Lead" tag.
 */

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { email } = JSON.parse(event.body || '{}');

        if (!email) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Email is required' }) };
        }

        const apiKey = process.env.GHL_API_KEY;
        const locationId = process.env.GHL_LOCATION_ID;

        if (!apiKey || !locationId) {
            console.error('GHL Configuration missing');
            return { statusCode: 500, body: JSON.stringify({ error: 'GHL not configured' }) };
        }

        // Using GHL V2 API (LeadConnector)
        // https://services.leadconnectorhq.com/contacts/upsert
        const response = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Version': '2021-07-28',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email,
                locationId,
                tags: ['LIT-Lead'],
                source: 'LIT Release Page'
            })
        });

        const data = await response.json();

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, data })
        };
    } catch (error: any) {
        console.error('GHL Lead Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
