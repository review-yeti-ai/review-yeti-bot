import { defineConfig } from 'vitest/config';
import path from 'path';

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
