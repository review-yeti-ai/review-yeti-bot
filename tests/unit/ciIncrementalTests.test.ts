import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  POSTGRES_MARKERS,
  REAPER_ACCEPTANCE,
  changedFiles,
  fullSuiteTrigger,
  literalText,
  parseNameStatus,
  isPostgresFile,
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

  describe('changed files', () => {
    it('keeps both sides of a rename or copy and stays aligned across entries', () => {
      const output = ['M', 'src/a.ts', 'R100', 'tests/fixtures/old.json', 'tests/fixtures/new.json',
        'C075', 'scripts/x.mjs', 'scripts/y.mjs', 'D', 'docs/gone.md', 'A', 'src/b.ts', ''].join('\0');
      expect(parseNameStatus(output)).toEqual([
        'docs/gone.md', 'scripts/x.mjs', 'scripts/y.mjs', 'src/a.ts', 'src/b.ts',
        'tests/fixtures/new.json', 'tests/fixtures/old.json',
      ]);
    });

    it('rejects output it does not understand instead of guessing', () => {
      expect(() => parseNameStatus('R100\0only-one-path\0')).toThrow(/truncated/u);
      expect(() => parseNameStatus('src/a.ts\0M\0')).toThrow(/unexpected/u);
    });

    it('refuses a floating ref or an unknown commit as the base', () => {
      expect(() => changedFiles('main', 'HEAD')).toThrow(/full commit SHA/u);
      expect(() => changedFiles('0'.repeat(40), 'HEAD')).toThrow();
    });
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

    it('narrows a directory reference that continues into a literal subdirectory', () => {
      const corpus = corpusOf({
        'tests/unit/dir.test.ts': "fs.readdirSync(path.join(root, 'src', 'review'));",
        'tests/unit/sub.test.ts': "fs.readdirSync(path.join(root, 'src', 'review', 'sub'));",
      });
      const { reached } = textReferenceClosure(['src/review/reviewCore.js'], corpus, new Map([['src/review', new Set(['sub'])]]));
      expect(reached).toContain('tests/unit/dir.test.ts');
      expect(reached).not.toContain('tests/unit/sub.test.ts');
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
    const plan = (mode: string, tests: number, postgres: string[] = [], reaper = false) => ({
      mode,
      reason: 'r',
      changed: [],
      tests: Array.from({ length: tests }, (_, i) => `tests/unit/t${i}.test.ts`),
      postgresTests: postgres,
      postgresExcludes: ['tests/integration/a.postgres.test.ts'],
      reaperAcceptance: reaper,
    });

    it('always shards the full suite four ways and passes no file list', () => {
      const outputs = planOutputs(plan('full', 0, ['tests/integration/a.postgres.test.ts'], true));
      expect(outputs['shard-count']).toBe('4');
      expect(JSON.parse(outputs.shards)).toEqual([1, 2, 3, 4]);
      expect(outputs.tests).toBe('[]');
      expect(JSON.parse(outputs['postgres-tests'])).toEqual(['tests/integration/a.postgres.test.ts']);
      expect(outputs['reaper-acceptance']).toBe('true');
    });

    it.each([[0, 0], [1, 1], [25, 1], [26, 2], [80, 2], [81, 3], [160, 3], [161, 4], [500, 4]])(
      'sizes an incremental run of %i files at %i shard(s)',
      (files, shards) => {
        expect(shardCount(plan(files ? 'subset' : 'none', files))).toBe(shards);
      },
    );

    it('hands the selected Postgres files and the reaper flag to the Postgres job', () => {
      const selected = planOutputs(plan('subset', 3, ['tests/integration/a.postgres.test.ts'], true));
      expect(JSON.parse(selected['postgres-tests'])).toEqual(['tests/integration/a.postgres.test.ts']);
      expect(selected['reaper-acceptance']).toBe('true');
      const none = planOutputs(plan('subset', 3));
      expect(none['postgres-tests']).toBe('[]');
      expect(none['reaper-acceptance']).toBe('false');
    });

    it('always excludes every Postgres-backed file from the plain shards', () => {
      const outputs = planOutputs(plan('subset', 3));
      expect(JSON.parse(outputs['exclude-tests'])).toEqual(['tests/integration/a.postgres.test.ts']);
    });

    it('names the same reaper harness file the npm script runs', () => {
      const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      expect(packageJson.scripts['test:acceptance:reaper'].split(/\s+/u)).toContain(REAPER_ACCEPTANCE);
      expect(fs.existsSync(path.join(root, REAPER_ACCEPTANCE))).toBe(true);
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
      expect(script).toContain(
        'if [ "$SHARD_COUNT" = "0" ]; then require vitest "$VITEST" skipped; else require vitest "$VITEST" success; fi',
      );
      expect(script).toContain(
        'if [ "$POSTGRES_TESTS" = "[]" ]; then require vitest-postgres "$VITEST_POSTGRES" skipped; '
          + 'else require vitest-postgres "$VITEST_POSTGRES" success; fi',
      );
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

  describe('Postgres classification (REL-1069)', () => {
    // The detector decides which JOB owns a suite. A refactor once silently emptied
    // it: thirteen suites stopped spelling the env var literally, all were routed
    // into the plain shards (which have no database), and CI went red. These pin
    // both directions -- recognition must survive the helper, and must not widen.
    const matches = (source: string) => POSTGRES_MARKERS.some((marker: RegExp) => marker.test(source));

    it('recognises the legacy literal spelling', () => {
      expect(matches("const url = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();")).toBe(true);
    });

    it('recognises the shared helper, so consolidating cannot declassify a suite', () => {
      expect(matches('const databaseUrl = postgresDatabaseUrl();')).toBe(true);
    });

    it('recognises the CI tripwire call', () => {
      // The CALL, not the import: importing the module without invoking the guard
      // is not evidence a suite is Postgres-backed, and matching the import would
      // classify any file that merely references it.
      expect(matches('requireDatabaseUrlInCi();')).toBe(true);
    });

    it('does not classify an ordinary unit test', () => {
      // Over-matching is the silent failure: real unit tests would be routed to a
      // job with a database and a narrower file set.
      expect(matches("import { describe, it } from 'vitest';\nit('adds', () => {});")).toBe(false);
      expect(matches('const databaseUrl = process.env.SOME_OTHER_DATABASE;')).toBe(false);
    });

    it('classifies by NAME, so a unit test mentioning the helper is not swept in', () => {
      // The concrete regression: this PR's OWN unit tests call the helper
      // (`mod.requireDatabaseUrlInCi()`) or quote it as a literal, so content
      // matching put them in postgresExcludes and dropped them from the unit
      // shards. The module under test is not Postgres-backed because its name
      // contains the word.
      expect(isPostgresFile('tests/unit/postgresSuiteTripwire.test.ts', 'mod.requireDatabaseUrlInCi();'))
        .toBe(false);
      expect(isPostgresFile('tests/unit/ciIncrementalTests.test.ts', "expect(matches('requireDatabaseUrlInCi();')).toBe(true);"))
        .toBe(false);
      // ...while a genuinely named suite is always classified.
      expect(isPostgresFile('tests/integration/reviewRunLifecycle.postgres.test.ts', '')).toBe(true);
      expect(isPostgresFile('tests/integration/x.postgres.test.ts', 'const u = postgresDatabaseUrl();')).toBe(true);
    });

    it('classifies an INTEGRATION suite by content, for the legacy spelling', () => {
      // The content-marker branch was retained but never driven: every other call
      // passes a tests/unit path (returns false at the integration guard) or a
      // *.postgres.test.ts name (returns true at the name check), so both returned
      // before consulting the markers. Replacing the final marker check with
      // `return false` would have left this file fully green while legacy-spelled
      // integration suites were silently routed into the shards with no database
      // (REL-1069 review).
      const integration = 'tests/integration/legacySpelling.test.ts';
      expect(isPostgresFile(integration, 'const url = process.env.REVIEW_YETI_TEST_DATABASE_URL;')).toBe(true);
      expect(isPostgresFile(integration, 'const url = postgresDatabaseUrl();')).toBe(true);
      expect(isPostgresFile(integration, 'requireDatabaseUrlInCi();')).toBe(true);
      // ...and an integration suite with no marker at all is still not Postgres.
      expect(isPostgresFile(integration, "import { describe, it } from 'vitest';")).toBe(false);
    });

    it('every postgres suite in the tree is CLASSIFIED (by name, not content)', () => {
      // Asserted through isPostgresFile, the classifier CI actually uses, rather
      // than through content matching. The previous form demanded marker presence,
      // which classification does not require: a suite delegating connection setup
      // to a shared fixture still routes correctly by name yet would have failed
      // here. It also overstated its own name -- a broken name regex passed it while
      // being caught only by the sibling test (REL-1069 review).
      const dir = path.join(root, 'tests/integration');
      const suites = fs.readdirSync(dir).filter((name: string) => name.endsWith('.postgres.test.ts'));
      expect(suites.length).toBeGreaterThan(0);
      const unclassified = suites.filter(
        (name: string) => !isPostgresFile(`tests/integration/${name}`),
      );
      expect(unclassified).toEqual([]);
    });
  });
});
