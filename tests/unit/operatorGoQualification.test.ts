import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  goFailureReceipt,
  OPERATOR_MODULE,
  parseGoVersion,
  readOperatorGoTestNameAllowlist,
  type GoProcessResult,
} from '../support/operatorGoFailureReceipt';

const root = process.cwd();
const workflow = yaml.load(
  fs.readFileSync(path.join(root, '.github/workflows/ci-cd.yaml'), 'utf8'),
) as any;
const operatorDirectory = path.join(root, 'k8s-operator');
const sourceTestNames = readOperatorGoTestNameAllowlist(operatorDirectory);
const goVersion = 'go1.24.13';

function receipt(result: GoProcessResult) {
  return goFailureReceipt(result, { goVersion, sourceTestNames });
}

describe('embedded operator Go qualification workflow', () => {
  const vitest = workflow.jobs.vitest;
  const steps = vitest.steps as Array<Record<string, any>>;
  const setupGoIndex = steps.findIndex((step) =>
    step.uses === 'actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16');
  const verifyGoIndex = steps.findIndex((step) => step.name === 'Verify embedded operator Go toolchain');
  const runVitestIndex = steps.findIndex((step) => step.name === 'Run Vitest shard');

  function runToolchainReadback(fakeVersion: string) {
    const scratch = fs.mkdtempSync(path.join(tmpdir(), 'operator-go-readback-'));
    try {
      fs.writeFileSync(path.join(scratch, 'go'), [
        '#!/bin/sh',
        'if [ "$#" -ne 2 ] || [ "$1" != "env" ] || [ "$2" != "GOVERSION" ]; then exit 97; fi',
        `printf '%s\\n' '${fakeVersion}'`,
        '',
      ].join('\n'), { mode: 0o700 });
      return spawnSync('/bin/bash', [
        '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', String(steps[verifyGoIndex]?.run ?? ''),
      ], {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: scratch, NODE_ENV: 'test' },
        timeout: 5000,
        maxBuffer: 16 * 1024,
      });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  it('pins the Vitest runner to the operator toolchain without adding a Go cache', () => {
    expect(setupGoIndex).toBeGreaterThanOrEqual(0);
    const setup = steps[setupGoIndex];
    expect(setup.with).toMatchObject({
      'go-version': '1.24.13',
      'check-latest': false,
      cache: false,
    });
  });

  it('reads back only the normal Go version before the shard executes', () => {
    expect(verifyGoIndex).toBeGreaterThan(setupGoIndex);
    expect(verifyGoIndex).toBeLessThan(runVitestIndex);
    const verify = steps[verifyGoIndex];
    const run = String(verify?.run ?? '');
    expect(verify?.shell).toBe('bash');
    expect(Boolean(verify?.['continue-on-error'])).toBe(false);
    expect(run).toContain('go env GOVERSION');
    expect(run).toMatch(/test\s+"\$actual"\s*=\s*"go1\.24\.13"/u);
    expect(run).toMatch(/printf[^\n]*Go toolchain/u);
    expect(run).not.toMatch(/printenv|env\s+$/u);
  });

  it('accepts the expected toolchain and prints only the bounded version receipt', () => {
    const result = runToolchainReadback('go1.24.13');
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe('Go toolchain: go1.24.13\n');
    expect(result.stderr).toBe('');
  });

  it('fails the actual Bash version gate for a mismatched toolchain', () => {
    const result = runToolchainReadback('go1.27.0');
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('leaves the existing Vitest job boundary and timeout intact', () => {
    // PEG DECLINED for the default SKU. The shards are CPU-bound: measured
    // same-SHA on PR #1247 against the 4-vCPU main baseline, every shard
    // stretched 2.11x-2.31x, past the 2x budget where a vCPU cut loses on
    // normalized compute (wall x vCPU). The node_modules cache was warm in the
    // 2-vCPU run, so this is CPU and not a cold-cache artifact.
    //
    // `runs-on` is now the bench-aware expression: it honours the
    // workflow_dispatch `bench_runner` override when set (for same-SHA A/B) and
    // otherwise resolves to this job's own SKU.
    // Pin the EXPRESSION'S SEMANTICS, not substrings. Substring checks pass for
    // an inverted guard (`!=` -> `==`, which silently disables the override on
    // every job) and for a flipped default SKU (`...-arm`), so they would not
    // catch the exact regressions this assertion exists for.
    expect(vitest['runs-on']).toMatch(
      /\$\{\{ inputs\.bench_runner != '' && inputs\.bench_runner \|\| 'ubuntu-latest' \}\}/,
    );
    expect(vitest['timeout-minutes']).toBe(25);
    expect(vitest.permissions).toEqual({ contents: 'read' });
    expect(vitest.container).toBeUndefined();
  });

  it('explains the bench_runner input and derives bench coverage from the workflow', () => {
    // The publishing lane is the ONLY legitimate exclusion: those jobs choose
    // their own runner per matrix arm (and per defence-in-depth they must not be
    // swept into an A/B). Everything else that runs on a Blacksmith label must
    // carry the bench expression.
    const PUBLISH_LANE = new Set([
      'publish-ghcr-arch', 'publish-ghcr', 'attest-published-indexes',
    ]);

    // Coverage is DERIVED, and deliberately NOT from the current `runs-on`:
    // filtering on `includes('blacksmith-')` would let a job escape this guard
    // simply by dropping the expression (e.g. moving vitest to ubuntu-latest),
    // which is the "mixed runner set with no signal" failure it exists to prevent.
    const benchCovered = Object.keys(workflow.jobs).filter((name) => !PUBLISH_LANE.has(name));

    // Per-job default SKU, pinned explicitly. Decisions documented from the same-SHA A/B.
    const EXPECTED_DEFAULTS: Record<string, string> = {
      'test-plan': 'ubuntu-latest',
      'worker-helper': 'ubuntu-latest',
      typecheck: 'ubuntu-latest',
      'operator-test': 'ubuntu-latest',
      'legacy-runtime': 'ubuntu-latest',
      test: 'ubuntu-latest',
      vitest: 'ubuntu-latest',
      'vitest-postgres': 'ubuntu-latest',
      build: 'ubuntu-latest',
    };
    // A job added without a documented SKU decision fails here rather than
    // escaping the guard silently.
    expect(benchCovered.filter((j) => !(j in EXPECTED_DEFAULTS))).toEqual([]);
    expect(benchCovered.length).toBeGreaterThan(0);

    // THE SOURCE, not just the consumers: deleting or renaming the input block
    // leaves every runs-on string intact, so a consumers-only guard stays green
    // while the override is dead on all nine jobs. Assert the declaration.
    const dispatch = (workflow[true as any] ?? (workflow as any).on)?.workflow_dispatch;
    expect(dispatch).toBeDefined();
    const input = dispatch.inputs?.bench_runner;
    expect(input).toBeDefined();
    expect(input.required).toBe(false);
    expect(input.default).toBe('');
    // The options must include the labels the A/B actually dispatches with.
    expect(input.options).toEqual(expect.arrayContaining([
      '',
      'blacksmith-2vcpu-ubuntu-2404',
      'blacksmith-2vcpu-ubuntu-2404-arm',
      'blacksmith-4vcpu-ubuntu-2404',
      'blacksmith-4vcpu-ubuntu-2404-arm',
      'ubuntu-latest',
      'ubuntu-24.04-arm',
    ]));

    for (const job of benchCovered) {
      const actual = (workflow.jobs[job] as any)['runs-on'];
      const expected =
        "${{ inputs.bench_runner != '' && inputs.bench_runner || '" +
        EXPECTED_DEFAULTS[job] +
        "' }}";
      // Full literal: pins direction (a `!=` -> `==` inversion fails), the exact
      // default SKU (a 2<->4 vCPU change fails), and the arm axis.
      expect(job + '|' + actual).toBe(job + '|' + expected);
    }
  });


  it('gates the cache layer on runner.environment with one derived key per family', () => {
    // The portability claim rests on this discriminator, and nothing else
    // exercised it: inverting a single `==` here would silently send every
    // Blacksmith run down a cold `npm ci` -- green, just minutes slower. The
    // composite action is parsed with the same treatment the workflow gets.
    const actionPath = path.join(root, '.github/actions/node-deps/action.yml');
    const action = yaml.load(fs.readFileSync(actionPath, 'utf8')) as any;
    const steps = action.runs.steps as Array<Record<string, any>>;

    const sticky = steps.filter((s) =>
      typeof s.uses === 'string' && s.uses.startsWith('useblacksmith/stickydisk@'));
    const actionsCache = steps.filter((s) =>
      typeof s.uses === 'string' && s.uses.startsWith('actions/cache@'));

    expect(sticky.length).toBe(2);
    expect(actionsCache.length).toBe(2);
    for (const s of sticky) {
      expect(s.if).toBe("runner.environment == 'self-hosted'");
    }
    for (const s of actionsCache) {
      expect(s.if).toBe("runner.environment == 'github-hosted'");
    }

    // Parity is structural: every mount step references a value derived once in
    // the `key` step, so the two families cannot drift onto different keys.
    const mountKeys = [...sticky, ...actionsCache].map((s) => s.with.key);
    for (const k of mountKeys) {
      expect(k).toMatch(/^\$\{\{ steps\.key\.outputs\.(npm_cache_key|node_modules_key) \}\}$/);
    }
    const keyStep = steps.find((s) => s.id === 'key');
    expect(keyStep).toBeDefined();
    expect(keyStep!.run).toContain('npm_cache_key=');
    expect(keyStep!.run).toContain('node_modules_key=');
  });

  it('gates the Next.js build cache on runner.environment for sticky disk vs actions/cache', () => {
    const build = workflow.jobs.build;
    const buildSteps = build.steps as Array<Record<string, any>>;
    const sticky = buildSteps.find((s) =>
      typeof s.uses === 'string' && s.uses.startsWith('useblacksmith/stickydisk@'));
    const actionsCache = buildSteps.find((s) =>
      typeof s.uses === 'string' && s.uses.startsWith('actions/cache@'));

    expect(sticky).toBeDefined();
    expect(sticky?.if).toBe("runner.environment == 'self-hosted'");
    expect(actionsCache).toBeDefined();
    expect(actionsCache?.if).toBe("runner.environment == 'github-hosted'");
    expect(actionsCache?.with?.path).toBe('./.next/cache');
  });

  it('bounds the build heap so the build does not OOM on a smaller runner', () => {
    // Node derives its default old-space cap from the HOST's RAM, so `next
    // build` OOM'd on 2 vCPU (
    //   FATAL ERROR: Ineffective mark-compacts near heap limit
    //   Allocation failed - JavaScript heap out of memory)
    // while the build's real working set is only ~1.4 GB RSS (measured with
    // /usr/bin/time -l). Pinning NODE_OPTIONS makes the requirement a property
    // of the build rather than of whichever runner it lands on -- which is what
    // lets the SKU be chosen on cost without changing whether the build
    // succeeds.
    const build = workflow.jobs.build;
    const buildSteps = build.steps as Array<Record<string, any>>;
    const buildStep = buildSteps.find((s) =>
      typeof s.run === 'string' && s.run.includes('npm run build'));
    expect(buildStep).toBeDefined();
    // Presence alone is not the invariant. The stated purpose is that the build
    // does not OOM on a smaller runner, and the measured working set is ~1.4 GB
    // RSS, so a cap BELOW that (e.g. --max-old-space-size=1024, a plausible
    // "fit the small box" value) must fail this test rather than pass it.
    const heapCapMb = Number(
      /--max-old-space-size=(\d+)/.exec(buildStep!.env?.NODE_OPTIONS ?? '')?.[1],
    );
    expect(Number.isFinite(heapCapMb)).toBe(true);
    expect(heapCapMb).toBeGreaterThanOrEqual(2048);
    expect(build['timeout-minutes']).toBe(15);
  });

  it('parses only a successful conventional Go version readback', () => {
    expect(parseGoVersion({ status: 0, signal: null, stdout: 'go version go1.24.13 linux/amd64\n' })).toBe(goVersion);
    expect(parseGoVersion({ status: 0, signal: null, stdout: 'go version go1.27.0 darwin/arm64\n' })).toBe('go1.27.0');
    expect(parseGoVersion({ status: 1, signal: null, stdout: 'go version go1.24.13 linux/amd64\n' })).toBeNull();
    expect(parseGoVersion({ status: 0, signal: null, stdout: 'CANARY_SECRET go version go1.24.13 linux/amd64' })).toBeNull();
    expect(parseGoVersion({ status: 0, signal: null, stdout: 'CANARY_SECRET\ngo version go1.24.13 linux/amd64' })).toBeNull();
    expect(parseGoVersion({ status: 0, signal: null, stdout: 'go version go1.24 linux/amd64' })).toBeNull();
  });

  it('derives test identifiers from operator test source, not child output', () => {
    expect(sourceTestNames.has('TestOperatorDisabledUnlessExplicitlyEnabled')).toBe(true);
    expect(sourceTestNames.has('TestCANARY_SECRET')).toBe(false);
  });

  it('classifies a recognized Go test failure and reports only its source-declared top-level test', () => {
    const result = receipt({
      status: 1,
      signal: null,
      stdout: `--- FAIL: TestOperatorDisabledUnlessExplicitlyEnabled/CANARY_SECRET_subtest (0.00s)\nFAIL\t${OPERATOR_MODULE}/controllers\t0.02s\n`,
      stderr: '',
    });
    expect(result).toMatchObject({
      failureClass: 'package_failure',
      diagnosticClass: 'go_test_failure',
      goVersion,
      failedPackages: [`${OPERATOR_MODULE}/controllers`],
      failedTests: ['TestOperatorDisabledUnlessExplicitlyEnabled'],
    });
    expect(JSON.stringify(result)).not.toMatch(/CANARY_SECRET/u);
  });

  it('asserts the successful-suite diagnostic class', () => {
    const result = receipt({
      status: 0,
      signal: null,
      stdout: `ok\t${OPERATOR_MODULE}/controllers\t0.02s\n`,
      stderr: '',
    });
    expect(result).toMatchObject({ failureClass: 'success', diagnosticClass: 'success', goVersion });
  });

  it('asserts the missing-exit-status diagnostic class', () => {
    const result = receipt({ status: null, signal: null, stdout: '', stderr: '' });
    expect(result).toMatchObject({ failureClass: 'missing_exit_status', diagnosticClass: 'missing_exit_status' });
  });

  it('asserts the missing-expected-package diagnostic class', () => {
    const result = receipt({
      status: 0,
      signal: null,
      stdout: `ok\t${OPERATOR_MODULE}/pkg/job\t0.02s\n`,
      stderr: '',
    });
    expect(result).toMatchObject({ failureClass: 'missing_expected_package', diagnosticClass: 'missing_expected_package' });
  });

  it('asserts that a suite-level failure is diagnosed as a Go test failure', () => {
    const result = receipt({
      status: 0,
      signal: null,
      stdout: `ok\t${OPERATOR_MODULE}/controllers\t0.02s\nFAIL\n`,
      stderr: '',
    });
    expect(result).toMatchObject({ failureClass: 'suite_failure', diagnosticClass: 'go_test_failure' });
  });

  it('classifies compiler failures without returning source paths or compiler text', () => {
    const result = receipt({
      status: 1,
      signal: null,
      stdout: '',
      stderr: `# ${OPERATOR_MODULE}/controllers\nprivate_source.go:12:3: undefined: CANARY_SECRET_SYMBOL\nFAIL\t${OPERATOR_MODULE}/controllers [build failed]\n`,
    });
    expect(result.diagnosticClass).toBe('compiler_failure');
    expect(result.failedPackages).toEqual([`${OPERATOR_MODULE}/controllers`]);
    expect(JSON.stringify(result)).not.toMatch(/private_source|CANARY_SECRET|undefined:/u);
  });

  it('classifies module-resolution failures while withholding dependency paths', () => {
    const result = receipt({
      status: 1,
      signal: null,
      stdout: '',
      stderr: 'go: missing go.sum entry for module providing package private.example/CANARY_SECRET/module',
    });
    expect(result.diagnosticClass).toBe('module_failure');
    expect(result.failedPackages).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/private\.example|CANARY_SECRET|go\.sum entry/u);
  });

  it('classifies resource failures from bounded known phrases and process codes', () => {
    const outputResult = receipt({
      status: 1,
      signal: null,
      stdout: '',
      stderr: 'runtime: failed to create new OS thread (errno=11)',
    });
    const processResult = receipt({
      status: null,
      signal: null,
      error: Object.assign(new Error('CANARY_SECRET /private/path'), { code: 'EAGAIN' }),
    });
    expect(outputResult.diagnosticClass).toBe('resource_exhausted');
    expect(processResult).toMatchObject({ failureClass: 'process_error', errorClass: 'resource_exhausted', diagnosticClass: 'resource_exhausted' });
    expect(JSON.stringify(processResult)).not.toMatch(/CANARY_SECRET|\/private\/path/u);
  });

  it.each([
    ['ETIMEDOUT', 'timeout'],
    ['ENOBUFS', 'output_buffer_limit'],
    ['ENOENT', 'executable_missing'],
    ['EACCES', 'permission_denied'],
    ['UNTRUSTED_SECRET_CODE', 'spawn_error'],
  ])('keeps spawn error %s in the closed receipt taxonomy', (code, diagnosticClass) => {
    const result = receipt({
      status: null,
      signal: null,
      error: Object.assign(new Error('CANARY_SECRET /private/path'), { code }),
    });
    expect(result).toMatchObject({ failureClass: 'process_error', diagnosticClass });
    expect(JSON.stringify(result)).not.toMatch(/CANARY_SECRET|UNTRUSTED_SECRET|\/private\/path/u);
  });

  it('keeps unknown nonzero output fail-closed and hash-only', () => {
    const stdout = 'CANARY_SECRET unclassified process output';
    const stderr = 'private path /private/build/operator.go';
    const result = goFailureReceipt({ status: 1, signal: null, stdout, stderr }, {
      goVersion: 'go1.24.13 linux/amd64 CANARY_SECRET',
      sourceTestNames,
    });
    expect(result).toMatchObject({
      failureClass: 'exit_nonzero',
      diagnosticClass: 'unclassified_exit',
      goVersion: null,
      failedPackages: [],
      failedTests: [],
    });
    expect(result.stdoutSha256).toBe(createHash('sha256').update(stdout).digest('hex'));
    expect(result.stderrSha256).toBe(createHash('sha256').update(stderr).digest('hex'));
    expect(JSON.stringify(result)).not.toMatch(/CANARY_SECRET|private path|\/private\/build|operator\.go|linux\/amd64/u);
  });

  it('keeps unknown signals and missing toolchain versions non-authoritative', () => {
    const signal = receipt({ status: null, signal: 'UNTRUSTED_SECRET_SIGNAL', stdout: '', stderr: '' });
    const missingVersion = goFailureReceipt({
      status: 0,
      signal: null,
      stdout: `ok\t${OPERATOR_MODULE}/controllers\t0.01s\n`,
      stderr: '',
    });
    expect(signal).toMatchObject({ signal: 'UNKNOWN', diagnosticClass: 'process_signal' });
    expect(JSON.stringify(signal)).not.toMatch(/UNTRUSTED_SECRET/u);
    expect(missingVersion).toMatchObject({ failureClass: 'success', diagnosticClass: 'toolchain_version_unavailable', goVersion: null });
  });
});

// Regression fixtures use the existing receipt API. The plain manifest is independently
// reconstructed from the actual owner files; the implementation must verify those facts
// itself before retaining any observation. Raw native output must remain hash-only.
const lifecycleTestName = 'TestM4_Integration_DynamicLifecycle_SlotRecycling_AcrossThreads';
const lifecycleFile = 'controllers/m4_multithread_concurrency_test.go';
const assertionSourceFiles = [
  lifecycleFile,
  'controllers/m2_declarative_admission_concurrency_test.go',
];
const lifecycleTemplates = [
  { templateId: 'm4.lifecycle.initial-running', line: 256,
    format: 'expected initial %d running reviews, got %d',
    message: 'expected initial 4 running reviews, got 3', values: { expected: 4, actual: 3 } },
  { templateId: 'm4.lifecycle.review0-phase', line: 326,
    format: 'expected Review 0 Succeeded, got %s',
    message: 'expected Review 0 Succeeded, got Running', values: { expected: 'Succeeded', actual: 'Running' } },
  { templateId: 'm4.lifecycle.review1-phase', line: 329,
    format: 'expected Review 1 Succeeded, got %s',
    message: 'expected Review 1 Succeeded, got Running', values: { expected: 'Succeeded', actual: 'Running' } },
  { templateId: 'm4.lifecycle.review2-phase', line: 332,
    format: 'expected Review 2 Failed, got %s',
    message: 'expected Review 2 Failed, got Running', values: { expected: 'Failed', actual: 'Running' } },
  { templateId: 'm4.lifecycle.turnover-running', line: 358,
    format: 'expected %d running reviews after slot turnover, got %d',
    message: 'expected 4 running reviews after slot turnover, got 3', values: { expected: 4, actual: 3 } },
  { templateId: 'm4.lifecycle.succeeded-count', line: 361,
    format: 'expected 2 succeeded reviews, got %d',
    message: 'expected 2 succeeded reviews, got 1', values: { expected: 2, actual: 1 } },
  { templateId: 'm4.lifecycle.failed-count', line: 364,
    format: 'expected 1 failed review, got %d',
    message: 'expected 1 failed review, got 0', values: { expected: 1, actual: 0 } },
  { templateId: 'm4.lifecycle.queued-count', line: 367,
    format: 'expected %d queued reviews, got %d',
    message: 'expected 9 queued reviews, got 10', values: { expected: 9, actual: 10 } },
  { templateId: 'm4.lifecycle.capacity-max', line: 371,
    format: 'limit exceeded during turnover: max %d',
    message: 'limit exceeded during turnover: max 5', values: { maximum: 5 } },
];

interface AssertionManifestFixture {
  schema: string;
  sources: Array<{ file: string; sha256: string }>;
  assertions: Array<{
    templateId: string;
    source: { file: string; sha256: string; line: number };
    testName: string;
    format: string;
  }>;
}

function sourceManifestFixture(): AssertionManifestFixture {
  const sources = assertionSourceFiles.map((file) => ({
    file,
    sha256: createHash('sha256').update(fs.readFileSync(path.join(operatorDirectory, file))).digest('hex'),
  }));
  return {
    schema: 'operator-go-assertion-manifest.v1',
    sources,
    assertions: lifecycleTemplates.map(({ templateId, line, format }) => ({
      templateId, source: { ...sources[0], line }, testName: lifecycleTestName, format,
    })),
  };
}

function nativeAssertionOutput(message: string, line = 358, threads: number | string = 4) {
  return [
    `--- FAIL: ${lifecycleTestName} (0.01s)`,
    `    --- FAIL: ${lifecycleTestName}/${threads}Threads (0.01s)`,
    `        m4_multithread_concurrency_test.go:${line}: ${message}`,
    `FAIL\t${OPERATOR_MODULE}/controllers\t0.02s`,
    '',
  ].join('\n');
}

function assertionReceipt(
  result: GoProcessResult,
  sourceAssertionManifest: unknown = sourceManifestFixture(),
  overrides: { goVersion?: unknown; sourceTestNames?: ReadonlySet<string>; operatorDirectory?: string } = {},
) {
  // An options variable remains structurally compatible with the pre-fix API. OLD
  // exercises actual missing receipt data rather than an absent import or type member.
  const options = { goVersion, sourceTestNames, operatorDirectory, sourceAssertionManifest, ...overrides };
  return goFailureReceipt(result, options);
}

function expectNoAssertionObservation(result: ReturnType<typeof goFailureReceipt>, stdout: string, stderr = '') {
  expect(result).not.toHaveProperty('assertionObservations.0');
  expect(result.stdoutSha256).toBe(createHash('sha256').update(stdout).digest('hex'));
  expect(result.stderrSha256).toBe(createHash('sha256').update(stderr).digest('hex'));
  expect(JSON.stringify(result)).not.toMatch(/CANARY_SECRET|Bearer |github_pat_|private\.example|\/private\/|expected 4 running/u);
}

describe('source-bound operator native assertion observations', () => {
  const positiveRows = lifecycleTemplates.flatMap((template) => [1, 4, 16].map((threadCount) => ({
    ...template, threadCount,
  })));

  it.each(positiveRows)('retains $templateId in $threadCount Threads from the exact source declaration', (row) => {
    const manifest = sourceManifestFixture();
    const stdout = nativeAssertionOutput(row.message, row.line, row.threadCount);
    const result = assertionReceipt({ status: 1, signal: null, stdout, stderr: '' }, manifest);
    expect(result).toMatchObject({
      failureClass: 'package_failure', diagnosticClass: 'go_test_failure',
      failedTests: [lifecycleTestName], failedPackages: [`${OPERATOR_MODULE}/controllers`],
      assertionObservations: [{
        templateId: row.templateId,
        testName: lifecycleTestName,
        threadCount: row.threadCount,
        source: { file: lifecycleFile, sha256: manifest.sources[0].sha256, line: row.line },
        values: row.values,
      }],
    });
    expect(result).toHaveProperty('assertionObservations.length', 1);
    expect(result.stdoutSha256).toBe(createHash('sha256').update(stdout).digest('hex'));
    expect(result.stderrSha256).toBe(createHash('sha256').update('').digest('hex'));
    expect(JSON.stringify(result)).not.toContain(row.message);
  });

  it('retains three distinct source-bound assertions across the full thread matrix', () => {
    const manifest = sourceManifestFixture();
    const rows = [
      { ...lifecycleTemplates[4], threadCount: 1 },
      { ...lifecycleTemplates[5], threadCount: 4 },
      { ...lifecycleTemplates[8], threadCount: 16 },
    ];
    const stdout = rows.map((row) => nativeAssertionOutput(row.message, row.line, row.threadCount)).join('');
    const result = assertionReceipt({ status: 1, signal: null, stdout, stderr: '' }, manifest);
    expect(result).toMatchObject({
      failureClass: 'package_failure', diagnosticClass: 'go_test_failure',
      failedTests: [lifecycleTestName], failedPackages: [`${OPERATOR_MODULE}/controllers`],
    });
    expect(result.assertionObservations).toHaveLength(3);
    expect(result.assertionObservations).toEqual(rows.map((row) => ({
      templateId: row.templateId,
      testName: lifecycleTestName,
      threadCount: row.threadCount,
      source: { file: lifecycleFile, sha256: manifest.sources[0].sha256, line: row.line },
      values: row.values,
    })));
    expect(result.assertionObservations?.map((row) => row.threadCount)).toEqual([1, 4, 16]);
    expect(result.assertionObservations?.map((row) => row.templateId)).toEqual(rows.map((row) => row.templateId));
    expect(result.stdoutSha256).toBe(createHash('sha256').update(stdout).digest('hex'));
    expect(result.stderrSha256).toBe(createHash('sha256').update('').digest('hex'));
    const serialized = JSON.stringify(result);
    for (const row of rows) expect(serialized).not.toContain(row.message);
    expect(serialized).not.toMatch(/CANARY_SECRET|Bearer |github_pat_|private\.example|\/private\//u);
  });

  const malformedOutputRows = [
    { name: 'unknown fatal template', stdout: nativeAssertionOutput('CANARY_SECRET arbitrary assertion') },
    { name: 'negative count', stdout: nativeAssertionOutput('expected 4 running reviews after slot turnover, got -1') },
    { name: 'fractional count', stdout: nativeAssertionOutput('expected 4 running reviews after slot turnover, got 3.5') },
    { name: 'noncanonical leading zero', stdout: nativeAssertionOutput('expected 4 running reviews after slot turnover, got 03') },
    { name: 'nonfinite count', stdout: nativeAssertionOutput('expected 4 running reviews after slot turnover, got Infinity') },
    { name: 'unsafe integer count', stdout: nativeAssertionOutput('expected 4 running reviews after slot turnover, got 9007199254740993') },
    { name: 'source-mismatched expected limit', stdout: nativeAssertionOutput('expected 5 running reviews after slot turnover, got 3') },
    { name: 'unknown phase', stdout: nativeAssertionOutput('expected Review 0 Succeeded, got CANARY_SECRET', 326) },
    { name: 'phase with trailing credential', stdout: nativeAssertionOutput('expected Review 0 Succeeded, got Running Bearer CANARY_SECRET', 326) },
    { name: 'missing phase', stdout: nativeAssertionOutput('expected Review 2 Failed, got ', 332) },
    { name: 'unknown thread matrix member', stdout: nativeAssertionOutput(lifecycleTemplates[4].message, 358, 2) },
    { name: 'noncanonical thread count', stdout: nativeAssertionOutput(lifecycleTemplates[4].message, 358, '04') },
    { name: 'thread path with canary suffix', stdout: nativeAssertionOutput(lifecycleTemplates[4].message).replace('/4Threads (', '/4Threads/CANARY_SECRET (') },
    { name: 'wrong source declaration line', stdout: nativeAssertionOutput(lifecycleTemplates[4].message, 357) },
    { name: 'absolute native source path', stdout: nativeAssertionOutput(lifecycleTemplates[4].message).replace('m4_multithread_concurrency_test.go:', '/private/build/m4_multithread_concurrency_test.go:') },
    { name: 'traversal native source path', stdout: nativeAssertionOutput(lifecycleTemplates[4].message).replace('m4_multithread_concurrency_test.go:', '../m4_multithread_concurrency_test.go:') },
    { name: 'unknown native source file', stdout: nativeAssertionOutput(lifecycleTemplates[4].message).replace('m4_multithread_concurrency_test.go:', 'private_source.go:') },
    { name: 'mixed known and arbitrary assertion lines', stdout: nativeAssertionOutput(lifecycleTemplates[4].message).replace(`FAIL\t${OPERATOR_MODULE}`, `        m4_multithread_concurrency_test.go:358: Bearer CANARY_SECRET\nFAIL\t${OPERATOR_MODULE}`) },
    { name: 'ambiguous duplicate assertions', stdout: nativeAssertionOutput(lifecycleTemplates[4].message).replace(`FAIL\t${OPERATOR_MODULE}`, `        m4_multithread_concurrency_test.go:358: ${lifecycleTemplates[4].message}\nFAIL\t${OPERATOR_MODULE}`) },
    { name: 'unknown top-level test', stdout: nativeAssertionOutput(lifecycleTemplates[4].message).replaceAll(lifecycleTestName, 'TestCANARY_SECRET') },
    { name: 'different source-declared top-level test', stdout: nativeAssertionOutput(lifecycleTemplates[4].message).replaceAll(lifecycleTestName, 'TestOperatorDisabledUnlessExplicitlyEnabled') },
    { name: 'subtest does not belong to enclosing test', stdout: nativeAssertionOutput(lifecycleTemplates[4].message).replace(`${lifecycleTestName}/4Threads`, 'TestOperatorDisabledUnlessExplicitlyEnabled/4Threads') },
    { name: 'missing enclosing top-level failure', stdout: nativeAssertionOutput(lifecycleTemplates[4].message).split('\n').slice(1).join('\n') },
    { name: 'missing thread failure context', stdout: nativeAssertionOutput(lifecycleTemplates[4].message).split('\n').filter((line) => !line.includes('/4Threads')).join('\n') },
    { name: 'mixed credential in the matched numeric field', stdout: nativeAssertionOutput('expected 4 running reviews after slot turnover, got 3 github_pat_CANARY_SECRET') },
    { name: 'too many native failure blocks', stdout: [1, 4, 16, 1].map((threads) => nativeAssertionOutput(lifecycleTemplates[4].message, 358, threads)).join('') },
    { name: 'misplaced assertion outside a failure block', stdout: `m4_multithread_concurrency_test.go:358: ${lifecycleTemplates[4].message}\nFAIL\t${OPERATOR_MODULE}/controllers\t0.01s\n` },
  ];
  it.each(malformedOutputRows)('withholds $name and preserves the original output digest', ({ stdout }) => {
    const result = assertionReceipt({ status: 1, signal: null, stdout, stderr: '' });
    expect(result.failureClass).not.toBe('success');
    expectNoAssertionObservation(result, stdout);
  });

  const forgedManifestRows: Array<{ name: string; mutate: (manifest: AssertionManifestFixture) => unknown }> = [
    { name: 'absent manifest', mutate: () => null },
    { name: 'nonobject manifest', mutate: () => 'CANARY_SECRET' },
    { name: 'unknown schema', mutate: (m) => ({ ...m, schema: 'CANARY_SECRET' }) },
    { name: 'missing source inventory', mutate: (m) => ({ ...m, sources: [] }) },
    { name: 'duplicate source inventory', mutate: (m) => ({ ...m, sources: [m.sources[0], m.sources[0]] }) },
    { name: 'unselected source inventory file', mutate: (m) => { m.sources[1].file = 'controllers/private_source.go'; return m; } },
    { name: 'forged sibling fixture hash', mutate: (m) => { m.sources[1].sha256 = 'a'.repeat(64); return m; } },
    { name: 'forged lifecycle source hash', mutate: (m) => { m.sources[0].sha256 = 'a'.repeat(64); m.assertions.forEach((a) => { a.source.sha256 = m.sources[0].sha256; }); return m; } },
    { name: 'noncanonical source hash', mutate: (m) => { m.sources[0].sha256 = m.sources[0].sha256.toUpperCase(); return m; } },
    { name: 'forged assertion source hash', mutate: (m) => { m.assertions[4].source.sha256 = 'b'.repeat(64); return m; } },
    { name: 'absolute source inventory path', mutate: (m) => { m.sources[0].file = path.join(operatorDirectory, lifecycleFile); return m; } },
    { name: 'traversal source inventory path', mutate: (m) => { m.sources[0].file = `../${lifecycleFile}`; return m; } },
    { name: 'absolute assertion path', mutate: (m) => { m.assertions[4].source.file = `/private/${lifecycleFile}`; return m; } },
    { name: 'traversal assertion path', mutate: (m) => { m.assertions[4].source.file = `../${lifecycleFile}`; return m; } },
    { name: 'wrong declaration line', mutate: (m) => { m.assertions[4].source.line = 357; return m; } },
    { name: 'fractional declaration line', mutate: (m) => { m.assertions[4].source.line = 358.5; return m; } },
    { name: 'unknown template identifier', mutate: (m) => { m.assertions[4].templateId = 'CANARY_SECRET'; return m; } },
    { name: 'duplicate template', mutate: (m) => { m.assertions.push(m.assertions[4]); return m; } },
    { name: 'missing template', mutate: (m) => { m.assertions.splice(4, 1); return m; } },
    { name: 'forged arbitrary format', mutate: (m) => { m.assertions[4].format = 'CANARY_SECRET %s'; return m; } },
    { name: 'source format from another assertion', mutate: (m) => { m.assertions[4].format = m.assertions[0].format; return m; } },
    { name: 'unknown source test', mutate: (m) => { m.assertions[4].testName = 'TestCANARY_SECRET'; return m; } },
    { name: 'different declared source test', mutate: (m) => { m.assertions[4].testName = 'TestOperatorDisabledUnlessExplicitlyEnabled'; return m; } },
    { name: 'source path case alias', mutate: (m) => { m.assertions[4].source.file = 'controllers/M4_multithread_concurrency_test.go'; return m; } },
    { name: 'credential property widening', mutate: (m) => ({ ...m, credential: 'Bearer CANARY_SECRET' }) },
    { name: 'throwing untrusted manifest accessor', mutate: (m) => Object.defineProperty(m, 'sources', { get() { throw new Error('CANARY_SECRET'); } }) },
  ];
  it.each(forgedManifestRows)('refuses $name even when native output matches a known assertion', ({ mutate }) => {
    const stdout = nativeAssertionOutput(lifecycleTemplates[4].message);
    const result = assertionReceipt({ status: 1, signal: null, stdout, stderr: '' }, mutate(sourceManifestFixture()));
    expect(result.failureClass).not.toBe('success');
    expectNoAssertionObservation(result, stdout);
  });

  it.each([
    { name: 'missing source test membership', overrides: { sourceTestNames: new Set<string>() } },
    { name: 'unknown toolchain', overrides: { goVersion: 'go1.24.13 CANARY_SECRET' } },
    { name: 'missing owner directory', overrides: { operatorDirectory: path.join(operatorDirectory, 'missing') } },
    { name: 'non-directory owner root', overrides: { operatorDirectory: path.join(operatorDirectory, 'go.mod') } },
  ])('refuses $name without turning failure into success', ({ overrides }) => {
    const stdout = nativeAssertionOutput(lifecycleTemplates[4].message);
    const result = assertionReceipt({ status: 1, signal: null, stdout, stderr: '' }, sourceManifestFixture(), overrides);
    expect(result.failureClass).not.toBe('success');
    expectNoAssertionObservation(result, stdout);
  });

  it.each([
    { name: 'successful process status', result: { status: 0, signal: null } },
    { name: 'absent status', result: { signal: null } },
    { name: 'fractional status', result: { status: 1.5, signal: null } },
    { name: 'negative status', result: { status: -1, signal: null } },
    { name: 'out-of-range status', result: { status: 256, signal: null } },
    { name: 'string status', result: { status: '1', signal: null } },
    { name: 'known termination signal', result: { status: 1, signal: 'SIGTERM' } },
    { name: 'unknown termination signal', result: { status: 1, signal: 'CANARY_SECRET' } },
    { name: 'spawn error', result: { status: 1, signal: null, error: { code: 'ENOENT' } } },
  ])('does not promote assertion-looking text with $name', ({ result }) => {
    const stdout = nativeAssertionOutput(lifecycleTemplates[4].message);
    expectNoAssertionObservation(assertionReceipt({ ...result, stdout, stderr: '' }), stdout);
  });

  it('keeps successful native package output free of assertion observations', () => {
    const stdout = `ok\t${OPERATOR_MODULE}/controllers\t0.01s\n`;
    const result = assertionReceipt({ status: 0, signal: null, stdout, stderr: '' });
    expect(result.failureClass).toBe('success');
    expectNoAssertionObservation(result, stdout);
  });

  it('retains an ordinary unknown Go failure as hash-only when no manifest is supplied', () => {
    const stdout = nativeAssertionOutput(lifecycleTemplates[4].message);
    expectNoAssertionObservation(receipt({ status: 1, signal: null, stdout, stderr: '' }), stdout);
  });

  it('rejects an assertion candidate supplied on stderr without stdout test context', () => {
    const stderr = nativeAssertionOutput(lifecycleTemplates[4].message);
    const result = assertionReceipt({ status: 1, signal: null, stdout: '', stderr });
    expectNoAssertionObservation(result, '', stderr);
  });

  it('withholds a valid stdout observation when stderr is not empty', () => {
    const stdout = nativeAssertionOutput(lifecycleTemplates[4].message);
    const stderr = 'go: downloading github.com/example/mod v1.0.0\n';
    const result = assertionReceipt({ status: 1, signal: null, stdout, stderr });
    expectNoAssertionObservation(result, stdout, stderr);
  });
});

describe('operator receipt defensive source and process neighbors', () => {
  it('returns no source test names for unreadable directory kinds', () => {
    expect([...readOperatorGoTestNameAllowlist(path.join(operatorDirectory, 'missing-directory'))]).toEqual([]);
    expect([...readOperatorGoTestNameAllowlist(path.join(operatorDirectory, 'go.mod'))]).toEqual([]);
  });

  it('walks genuine Go tests but skips vendor, dependency, Git and symlink sources', () => {
    const scratch = fs.mkdtempSync(path.join(tmpdir(), 'operator-go-source-names-'));
    try {
      for (const name of ['nested', 'vendor', 'node_modules', '.git']) fs.mkdirSync(path.join(scratch, name));
      fs.writeFileSync(path.join(scratch, 'nested', 'real_test.go'), [
        'package controllers',
        'func TestDeclaredFixture(t *testing.T) {}',
        'func TestdeclaredInvalid(t *testing.T) {}',
        `func Test${'A'.repeat(130)}(t *testing.T) {}`,
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(scratch, 'ordinary.go'), 'func TestUnselectedFile(t *testing.T) {}');
      for (const name of ['vendor', 'node_modules', '.git']) {
        fs.writeFileSync(path.join(scratch, name, 'ignored_test.go'), 'func TestIgnoredSource(t *testing.T) {}');
      }
      fs.symlinkSync(path.join(scratch, 'nested', 'real_test.go'), path.join(scratch, 'link_test.go'));
      expect([...readOperatorGoTestNameAllowlist(scratch)]).toEqual(['TestDeclaredFixture']);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.each(['EMFILE', 'ENFILE', 'ENOMEM'])('keeps resource spawn code %s in its existing class', (code) => {
    expect(receipt({ status: null, signal: null, error: { code } })).toMatchObject({
      failureClass: 'process_error', diagnosticClass: 'resource_exhausted', errorClass: 'resource_exhausted',
    });
  });

  it.each([
    { name: 'primitive error', error: 'CANARY_SECRET' },
    { name: 'non-string error code', error: { code: 123 } },
    { name: 'throwing code getter', error: Object.defineProperty({}, 'code', { get() { throw new Error('CANARY_SECRET'); } }) },
  ])('keeps $name in the hash-only spawn taxonomy', ({ error }) => {
    const result = receipt({ status: null, signal: null, error });
    expect(result).toMatchObject({ failureClass: 'process_error', errorClass: 'spawn_error' });
    expect(JSON.stringify(result)).not.toContain('CANARY_SECRET');
  });

  it.each([
    { status: 0, signal: 'SIGTERM', stdout: 'go version go1.24.13 linux/amd64' },
    { status: 0, signal: null, error: { code: 'ENOENT' }, stdout: 'go version go1.24.13 linux/amd64' },
    { status: 0, signal: null, stdout: Buffer.from('go version go1.24.13 linux/amd64') },
    { status: 0, signal: null, stdout: 'unknown version' },
  ])('refuses non-authoritative Go version readback %#', (result) => {
    expect(parseGoVersion(result)).toBeNull();
  });

  it('never reports unknown package names or arbitrary test identifiers', () => {
    const stdout = '--- FAIL: TestCANARY_SECRET (0.01s)\nFAIL\tprivate.example/CANARY_SECRET\t0.01s\n';
    const result = receipt({ status: 1, signal: null, stdout, stderr: '' });
    expect(result).toMatchObject({ failedPackages: [], failedTests: [] });
    expect(JSON.stringify(result)).not.toMatch(/CANARY_SECRET|private\.example/u);
  });

  it('deduplicates and bounds source-declared top-level failure identifiers', () => {
    const names = [...sourceTestNames].sort().slice(0, 30);
    expect(names).toHaveLength(30);
    const stdout = [...names, ...names].map((name) => `--- FAIL: ${name} (0.01s)`).join('\n');
    expect(receipt({ status: 1, signal: null, stdout, stderr: '' }).failedTests).toEqual(names.slice(0, 24));
  });

  it('handles non-string native streams without serializing them', () => {
    const result = receipt({ status: 1, signal: null, stdout: { canary: 'CANARY_SECRET' }, stderr: Buffer.from('CANARY_SECRET') });
    expect(result).toMatchObject({ failureClass: 'exit_nonzero', diagnosticClass: 'unclassified_exit' });
    expect(result.stdoutSha256).toBe(createHash('sha256').update('').digest('hex'));
    expect(result.stderrSha256).toBe(result.stdoutSha256);
    expect(JSON.stringify(result)).not.toContain('CANARY_SECRET');
  });
});
