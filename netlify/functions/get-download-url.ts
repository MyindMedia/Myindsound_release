import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { userId, productId } = JSON.parse(event.body || '{}');

        if (!userId || !productId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId or productId' }) };
        }

        // 1. Verify Access
        const { data: access, error: accessError } = await supabase
            .from('user_access')
            .select('*')
            .eq('user_id', userId)
            .eq('product_id', productId)
            .single();

        if (accessError || !access) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Access denied' }) };
        }

        // 2. Logic to map productId to actual storage file
        // For LIT Product ID: f67a66b8-59a0-413f-b943-8fbb9cdee876
        let fileName = '';
        let bucket = '';

        if (productId === 'f67a66b8-59a0-413f-b943-8fbb9cdee876') {
            fileName = 'ThaMyind - LIT EP.zip';
            bucket = 'LIT';
        } else {
            return { statusCode: 404, body: JSON.stringify({ error: 'Download not available for this product yet' }) };
        }

        // 3. Generate Signed URL
        const { data, error: storageError } = await supabase
            .storage
            .from(bucket)
            .createSignedUrl(fileName, 3600); // 1 hour

        if (storageError || !data) {
            return { statusCode: 500, body: JSON.stringify({ error: 'Error generating download link' }) };
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadUrl: data.signedUrl })
        };
    } catch (error: any) {
        console.error('Error in get-download-url:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal Server Error' })
        };
    }
};
