/**
 * Review task plan data model.
 *
 * Review Yeti is moving from independent per-persona fan-out lanes to a single
 * composed reviewer that plans its own bounded list of review tasks. This
 * module is the data model and validator for that plan -- it is deliberately
 * inert. Nothing here executes a review, dispatches a provider, or is wired
 * into the existing panel/roster machinery. A later change consumes
 * `ReviewTask` and `validateTaskPlan` to actually run the composed reviewer.
 *
 * Two design constraints carry the whole file:
 *
 * 1. A `ReviewTask.id` must satisfy the same format `isRosterId` enforces in
 *    `src/cli/publishingReview.ts`. That makes a valid task plan automatically
 *    a valid roster and a valid completion payload with no contract change
 *    anywhere downstream -- the plan's tasks can be handed straight to the
 *    existing roster/arbitration code once the engine exists.
 * 2. `validateTaskPlan` is deterministic, app-side, and fail-closed. The plan
 *    itself is model output, produced from a prompt that necessarily contains
 *    untrusted diff text. Nothing the model writes into the plan -- including
 *    which dimension it decides to label a task -- can be trusted to decide
 *    whether the plan is *complete*. Completeness is judged against the
 *    heuristic (non-model) domain classifier in `classifierEngine.ts`. See the
 *    security-floor check below for why that specifically matters.
 */

import { createHash } from 'node:crypto';
import { classifyDomainLanesByHeuristic } from './pathDomainContract';

// ---------------------------------------------------------------------------
// Task dimensions
// ---------------------------------------------------------------------------

/**
 * Closed vocabulary of task dimensions.
 *
 * Drawn directly from the persona vocabulary `resolveWorkerConfig` reads in
 * `src/config/publishingWorkerConfig.ts` (`personaMap`, and the `default6`
 * list it falls back to). That map accepts both a human-facing persona name
 * ("security") and an internal lane-id alias ("sec-lane") as equivalent
 * config input; this enum keeps only the human-facing names, because that is
 * the vocabulary an authoring model should be planning against, and folding
 * in the alias would let the same underlying persona show up as two
 * different-looking dimensions in one plan. `licensing` and `contract` are
 * included alongside the `default6` names because `personaMap` accepts them
 * as configured personas too -- this is the map's vocabulary, not an invented
 * one, and this file must not add a dimension the persona system does not
 * already recognize.
 */
export const TASK_DIMENSIONS = [
  'security',
  'performance',
  'architecture',
  'testing',
  'dependencies',
  'contract',
  'licensing',
] as const;

export type TaskDimension = (typeof TASK_DIMENSIONS)[number];

const TASK_DIMENSION_SET: ReadonlySet<string> = new Set(TASK_DIMENSIONS);

export function isTaskDimension(value: unknown): value is TaskDimension {
  return typeof value === 'string' && TASK_DIMENSION_SET.has(value);
}

/** The dimension the security floor check requires. Kept as a named constant
 * rather than an inline literal so the security-floor check below reads as
 * "the security dimension" instead of a bare string that could drift. */
const SECURITY_DIMENSION: TaskDimension = 'security';

// ---------------------------------------------------------------------------
// Task id
// ---------------------------------------------------------------------------

/**
 * The single definition of the id format shared by composed-review task ids and persona roster
 * ids. `isRosterId` in `src/cli/publishingReview.ts` delegates here rather than re-declaring the
 * regex, because the two formats being identical is load-bearing: it is what lets a validated task
 * plan be a valid roster and a valid completion payload with no contract change downstream. Two
 * hand-maintained copies would drift, and the drift would only surface as a valid plan being
 * rejected as an invalid roster.
 */
export const MAX_TASK_ID_LENGTH = 128;
export const TASK_ID_PATTERN = new RegExp(`^[a-z][a-z0-9_-]{0,${MAX_TASK_ID_LENGTH - 1}}$`, 'u');

export function isValidTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TASKS = 8;
/** A plan the validator accepts must fit the completion wire format and trusted gate. */
export const MAX_TASKS_HARD_CAP = DEFAULT_MAX_TASKS;
export const MAX_TASK_TEXT_LENGTH = 400;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ReviewTask {
  /** Must satisfy `isValidTaskId` (mirrors `isRosterId`). */
  id: string;
  /** Closed enum -- see `TASK_DIMENSIONS`. */
  dimension: TaskDimension;
  /** Validated subset of the diff's changed files; never phantom paths. */
  paths: string[];
  /** <= `MAX_TASK_TEXT_LENGTH` characters. */
  question: string;
  /** <= `MAX_TASK_TEXT_LENGTH` characters. */
  rationale: string;
}

export interface ReviewTaskPlan {
  tasks: ReviewTask[];
}

/**
 * Loose input shapes for the boundary the validator actually sits on: model
 * output that has been JSON-parsed but not yet trusted to match `ReviewTask`.
 */
export interface RawReviewTask {
  id?: unknown;
  dimension?: unknown;
  paths?: unknown;
  question?: unknown;
  rationale?: unknown;
}

export interface RawReviewTaskPlan {
  tasks?: unknown;
}

export interface ValidateTaskPlanContext {
  /** Every path present in the diff under review. */
  changedFiles: string[];
  /** Overrides `DEFAULT_MAX_TASKS`; always clamped to `MAX_TASKS_HARD_CAP`. */
  maxTasks?: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type TaskPlanRejectionReason =
  | 'empty_plan'
  | 'too_many_tasks'
  | 'malformed_ids'
  | 'duplicate_ids'
  | 'unknown_dimension'
  | 'invalid_task_fields'
  | 'task_emptied_by_path_drop'
  | 'security_floor_violation'
  | 'coverage_gap';

export interface TaskPlanRejection {
  valid: false;
  reason: TaskPlanRejectionReason;
  message: string;
  /** Task ids implicated in the rejection, when applicable. */
  offendingIds?: string[];
  /** Changed-file paths implicated in the rejection, when applicable. */
  offendingPaths?: string[];
  /**
   * Only set for `coverage_gap`: the non-doc/asset changed-file paths no
   * task covers. A caller may issue exactly one bounded corrective turn
   * asking the model to add these paths to the plan, then re-validate.
   * `security_floor_violation` never sets this -- see the check below.
   */
  uncoveredPaths?: string[];
}

export interface ValidTaskPlan {
  valid: true;
  /** Normalized: phantom paths dropped, path lists de-duplicated. */
  tasks: ReviewTask[];
}

export type TaskPlanValidationResult = ValidTaskPlan | TaskPlanRejection;

function reject(
  reason: TaskPlanRejectionReason,
  message: string,
  extra: Partial<Omit<TaskPlanRejection, 'valid' | 'reason' | 'message'>> = {},
): TaskPlanRejection {
  return { valid: false, reason, message, ...extra };
}

/**
 * Blank text is a plan defect and stays rejected. Oversized text is clamped.
 * A question or rationale past the cap is planning prose, not a coverage or
 * security decision, and failing the whole review on it took live composed
 * runs down after the one corrective turn still came back too long.
 */
function boundedTaskText(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value.length <= MAX_TASK_TEXT_LENGTH ? value : value.slice(0, MAX_TASK_TEXT_LENGTH);
}

export function resolveComposedMaxTasks(maxTasks: unknown): number {
  if (typeof maxTasks !== 'number' || !Number.isSafeInteger(maxTasks) || maxTasks < 1) {
    return DEFAULT_MAX_TASKS;
  }
  return Math.min(maxTasks, MAX_TASKS_HARD_CAP);
}

function idOf(raw: RawReviewTask): string {
  return typeof raw?.id === 'string' ? raw.id : String(raw?.id);
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate a (model-authored, untrusted) task plan against a diff's changed
 * files. Never throws -- an invalid plan is an expected, reportable outcome,
 * not an exceptional one. See the module docblock for the two invariants
 * this exists to protect.
 */
export function validateTaskPlan(
  plan: RawReviewTaskPlan | null | undefined,
  context: ValidateTaskPlanContext,
): TaskPlanValidationResult {
  const effectiveMaxTasks = resolveComposedMaxTasks(context.maxTasks);
  const rawTasks: RawReviewTask[] = Array.isArray(plan?.tasks) ? (plan!.tasks as RawReviewTask[]) : [];

  // --- Rule 1: cardinality ------------------------------------------------
  if (rawTasks.length === 0) {
    return reject('empty_plan', 'Task plan must contain at least one task.');
  }
  if (rawTasks.length > effectiveMaxTasks) {
    return reject(
      'too_many_tasks',
      `Task plan has ${rawTasks.length} tasks, exceeding the limit of ${effectiveMaxTasks}.`,
    );
  }

  // --- Rule 2: ids match the roster regex and are unique ------------------
  // Case is not part of the contract. A live plan died on ids "T1".."T4";
  // folding to lowercase makes those the same roster ids the rest of the
  // pipeline already accepts. Anything still illegal after that stays rejected.
  const malformedIds: string[] = [];
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const raw of rawTasks) {
    const folded = typeof raw?.id === 'string' ? raw.id.trim().toLowerCase() : '';
    if (!isValidTaskId(folded)) {
      malformedIds.push(idOf(raw));
      continue;
    }
    raw.id = folded;
    if (seenIds.has(folded)) {
      duplicateIds.add(folded);
    } else {
      seenIds.add(folded);
    }
  }

  if (malformedIds.length > 0) {
    return reject(
      'malformed_ids',
      `Task id(s) do not match the roster id format: ${malformedIds.join(', ')}.`,
      { offendingIds: malformedIds },
    );
  }
  if (duplicateIds.size > 0) {
    return reject('duplicate_ids', `Duplicate task id(s): ${[...duplicateIds].join(', ')}.`, {
      offendingIds: [...duplicateIds],
    });
  }

  // --- Rule 3a: dimensions are in the closed enum --------------------------
  const unknownDimensionIds: string[] = [];
  for (const raw of rawTasks) {
    if (!isTaskDimension(raw?.dimension)) {
      unknownDimensionIds.push(idOf(raw));
    }
  }
  if (unknownDimensionIds.length > 0) {
    return reject(
      'unknown_dimension',
      `Task(s) use a dimension outside the closed persona vocabulary: ${unknownDimensionIds.join(', ')}.`,
      { offendingIds: unknownDimensionIds },
    );
  }

  // --- Field shape: question/rationale must be non-empty. Over-long text is clamped. ---
  const clampedText = new Map<RawReviewTask, { question: string; rationale: string }>();
  const invalidFieldIds: string[] = [];
  for (const raw of rawTasks) {
    const question = boundedTaskText(raw?.question);
    const rationale = boundedTaskText(raw?.rationale);
    if (question === null || rationale === null) {
      invalidFieldIds.push(idOf(raw));
      continue;
    }
    clampedText.set(raw, { question, rationale });
  }
  if (invalidFieldIds.length > 0) {
    return reject(
      'invalid_task_fields',
      `Task(s) have a missing or blank question or rationale: ${invalidFieldIds.join(', ')}.`,
      { offendingIds: invalidFieldIds },
    );
  }

  // --- Rule 3b: paths must exist in changedFiles; phantom paths replaced ---
  // A path the model invents is not part of the diff. Drop it. A task that
  // then covers nothing is rebound onto the real changed files that no other
  // task covers, so a naming miss does not fail the review. The security
  // floor below still judges the rebound plan and is not correctable.
  const changedFileSet = new Set(context.changedFiles);
  const normalizedTasks: ReviewTask[] = [];
  const emptied: RawReviewTask[] = [];

  const pushTask = (raw: RawReviewTask, paths: string[]): TaskPlanValidationResult | null => {
    const text = clampedText.get(raw);
    if (!text) {
      return reject('invalid_task_fields', `Task ${idOf(raw)} lost its question or rationale during validation.`, {
        offendingIds: [idOf(raw)],
      });
    }
    normalizedTasks.push({
      id: raw.id as string,
      dimension: raw.dimension as TaskDimension,
      paths,
      question: text.question,
      rationale: text.rationale,
    });
    return null;
  };

  for (const raw of rawTasks) {
    const rawPaths = Array.isArray(raw.paths) ? raw.paths : [];
    const keptPaths = Array.from(
      new Set(rawPaths.filter((p): p is string => typeof p === 'string' && changedFileSet.has(p))),
    );
    if (keptPaths.length === 0) {
      emptied.push(raw);
      continue;
    }
    const failed = pushTask(raw, keptPaths);
    if (failed) return failed;
  }

  const covered = new Set(normalizedTasks.flatMap((task) => task.paths));
  const uncovered = context.changedFiles.filter((path) => !covered.has(path));
  if (emptied.length > 0 && uncovered.length > 0) {
    const buckets = emptied.map(() => [] as string[]);
    uncovered.forEach((path, index) => buckets[index % emptied.length].push(path));
    for (let index = 0; index < emptied.length; index += 1) {
      if (buckets[index].length === 0) continue;
      const failed = pushTask(emptied[index], buckets[index]);
      if (failed) return failed;
    }
  }

  // --- Heuristic (non-model) domain classification of the real diff -------
  // Deliberately computed from `context.changedFiles`, not from anything the
  // plan claims. Everything from here down judges the plan against this
  // classification, never against the model's own account of itself.
  const domainLanes = classifyDomainLanesByHeuristic(context.changedFiles.map((path) => ({ path })));
  const nonDocAssetPaths = context.changedFiles.filter((path) => domainLanes[path] !== 'docs_assets');
  // Match the execution ledger: lockfiles and data still contain reviewable regions
  // when they accompany code, so planning must expose gaps before tasks start.
  const pathsRequiringCoverage = nonDocAssetPaths;
  const securityAuthPaths = context.changedFiles.filter((path) => domainLanes[path] === 'security_auth');

  // --- Rule 5: security floor ----------------------------------------------
  // Which files are security-sensitive comes from the path heuristic, never
  // from the plan. The model does not get a retry to add them: a retry is
  // something an injected diff can spend on a decoy. The engine assigns the
  // missing paths onto a security task itself, so those files are still
  // reviewed and a missing label does not fail the whole review.
  if (securityAuthPaths.length > 0) {
    const securityCoveredPaths = new Set<string>();
    for (const task of normalizedTasks) {
      if (task.dimension !== SECURITY_DIMENSION) continue;
      for (const p of task.paths) securityCoveredPaths.add(p);
    }
    const uncoveredSecurityPaths = securityAuthPaths.filter((p) => !securityCoveredPaths.has(p));
    if (uncoveredSecurityPaths.length > 0) {
      const existing = normalizedTasks.find((task) => task.dimension === SECURITY_DIMENSION);
      if (existing) {
        existing.paths = Array.from(new Set([...existing.paths, ...uncoveredSecurityPaths]));
      } else if (normalizedTasks.length < effectiveMaxTasks) {
        const id = normalizedTasks.some((task) => task.id === 'security-coverage')
          ? 'security-floor'
          : 'security-coverage';
        normalizedTasks.push({
          id,
          dimension: SECURITY_DIMENSION,
          paths: [...uncoveredSecurityPaths],
          question: 'What security or auth defect do these changes introduce?',
          rationale: 'These paths are security-sensitive, so they are reviewed on a security task when the plan did not cover them that way.',
        });
      } else {
        const host = normalizedTasks.find((task) => task.paths.some((path) => uncoveredSecurityPaths.includes(path)))
          ?? normalizedTasks[0];
        host.dimension = SECURITY_DIMENSION;
        host.paths = Array.from(new Set([...host.paths, ...uncoveredSecurityPaths]));
      }
    }
  }

  // --- Rule 4: coverage ------------------------------------------------------
  const coveredPaths = new Set<string>();
  for (const task of normalizedTasks) {
    for (const p of task.paths) coveredPaths.add(p);
  }
  const uncoveredPaths = pathsRequiringCoverage.filter((p) => !coveredPaths.has(p));
  if (uncoveredPaths.length > 0) {
    return reject(
      'coverage_gap',
      `Changed file(s) are not covered by any task: ${uncoveredPaths.join(', ')}.`,
      { uncoveredPaths },
    );
  }

  return { valid: true, tasks: normalizedTasks };
}

// ===========================================================================
// ReviewTaskContract v2: Lean Finding Summary & Execution Contract
// ===========================================================================

export type FindingSeverity = 'P0' | 'P1' | 'P2';

export interface LeanFindingSummary {
  severity: FindingSeverity;
  file: string;
  line: number;
  fingerprint: string;
  summary: string;
}

export type ReviewFindingDigest = LeanFindingSummary;

export interface ReviewTaskResultV2 {
  nonce: string;
  task: string;
  status: 'COMPLETE' | 'BLOCKED';
  blockedReason?: string | null;
  findings: LeanFindingSummary[];
}

export function computeFindingFingerprint(
  runId: string,
  persona: string,
  file: string,
  line: number,
  summary: string,
): string {
  const normFile = (file || '').toLowerCase().replace(/\\/g, '/').trim();
  const normSummary = (summary || '').trim().replace(/\s+/g, ' ');
  return createHash('sha256')
    .update(`${runId}:${persona}:${normFile}:${line}:${normSummary}`)
    .digest('hex')
    .slice(0, 16);
}

export function isDeterministicFingerprint(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (/^fp1_[a-f0-9]{24}$/u.test(value) || /^[a-f0-9]{16}$/i.test(value) || /^[a-f0-9]{64}$/i.test(value))
  );
}

export interface ValidateFindingDigestContext {
  changedFiles: string[] | Array<{ path: string }>;
  addedLinesByFile?: Record<string, number[]>;
  runId?: string;
  persona?: string;
}

export function validateFindingDigest(
  raw: unknown,
  context: string[] | ValidateFindingDigestContext,
): { valid: true; digest: LeanFindingSummary } | { valid: false; reason: string; error: string } {
  const ctx: ValidateFindingDigestContext = Array.isArray(context)
    ? { changedFiles: context }
    : (context || { changedFiles: [] });

  const changedFileList = (ctx.changedFiles || []).map((f) =>
    typeof f === 'string' ? f.replace(/\\/g, '/').trim() : (f?.path || '').replace(/\\/g, '/').trim(),
  );

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, reason: 'invalid_shape', error: 'Finding must be an object' };
  }

  const rawObj = raw as Record<string, unknown>;

  if (rawObj.severity !== 'P0' && rawObj.severity !== 'P1' && rawObj.severity !== 'P2') {
    return { valid: false, reason: 'severity_invalid', error: `Invalid severity: ${String(rawObj.severity)}` };
  }

  const file = typeof rawObj.file === 'string'
    ? rawObj.file.replace(/\\/g, '/').trim()
    : typeof rawObj.path === 'string'
      ? rawObj.path.replace(/\\/g, '/').trim()
      : '';

  if (!file) {
    return { valid: false, reason: 'path_invalid', error: 'Finding file path must be a non-empty string' };
  }

  if (!changedFileList.includes(file)) {
    return { valid: false, reason: 'path_not_changed', error: `File is not in changed files: ${file}` };
  }

  const line = rawObj.line;
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line <= 0) {
    return { valid: false, reason: 'line_invalid', error: `Invalid line number: ${String(line)}` };
  }

  if (ctx.addedLinesByFile && ctx.addedLinesByFile[file]) {
    const addedLines = ctx.addedLinesByFile[file];
    if (!addedLines.includes(line)) {
      return { valid: false, reason: 'line_not_added', error: `line_not_added: Line ${line} was not added in diff` };
    }
  }

  const rawSummary = typeof rawObj.summary === 'string'
    ? rawObj.summary
    : typeof rawObj.title === 'string'
      ? rawObj.title
      : '';
  const summary = rawSummary.trim();

  if (!summary) {
    return { valid: false, reason: 'summary_empty', error: 'Summary cannot be empty' };
  }

  if (summary.length > 400) {
    return { valid: false, reason: 'summary_too_long', error: 'Summary exceeds 400 characters' };
  }

  const fingerprint = isDeterministicFingerprint(rawObj.fingerprint)
    ? (rawObj.fingerprint as string)
    : computeFindingFingerprint(ctx.runId || 'default-run', ctx.persona || 'reviewer', file, line, summary);

  return {
    valid: true,
    digest: {
      severity: rawObj.severity as FindingSeverity,
      file,
      line,
      fingerprint,
      summary,
    },
  };
}

export interface ValidateReviewTaskResultV2Context {
  changedFiles: string[] | Array<{ path: string }>;
  expectedNonce?: string;
  expectedTaskId?: string;
  addedLinesByFile?: Record<string, number[]>;
  runId?: string;
  persona?: string;
}

export type ReviewTaskResultV2ValidationResult =
  | { valid: true; result: ReviewTaskResultV2 }
  | { valid: false; error: string; reason: string; index?: number };

export function validateReviewTaskResultV2(
  raw: unknown,
  context: string[] | ValidateReviewTaskResultV2Context,
): ReviewTaskResultV2ValidationResult {
  const ctx: ValidateReviewTaskResultV2Context = Array.isArray(context)
    ? { changedFiles: context }
    : (context || { changedFiles: [] });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, reason: 'response_shape', error: 'Review task result must be an object' };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.nonce !== 'string' || !obj.nonce) {
    return { valid: false, reason: 'nonce_invalid', error: 'Task result nonce must be a non-empty string' };
  }
  if (ctx.expectedNonce !== undefined && obj.nonce !== ctx.expectedNonce) {
    return { valid: false, reason: 'nonce_mismatch', error: `Nonce mismatch: expected ${ctx.expectedNonce}, got ${obj.nonce}` };
  }

  if (typeof obj.task !== 'string' || !obj.task) {
    return { valid: false, reason: 'task_invalid', error: 'Task result task id must be a non-empty string' };
  }
  if (ctx.expectedTaskId !== undefined && obj.task !== ctx.expectedTaskId) {
    return { valid: false, reason: 'task_mismatch', error: `Task mismatch: expected ${ctx.expectedTaskId}, got ${obj.task}` };
  }

  if (obj.status !== 'COMPLETE' && obj.status !== 'BLOCKED') {
    return { valid: false, reason: 'status_enum', error: `Invalid status: ${String(obj.status)}, must be COMPLETE or BLOCKED` };
  }

  const blockedReason = obj.blockedReason === null || typeof obj.blockedReason === 'string'
    ? (obj.blockedReason as string | null)
    : undefined;

  if (!Array.isArray(obj.findings)) {
    return { valid: false, reason: 'findings_not_array', error: 'Task result findings must be an array' };
  }

  const findings: LeanFindingSummary[] = [];
  for (let i = 0; i < obj.findings.length; i++) {
    const rawFinding = obj.findings[i];
    const validation = validateFindingDigest(rawFinding, ctx);
    if (!validation.valid) {
      return {
        valid: false,
        reason: validation.reason,
        error: `Finding at index ${i} is invalid: ${validation.error}`,
        index: i,
      };
    }
    findings.push(validation.digest);
  }

  return {
    valid: true,
    result: {
      nonce: obj.nonce,
      task: obj.task,
      status: obj.status as 'COMPLETE' | 'BLOCKED',
      blockedReason,
      findings,
    },
  };
}

export function hydrateLeanFinding(summary: LeanFindingSummary): {
  severity: FindingSeverity;
  path: string;
  line: number;
  startLine: number;
  title: string;
  body: string;
  fingerprint: string;
} {
  return {
    severity: summary.severity,
    path: summary.file,
    line: summary.line,
    startLine: summary.line,
    title: summary.summary.slice(0, 160),
    body: summary.summary,
    fingerprint: summary.fingerprint,
  };
}

// ===========================================================================
// File Coverage Quorum Validator & Contract (R4)
// ===========================================================================

export interface FileCoverageOptions {
  minFileCoveragePct?: number;
  requiredCoveragePct?: number;
  enforceSecurityFloor?: boolean;
  securityFloorRequired?: boolean;
  activeFindings?: (LeanFindingSummary | ReviewFindingDigest)[];
  bypassLockfiles?: boolean;
}

export interface FileCoverageValidationResult {
  satisfied: boolean;
  coveragePct: number;
  coveredPaths: string[];
  uncoveredPaths: string[];
  securityCoverageSatisfied: boolean;
  missingSecurityPaths: string[];
  quorumSatisfied?: boolean;
  securityFloorSatisfied?: boolean;
  mode?: 'file_coverage' | 'blocker_fast_path';
  verdict?: 'SHIP' | 'FIX_FIRST' | 'BLOCK';
  status?: 'COMPLETE' | 'INCOMPLETE_REVIEW' | 'BLOCKER_EXIT';
  rationale?: string;
  blockerFastPath?: boolean;
  blockerFinding?: LeanFindingSummary;
}

export interface CompletedTaskOutcomeLike {
  taskId?: string;
  task?: string;
  id?: string;
  dimension?: TaskDimension;
  paths?: string[];
  coveredPaths?: string[];
  status?: string;
  findings?: LeanFindingSummary[];
}

export function validateFileCoverageQuorum(
  planOrOptions: ReviewTaskPlan | {
    plan?: ReviewTaskPlan;
    changedFiles: (string | { path: string })[];
    completedTasks: (ReviewTaskResultV2 | CompletedTaskOutcomeLike)[];
    activeFindings?: (LeanFindingSummary | ReviewFindingDigest)[];
    minFileCoveragePct?: number;
    requiredCoveragePct?: number;
    enforceSecurityFloor?: boolean;
    securityFloorRequired?: boolean;
  },
  maybeCompletedTasks?: (ReviewTaskResultV2 | CompletedTaskOutcomeLike)[],
  maybeChangedFiles?: (string | { path: string })[],
  maybeOptions?: FileCoverageOptions,
): FileCoverageValidationResult {
  let plan: ReviewTaskPlan | undefined;
  let completedTasks: (ReviewTaskResultV2 | CompletedTaskOutcomeLike)[];
  let rawChangedFiles: (string | { path: string })[];
  let options: FileCoverageOptions;

  if (typeof planOrOptions === 'object' && planOrOptions !== null && 'changedFiles' in planOrOptions) {
    const opts = planOrOptions as {
      plan?: ReviewTaskPlan;
      changedFiles: (string | { path: string })[];
      completedTasks: (ReviewTaskResultV2 | CompletedTaskOutcomeLike)[];
      activeFindings?: (LeanFindingSummary | ReviewFindingDigest)[];
      minFileCoveragePct?: number;
      requiredCoveragePct?: number;
      enforceSecurityFloor?: boolean;
      securityFloorRequired?: boolean;
    };
    plan = opts.plan;
    completedTasks = Array.isArray(opts.completedTasks) ? opts.completedTasks : [];
    rawChangedFiles = Array.isArray(opts.changedFiles) ? opts.changedFiles : [];
    options = {
      activeFindings: opts.activeFindings,
      minFileCoveragePct: opts.minFileCoveragePct,
      requiredCoveragePct: opts.requiredCoveragePct,
      enforceSecurityFloor: opts.enforceSecurityFloor ?? opts.securityFloorRequired,
      securityFloorRequired: opts.securityFloorRequired ?? opts.enforceSecurityFloor,
    };
  } else {
    plan = planOrOptions as ReviewTaskPlan;
    completedTasks = Array.isArray(maybeCompletedTasks) ? maybeCompletedTasks : [];
    rawChangedFiles = Array.isArray(maybeChangedFiles) ? maybeChangedFiles : [];
    options = maybeOptions || {};
  }

  const changedFiles: string[] = rawChangedFiles.map((file) =>
    typeof file === 'string' ? file : file.path
  );

  const activeFindings: LeanFindingSummary[] = [
    ...(options.activeFindings || []),
    ...completedTasks.flatMap((t) => (Array.isArray(t.findings) ? t.findings : [])),
  ];

  // 1. Blocker Fast-Path Quorum Check (Verified P0 Finding Immediately Halts Review)
  const p0 = activeFindings.find((f) => f.severity === 'P0');
  if (p0) {
    return {
      satisfied: true,
      quorumSatisfied: true,
      mode: 'blocker_fast_path',
      verdict: 'BLOCK',
      status: 'BLOCKER_EXIT',
      rationale: `P0 Blocker detected on ${(p0 as any).file || (p0 as any).path || 'unknown'}:${p0.line}. Fast-path early-exit triggered.`,
      coveragePct: 0,
      coveredPaths: [],
      uncoveredPaths: [],
      securityCoverageSatisfied: true,
      securityFloorSatisfied: true,
      missingSecurityPaths: [],
      blockerFastPath: true,
      blockerFinding: p0,
    };
  }

  // 2. Classify reviewable files (exempt pure docs and assets)
  const domainMap = classifyDomainLanesByHeuristic(changedFiles.map((p) => ({ path: p })));
  const reviewableCodePaths = changedFiles.filter(
    (p) => domainMap[p] !== 'docs_assets'
  );

  // If all files are documentation or assets, coverage is automatically satisfied
  if (reviewableCodePaths.length === 0) {
    const hasP1 = activeFindings.some((f) => f.severity === 'P1');
    return {
      satisfied: true,
      quorumSatisfied: true,
      mode: 'file_coverage',
      verdict: hasP1 ? 'FIX_FIRST' : 'SHIP',
      status: 'COMPLETE',
      rationale: 'All changed files are documentation or assets. Coverage satisfied automatically.',
      coveragePct: 100,
      coveredPaths: [],
      uncoveredPaths: [],
      securityCoverageSatisfied: true,
      securityFloorSatisfied: true,
      missingSecurityPaths: [],
      blockerFastPath: false,
    };
  }

  // 3. Collect covered paths from completed tasks only
  const coveredSet = new Set<string>();
  const securityCoveredSet = new Set<string>();

  for (const t of completedTasks) {
    const item = t as Record<string, any>;
    const status = (item.status || '').toLowerCase();
    if (status === 'blocked' || status === 'error' || status === 'failed' || status === 'stalled') {
      continue;
    }

    let taskPaths: string[] = [];
    if (Array.isArray(item.coveredPaths) && item.coveredPaths.length > 0) {
      taskPaths = item.coveredPaths;
    } else if (Array.isArray(item.paths) && item.paths.length > 0) {
      taskPaths = item.paths;
    } else if (plan && Array.isArray(plan.tasks)) {
      const taskId = item.task || item.taskId || item.id;
      const matched = plan.tasks.find((pTask) => pTask.id === taskId);
      if (matched && Array.isArray(matched.paths)) {
        taskPaths = matched.paths;
      }
    }

    let dimension: TaskDimension | undefined = item.dimension;
    if (!dimension && plan && Array.isArray(plan.tasks)) {
      const taskId = item.task || item.taskId || item.id;
      const matched = plan.tasks.find((pTask) => pTask.id === taskId);
      if (matched) {
        dimension = matched.dimension;
      }
    }

    for (const p of taskPaths) {
      coveredSet.add(p);
      if (dimension === 'security') {
        securityCoveredSet.add(p);
      }
    }
  }

  const uncoveredPaths = reviewableCodePaths.filter((p) => !coveredSet.has(p));
  const coveredPaths = reviewableCodePaths.filter((p) => coveredSet.has(p));
  const coveragePct = reviewableCodePaths.length === 0
    ? 100
    : Math.round(((reviewableCodePaths.length - uncoveredPaths.length) / reviewableCodePaths.length) * 100);

  // 4. Security Floor Check
  const securityAuthPaths = changedFiles.filter((p) => domainMap[p] === 'security_auth');
  const missingSecurityPaths = securityAuthPaths.filter((p) => !securityCoveredSet.has(p));
  const enforceFloor = options.enforceSecurityFloor ?? options.securityFloorRequired ?? true;
  const securityCoverageSatisfied = enforceFloor ? missingSecurityPaths.length === 0 : true;

  const minPct = options.minFileCoveragePct ?? options.requiredCoveragePct ?? 100;
  const isCoverageSatisfied = coveragePct >= minPct;
  const satisfied = isCoverageSatisfied && securityCoverageSatisfied;

  const hasP1 = activeFindings.some((f) => f.severity === 'P1');
  const verdict: 'SHIP' | 'FIX_FIRST' | 'BLOCK' = !satisfied
    ? 'BLOCK'
    : hasP1
      ? 'FIX_FIRST'
      : 'SHIP';
  const status: 'COMPLETE' | 'INCOMPLETE_REVIEW' | 'BLOCKER_EXIT' = satisfied
    ? 'COMPLETE'
    : 'INCOMPLETE_REVIEW';

  let rationale: string;
  if (!securityCoverageSatisfied) {
    rationale = `Security floor unsatisfied: [${missingSecurityPaths.join(', ')}] not inspected by security task.`;
  } else if (!isCoverageSatisfied) {
    rationale = `File coverage incomplete (${coveragePct}% < ${minPct}%). Uncovered: [${uncoveredPaths.join(', ')}].`;
  } else {
    rationale = `${coveragePct}% of reviewable files inspected across completed domains. Quorum satisfied.`;
  }

  return {
    satisfied,
    quorumSatisfied: satisfied,
    coveragePct,
    coveredPaths,
    uncoveredPaths,
    securityCoverageSatisfied,
    securityFloorSatisfied: securityCoverageSatisfied,
    missingSecurityPaths,
    mode: 'file_coverage',
    verdict,
    status,
    rationale,
    blockerFastPath: false,
  };
}

export function isFileCoverageSatisfied(
  completedTasks: Array<{
    dimension?: TaskDimension;
    paths?: string[];
    coveredPaths?: string[];
    status?: string;
    task?: string;
    taskId?: string;
  }>,
  changedFiles: (string | { path: string })[],
  options?: {
    enforceSecurityFloor?: boolean;
    minFileCoveragePct?: number;
    plan?: ReviewTaskPlan;
  },
): {
  satisfied: boolean;
  uncoveredPaths: string[];
  coveragePct: number;
  missingSecurityPaths: string[];
  securityCoverageSatisfied: boolean;
} {
  const result = validateFileCoverageQuorum(
    options?.plan ?? { tasks: [] },
    completedTasks as any,
    changedFiles,
    options,
  );
  return {
    satisfied: result.satisfied,
    uncoveredPaths: result.uncoveredPaths,
    coveragePct: result.coveragePct,
    missingSecurityPaths: result.missingSecurityPaths,
    securityCoverageSatisfied: result.securityCoverageSatisfied,
  };
}


