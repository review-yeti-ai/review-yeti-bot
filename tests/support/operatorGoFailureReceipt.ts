import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const OPERATOR_MODULE = 'github.com/review-yeti-ai/review-yeti-bot/k8s-operator';

const OPERATOR_PACKAGE_SUFFIXES = [
  '', '/api/v1alpha1', '/api/v1alpha2', '/controllers', '/pkg/cleanup', '/pkg/job',
  '/pkg/metrics', '/pkg/queue', '/pkg/workspace',
] as const;
const OPERATOR_PACKAGES = new Set(OPERATOR_PACKAGE_SUFFIXES.map((suffix) => OPERATOR_MODULE + suffix));
const GO_SIGNALS = new Set([
  'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGABRT', 'SIGFPE', 'SIGKILL', 'SIGSEGV',
  'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGUSR1', 'SIGUSR2', 'SIGBUS', 'SIGTRAP',
]);
const SAFE_GO_VERSION = /^go\d+\.\d+\.\d+$/u;
const GO_TEST_NAME = /^Test[A-Z][A-Za-z0-9_]{0,126}$/u;
const MAX_REPORTED_TESTS = 24;

export type GoFailureClass =
  | 'process_error'
  | 'process_signal'
  | 'package_failure'
  | 'missing_exit_status'
  | 'exit_nonzero'
  | 'suite_failure'
  | 'missing_expected_package'
  | 'success';

export type GoDiagnosticClass =
  | 'success'
  | 'go_test_failure'
  | 'compiler_failure'
  | 'module_failure'
  | 'resource_exhausted'
  | 'timeout'
  | 'output_buffer_limit'
  | 'executable_missing'
  | 'permission_denied'
  | 'spawn_error'
  | 'process_signal'
  | 'missing_exit_status'
  | 'unclassified_exit'
  | 'missing_expected_package'
  | 'toolchain_version_unavailable';

type GoSpawnErrorClass =
  | 'timeout'
  | 'output_buffer_limit'
  | 'executable_missing'
  | 'permission_denied'
  | 'resource_exhausted'
  | 'spawn_error';

export interface GoProcessResult {
  status?: unknown;
  signal?: unknown;
  error?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

export interface GoFailureReceiptOptions {
  goVersion?: unknown;
  sourceTestNames?: ReadonlySet<string>;
}

export interface GoFailureReceipt {
  status: number | null;
  signal: string | null;
  errorClass: GoSpawnErrorClass | null;
  failureClass: GoFailureClass;
  diagnosticClass: GoDiagnosticClass;
  goVersion: string | null;
  failedPackages: string[];
  failedTests: string[];
  stdoutSha256: string;
  stderrSha256: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function exitStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
    ? value
    : null;
}

function errorCode(error: unknown): string | null {
  if (error === null || error === undefined || typeof error !== 'object') return null;
  try {
    const value = (error as { code?: unknown }).code;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function classifySpawnError(error: unknown): GoSpawnErrorClass | null {
  if (error === null || error === undefined) return null;
  switch (errorCode(error)) {
    case 'ETIMEDOUT': return 'timeout';
    case 'ENOBUFS': return 'output_buffer_limit';
    case 'ENOENT': return 'executable_missing';
    case 'EACCES': return 'permission_denied';
    case 'EAGAIN':
    case 'EMFILE':
    case 'ENFILE':
    case 'ENOMEM': return 'resource_exhausted';
    default: return 'spawn_error';
  }
}

function parsedVersion(value: unknown): string | null {
  return typeof value === 'string' && SAFE_GO_VERSION.test(value) ? value : null;
}

/** Return only the release identifier from a successful, conventional `go version` result. */
export function parseGoVersion(result: GoProcessResult): string | null {
  if (exitStatus(result.status) !== 0 || result.signal !== null || result.error !== undefined && result.error !== null) {
    return null;
  }
  const match = /^go version (go\d+\.\d+\.\d+)(?:\s|$)/u.exec(text(result.stdout).trim());
  return parsedVersion(match?.[1]);
}

/**
 * Build a source-derived allowlist of top-level Go test identifiers. Only identifiers are kept;
 * directories and source contents never enter the returned receipt.
 */
export function readOperatorGoTestNameAllowlist(operatorDirectory: string): ReadonlySet<string> {
  const names = new Set<string>();
  const pending = [operatorDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name !== 'vendor' && entry.name !== 'node_modules' && entry.name !== '.git') {
          pending.push(join(directory, entry.name));
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('_test.go')) continue;
      let source: string;
      try {
        source = readFileSync(join(directory, entry.name), 'utf8');
      } catch {
        continue;
      }
      for (const match of source.matchAll(/^\s*func\s+(Test[A-Z][A-Za-z0-9_]*)\s*\(/gmu)) {
        if (GO_TEST_NAME.test(match[1])) names.add(match[1]);
      }
    }
  }
  return names;
}

function recognizedPackages(output: string): string[] {
  const matches = new Set<string>();
  for (const match of output.matchAll(/^FAIL\s+(\S+)(?:\s|$)/gmu)) {
    if (OPERATOR_PACKAGES.has(match[1])) matches.add(match[1]);
  }
  return [...matches].sort();
}

function recognizedTests(output: string, sourceTestNames: ReadonlySet<string> | undefined): string[] {
  if (!sourceTestNames) return [];
  const matches = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^--- FAIL:\s+(Test[A-Z][A-Za-z0-9_]*)(?:\/[^\s(]+)*(?:\s|\(|$)/u.exec(line);
    const name = match?.[1];
    if (name && GO_TEST_NAME.test(name) && sourceTestNames.has(name)) matches.add(name);
  }
  return [...matches].sort().slice(0, MAX_REPORTED_TESTS);
}

function compilerPackages(output: string): string[] {
  const matches = new Set<string>();
  for (const match of output.matchAll(/^#\s+(\S+)/gmu)) {
    if (OPERATOR_PACKAGES.has(match[1])) matches.add(match[1]);
  }
  for (const match of output.matchAll(/^FAIL\s+(\S+)\s+\[build failed\]/gmu)) {
    if (OPERATOR_PACKAGES.has(match[1])) matches.add(match[1]);
  }
  return [...matches].sort();
}

function hasResourceFailure(output: string): boolean {
  return /failed to create new OS thread|resource temporarily unavailable|cannot allocate memory|no space left on device|too many open files/iu.test(output);
}

function hasModuleFailure(output: string): boolean {
  return /^go: (?:missing go\.sum entry for module providing package|updates to go\.mod needed|no required module provides package|errors parsing go\.mod|go\.mod file not found|module lookup disabled)/mi.test(output);
}

function diagnosticClass(
  failureClass: GoFailureClass,
  spawnErrorClass: GoSpawnErrorClass | null,
  signal: string | null,
  status: number | null,
  output: string,
  packages: string[],
  tests: string[],
  compiler: string[],
  goVersion: string | null,
): GoDiagnosticClass {
  if (spawnErrorClass !== null) {
    if (spawnErrorClass === 'resource_exhausted') return 'resource_exhausted';
    if (spawnErrorClass === 'timeout' || spawnErrorClass === 'output_buffer_limit'
      || spawnErrorClass === 'executable_missing' || spawnErrorClass === 'permission_denied') {
      return spawnErrorClass;
    }
    return 'spawn_error';
  }
  if (signal !== null) return 'process_signal';
  if (status === null) return 'missing_exit_status';
  if (status !== 0) {
    if (hasResourceFailure(output)) return 'resource_exhausted';
    if (hasModuleFailure(output)) return 'module_failure';
    if (compiler.length > 0) return 'compiler_failure';
    if (packages.length > 0 || tests.length > 0 || /^--- FAIL:\s+Test[A-Z]/mu.test(output)) {
      return 'go_test_failure';
    }
    return 'unclassified_exit';
  }
  if (failureClass === 'suite_failure') return 'go_test_failure';
  if (failureClass === 'missing_expected_package') return 'missing_expected_package';
  if (failureClass !== 'success') return 'unclassified_exit';
  return goVersion === null ? 'toolchain_version_unavailable' : 'success';
}

/**
 * Preserve the old pass/fail gate while adding only bounded, allowlisted diagnostics. Raw child
 * output, arbitrary error messages/codes, and filesystem paths are represented by hashes only.
 */
export function goFailureReceipt(
  result: GoProcessResult,
  options: GoFailureReceiptOptions = {},
): GoFailureReceipt {
  const stdout = text(result.stdout);
  const stderr = text(result.stderr);
  const output = `${stdout}\n${stderr}`;
  const failedPackages = recognizedPackages(output);
  const failedTests = recognizedTests(output, options.sourceTestNames);
  const compilePackages = compilerPackages(output);
  const spawnErrorClass = classifySpawnError(result.error);
  const signal = result.signal === null
    ? null
    : typeof result.signal === 'string' && GO_SIGNALS.has(result.signal) ? result.signal : 'UNKNOWN';
  const status = exitStatus(result.status);
  const goVersion = parsedVersion(options.goVersion);
  const failureClass: GoFailureClass = spawnErrorClass !== null ? 'process_error'
    : signal !== null ? 'process_signal'
    : failedPackages.length > 0 ? 'package_failure'
    : status === null ? 'missing_exit_status'
    : status !== 0 ? 'exit_nonzero'
    : stdout.includes('FAIL') ? 'suite_failure'
    : !stdout.includes(`${OPERATOR_MODULE}/controllers`) ? 'missing_expected_package'
    : 'success';

  return {
    status,
    signal,
    errorClass: spawnErrorClass,
    failureClass,
    diagnosticClass: diagnosticClass(
      failureClass, spawnErrorClass, signal, status, output, failedPackages, failedTests, compilePackages, goVersion,
    ),
    goVersion,
    failedPackages,
    failedTests,
    stdoutSha256: createHash('sha256').update(stdout, 'utf8').digest('hex'),
    stderrSha256: createHash('sha256').update(stderr, 'utf8').digest('hex'),
  };
}
