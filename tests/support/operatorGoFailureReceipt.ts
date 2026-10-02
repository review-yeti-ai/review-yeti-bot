import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
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
  operatorDirectory?: unknown;
  sourceAssertionManifest?: unknown;
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
  assertionObservations?: GoAssertionObservation[];
}

const LIFECYCLE_TEST = 'TestM4_Integration_DynamicLifecycle_SlotRecycling_AcrossThreads';
const ASSERTION_FILES = [
  'controllers/m4_multithread_concurrency_test.go',
  'controllers/m2_declarative_admission_concurrency_test.go',
] as const;
const OWNER_OPERATOR_DIRECTORY = resolve(__dirname, '../../k8s-operator');
const ASSERTION_PHASES = new Set([
  'Queued', 'Running', 'Succeeded', 'Failed', 'Expired', 'Cancelled',
  'AwaitingResumption', 'Suspended',
]);
const LIFECYCLE_CONTEXT = [
  'threadCounts := []int{1, 4, 16}', 'name := fmt.Sprintf("%dThreads", threads)',
  't.Run(name, func(t *testing.T) {', 'const limit = 4', 'const totalReviews = 16',
  'if len(runningReviews) != limit {',
  'if cur0.Status.Phase != reviewv1alpha2.PhaseSucceeded {',
  'if cur1.Status.Phase != reviewv1alpha2.PhaseSucceeded {',
  'if cur2.Status.Phase != reviewv1alpha2.PhaseFailed {',
  'if runningCount != limit {', 'if succeededCount != 2 {', 'if failedCount != 1 {',
  'if queuedCount != totalReviews-limit-succeededCount-failedCount {',
  'if monitor.MaxObservedActive() > limit {',
] as const;
const ASSERTION_TEMPLATES = [
  { templateId: 'm4.lifecycle.initial-running', kind: 'count', expected: 4,
    format: 'expected initial %d running reviews, got %d', args: 'limit, len(runningReviews)',
    message: /^expected initial 4 running reviews, got ([0-9]+)$/u },
  { templateId: 'm4.lifecycle.review0-phase', kind: 'phase', expected: 'Succeeded',
    format: 'expected Review 0 Succeeded, got %s', args: 'cur0.Status.Phase',
    message: /^expected Review 0 Succeeded, got ([A-Za-z]+)$/u },
  { templateId: 'm4.lifecycle.review1-phase', kind: 'phase', expected: 'Succeeded',
    format: 'expected Review 1 Succeeded, got %s', args: 'cur1.Status.Phase',
    message: /^expected Review 1 Succeeded, got ([A-Za-z]+)$/u },
  { templateId: 'm4.lifecycle.review2-phase', kind: 'phase', expected: 'Failed',
    format: 'expected Review 2 Failed, got %s', args: 'cur2.Status.Phase',
    message: /^expected Review 2 Failed, got ([A-Za-z]+)$/u },
  { templateId: 'm4.lifecycle.turnover-running', kind: 'count', expected: 4,
    format: 'expected %d running reviews after slot turnover, got %d', args: 'limit, runningCount',
    message: /^expected 4 running reviews after slot turnover, got ([0-9]+)$/u },
  { templateId: 'm4.lifecycle.succeeded-count', kind: 'count', expected: 2,
    format: 'expected 2 succeeded reviews, got %d', args: 'succeededCount',
    message: /^expected 2 succeeded reviews, got ([0-9]+)$/u },
  { templateId: 'm4.lifecycle.failed-count', kind: 'count', expected: 1,
    format: 'expected 1 failed review, got %d', args: 'failedCount',
    message: /^expected 1 failed review, got ([0-9]+)$/u },
  { templateId: 'm4.lifecycle.queued-count', kind: 'count', expected: 9,
    format: 'expected %d queued reviews, got %d', args: 'totalReviews-limit-succeededCount-failedCount, queuedCount',
    message: /^expected 9 queued reviews, got ([0-9]+)$/u },
  { templateId: 'm4.lifecycle.capacity-max', kind: 'maximum', expected: 4,
    format: 'limit exceeded during turnover: max %d', args: 'monitor.MaxObservedActive()',
    message: /^limit exceeded during turnover: max ([0-9]+)$/u },
] as const;

interface GoAssertionSource {
  file: string;
  sha256: string;
}

interface GoAssertionDeclaration {
  templateId: string;
  source: GoAssertionSource & { line: number };
  testName: string;
  format: string;
}

export interface GoAssertionManifest {
  schema: 'operator-go-assertion-manifest.v1';
  sources: GoAssertionSource[];
  assertions: GoAssertionDeclaration[];
}

export interface GoAssertionObservation {
  templateId: string;
  source: GoAssertionSource & { line: number };
  testName: string;
  threadCount: number;
  values: { expected: number | string; actual: number | string } | { maximum: number };
}

/** Derive the closed declaration inventory from this helper's own repository, never output paths. */
export function readOperatorGoAssertionManifest(operatorDirectory: unknown): GoAssertionManifest | null {
  if (typeof operatorDirectory !== 'string') return null;
  try {
    const ownerRoot = realpathSync(OWNER_OPERATOR_DIRECTORY);
    if (realpathSync(operatorDirectory) !== ownerRoot || !lstatSync(ownerRoot).isDirectory()) return null;
    const contents = ASSERTION_FILES.map((file) => {
      const path = join(ownerRoot, file);
      if (realpathSync(path) !== path || !lstatSync(path).isFile()) throw new Error('Invalid assertion source');
      return readFileSync(path);
    });
    const sources = ASSERTION_FILES.map((file, index) => ({
      file, sha256: createHash('sha256').update(contents[index]).digest('hex'),
    }));
    const lines = contents[0].toString('utf8').split(/\r?\n/u);
    const start = lines.indexOf(`func ${LIFECYCLE_TEST}(t *testing.T) {`);
    const end = lines.findIndex((line, index) => index > start && line === '}');
    if (start < 0 || end <= start) return null;
    const body = lines.slice(start, end + 1).map((line) => line.trim());
    if (!LIFECYCLE_CONTEXT.every((anchor) => body.includes(anchor))) return null;
    const assertions = ASSERTION_TEMPLATES.map((template) => {
      const declaration = `t.Fatalf(${JSON.stringify(template.format)}, ${template.args})`;
      const matches = body.flatMap((line, index) => line === declaration ? [start + index + 1] : []);
      if (matches.length !== 1) throw new Error('Ambiguous assertion declaration');
      return {
        templateId: template.templateId, source: { ...sources[0], line: matches[0] },
        testName: LIFECYCLE_TEST, format: template.format,
      };
    });
    return { schema: 'operator-go-assertion-manifest.v1', sources, assertions };
  } catch {
    return null;
  }
}

/** Compare closed data without reading accessors or allowing additional keys at any depth. */
function sameAssertionManifest(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual) !== Array.isArray(expected)) return false;
  const prototype = Object.getPrototypeOf(actual);
  if (prototype !== (Array.isArray(expected) ? Array.prototype : Object.prototype) && prototype !== null) return false;
  const keys = Reflect.ownKeys(expected);
  if (Reflect.ownKeys(actual).length !== keys.length) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(actual, key);
    return descriptor !== undefined && 'value' in descriptor
      && sameAssertionManifest(descriptor.value, (expected as Record<PropertyKey, unknown>)[key]);
  });
}

function assertionValues(template: typeof ASSERTION_TEMPLATES[number], message: string): GoAssertionObservation['values'] | null {
  const match = template.message.exec(message);
  if (!match) return null;
  const value = match[1];
  if (template.kind === 'phase') {
    return ASSERTION_PHASES.has(value) && value !== template.expected
      ? { expected: template.expected, actual: value } : null;
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || String(count) !== value || count > 16) return null;
  if (template.kind === 'maximum') return count > template.expected ? { maximum: count } : null;
  return count !== template.expected ? { expected: template.expected, actual: count } : null;
}

/** All candidate blocks must be complete and closed; one unknown line withholds the whole inventory. */
function parseAssertionBlocks(stdout: string, manifest: GoAssertionManifest): GoAssertionObservation[] {
  const observations: GoAssertionObservation[] = [];
  const threads = new Set<number>();
  let enclosing = false;
  let thread: number | null = null;
  let observed = false;
  let packageFooter = false;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    const top = /^--- FAIL: (Test[A-Z][A-Za-z0-9_]*) \([0-9]+(?:\.[0-9]+)?s\)$/u.exec(line);
    if (top) {
      if (top[1] !== LIFECYCLE_TEST || enclosing && (thread === null || !observed)) return [];
      enclosing = true;
      packageFooter = false;
      thread = null;
      continue;
    }
    const sub = /^ {4}--- FAIL: (Test[A-Z][A-Za-z0-9_]*)\/(1|4|16)Threads \([0-9]+(?:\.[0-9]+)?s\)$/u.exec(line);
    if (sub) {
      if (!enclosing || sub[1] !== LIFECYCLE_TEST || thread !== null && !observed) return [];
      thread = Number(sub[2]);
      if (threads.has(thread)) return [];
      threads.add(thread);
      packageFooter = false;
      observed = false;
      continue;
    }
    const assertion = /^ {8}([a-z0-9_]+\.go):([1-9][0-9]*): (.+)$/u.exec(line);
    if (assertion) {
      if (!enclosing || thread === null || observed) return [];
      const declaration = manifest.assertions.find((row) => basename(row.source.file) === assertion[1]
        && String(row.source.line) === assertion[2]);
      const template = ASSERTION_TEMPLATES.find((row) => row.templateId === declaration?.templateId);
      const values = template ? assertionValues(template, assertion[3]) : null;
      if (!declaration || !values) return [];
      observations.push({
        templateId: declaration.templateId, source: { ...declaration.source },
        testName: declaration.testName, threadCount: thread, values,
      });
      observed = true;
      continue;
    }
    const footer = /^(FAIL|ok|\?)\s+(\S+)(?:\s+(?:[0-9]+(?:\.[0-9]+)?s|\[no test files\]|\(cached\)))?$/u.exec(line);
    if (footer) {
      if (!OPERATOR_PACKAGES.has(footer[2])
        || enclosing && (thread === null || !observed
          || footer[1] !== 'FAIL' || footer[2] !== `${OPERATOR_MODULE}/controllers`)) return [];
      if (footer[1] === 'FAIL' && footer[2] === `${OPERATOR_MODULE}/controllers`) packageFooter = true;
      enclosing = false;
      thread = null;
      continue;
    }
    if (line === 'FAIL') {
      if (enclosing && (thread === null || !observed)) return [];
      enclosing = false;
      thread = null;
      continue;
    }
    return [];
  }
  return packageFooter && observations.length > 0 && observations.length <= 3
    && !enclosing ? observations : [];
}

function assertionObservations(
  result: GoProcessResult,
  options: GoFailureReceiptOptions,
  stdout: string,
  goVersion: string | null,
): GoAssertionObservation[] {
  if (exitStatus(result.status) === null || result.status === 0 || result.signal !== null
    || result.error !== undefined && result.error !== null || goVersion === null
    || text(result.stderr).trim() !== '') return [];
  try {
    if (!options.sourceTestNames?.has(LIFECYCLE_TEST)) return [];
    const manifest = readOperatorGoAssertionManifest(options.operatorDirectory);
    if (!manifest || !sameAssertionManifest(options.sourceAssertionManifest, manifest)) return [];
    return parseAssertionBlocks(stdout, manifest);
  } catch {
    return [];
  }
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

  const observations = assertionObservations(result, options, stdout, goVersion);
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
    ...(observations.length > 0 ? { assertionObservations: observations } : {}),
  };
}
