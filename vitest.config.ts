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
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    fileParallelism: false,
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
