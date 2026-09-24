import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  fullSuiteTrigger,
  literalText,
  textReferenceClosure,
} from '../../scripts/ci/select-vitest-tests.mjs';
import { planOutputs, shardCount } from '../../scripts/ci/plan-outputs.mjs';

const root = process.cwd();

/**
 * REL-1074. Pull requests run only the Vitest files their change reaches; everything else, and any
 * PR that touches a global input, runs the whole suite sharded. These pin the parts of that design
 * whose failure would silently shrink the suite: the full-suite triggers, the non-import reference
 * scan, the plan-to-output mapping, and the aggregator that keeps the required check named `test`.
 */
describe('CI incremental test selection (REL-1074)', () => {
  describe('full-suite triggers', () => {
    it.each([
      'package.json',
      'package-lock.json',
      'legacy-runtime/package-lock.json',
      'vitest.config.ts',
      'vitest.release.config.ts',
      'tsconfig.json',
      'tsconfig.server.json',
      'tests/setup.ts',
      'tests/globalSetup.ts',
      '.github/workflows/ci-cd.yaml',
      '.github/workflows/pipelines/review-pipeline.js',
      '.github/actions/node-deps/action.yml',
      'scripts/ensure-pipeline-build.js',
      'scripts/ensure-static-assets.js',
      'scripts/build-domain-index.ts',
      'scripts/ci/select-vitest-tests.mjs',
      'schemas/review-config.schema.json',
      '.env',
      '.env.example',
      '.nvmrc',
    ])('runs everything when %s changes', (file) => {
      expect(fullSuiteTrigger(file)).not.toBeNull();
    });

    it.each(['src/review/reviewCore.js', 'tests/unit/foo.test.ts', 'docs/guide.md', 'k8s-operator/main.go'])(
      'leaves %s to the module graph and reference scan',
      (file) => {
        expect(fullSuiteTrigger(file)).toBeNull();
      },
    );
  });

  describe('references the module graph cannot see', () => {
    const corpusOf = (files: Record<string, string>) =>
      new Map(Object.entries(files).map(([file, text]) => [file, literalText(file, text, ts)]));

    it('reaches a test that reads a fixture through path.join', () => {
      const corpus = corpusOf({
        'tests/unit/cassette.test.ts': "const dir = path.join(__dirname, '..', 'fixtures', 'cassettes');",
        'tests/unit/other.test.ts': "it('x', () => expect(1).toBe(1));",
      });
      const { reached } = textReferenceClosure(['tests/fixtures/cassettes/run-1.json'], corpus);
      expect(reached).toContain('tests/unit/cassette.test.ts');
      expect(reached).not.toContain('tests/unit/other.test.ts');
    });

    it('reaches a contract test that reads a source file as text', () => {
      const corpus = corpusOf({
        'tests/unit/contract.test.ts': "fs.readFileSync(path.join(root, 'k8s', 'review-job-dispatcher.yaml.tpl'), 'utf8');",
      });
      const { reached } = textReferenceClosure(['k8s/review-job-dispatcher.yaml.tpl'], corpus);
      expect(reached).toContain('tests/unit/contract.test.ts');
    });

    it('follows a CommonJS require chain out of the Vite graph to the test that loads it', () => {
      const corpus = corpusOf({
        '.github/workflows/pipelines/review-pipeline.js':
          "try { diffCompactor = require('../../../src/pipeline/diffCompactor'); } catch (_) {}",
        'tests/unit/pipeline.test.ts': "const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));",
      });
      const { reached } = textReferenceClosure(['src/pipeline/diffCompactor.ts'], corpus);
      expect(reached).toContain('.github/workflows/pipelines/review-pipeline.js');
      expect(reached).toContain('tests/unit/pipeline.test.ts');
    });

    it('ignores a file named only in a comment', () => {
      const corpus = corpusOf({
        'src/config/schema.ts': '/** see `src/cli/publishingReview.ts` */\nexport const x = 1;',
      });
      const { reached } = textReferenceClosure(['src/cli/publishingReview.ts'], corpus);
      expect(reached).not.toContain('src/config/schema.ts');
    });

    it('counts a directory scan of code only from tests and out-of-graph scripts', () => {
      const corpus = corpusOf({
        'tests/unit/noOnly.test.ts': "for (const f of fs.readdirSync(path.join(root, 'src', 'review'))) {}",
        'src/cli/routing.ts': "export const paths = ['src/review/**'];",
      });
      const { reached } = textReferenceClosure(['src/review/reviewCore.js'], corpus);
      expect(reached).toContain('tests/unit/noOnly.test.ts');
      expect(reached).not.toContain('src/cli/routing.ts');
    });

    it('treats an ancestor directory as the root of a recursive walk', () => {
      const corpus = corpusOf({
        'tests/unit/walk.test.ts': "const files = walk(path.join(root, 'src'));",
        'tests/unit/elsewhere.test.ts': "const dir = path.join(root, 'src', 'config');",
        'tests/unit/glob.test.ts': "const files = globSync('src/**/*.ts');",
      });
      const { reached } = textReferenceClosure(['src/review/deep/reviewCore.ts'], corpus);
      expect(reached).toContain('tests/unit/walk.test.ts');
      expect(reached).toContain('tests/unit/glob.test.ts');
      expect(reached).not.toContain('tests/unit/elsewhere.test.ts');
    });
  });

  describe('plan outputs', () => {
    const plan = (mode: string, tests: number, postgres: string[] = []) => ({
      mode,
      reason: 'r',
      changed: [],
      tests: Array.from({ length: tests }, (_, i) => `tests/unit/t${i}.test.ts`),
      postgresTests: postgres,
      postgresExcludes: ['tests/integration/a.postgres.test.ts'],
      reaperAcceptance: false,
    });

    it('always shards the full suite four ways and passes no file list', () => {
      const outputs = planOutputs(plan('full', 0));
      expect(outputs['shard-count']).toBe('4');
      expect(JSON.parse(outputs.shards)).toEqual([1, 2, 3, 4]);
      expect(outputs.tests).toBe('[]');
    });

    it('sizes incremental shards by selected files, never beyond the full count', () => {
      expect(shardCount(plan('none', 0))).toBe(0);
      expect(shardCount(plan('subset', 1))).toBe(1);
      expect(shardCount(plan('subset', 60))).toBe(2);
      expect(shardCount(plan('subset', 500))).toBe(4);
    });

    it('always excludes every Postgres-backed file from the plain shards', () => {
      const outputs = planOutputs(plan('subset', 3));
      expect(JSON.parse(outputs['exclude-tests'])).toEqual(['tests/integration/a.postgres.test.ts']);
    });
  });

  describe('workflow', () => {
    const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/ci-cd.yaml'), 'utf8')) as any;
    const jobs = workflow.jobs as Record<string, any>;

    it('keeps the required check name `test` as an always-run aggregator over every test job', () => {
      expect(jobs.test.needs).toEqual(['test-plan', 'vitest', 'vitest-postgres', 'worker-helper', 'build']);
      expect(String(jobs.test.if)).toMatch(/^always\(\) && /u);
      const script = jobs.test.steps.map((step: any) => step.run ?? '').join('\n');
      expect(script).toContain('require test-plan "$PLAN" success');
      expect(script).toContain('require worker-helper "$WORKER_HELPER" success');
      expect(script).toContain('require build "$BUILD" success');
      expect(script).toContain('exit "$failed"');
    });

    it('runs the full suite for every event except a pull request', () => {
      const plan = jobs['test-plan'].steps.find((step: any) => step.id === 'plan').run as string;
      expect(plan).toMatch(/if \[ "\$EVENT_NAME" != "pull_request" \]; then\s+node scripts\/ci\/select-vitest-tests\.mjs --full/u);
      expect(workflow.on.schedule).toHaveLength(1);
      expect(workflow.on.push.branches).toEqual(['main']);
    });

    it('selects from a pinned merge base, not a floating ref', () => {
      const base = jobs['test-plan'].steps.find((step: any) => step.id === 'base');
      expect(base.env.BASE_SHA).toBe('${{ github.event.pull_request.base.sha }}');
      expect(base.env.HEAD_SHA).toBe('${{ github.event.pull_request.head.sha }}');
      expect(base.run).toContain('git merge-base "$BASE_SHA" "$HEAD_SHA"');
      expect(jobs['test-plan'].steps[0].with['fetch-depth']).toBe(0);
    });

    it('starts Postgres only in the job that runs the Postgres-backed files', () => {
      const withPostgres = Object.entries(jobs).filter(([, job]) => job.services?.postgres).map(([name]) => name);
      expect(withPostgres).toEqual(['vitest-postgres']);
    });

    it('shards Vitest from the plan and never fails fast across shards', () => {
      expect(jobs.vitest.strategy['fail-fast']).toBe(false);
      expect(jobs.vitest.strategy.matrix.shard).toBe('${{ fromJSON(needs.test-plan.outputs.shards) }}');
      const run = jobs.vitest.steps.map((step: any) => step.run ?? '').join('\n');
      expect(run).toContain('--shard=${SHARD}/${SHARDS}');
      expect(run).toContain('npm run test:artifacts');
    });

    it('keeps the worker-helper tests and the build as gates of `test`', () => {
      expect(jobs['worker-helper'].steps.some((step: any) => step.run === 'npm run test:worker-helper')).toBe(true);
      expect(jobs.build.steps.some((step: any) => step.run === 'npm run build')).toBe(true);
    });
  });
});
