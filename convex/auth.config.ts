// Clerk issues a JWT from the template named "convex" (aud: "convex").
// The template must exist on every Clerk instance this deployment trusts.
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: 'convex',
    },
  ],
};
