import { defineConfig } from 'vitest/config';

/**
 * The offline suite.
 *
 * The longer timeout is for cold starts, not slow tests. The first test in a
 * file that builds the server pays for importing Fastify and every route
 * module, and on a slow or busy machine — the whole monorepo testing in
 * parallel under turbo — that import alone ran past vitest's five-second
 * default, failing tests that do nothing wrong. A real hang still fails.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
    testTimeout: 20_000,
  },
});
