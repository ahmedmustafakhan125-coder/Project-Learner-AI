import { defineConfig } from 'vitest/config';

/**
 * Grader calibration: real model calls, so never part of the default run.
 * See test/calibration.live.test.ts.
 */
export default defineConfig({
  test: {
    include: ['test/calibration.live.test.ts'],
    testTimeout: 300_000,
    fileParallelism: false,
  },
});
