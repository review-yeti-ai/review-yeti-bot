/**
 * REL-1081 (plan W4): Jev triage in SHADOW mode.
 *
 * Spec: docs/superpowers/specs/2026-09-23-review-content-shrinking-and-jev-triage.md, section 4 W4.
 *
 * Per changed file, asks Jev (TypeSafe AI System One, `../gateway/jevClient`) three closed
 * questions -- a category choice, a 1-5 risk score with written criteria, and one yes/no
 * ("noul") per enabled persona -- logs the typed answers, and after the panel finishes joins
 * them with the findings the panel actually produced on that file. The joined log lines are the
 * calibration data the plan's section 5 step 6 needs before Jev may ever affect a review.
 *
 * WHAT THIS MODULE MUST NEVER DO (plan section 3; pinned by tests/unit/jevTriageShadow*.test.ts):
 *
 *   - Change the review. Nothing here returns a value the worker feeds back into the panel,
 *     arbitration, the published check, or any completion callback. The worker only starts the
 *     triage, later asks it to log the join, and aborts it. It never reads a decision.
 *   - Block or slow the review. The triage runs concurrently with the panel, every call shares
 *     one bounded stage budget, and `settled` resolves by a hard deadline even if the Jev client
 *     (or a test double) ignores its abort signal. The worker awaits the join only after every
 *     outcome-visible action (check publication, completion callbacks) has already happened.
 *   - Fail closed. The flag off, `TYPESAFE_*` unset, a partial `TYPESAFE_*` config (which
 *     `jevTransport` rightly throws for elsewhere), a client that cannot be constructed, a thrown
 *     `ask()`, an `unavailable` outcome, a malformed answer, or a timeout all resolve to "logged,
 *     nothing else happened". No path here throws or rejects into the worker.
 *   - Ask Jev to count. Line counts, hunk counts, test/security/docs classification and the
 *     truncation marker are computed in code and passed as facts (`TriageFileFacts`).
 */
import {
  JevClient,
  isScoreIndexKey,
  type JevAnswer,
  type JevAsker,
  type JevChoiceAnswer,
  type JevNoulAnswer,
  type JevQuestion,
  type JevScoreAnswer,
} from '../gateway/jevClient';
import { jevTransport } from './jevTransport';
import { JEV_INPUT_TOKEN_USD_PER_MILLION } from '../types/jevContract';
import { classifyLockfileOrGeneratedPath } from '../pipeline/hunkFilter';
import { isDocumentationOrAssetPath } from './reviewableContent';
import { getMetrics } from '../telemetry';
import { logger } from '../utils/logger';
import type { ChangedFile } from './changedFiles';

export const JEV_SHADOW_FLAG = 'REVIEW_YETI_JEV_SHADOW';
/** Telemetry seam passed to `JevClient.ask()`; tags the client's own request/latency/cost metrics. */
export const JEV_TRIAGE_SHADOW_SEAM = 'triage_shadow';

export const JEV_TRIAGE_LOG = {
  decision: 'jev_triage_shadow_decision',
  join: 'jev_triage_shadow_join',
  summary: 'jev_triage_shadow_summary',
  skipped: 'jev_triage_shadow_skipped',
} as const;

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

const ALL_REPOSITORIES = new Set(['true', '1', 'on', 'all', '*']);

/**
 * Default OFF. `true`/`1`/`on`/`all`/`*` enables every repository; otherwise the value is a
 * comma-separated allow-list of `owner/repo` (case-insensitive), so the flag can be enabled per
 * repository first (plan section 3.6). Anything else, including unset, is off.
 */
/** Worker environment, read only. Deliberately looser than `NodeJS.ProcessEnv`. */
export type JevShadowEnv = Readonly<Record<string, string | undefined>>;

export function jevShadowEnabledFor(env: JevShadowEnv, repository: string): boolean {
  const raw = String(env[JEV_SHADOW_FLAG] || '').trim().toLowerCase();
  if (!raw) return false;
  if (ALL_REPOSITORIES.has(raw)) return true;
  const target = String(repository || '').trim().toLowerCase();
  if (!target) return false;
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean).includes(target);
}

// ---------------------------------------------------------------------------
// Questions (closed sets only -- Jev never generates text)
// ---------------------------------------------------------------------------

export const JEV_TRIAGE_CATEGORIES: Record<string, string> = {
  mechanical_rename: 'The file was renamed or moved, and any content change is only the mechanical consequence (paths, imports, identifiers).',
  formatting: 'Only whitespace, formatting, or comment layout changed; no behaviour could change.',
  generated: 'The file is machine-generated or vendored (build output, codegen, snapshots, bundled third-party code).',
  test: 'Test code, test fixtures, or test configuration.',
  config: 'Non-security configuration: application settings, linters, editor or tooling configuration.',
  docs: 'Documentation, prose, or non-executable assets.',
  source_low_risk: 'Executable source with a small, local, low-consequence change (a log message, a constant, an isolated helper).',
  source: 'Executable source that changes application behaviour.',
  security_sensitive: 'Authentication, authorization, cryptography, secrets handling, CI/CD workflows, container or infrastructure definitions, or dependency manifests.',
};

/**
 * Ordered risk levels 1..5. Index 0 is level 1. Jev keys the score answer's `legend` and
 * `probabilities` by this index as a string ("0".."4"), so level = index + 1.
 */
export const JEV_RISK_CRITERIA: readonly string[] = [
  'Level 1, trivial: no behavioural effect (documentation, comments, formatting, a pure rename).',
  'Level 2, low: an isolated change with a small blast radius (tests, non-critical configuration, a local refactor with unchanged behaviour).',
  'Level 3, moderate: changes application logic inside one contained module.',
  'Level 4, high: changes shared logic, a public interface, data handling, concurrency, or error and retry paths.',
  'Level 5, critical: touches authentication, authorization, cryptography, secrets, CI/CD, infrastructure, or dependency manifests, or a mistake could cause data loss or a security exposure.',
];

const CHARTER_FOCUS: Record<string, string> = {
  'builtin:security': 'security vulnerabilities, unsafe input handling, secrets, authentication and authorization',
  'builtin:performance': 'performance, resource usage, algorithmic complexity, and latency',
  'builtin:architecture': 'architecture, module boundaries, coupling, and design consistency',
  'builtin:consistency': 'test quality, test coverage, and consistency with existing conventions',
  'builtin:dependency-health': 'dependency changes, versions, supply chain, and license health',
  'builtin:contract': 'API and data contracts, compatibility, and interface changes',
  'builtin:policy-compliance': 'licensing and policy compliance',
  'builtin:correctness': 'logic errors and correctness bugs',
};

export interface TriagePersona {
  id: string;
  charter?: string;
}

export const LANE_QUESTION_PREFIX = 'lane__';

export function laneQuestionKey(personaId: string): string {
  return `${LANE_QUESTION_PREFIX}${personaId}`;
}

export function buildJevTriageQuestions(personas: readonly TriagePersona[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    category: {
      type: 'choice',
      instructions: 'Which single category best describes the change to this file? Use the supplied facts; they are computed exactly.',
      criteria: { ...JEV_TRIAGE_CATEGORIES },
    },
    risk: {
      type: 'score',
      instructions: 'How risky is the change to this file, if it contained a mistake? Pick the level whose description fits best.',
      criteria: [...JEV_RISK_CRITERIA],
    },
  };
  for (const persona of personas) {
    const focus = CHARTER_FOCUS[String(persona.charter || '')] || `the "${persona.id}" review charter`;
    questions[laneQuestionKey(persona.id)] = {
      type: 'noul',
      instructions: `Should the reviewer focused on ${focus} review this file?`,
      criteria: {
        true: `The change could plausibly contain a problem in ${focus}.`,
        false: `The change cannot plausibly contain a problem in ${focus}.`,
      },
    };
  }
  return questions;
}

// ---------------------------------------------------------------------------
// Deterministic facts (computed in code; never asked)
// ---------------------------------------------------------------------------

const SECURITY_SENSITIVE_PATTERNS: readonly RegExp[] = [
  // Authentication, authorization, crypto, secrets.
  /(^|[/._-])(auth|authn|authz|oauth|oidc|saml|sso|jwt|login|session|permissions?|rbac|acl|crypto|cipher|encrypt|decrypt|signing|signature|secrets?|credentials?|passwords?|tokens?|keys?)([/._-]|$)/iu,
  /\.(pem|key|crt|p12|pfx|jks|keystore)$/iu,
  // CI/CD.
  /(^|\/)\.github\/(workflows|actions)\//iu,
  /(^|\/)\.gitlab-ci\.ya?ml$/iu,
  /(^|\/)\.circleci\//iu,
  /(^|\/)jenkinsfile$/iu,
  /(^|\/)azure-pipelines[^/]*\.ya?ml$/iu,
  /(^|\/)action\.ya?ml$/iu,
  // Containers and infrastructure as code.
  /(^|\/)(dockerfile|containerfile)([^/]*)$/iu,
  /(^|\/)[^/]*\.dockerfile$/iu,
  /(^|\/)(docker-)?compose[^/]*\.ya?ml$/iu,
  /\.(tf|tfvars|hcl)$/iu,
  /(^|\/)(charts|helm|k8s|kubernetes|kustomize|terraform|infra|infrastructure|deploy|deployment)\//iu,
  /(^|\/)kustomization\.ya?ml$/iu,
  // Dependency manifests and lockfiles.
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|pipfile(\.lock)?|pyproject\.toml|poetry\.lock|go\.mod|go\.sum|cargo\.toml|cargo\.lock|gemfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?|mix\.exs|mix\.lock|composer\.(json|lock)|[^/]*\.csproj|packages\.config)$/iu,
];

export function isSecuritySensitivePath(filePath: string): boolean {
  const normalized = String(filePath || '').replace(/\\/gu, '/');
  return SECURITY_SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

const TEST_PATTERNS: readonly RegExp[] = [
  /(^|\/)(test|tests|__tests__|__mocks__|spec|specs|testdata|fixtures)\//iu,
  /\.(test|spec)\.[a-z0-9]+$/iu,
  /_test\.(go|py|exs?|rb|rs)$/iu,
  /(^|\/)test_[^/]+\.py$/iu,
  /(^|\/)[^/]*Tests?\.(java|kt|cs|swift)$/u,
];

export function isTestPath(filePath: string): boolean {
  const normalized = String(filePath || '').replace(/\\/gu, '/');
  return TEST_PATTERNS.some((pattern) => pattern.test(normalized));
}

export type TriageChangeKind = 'added' | 'deleted' | 'renamed' | 'modified';

export interface TriageFileFacts {
  path: string;
  extension: string;
  change_kind: TriageChangeKind;
  added_lines: number;
  removed_lines: number;
  hunk_count: number;
  is_test: boolean;
  is_docs_or_asset: boolean;
  lockfile_or_generated: 'lockfile' | 'generated' | null;
  security_sensitive: boolean;
  is_submodule: boolean;
  is_binary: boolean;
  patch_chars: number;
  hunks_truncated: boolean;
}

function extensionOf(filePath: string): string {
  const base = filePath.split('/').pop() || filePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function changeKindOf(patch: string): TriageChangeKind {
  if (/^new file mode /mu.test(patch)) return 'added';
  if (/^deleted file mode /mu.test(patch)) return 'deleted';
  if (/^rename (from|to) /mu.test(patch)) return 'renamed';
  return 'modified';
}

/** The hunk body only: everything from the first `@@` on. Headers are facts, not content. */
function hunkBody(patch: string): string {
  const index = patch.search(/^@@/mu);
  return index >= 0 ? patch.slice(index) : '';
}

export function computeTriageFileFacts(file: ChangedFile, maxHunkChars: number): { facts: TriageFileFacts; hunks: string } {
  const patch = String(file.patch || '');
  const body = hunkBody(patch);
  let added = 0;
  let removed = 0;
  let hunks = 0;
  for (const line of body.split('\n')) {
    if (line.startsWith('@@')) hunks += 1;
    else if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  const truncated = body.length > maxHunkChars;
  return {
    facts: {
      path: file.path,
      extension: extensionOf(file.path),
      change_kind: changeKindOf(patch),
      added_lines: added,
      removed_lines: removed,
      hunk_count: hunks,
      is_test: isTestPath(file.path),
      is_docs_or_asset: isDocumentationOrAssetPath(file.path),
      lockfile_or_generated: classifyLockfileOrGeneratedPath(file.path),
      security_sensitive: isSecuritySensitivePath(file.path),
      is_submodule: file.isSubmodule === true,
      is_binary: /^Binary files .* differ$/mu.test(patch) || /^GIT binary patch$/mu.test(patch),
      patch_chars: body.length,
      hunks_truncated: truncated,
    },
    hunks: truncated ? body.slice(0, maxHunkChars) : body,
  };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface JevTriageShadowLimits {
  /** Files beyond this many (in diff order) are recorded as `file_cap` and not asked. */
  maxFiles: number;
  /** Concurrent `ask()` calls. */
  concurrency: number;
  /** Hunk characters sent per file; the rest is dropped and `hunks_truncated` is set. */
  maxHunkChars: number;
  /** JevClient shared stage budget for the whole triage. */
  stageBudgetMs: number;
  /** JevClient per-call cap. */
  perCallCapMs: number;
  /** JevClient retries on 429/529. */
  maxRetries: number;
  /**
   * Hard deadline for `settled`, measured from start. Independent of the client's own budget so
   * a client (or double) that ignores its abort signal still cannot hold the worker.
   */
  hardTimeoutMs: number;
}

export const DEFAULT_JEV_TRIAGE_SHADOW_LIMITS: Readonly<JevTriageShadowLimits> = Object.freeze({
  maxFiles: 40,
  concurrency: 4,
  maxHunkChars: 12_000,
  stageBudgetMs: 15_000,
  perCallCapMs: 5_000,
  maxRetries: 1,
  hardTimeoutMs: 16_000,
});

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type TriageDecisionOutcome =
  | 'ok'
  | 'unavailable'
  | 'error'
  | 'file_cap'
  | 'not_started';

export interface TriageLaneDecision {
  noul: number | null;
}

export interface TriageFileDecision {
  path: string;
  outcome: TriageDecisionOutcome;
  /** `unavailable` reason from the client, or the error class for `error`. */
  reason?: string;
  facts: TriageFileFacts;
  category?: string | null;
  category_valid?: boolean;
  category_confidence?: number | null;
  category_probabilities?: Record<string, number>;
  risk_score?: number | null;
  risk_level?: number | null;
  risk_confidence?: number | null;
  risk_probabilities?: Record<string, number>;
  lanes?: Record<string, TriageLaneDecision>;
  model?: string;
  model_pin?: string;
  model_pin_match?: boolean;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  latency_ms: number;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numericRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

/** Criteria index (0-based) for a score-answer key, or -1 if the key is not a defined risk level. */
function riskIndexFromKey(answer: JevScoreAnswer, key: string): number {
  if (!isScoreIndexKey(key)) return -1;
  if (answer.legend && !Object.prototype.hasOwnProperty.call(answer.legend, key)) return -1;
  const index = Number(key);
  return index < JEV_RISK_CRITERIA.length ? index : -1;
}

/**
 * Risk level 1..5 from the score answer: the argmax of `probabilities` over the legend indices,
 * plus one. `score` is deliberately NOT used: the live API returns it as the expected 0-based
 * level index (a mean in [0, n-1], REL-1100), which is off by one from a level and, for a split
 * distribution, can name a level Jev itself rates unlikely. It is logged raw as `risk_score`. A tie
 * resolves to the HIGHER level, so a shadow log never under-reports risk. Null when no
 * probability names a defined level -- a shadow log records "unknown", it never guesses.
 */
export function riskLevelFromAnswer(answer: JevScoreAnswer | undefined): number | null {
  if (!answer) return null;
  const probabilities = numericRecord(answer.probabilities);
  let bestIndex = -1;
  let bestProbability = -Infinity;
  for (const [key, probability] of Object.entries(probabilities)) {
    const index = riskIndexFromKey(answer, key);
    if (index < 0) continue;
    if (probability > bestProbability || (probability === bestProbability && index > bestIndex)) {
      bestIndex = index;
      bestProbability = probability;
    }
  }
  return bestIndex >= 0 ? bestIndex + 1 : null;
}

// ---------------------------------------------------------------------------
// Join inputs (a structural subset of the panel result -- read only)
// ---------------------------------------------------------------------------

export interface TriageJoinFinding {
  path?: unknown;
  severity?: unknown;
}

export interface TriageJoinInput {
  /** Canonical (published) findings. */
  findings: readonly TriageJoinFinding[];
  /** Raw per-lane results, for per-persona attribution. */
  personas: ReadonlyArray<{ id?: unknown; findings?: readonly TriageJoinFinding[] }>;
  /** Persona ids the panel considered applicable, when it reports them. */
  applicablePersonaIds?: readonly unknown[];
  mode: string;
  verdict: string;
  conclusion: string;
}

const BLOCKING = new Set(['P0', 'P1']);

function severityOf(finding: TriageJoinFinding): string {
  return String(finding?.severity || 'P2').toUpperCase();
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface JevTriageShadowSummary {
  status: 'disabled' | 'unconfigured' | 'misconfigured' | 'completed' | 'timeout' | 'aborted' | 'error';
  decisions: TriageFileDecision[];
}

export interface JevTriageShadowHandle {
  /** Resolves by `hardTimeoutMs`; never rejects. */
  readonly settled: Promise<JevTriageShadowSummary>;
  /** Logs one join line per file plus one summary line. Never throws or rejects. */
  join(input: TriageJoinInput): Promise<void>;
  /** Stops outstanding calls and timers. Idempotent. */
  abort(): void;
}

export interface StartJevTriageShadowInput {
  env: JevShadowEnv;
  repository: string;
  runId: string;
  prNumber: number;
  headSha: string;
  changedFiles: readonly ChangedFile[];
  personas: readonly TriagePersona[];
  /** Test seam. Production builds a `JevClient` from `TYPESAFE_*`. */
  asker?: JevAsker;
  limits?: Partial<JevTriageShadowLimits>;
  now?: () => number;
}

function inertHandle(status: JevTriageShadowSummary['status']): JevTriageShadowHandle {
  const settled = Promise.resolve<JevTriageShadowSummary>({ status, decisions: [] });
  return { settled, join: async () => undefined, abort: () => undefined };
}

function errorClass(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return typeof error;
}

function safeMetric(record: () => void): void {
  try {
    record();
  } catch {
    // Telemetry is never allowed to affect the review.
  }
}

/**
 * Starts the shadow triage. Synchronous and total: it never throws, and when the flag is off it
 * does no work at all (not even resolving `TYPESAFE_*`, whose partial-config check throws).
 */
export function startJevTriageShadow(input: StartJevTriageShadowInput): JevTriageShadowHandle {
  try {
    return startInternal(input);
  } catch (error) {
    logger.warn('Jev triage shadow failed to start; review unaffected', {
      event: JEV_TRIAGE_LOG.skipped,
      reason: 'start_error',
      error_class: errorClass(error),
      runId: input?.runId,
      repository: input?.repository,
    });
    return inertHandle('error');
  }
}

function startInternal(input: StartJevTriageShadowInput): JevTriageShadowHandle {
  if (!jevShadowEnabledFor(input.env, input.repository)) return inertHandle('disabled');

  const context = {
    runId: input.runId,
    repository: input.repository,
    prNumber: input.prNumber,
    headSha: input.headSha,
  };

  let transport: ReturnType<typeof jevTransport>;
  try {
    transport = jevTransport(input.env as NodeJS.ProcessEnv);
  } catch {
    logger.warn('Jev triage shadow skipped: TYPESAFE_* configuration is partial or invalid; review unaffected', {
      event: JEV_TRIAGE_LOG.skipped, reason: 'misconfigured', ...context,
    });
    return inertHandle('misconfigured');
  }
  if (!transport) {
    logger.info('Jev triage shadow skipped: TYPESAFE_* is not configured; review unaffected', {
      event: JEV_TRIAGE_LOG.skipped, reason: 'unconfigured', ...context,
    });
    return inertHandle('unconfigured');
  }

  const limits: JevTriageShadowLimits = { ...DEFAULT_JEV_TRIAGE_SHADOW_LIMITS, ...(input.limits || {}) };
  const now = input.now || Date.now;

  let asker: JevAsker;
  try {
    asker = input.asker || new JevClient({
      baseUrl: transport.baseUrl,
      apiKey: transport.apiKey,
      model: transport.model,
      modelPin: transport.modelPin,
      stageBudgetMs: limits.stageBudgetMs,
      perCallCapMs: limits.perCallCapMs,
      maxRetries: limits.maxRetries,
    });
  } catch (error) {
    logger.warn('Jev triage shadow skipped: client could not be constructed; review unaffected', {
      event: JEV_TRIAGE_LOG.skipped, reason: 'client_error', error_class: errorClass(error), ...context,
    });
    return inertHandle('misconfigured');
  }

  const modelPin = transport.modelPin;
  const questions = buildJevTriageQuestions(input.personas);
  const personaIds = input.personas.map((persona) => persona.id);
  // Snapshot what we read so a later mutation elsewhere cannot change what we log, and so this
  // module never holds (let alone mutates) the worker's own array.
  const files = input.changedFiles.map((file) => ({
    path: file.path, patch: file.patch, ...(file.isSubmodule ? { isSubmodule: true } : {}),
  }));
  const startedAt = now();
  const controller = new AbortController();
  const decisions: Array<TriageFileDecision | undefined> = new Array(files.length).fill(undefined);
  const factsCache = files.map((file) => computeTriageFileFacts(file, limits.maxHunkChars));

  const record = (index: number, decision: TriageFileDecision): void => {
    decisions[index] = decision;
    logger.info('Jev triage shadow decision', { event: JEV_TRIAGE_LOG.decision, ...context, ...flattenDecision(decision) });
    safeMetric(() => getMetrics().jevTriageShadowFiles.add(1, {
      outcome: decision.outcome,
      category: decision.category_valid ? String(decision.category) : 'none',
      risk_level: decision.risk_level ? String(decision.risk_level) : 'none',
    }));
  };

  const askOne = async (index: number): Promise<void> => {
    const { facts, hunks } = factsCache[index];
    const callStarted = now();
    try {
      const outcome = await asker.ask({
        state: { file: { path: facts.path, extension: facts.extension }, facts, hunks },
        questions,
        seam: JEV_TRIAGE_SHADOW_SEAM,
        signal: controller.signal,
      });
      // Past the hard deadline (or an abort) the summary is already final: a late answer is
      // dropped rather than logged as if it had counted.
      if (controller.signal.aborted) return;
      if (outcome.status !== 'ok') {
        record(index, { path: facts.path, outcome: 'unavailable', reason: outcome.reason, facts, latency_ms: outcome.durationMs });
        return;
      }
      record(index, decisionFromAnswers(facts, outcome, personaIds, modelPin));
    } catch (error) {
      if (controller.signal.aborted) return;
      // Includes programmer errors from validateJevQuestions: in shadow mode they are logged and
      // absorbed, never allowed to reach the worker.
      record(index, { path: facts.path, outcome: 'error', reason: errorClass(error), facts, latency_ms: now() - callStarted });
    }
  };

  const eligible = Math.min(files.length, Math.max(0, limits.maxFiles));
  for (let index = eligible; index < files.length; index += 1) {
    record(index, { path: files[index].path, outcome: 'file_cap', facts: factsCache[index].facts, latency_ms: 0 });
  }

  let next = 0;
  const workerLoop = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const index = next;
      next += 1;
      if (index >= eligible) return;
      await askOne(index);
    }
  };
  const run = Promise.all(
    Array.from({ length: Math.max(1, Math.min(limits.concurrency, eligible || 1)) }, () => workerLoop()),
  ).then(() => 'completed' as const);

  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const hardDeadline = new Promise<'timeout'>((resolve) => {
    hardTimer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, Math.max(0, limits.hardTimeoutMs));
    // Never keep the worker process alive for the shadow lane.
    (hardTimer as { unref?: () => void }).unref?.();
  });
  let abortResolve: (() => void) | undefined;
  const aborted = new Promise<'aborted'>((resolve) => {
    abortResolve = () => resolve('aborted');
  });

  const settled: Promise<JevTriageShadowSummary> = Promise.race([run, hardDeadline, aborted])
    .catch(() => 'error' as const)
    .then((status) => {
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      const finalized = decisions.map((decision, index) => decision || {
        path: files[index].path,
        outcome: 'not_started' as const,
        reason: status,
        facts: factsCache[index].facts,
        latency_ms: 0,
      });
      return { status, decisions: finalized };
    });

  let joined = false;
  const join = async (joinInput: TriageJoinInput): Promise<void> => {
    if (joined) return;
    joined = true;
    try {
      const summary = await settled;
      logJoin(context, summary, joinInput, now() - startedAt, modelPin);
    } catch (error) {
      logger.warn('Jev triage shadow join failed; review unaffected', {
        event: JEV_TRIAGE_LOG.summary, reason: 'join_error', error_class: errorClass(error), ...context,
      });
    }
  };

  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
    if (hardTimer !== undefined) clearTimeout(hardTimer);
    abortResolve?.();
  };

  return { settled, join, abort };
}

function decisionFromAnswers(
  facts: TriageFileFacts,
  outcome: { answers: Record<string, JevAnswer>; model: string; usage: { input_tokens: number; output_tokens: number }; durationMs: number },
  personaIds: readonly string[],
  modelPin: string,
): TriageFileDecision {
  const category = outcome.answers.category as JevChoiceAnswer | undefined;
  const risk = outcome.answers.risk as JevScoreAnswer | undefined;
  const lanes: Record<string, TriageLaneDecision> = {};
  for (const id of personaIds) {
    const lane = outcome.answers[laneQuestionKey(id)] as JevNoulAnswer | undefined;
    lanes[id] = { noul: finiteOrNull(lane?.noul) };
  }
  const chosen = typeof category?.choice === 'string' ? category.choice : null;
  const inputTokens = Number.isFinite(outcome.usage.input_tokens) ? outcome.usage.input_tokens : 0;
  return {
    path: facts.path,
    outcome: 'ok',
    facts,
    category: chosen,
    // A choice outside the closed set is recorded, flagged, and never trusted.
    category_valid: chosen !== null && Object.prototype.hasOwnProperty.call(JEV_TRIAGE_CATEGORIES, chosen),
    category_confidence: finiteOrNull(category?.confidence),
    category_probabilities: numericRecord(category?.probabilities),
    risk_score: finiteOrNull(risk?.score),
    risk_level: riskLevelFromAnswer(risk),
    risk_confidence: finiteOrNull(risk?.confidence),
    risk_probabilities: riskProbabilitiesByLevel(risk),
    lanes,
    model: outcome.model,
    model_pin: modelPin,
    model_pin_match: outcome.model === modelPin,
    input_tokens: inputTokens,
    output_tokens: Number.isFinite(outcome.usage.output_tokens) ? outcome.usage.output_tokens : 0,
    cost_usd: (inputTokens * JEV_INPUT_TOKEN_USD_PER_MILLION) / 1_000_000,
    latency_ms: outcome.durationMs,
  };
}

/** Re-keys score probabilities (index-keyed) as `level_1`..`level_5` so log fields stay short and queryable. */
function riskProbabilitiesByLevel(answer: JevScoreAnswer | undefined): Record<string, number> {
  if (!answer) return {};
  const out: Record<string, number> = {};
  for (const [key, probability] of Object.entries(numericRecord(answer.probabilities))) {
    const index = riskIndexFromKey(answer, key);
    out[index >= 0 ? `level_${index + 1}` : key] = probability;
  }
  return out;
}

/** One flat-ish object per file. VictoriaLogs flattens nested objects into dotted field names. */
function flattenDecision(decision: TriageFileDecision): Record<string, unknown> {
  const { facts, ...rest } = decision;
  return { ...rest, facts };
}

function logJoin(
  context: Record<string, unknown>,
  summary: JevTriageShadowSummary,
  joinInput: TriageJoinInput,
  wallMs: number,
  modelPin: string,
): void {
  const byPath = new Map<string, { total: number; p0: number; p1: number; p2: number }>();
  for (const finding of joinInput.findings || []) {
    const path = String(finding?.path || '');
    const entry = byPath.get(path) || { total: 0, p0: 0, p1: 0, p2: 0 };
    entry.total += 1;
    const severity = severityOf(finding);
    if (severity === 'P0') entry.p0 += 1;
    else if (severity === 'P1') entry.p1 += 1;
    else entry.p2 += 1;
    byPath.set(path, entry);
  }

  const lanePath = new Map<string, Map<string, { findings: number; blocking: number }>>();
  const ranLanes = new Set<string>();
  for (const persona of joinInput.personas || []) {
    const id = String(persona?.id || '');
    if (!id) continue;
    ranLanes.add(id);
    for (const finding of persona.findings || []) {
      const path = String(finding?.path || '');
      const perPath = lanePath.get(path) || new Map<string, { findings: number; blocking: number }>();
      const entry = perPath.get(id) || { findings: 0, blocking: 0 };
      entry.findings += 1;
      if (BLOCKING.has(severityOf(finding))) entry.blocking += 1;
      perPath.set(id, entry);
      lanePath.set(path, perPath);
    }
  }
  const applicable = new Set((joinInput.applicablePersonaIds || []).map((id) => String(id)));

  let asked = 0;
  let ok = 0;
  let inputTokens = 0;
  let costUsd = 0;
  const outcomes: Record<string, number> = {};
  const models = new Set<string>();

  for (const decision of summary.decisions) {
    outcomes[decision.outcome] = (outcomes[decision.outcome] || 0) + 1;
    if (decision.outcome === 'ok' || decision.outcome === 'unavailable' || decision.outcome === 'error') asked += 1;
    if (decision.outcome === 'ok') ok += 1;
    inputTokens += decision.input_tokens || 0;
    costUsd += decision.cost_usd || 0;
    if (decision.model) models.add(decision.model);

    const actual = byPath.get(decision.path) || { total: 0, p0: 0, p1: 0, p2: 0 };
    const perLane = lanePath.get(decision.path) || new Map();
    const lanes: Record<string, Record<string, unknown>> = {};
    for (const [id, lane] of Object.entries(decision.lanes || {})) {
      const found = perLane.get(id) || { findings: 0, blocking: 0 };
      lanes[id] = {
        noul: lane.noul,
        said_yes: lane.noul === null ? null : lane.noul >= 0.5,
        ran: ranLanes.has(id),
        applicable: applicable.size > 0 ? applicable.has(id) : null,
        findings: found.findings,
        blocking: found.blocking,
      };
    }
    const findingClass = actual.p0 + actual.p1 > 0 ? 'blocking' : actual.total > 0 ? 'advisory' : 'none';
    logger.info('Jev triage shadow join', {
      event: JEV_TRIAGE_LOG.join,
      ...context,
      path: decision.path,
      outcome: decision.outcome,
      ...(decision.reason ? { reason: decision.reason } : {}),
      category: decision.category ?? null,
      category_valid: decision.category_valid ?? null,
      category_confidence: decision.category_confidence ?? null,
      risk_level: decision.risk_level ?? null,
      risk_score: decision.risk_score ?? null,
      risk_confidence: decision.risk_confidence ?? null,
      model: decision.model ?? null,
      model_pin: modelPin,
      model_pin_match: decision.model_pin_match ?? null,
      security_sensitive: decision.facts.security_sensitive,
      is_test: decision.facts.is_test,
      added_lines: decision.facts.added_lines,
      removed_lines: decision.facts.removed_lines,
      hunks_truncated: decision.facts.hunks_truncated,
      panel_mode: joinInput.mode,
      verdict: joinInput.verdict,
      conclusion: joinInput.conclusion,
      findings_total: actual.total,
      findings_p0: actual.p0,
      findings_p1: actual.p1,
      findings_p2: actual.p2,
      finding_class: findingClass,
      lanes,
    });
    safeMetric(() => getMetrics().jevTriageShadowJoin.add(1, {
      risk_level: decision.risk_level ? String(decision.risk_level) : 'none',
      finding_class: findingClass,
    }));
  }

  logger.info('Jev triage shadow summary', {
    event: JEV_TRIAGE_LOG.summary,
    ...context,
    status: summary.status,
    files: summary.decisions.length,
    asked,
    ok,
    outcomes,
    input_tokens: inputTokens,
    cost_usd: costUsd,
    wall_ms: wallMs,
    models: Array.from(models),
    model_pin: modelPin,
    panel_mode: joinInput.mode,
    verdict: joinInput.verdict,
  });
}
