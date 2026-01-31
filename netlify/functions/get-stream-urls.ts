import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        // 1. Get User ID from headers (passed by frontend after Clerk auth)
        const userId = event.headers['x-user-id'];
        if (!userId) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
        }

        // 2. Verify Access to LIT EP (Product ID: f67a66b8-59a0-413f-b943-8fbb9cdee876)
        const { data: access, error: accessError } = await supabase
            .from('user_access')
            .select('*')
            .eq('user_id', userId)
            .eq('product_id', 'f67a66b8-59a0-413f-b943-8fbb9cdee876')
            .single();

        if (accessError || !access) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Access denied to this product' }) };
        }

        // 3. Define the tracks we expect in the LIT bucket
        const trackFiles = [
            '1. L.I.T. ( Living In Truth).mp3',
            '2. G. O. D.mp3',
            '3. Victory In the Valley.wav',
            '4. Tired.mp3',
            '5. Let Him Cook.mp3',
            '6. Faith.mp3'
        ];

        // 4. Generate Signed URLs for each track
        const signedUrls = await Promise.all(trackFiles.map(async (fileName) => {
            const { data, error } = await supabase
                .storage
                .from('LIT')
                .createSignedUrl(fileName, 7200); // 2 hours

            return {
                fileName,
                url: data?.signedUrl || null,
                error: error?.message || null
            };
        }));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tracks: signedUrls })
        };
    } catch (error: any) {
        console.error('Error getting stream URLs:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal Server Error' })
        };
    }
};
