import { defineConfig } from 'vitest/config';

/**
 * Live-database suite.
 *
 * Separate from the default run because it needs a real Supabase project and
 * writes rows. The offline suite stays hermetic — no network, no keys, no
 * database — so it can run anywhere, including a fresh clone in CI.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.live.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
