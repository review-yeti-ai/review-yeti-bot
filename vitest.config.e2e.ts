import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  test: {
    name: 'e2e-test-suite',
    include: ['tests/e2e/**/*.test.ts', 'tests/unit/harnessSmoke.test.ts'],
    passWithNoTests: true,
    globalSetup: ['tests/e2e/harness/globalSetup.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 10000,
    threads: true,
    maxThreads: 4,
    minThreads: 1,
    reporters: ['default'],
  },
  resolve: {
    alias: {
      '@src': path.resolve(__dirname, './src'),
      '@harness': path.resolve(__dirname, './tests/e2e/harness'),
    },
  },
});
