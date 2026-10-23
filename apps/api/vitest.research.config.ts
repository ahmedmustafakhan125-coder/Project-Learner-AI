import { defineConfig } from 'vitest/config';

/**
 * Live research and Stack Brief runs: real Claude calls with web search, so
 * never part of the default run. See test/research.live.test.ts and
 * test/brief.live.test.ts.
 */
export default defineConfig({
  test: {
    include: ['test/research.live.test.ts', 'test/brief.live.test.ts'],
    testTimeout: 600_000,
    fileParallelism: false,
  },
});
