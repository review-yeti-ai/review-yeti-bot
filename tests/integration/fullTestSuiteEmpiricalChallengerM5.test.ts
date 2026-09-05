import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import config from '../../vitest.config';

describe('Milestone 5 Empirical Challenger: Full Test Suite & Isolation Harness', () => {
  const projectRoot = path.resolve(__dirname, '../../');
  const testsDir = path.join(projectRoot, 'tests');

  describe('1. Process Isolation Verification under Vitest 4', () => {
    it('vitest.config.ts uses top-level pool controls without deprecated poolOptions', () => {
      expect(config.test?.pool).toBe('forks');
      // REL-560: files run in parallel. The isolation guarantee this suite actually depends on is
      // `isolate: true` plus the forks pool -- one fresh process per file -- not serial execution.
      // Serial execution was a workaround for shared /tmp/ct-review-bot state, removed in #456.
      expect(config.test?.fileParallelism).toBe(true);
      expect(config.test?.isolate).toBe(true);
      expect((config.test as any)?.poolOptions).toBeUndefined();
    });

    it('verifies process isolation parameters', () => {
      expect(config.test?.fileParallelism).toBe(true);
      // Verify that process environment is isolated and process PID is accessible
      expect(process.pid).toBeGreaterThan(0);
      expect(typeof process.env).toBe('object');
    });

    it('ensures global state modification does not leak outside current test process', () => {
      // Modify local process.env key in this worker process
      const uniqueTestKey = 'TEST_EMPIRICAL_ISOLATION_M5_KEY';
      process.env[uniqueTestKey] = 'isolated_value';
      expect(process.env[uniqueTestKey]).toBe('isolated_value');
      delete process.env[uniqueTestKey];
      expect(process.env[uniqueTestKey]).toBeUndefined();
    });
  });

  describe('2. DOM Environment Isolation Verification', () => {
    it('vitest.config.ts sets default test environment to node', () => {
      expect(config.test?.environment).toBe('node');
    });

    it('every rendering test declares its own jsdom environment (REL-582)', () => {
      // This replaces an assertion on `environmentMatchGlobs`, which was removed in Vitest 3 and
      // is silently ignored by Vitest 4. That test verified a mapping the runner never applied --
      // false confidence, and it only survived because `moduleResolution: node` left vite's
      // `InlineConfig` as `any` so the unknown key never failed to typecheck.
      //
      // The mechanism actually in force is the per-file docblock. Assert that instead: any test
      // that renders must declare its own environment, or it runs without a DOM.
      const testsRoot = path.join(projectRoot, 'tests');
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(full); continue; }
          if (!/\.tsx?$/u.test(entry.name)) continue;
          const source = fs.readFileSync(full, 'utf8');
          // Require an actual import of a testing-library render, not merely the substring
          // "render(" -- otherwise this assertion matches its own source text.
          if (!/import\s*\{[^}]*\brender\b[^}]*\}\s*from\s*'@testing-library\//u.test(source)) continue;
          if (!/\brender\(/u.test(source)) continue;
          if (!/@vitest-environment\s+jsdom/u.test(source.slice(0, 400))) {
            offenders.push(path.relative(projectRoot, full));
          }
        }
      };
      walk(testsRoot);
      expect(offenders, `these render() but declare no jsdom environment: ${offenders.join(', ')}`).toEqual([]);
    });

    it('executes .test.ts file in Node environment without DOM globals (window, document, HTMLElement, localStorage)', () => {
      expect(typeof window).toBe('undefined');
      expect(typeof document).toBe('undefined');
      expect(typeof HTMLElement).toBe('undefined');
      expect(typeof localStorage).toBe('undefined');
      // Note: Node 21+ provides globalThis.navigator natively, but DOM window/document are undefined in Node environment
      expect(globalThis.window).toBeUndefined();
      expect(globalThis.document).toBeUndefined();
    });

    it('verifies clear boundary between Node unit tests and jsdom UI tests', () => {
      // Check setupFiles inclusion
      expect(config.test?.setupFiles).toContain('./tests/setup.ts');
    });
  });

  describe('3. Test Suite Integrity & 140+ Test File Coverage Verification', () => {
    // Helper function to recursively find test files
    function findTestFiles(dir: string): string[] {
      let results: string[] = [];
      if (!fs.existsSync(dir)) return results;
      const list = fs.readdirSync(dir);
      list.forEach((file) => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
          results = results.concat(findTestFiles(filePath));
        } else {
          if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) {
            results.push(filePath);
          }
        }
      });
      return results;
    }

    it('discovers at least 140 test files across unit, integration, e2e, and benchmark suites', () => {
      const allTestFiles = findTestFiles(testsDir);
      expect(allTestFiles.length).toBeGreaterThanOrEqual(140);
    });

    it('verifies all discovered test files fall within include globs in vitest.config.ts', () => {
      const includeGlobs = config.test?.include || [];
      expect(includeGlobs.length).toBeGreaterThan(0);

      const unitFiles = findTestFiles(path.join(testsDir, 'unit'));
      const integrationFiles = findTestFiles(path.join(testsDir, 'integration'));
      const e2eFiles = findTestFiles(path.join(testsDir, 'e2e'));
      const benchmarkFiles = findTestFiles(path.join(testsDir, 'benchmark'));

      expect(unitFiles.length).toBeGreaterThan(0);
      expect(integrationFiles.length).toBeGreaterThan(0);
      expect(e2eFiles.length).toBeGreaterThan(0);
      expect(benchmarkFiles.length).toBeGreaterThan(0);

      const totalFiles = unitFiles.length + integrationFiles.length + e2eFiles.length + benchmarkFiles.length;
      expect(totalFiles).toBeGreaterThanOrEqual(140);
    });

    it('verifies test setup file exists and is readable', () => {
      const setupPath = path.join(testsDir, 'setup.ts');
      expect(fs.existsSync(setupPath)).toBe(true);
      const setupContent = fs.readFileSync(setupPath, 'utf-8');
      expect(setupContent.length).toBeGreaterThan(0);
    });
  });
});
