import { defineConfig } from 'vitest/config';

/**
 * Conformance runs against LIVE provider APIs and therefore costs real money.
 * It is deliberately excluded from the default `npm test` and only runs via
 * `npm run test:conformance`.
 */
export default defineConfig({
  test: {
    include: ['conformance/**/*.conformance.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Providers are rate-limited; run one model at a time.
    fileParallelism: false,
  },
});
