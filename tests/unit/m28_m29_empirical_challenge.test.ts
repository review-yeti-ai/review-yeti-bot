import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import {
  ReflectionCommandParser,
  LearningStore,
  FeedbackListener,
  NitSuppressionEngine,
} from '../../src/reflection';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { scanRepositoryStack } from '../../src/onboarding/stackScanner';
import { generateCtReviewConfig } from '../../src/onboarding/configGenerator';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import { Finding } from '../../src/reflection/nitSuppressionEngine';
import { timeBudgetMs } from '../support/timeBudget';

describe('EMPIRICAL STRESS TEST: Milestone 28 & Milestone 29', () => {
  let memoryStore: PRMemoryStore;
  let learningStore: LearningStore;
  let nitEngine: NitSuppressionEngine;
  let tempDirsToClean: string[] = [];

  const createTempDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `m28_m29_stress_${prefix}_`));
    tempDirsToClean.push(dir);
    return dir;
  };

  beforeEach(() => {
    memoryStore = new PRMemoryStore(':memory:');
    learningStore = new LearningStore(memoryStore);
    nitEngine = new NitSuppressionEngine(memoryStore);
  });

  afterEach(() => {
    learningStore.close();
    for (const dir of tempDirsToClean) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
    tempDirsToClean = [];
  });

  // =========================================================================
  // MILESTONE 28 STRESS TESTS
  // =========================================================================
  describe('Milestone 28: Session Reflection Engine Stress Test', () => {
    describe('1. @ct-review learn Command Parsing Edge Cases', () => {
      const parser = new ReflectionCommandParser();

      it('should handle null, empty, and whitespace-only strings gracefully', () => {
        expect(parser.parse('')).toBeNull();
        expect(parser.parse('   ')).toBeNull();
        // @ts-ignore
        expect(parser.parse(null)).toBeNull();
        // @ts-ignore
        expect(parser.parse(undefined)).toBeNull();
      });

      it('should handle casing and extra whitespace variations', () => {
        const text = '   @ct-review learn   convention: Avoid console.log - Use winston   ';
        const res = parser.parse(text);
        expect(res).not.toBeNull();
        expect(res?.type).toBe('learning');
        expect(res?.category).toBe('convention');
        expect(res?.title).toBe('Avoid console.log');
        expect(res?.description).toBe('Use winston');
      });

      it('should stress-test case-sensitivity of @ct-review learn trigger', () => {
        const uppercaseTrigger = '@CT-REVIEW LEARN convention: Test Title - Test Desc';
        const resUpper = parser.parse(uppercaseTrigger);
        // Remediated: parse() is now case-insensitive
        expect(resUpper).not.toBeNull();
        expect(resUpper?.category).toBe('convention');
        expect(resUpper?.title).toBe('Test Title');
      });

      it('should parse complex ADR inputs with custom path globs', () => {
        const text = '@ct-review learn adr 101: Zero Trust Token Verification | Validate JWT signature on every RPC call | src/auth/**/*, src/gateway/**/*.ts';
        const res = parser.parse(text);
        expect(res).not.toBeNull();
        expect(res?.type).toBe('adr');
        expect(res?.adrNumber).toBe(101);
        expect(res?.title).toBe('Zero Trust Token Verification');
        expect(res?.description).toBe('Validate JWT signature on every RPC call');
        expect(res?.targetPaths).toEqual(['src/auth/**/*', 'src/gateway/**/*.ts']);
      });

      it('should handle nit commands with regex special characters and multiple pipes', () => {
        const text = '@ct-review learn nit: (err) => console.error(err) | Allow shorthand error log in test fixtures | extra | pipe';
        const res = parser.parse(text);
        expect(res).not.toBeNull();
        expect(res?.type).toBe('nit');
        expect(res?.pattern).toBe('(err) => console.error(err)');
        expect(res?.reason).toBe('Allow shorthand error log in test fixtures | extra | pipe');
      });

      it('should handle ReDoS and regex injection patterns safely in pattern string', () => {
        const redosPattern = '@ct-review learn nit: (a+)+$ | ReDoS test pattern';
        const res = parser.parse(redosPattern);
        expect(res).not.toBeNull();
        expect(res?.pattern).toBe('(a+)+$');
      });

      it('should stress-test multiline and special character content parsing', () => {
        const multilineText = `@ct-review learn security: Sanitize SQL Input - Protect against \\' OR \\'1\\'=\\'1
And newline injection attacks <script>alert(1)</script>`;
        const res = parser.parse(multilineText);
        expect(res).not.toBeNull();
        expect(res?.type).toBe('learning');
        // Remediated: multiline text preserves category 'security'
        expect(res?.category).toBe('security');
        expect(res?.title).toBe('Sanitize SQL Input');
        expect(res?.description).toContain('Protect against');
      });
    });

    describe('2. Reaction Feedback Parsing & Reply Refutation Patterns', () => {
      it('should test reaction type registration and document thumbsup mismatch', async () => {
        const listener = new FeedbackListener(learningStore);

        // Positive reactions
        await listener.handleReaction({ commentId: 1, reaction: '+1' });
        await listener.handleReaction({ commentId: 2, reaction: 'thumbsup' }); // Standard GitHub API reaction string
        await listener.handleReaction({ commentId: 3, reaction: 'thumbs_up' });
        await listener.handleReaction({ commentId: 4, reaction: 'like' });

        // Negative reactions
        await listener.handleReaction({ commentId: 5, reaction: '-1' });
        await listener.handleReaction({ commentId: 6, reaction: 'thumbsdown' });
        await listener.handleReaction({ commentId: 7, reaction: 'dislike' });
        await listener.handleReaction({ commentId: 8, reaction: 'thumbs_down' });

        const stats = await learningStore.getStats('default/repo');
        // Remediated: all 4 positive and 4 negative reactions are correctly recognized
        expect(stats.positiveFeedbackCount).toBe(4);
        expect(stats.negativeFeedbackCount).toBe(4);
      });

      it('should parse reply refutation phrases and record nit suppressions', async () => {
        const listener = new FeedbackListener(learningStore);

        const replyCases = [
          { body: 'This is a false positive review comment', expectedRecorded: true },
          { body: 'Please IGNORE this style suggestion', expectedRecorded: true },
          { body: 'It is just a minor nit, ignore it', expectedRecorded: true },
          { body: 'Great change, LGTM!', expectedRecorded: false },
          { body: 'Fixed in latest commit', expectedRecorded: false },
        ];

        for (let i = 0; i < replyCases.length; i++) {
          const item = replyCases[i];
          await listener.handleReply({
            owner: 'testorg',
            repo: 'testrepo',
            prNumber: 99,
            commentId: 100 + i,
            body: item.body,
          });
        }

        const learnings = await learningStore.getLearnedContext('testorg/testrepo');
        expect(learnings.resolvedNits.length).toBe(3);
      });
    });

    describe('3. Precision Nit Suppression Logic & Memory Storage', () => {
      it('should suppress only nits (severity: nit/minor/P2) matching pattern and record count', async () => {
        await memoryStore.recordResolvedNit('org/repo', 10, {
          pattern: 'unused import',
          filePath: 'src/utils/*.ts',
          reason: 'Cleaned up by linter',
        });

        const findings: Finding[] = [
          {
            id: 'f1',
            severity: 'P2',
            path: 'src/utils/logger.ts',
            title: 'Unused import found in logger module',
            body: 'Remove unused import stdlib',
          },
          {
            id: 'f2',
            severity: 'P0', // Critical severity must NOT be suppressed
            path: 'src/utils/logger.ts',
            title: 'Unused import causes security leak',
            body: 'Unused import contains secret key',
          },
          {
            id: 'f3',
            severity: 'minor',
            path: 'src/components/button.tsx', // Does not match src/utils/*.ts
            title: 'Unused import in UI',
            body: 'Unused import React',
          },
        ];

        const result = await nitEngine.suppressNits('org/repo', findings);

        // Verify active vs suppressed: f2 (P0) and f3 (non-matching path) retained
        expect(result.activeFindings.length).toBe(2);
        expect(result.suppressedFindings.length).toBe(1); // Only f1 suppressed

        // Verify SQLite suppression count increment
        const memoryResult = await memoryStore.queryLearnings('org/repo');
        expect(memoryResult.resolvedNits[0].suppressionCount).toBe(1);
      });

      it('should handle special regex characters in nit pattern safely without throwing', async () => {
        await memoryStore.recordResolvedNit('org/repo', 11, {
          pattern: 'console.log(val) [debug]',
          filePath: '**',
          reason: 'Debug log statement',
        });

        const findings: Finding[] = [
          {
            severity: 'nit',
            path: 'src/app.ts',
            title: 'console.log(val) [debug] detected',
            body: 'Remove before release',
          },
        ];

        expect(async () => {
          await nitEngine.suppressNits('org/repo', findings);
        }).not.toThrow();
      });

      it('should evaluate path globs in nit suppression engine correctly', async () => {
        await memoryStore.recordResolvedNit('org/repo', 12, {
          pattern: 'magic number',
          filePath: 'src/constants/**/*.ts',
          reason: 'Magic numbers allowed in constants directory',
        });

        const findings: Finding[] = [
          {
            severity: 'P2',
            path: 'src/constants/http/codes.ts',
            title: 'Magic number 404 found',
            body: 'Extract magic number',
          },
          {
            severity: 'P2',
            path: 'src/core/auth.ts', // Different directory!
            title: 'Magic number 3600 found',
            body: 'Extract magic number',
          },
        ];

        const res = await nitEngine.suppressNits('org/repo', findings);
        // Remediated: path glob matches src/constants/http/codes.ts, not src/core/auth.ts
        expect(res.suppressedFindings.length).toBe(1);
        expect(res.activeFindings.length).toBe(1);
      });
    });
  });

  // =========================================================================
  // MILESTONE 29 STRESS TESTS
  // =========================================================================
  describe('Milestone 29: Zero-Config Onboarding Wizard Stress Test', () => {
    const currentRepoRoot = path.resolve(__dirname, '../../');

    describe('1. Tech Stack Scanner Speed Benchmark (< 1000ms SLA)', () => {
      it('should complete repository scan under 1000ms SLA across 10 iterations', async () => {
        // Warmup run to prime module cache & I/O pool
        await scanRepositoryStack(currentRepoRoot);

        const durations: number[] = [];
        const ITERATIONS = 10;

        for (let i = 0; i < ITERATIONS; i++) {
          const t0 = performance.now();
          const scan = await scanRepositoryStack(currentRepoRoot);
          const t1 = performance.now();
          const elapsed = t1 - t0;
          durations.push(elapsed);

          expect(scan.detection.scanDurationMs).toBeLessThan(timeBudgetMs(3000));
          expect(elapsed).toBeLessThan(timeBudgetMs(3000));
        }

        durations.sort((a, b) => a - b);
        const min = durations[0];
        const max = durations[durations.length - 1];
        const avg = durations.reduce((a, b) => a + b, 0) / ITERATIONS;
        const p95 = durations[Math.floor(ITERATIONS * 0.95)];

        console.log(`[M29 BENCHMARK]: Tech Stack Scanner SLA Metric over ${ITERATIONS} runs:`);
        console.log(`  - Min: ${min.toFixed(2)}ms`);
        console.log(`  - Max: ${max.toFixed(2)}ms`);
        console.log(`  - Avg: ${avg.toFixed(2)}ms`);
        console.log(`  - P95: ${p95.toFixed(2)}ms`);

        expect(max).toBeLessThan(timeBudgetMs(1000));
        expect(p95).toBeLessThan(timeBudgetMs(1000));
      }, 15000);
    });

    describe('2. Stack Detection Accuracy Across All 8 Target Stacks', () => {
      it('should accurately detect TypeScript (TS) stack', async () => {
        const dir = createTempDir('ts');
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { typescript: '^5.0.0' } }));
        fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
        fs.writeFileSync(path.join(dir, 'index.ts'), 'const a: number = 1;');

        const res = await scanRepositoryStack(dir);
        expect(res.detection.languages.TypeScript).toBeGreaterThan(0);
        expect(res.detection.manifestsFound).toContain('package.json');
        expect(res.detection.manifestsFound).toContain('tsconfig.json');
        expect(res.recommendedPersonas.some((p) => p.id === 'ts-node-architect')).toBe(true);
      });

      it('should accurately detect JavaScript (JS) stack', async () => {
        const dir = createTempDir('js');
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '^4.18.0' } }));
        fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("hello");');

        const res = await scanRepositoryStack(dir);
        expect(res.detection.languages.JavaScript).toBeGreaterThan(0);
        expect(res.detection.frameworks).toContain('Express');
        expect(res.recommendedPersonas.some((p) => p.id === 'ts-node-architect')).toBe(true);
      });

      it('should accurately detect Python (Py) stack', async () => {
        const dir = createTempDir('py');
        fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[tool.poetry.dependencies]\nfastapi = "^0.100.0"');
        fs.writeFileSync(path.join(dir, 'requirements.txt'), 'fastapi==0.100.0');
        fs.writeFileSync(path.join(dir, 'main.py'), 'print("python")');

        const res = await scanRepositoryStack(dir);
        expect(res.detection.languages.Python).toBeGreaterThan(0);
        expect(res.detection.frameworks).toContain('FastAPI');
        expect(res.recommendedPersonas.some((p) => p.id === 'python-architect')).toBe(true);
      });

      it('should accurately detect Go stack', async () => {
        const dir = createTempDir('go');
        fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/app\n\ngo 1.22');
        fs.writeFileSync(path.join(dir, 'main.go'), 'package main\nfunc main() {}');

        const res = await scanRepositoryStack(dir);
        expect(res.detection.languages.Go).toBeGreaterThan(0);
        expect(res.detection.manifestsFound).toContain('go.mod');
        expect(res.recommendedPersonas.some((p) => p.id === 'go-systems-engineer')).toBe(true);
      });

      it('should accurately detect Java stack', async () => {
        const dir = createTempDir('java');
        fs.writeFileSync(path.join(dir, 'pom.xml'), '<project></project>');
        fs.writeFileSync(path.join(dir, 'Application.java'), 'public class Application {}');

        const res = await scanRepositoryStack(dir);
        expect(res.detection.languages.Java).toBeGreaterThan(0);
        expect(res.detection.manifestsFound).toContain('pom.xml');
        expect(res.recommendedPersonas.some((p) => p.id === 'java-enterprise-reviewer')).toBe(true);
      });

      it('should accurately detect Elixir stack', async () => {
        const dir = createTempDir('elixir');
        fs.writeFileSync(path.join(dir, 'mix.exs'), 'defmodule App.MixProject do end');
        fs.writeFileSync(path.join(dir, 'app.ex'), 'defmodule App do end');

        const res = await scanRepositoryStack(dir);
        expect(res.detection.languages.Elixir).toBeGreaterThan(0);
        expect(res.detection.manifestsFound).toContain('mix.exs');
        expect(res.recommendedPersonas.some((p) => p.id === 'elixir-beam-architect')).toBe(true);
      });

      it('should accurately detect Docker stack', async () => {
        const dir = createTempDir('docker');
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:20');
        fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'version: "3"');

        const res = await scanRepositoryStack(dir);
        expect(res.detection.infrastructure).toContain('Docker');
        expect(res.recommendedPersonas.some((p) => p.id === 'devops-sec-ops')).toBe(true);
      });

      it('should accurately detect Kubernetes (K8s) stack', async () => {
        const dir = createTempDir('k8s');
        fs.writeFileSync(path.join(dir, 'Chart.yaml'), 'apiVersion: v2');
        fs.mkdirSync(path.join(dir, 'k8s'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'k8s', 'deployment.yaml'), 'apiVersion: apps/v1');

        const res = await scanRepositoryStack(dir);
        expect(res.detection.infrastructure.some((i) => i.includes('Kubernetes'))).toBe(true);
        expect(res.recommendedPersonas.some((p) => p.id === 'devops-sec-ops')).toBe(true);
      });

      it('should accurately detect Polyglot multi-stack repository', async () => {
        const dir = createTempDir('polyglot');
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { typescript: '^5.0.0' } }));
        fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
        fs.writeFileSync(path.join(dir, 'main.py'), 'print("py")');
        fs.writeFileSync(path.join(dir, 'go.mod'), 'module test');
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node');

        const res = await scanRepositoryStack(dir);
        expect(res.detection.languages.TypeScript).toBeGreaterThan(0);
        expect(res.detection.languages.Python).toBeGreaterThan(0);
        expect(res.detection.languages.Go).toBeGreaterThan(0);
        expect(res.detection.infrastructure).toContain('Docker');
        expect(res.recommendedPersonas.length).toBeGreaterThanOrEqual(4);
      });
    });

    describe('3. Auto-Generated .ct-review.yaml String Zod Schema Validation', () => {
      it('should validate generated YAML text against ctReviewConfigV3Schema for all profiles', async () => {
        const profiles: Array<'chill' | 'balanced' | 'assertive'> = ['chill', 'balanced', 'assertive'];

        for (const profile of profiles) {
          const scanResult = await scanRepositoryStack(currentRepoRoot);
          const generated = generateCtReviewConfig({
            scanResult,
            profile,
            ticketEnforcement: profile === 'assertive',
          });

          // 1. Check generated string structure
          expect(generated.yamlText).toBeTypeOf('string');
          expect(generated.yamlText).toContain(`profile: ${profile}`);
          expect(generated.yamlText).toContain('version: 3');

          // 2. Parse YAML text into object
          const parsedYamlObj = yaml.load(generated.yamlText);

          // 3. Validate against Zod schema
          const validationResult = ctReviewConfigV3Schema.safeParse(parsedYamlObj);

          if (!validationResult.success) {
            console.error(`[M29 ZOD VALIDATION ERROR] Profile ${profile}:`, validationResult.error.format());
          }

          expect(validationResult.success).toBe(true);
        }
      }, 20000);
    });
  });
});
