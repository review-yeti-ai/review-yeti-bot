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

import { classifyDomainLanesByHeuristic } from './classifierEngine';

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
const TASK_ID_PATTERN = /^[a-z][a-z0-9_-]{0,127}$/u;

export function isValidTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TASKS = 8;
export const MAX_TASKS_HARD_CAP = 64;
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

function resolveMaxTasks(maxTasks: number | undefined): number {
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
  const effectiveMaxTasks = resolveMaxTasks(context.maxTasks);
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
  const malformedIds: string[] = [];
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const raw of rawTasks) {
    if (!isValidTaskId(raw?.id)) {
      malformedIds.push(idOf(raw));
      continue;
    }
    if (seenIds.has(raw.id as string)) {
      duplicateIds.add(raw.id as string);
    } else {
      seenIds.add(raw.id as string);
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

  // --- Rule 3b: paths must exist in changedFiles; phantom paths dropped ---
  // Same posture as classifierEngine.ts's phantom-path handling around
  // classifyDomainLanesByHeuristic's LLM-augmentation pass (~703-707): a path
  // the model invents that is not in the diff is silently dropped rather than
  // treated as an error in itself. A task can still be rejected as a result,
  // but the *reason* is "this task ended up covering nothing", not "this task
  // named a path that doesn't exist".
  const changedFileSet = new Set(context.changedFiles);
  const normalizedTasks: ReviewTask[] = [];
  const emptiedIds: string[] = [];

  for (const raw of rawTasks) {
    const rawPaths = Array.isArray(raw.paths) ? raw.paths : [];
    const keptPaths = Array.from(
      new Set(rawPaths.filter((p): p is string => typeof p === 'string' && changedFileSet.has(p))),
    );

    if (keptPaths.length === 0) {
      emptiedIds.push(idOf(raw));
      continue;
    }

    const text = clampedText.get(raw);
    if (!text) {
      return reject('invalid_task_fields', `Task ${idOf(raw)} lost its question or rationale during validation.`, {
        offendingIds: [idOf(raw)],
      });
    }
    normalizedTasks.push({
      id: raw.id as string,
      dimension: raw.dimension as TaskDimension,
      paths: keptPaths,
      question: text.question,
      rationale: text.rationale,
    });
  }

  if (emptiedIds.length > 0) {
    return reject(
      'task_emptied_by_path_drop',
      `Task(s) covered only phantom paths not present in the diff and were emptied by validation: ${emptiedIds.join(', ')}.`,
      { offendingIds: emptiedIds },
    );
  }

  // --- Heuristic (non-model) domain classification of the real diff -------
  // Deliberately computed from `context.changedFiles`, not from anything the
  // plan claims. Everything from here down judges the plan against this
  // classification, never against the model's own account of itself.
  const domainLanes = classifyDomainLanesByHeuristic(context.changedFiles.map((path) => ({ path })));
  const nonDocAssetPaths = context.changedFiles.filter((path) => domainLanes[path] !== 'docs_assets');
  const securityAuthPaths = context.changedFiles.filter((path) => domainLanes[path] === 'security_auth');

  // --- Rule 5: security floor ----------------------------------------------
  // THIS CHECK MUST RUN BEFORE THE GENERAL COVERAGE CHECK, AND MUST NOT BE
  // DOWNGRADED TO A CORRECTABLE GAP.
  //
  // The task plan is authored by a model from a prompt that necessarily
  // embeds untrusted diff text (the very thing under review). That is the
  // entire attack surface: a diff whose commit message, comments, or code
  // say "skip auth review", "trust me, this is just a typo fix", or similar
  // must not be able to shrink the plan by simply not emitting a `security`
  // task, or by emitting one that conveniently covers unrelated files while
  // leaving the real auth-surface file uncovered. If this were satisfiable
  // by the same bounded "add the missing path and resubmit" corrective turn
  // the ordinary coverage check gets (rule 4), a sufficiently clever
  // injection could exhaust that single retry on a decoy and still ship
  // uncovered. So: which files count as security-sensitive comes from
  // `classifyDomainLanesByHeuristic`, a deterministic, model-independent
  // heuristic over the actual changed paths -- never from the plan's own
  // dimension labels -- and a miss here fails the whole plan closed,
  // immediately, with no second attempt. Do not "simplify" this by trusting
  // `parsed`/model-provided dimensions or by folding it into the general
  // coverage gap below; that would remove the one guarantee this file exists
  // to provide.
  if (securityAuthPaths.length > 0) {
    const securityCoveredPaths = new Set<string>();
    for (const task of normalizedTasks) {
      if (task.dimension !== SECURITY_DIMENSION) continue;
      for (const p of task.paths) securityCoveredPaths.add(p);
    }
    const uncoveredSecurityPaths = securityAuthPaths.filter((p) => !securityCoveredPaths.has(p));
    if (uncoveredSecurityPaths.length > 0) {
      return reject(
        'security_floor_violation',
        `Security-sensitive path(s) are not covered by a "security" dimension task: ${uncoveredSecurityPaths.join(', ')}.`,
        { offendingPaths: uncoveredSecurityPaths },
      );
    }
  }

  // --- Rule 4: coverage ------------------------------------------------------
  const coveredPaths = new Set<string>();
  for (const task of normalizedTasks) {
    for (const p of task.paths) coveredPaths.add(p);
  }
  const uncoveredPaths = nonDocAssetPaths.filter((p) => !coveredPaths.has(p));
  if (uncoveredPaths.length > 0) {
    return reject(
      'coverage_gap',
      `Changed file(s) are not covered by any task: ${uncoveredPaths.join(', ')}.`,
      { uncoveredPaths },
    );
  }

  return { valid: true, tasks: normalizedTasks };
}
