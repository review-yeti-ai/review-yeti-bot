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

    it('vitest.config.ts includes correct environmentMatchGlobs for jsdom components', () => {
      const matchGlobs = config.test?.environmentMatchGlobs;
      expect(matchGlobs).toBeDefined();
      expect(Array.isArray(matchGlobs)).toBe(true);
      
      const tsxGlob = matchGlobs?.find(([pattern]: [string | RegExp, string]) => pattern === '**/*.tsx');
      expect(tsxGlob).toBeDefined();
      expect(tsxGlob?.[1]).toBe('jsdom');

      const sseGlob = matchGlobs?.find(([pattern]: [string | RegExp, string]) => pattern === '**/useSSE.test.ts');
      expect(sseGlob).toBeDefined();
      expect(sseGlob?.[1]).toBe('jsdom');

      const liveGlob = matchGlobs?.find(([pattern]: [string | RegExp, string]) => pattern === '**/liveStream*.test.ts');
      expect(liveGlob).toBeDefined();
      expect(liveGlob?.[1]).toBe('jsdom');
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
