import { defineConfig } from 'vitest/config';

/**
 * Containment suite — the P3 exit criterion.
 *
 * Kept out of the default `test` run because it needs a production build and a
 * real browser, which the hermetic unit suite deliberately does not. Run with
 * `npm run test:containment` after `npm run build`.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.browser.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 150_000,
    fileParallelism: false,
  },
});
