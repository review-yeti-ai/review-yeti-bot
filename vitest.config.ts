import { defineConfig } from 'vitest/config';
import path from 'path';

// Clear proxy environment variables to avoid Supertest routing to local proxy
delete process.env.http_proxy;
delete process.env.HTTP_PROXY;
delete process.env.https_proxy;
delete process.env.HTTPS_PROXY;
delete process.env.all_proxy;
delete process.env.ALL_PROXY;
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

export default defineConfig({
  oxc: {
    jsx: {
      runtime: 'automatic',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  ssr: {
    external: ['node:sqlite'],
  },
  optimizeDeps: {
    exclude: ['node:sqlite'],
  },
  test: {
    env: {
      HTTP_PROXY: '',
      http_proxy: '',
      HTTPS_PROXY: '',
      https_proxy: '',
      ALL_PROXY: '',
      all_proxy: '',
      NO_PROXY: '*',
      no_proxy: '*',
    },
    globals: true,
    environment: 'node',
    server: {
      deps: {
        external: ['node:sqlite'],
      },
    },
    setupFiles: ['./tests/setup.ts'],
    environmentMatchGlobs: [
      ['**/*.tsx', 'jsdom'],
      ['tests/**/*.tsx', 'jsdom'],
      ['tests/unit/components/**', 'jsdom'],
      ['**/useSSE.test.ts', 'jsdom'],
      ['**/liveStream*.test.ts', 'jsdom']
    ],
    include: [
      'src/**/*.test.ts',
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.tsx',
      'tests/integration/**/*.test.ts',
      'tests/integration/**/*.test.tsx',
      'tests/e2e/**/*.test.ts',
      'tests/benchmark/**/*.test.ts'
    ],
    cacheDir: 'node_modules/.vitest',
    pool: 'forks',
    // REL-560: run test files in parallel. Serial execution left the runner idle -- measured 117%
    // CPU across a full run on a 16-core machine, versus 443% and a ~4x wall-clock win at four
    // workers. After #456 gave every worker its own disposable state root, files no longer share
    // `/tmp/ct-review-bot`, which is what made serial execution load-bearing in the first place.
    //
    // Wall-clock budget assertions are the known hazard here: a `toBeLessThan(<ms>)` measured
    // inside one worker now includes contention from the others. Where those are real signal they
    // are scaled by the worker count (see tests/support/timing.ts); where a test genuinely cannot
    // tolerate a neighbour it must say so, not force the whole suite back into single file.
    fileParallelism: true,
    isolate: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', 'tests/'],
      thresholds: {
        lines: 75,
        functions: 80,
        branches: 60,
        statements: 75
      }
    }
  }
});
