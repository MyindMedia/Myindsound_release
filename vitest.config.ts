import { configDefaults, defineConfig } from 'vitest/config';

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
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'packages/**/*.test.ts'],
          // packages/wear has its own project below; keep it from running twice.
          exclude: [...configDefaults.exclude, 'packages/wear/**'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'wear',
          include: ['packages/wear/test/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
