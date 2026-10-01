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
  const build = workflow.jobs.build;
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
    // PEG DECLINED. The SKU stays at 4 vCPU because the shards are CPU-bound:
    // measured same-SHA on PR #1247 against the 4-vCPU main baseline, every
    // shard stretched 2.11x-2.31x, past the 2x budget where a vCPU cut loses on
    // normalized compute (wall x vCPU). The node_modules sticky disk was warm in
    // the 2-vCPU run, so this is CPU and not a cold-cache artifact.
    expect(vitest['runs-on']).toBe('blacksmith-4vcpu-ubuntu-2404');
    expect(vitest['timeout-minutes']).toBe(25);
    expect(vitest.permissions).toEqual({ contents: 'read' });
    expect(vitest.container).toBeUndefined();
  });

  it('keeps the memory-bound build job on the larger SKU', () => {
    // The one deliberate PEG EXCEPTION in this workflow. Pegging `build` to
    // 2 vCPU OOM'd `next build` on PR #1247 (job 110616268666): "Ineffective
    // mark-compacts near heap limit ... JavaScript heap out of memory" at
    // ~2.0 GB RSS. The larger SKU buys RAM here, not cores. This assertion
    // exists so a future blanket "make everything 2 vCPU" sweep has to
    // consciously delete the exception rather than inherit it.
    expect(build['runs-on']).toBe('blacksmith-4vcpu-ubuntu-2404');
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
