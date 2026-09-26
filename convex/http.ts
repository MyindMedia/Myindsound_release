import { httpRouter } from 'convex/server';
import { internal } from './_generated/api';
import { httpAction } from './_generated/server';
import { streamTrack } from './media';
import { handleNotification } from './storekit';

const http = httpRouter();

http.route({
  path: '/stripe/webhook',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const signature = request.headers.get('stripe-signature');
    if (!signature) return new Response('Missing signature', { status: 400 });
    const payload = await request.text();
    const { status } = await ctx.runAction(internal.payments.handleWebhook, { payload, signature });
    return new Response(status === 200 ? 'ok' : 'error', { status });
  }),
});

// App audio (AUD-1 option (a), AUD-2): a 5 minute signed link from `media.getStreamUrl`, served with byte ranges.
http.route({ path: '/media/stream', method: 'GET', handler: streamTrack });

// App Store Server Notifications V2 (PAY-8): signed by Apple, verified in storekit.ts. REFUND and REVOKE revoke.
http.route({ path: '/appstore/notifications', method: 'POST', handler: handleNotification });

export default http;
