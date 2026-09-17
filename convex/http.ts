import { httpRouter } from 'convex/server';
import { internal } from './_generated/api';
import { httpAction } from './_generated/server';

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

export default http;
