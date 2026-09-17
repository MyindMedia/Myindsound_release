import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'convex',
          include: ['convex/**/*.test.ts'],
          environment: 'edge-runtime',
          server: { deps: { inline: ['convex-test'] } },
        },
      },
      {
        extends: true,
        test: {
          name: 'frontend',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
