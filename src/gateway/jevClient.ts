import { runInSpan, getMetrics } from '../telemetry';
import { logger } from '../utils/logger';
import { raceWithAbort as sharedRaceWithAbort } from './raceWithAbort';
import { JEV_INPUT_TOKEN_USD_PER_MILLION, HTTPS_REQUIRED_REASON, isHttpsBaseUrl } from '../types/jevContract';

/**
 * Client for TypeSafe AI's "System One" model (Jev).
 *
 * Jev returns typed probabilistic decisions and never text: it cannot generate prose,
 * explain its reasoning, do arithmetic, compare dates, or count. Every question supplies
 * its own closed set of options ("pick a card from the deck, don't ask it to name one").
 *
 * `ask()` never rejects for a transport condition -- callers get a discriminated
 * `JevOutcome` and the type checker forces every call site to handle `unavailable`.
 * `throw` is reserved for programmer errors (malformed questions, oversized state) so
 * those fail loudly in CI instead of silently degrading into "unavailable" at runtime.
 */

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Required. Max 255 options. */
  criteria: Record<string, string | null>;
}

export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  /** Required. 2-10 ordered levels. */
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface JevNoulAnswer {
  type: 'noul';
  /** Probability 0-1. */
  noul: number;
}

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

/**
 * The score answer as the live API returns it (captured from jev-1.13.0, REL-1100):
 *
 *   {"type":"score","score":0.32,"confidence":0.74,
 *    "legend":{"0":"Level 1, trivial",...,"4":"Level 5, critical"},
 *    "probabilities":{"0":0.81,"1":0.07,"2":0.11,"3":0.01,"4":0.0}}
 *
 * `legend` and `probabilities` are keyed by the 0-based index of the question's `criteria`
 * entry, as a string. `score` is the EXPECTED level index, sum(index * probability), a
 * continuous value in [0, n-1] (0.32 above; production shows values like 3.98 for a
 * near-certain level 5). It is a mean, not a level: the level a caller wants is the most
 * probable legend index. An ordered legend ARRAY (the shape this
 * client first assumed) is still accepted and normalized to this keyed form by the client, so
 * every consumer sees exactly one shape.
 */
export interface JevScoreAnswer {
  type: 'score';
  /** Expected 0-based level index, sum(index * probability): continuous in [0, n-1]. Not a level. */
  score: number;
  /** Level description per 0-based criteria index ("0".."n-1"). */
  legend: Record<string, string>;
  /** Probability per level, keyed by the same index strings as `legend`. */
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

// ---------------------------------------------------------------------------
// Outcome — the compile-time fallback contract
// ---------------------------------------------------------------------------

export type JevUnavailableReason =
  | 'http_401'
  | 'http_422'
  | 'http_429'
  | 'http_529'
  | 'timeout'
  | 'malformed'
  | 'budget_exhausted'
  | 'disabled';

export const JEV_UNAVAILABLE_REASONS: readonly JevUnavailableReason[] = [
  'http_401',
  'http_422',
  'http_429',
  'http_529',
  'timeout',
  'malformed',
  'budget_exhausted',
  'disabled',
];

export type JevOutcome<K extends string> =
  | {
      status: 'ok';
      answers: Record<K, JevAnswer>;
      /** The versioned model reported by the response, e.g. "jev-1.13.0". */
      model: string;
      usage: { input_tokens: number; output_tokens: number };
      durationMs: number;
    }
  | { status: 'unavailable'; reason: JevUnavailableReason; durationMs: number };

export interface JevAskRequest<K extends string> {
  state: string | Record<string, unknown> | unknown[];
  questions: Record<K, JevQuestion>;
  /** Identifies the calling seam for telemetry. Defaults to 'unknown'. */
  seam?: string;
  signal?: AbortSignal;
}

export interface JevAsker {
  ask<K extends string>(request: JevAskRequest<K>): Promise<JevOutcome<K>>;
}

// ---------------------------------------------------------------------------
// Programmer-error validation (throws — these must fail loudly in CI)
// ---------------------------------------------------------------------------

export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;
/** ~64k token shared budget at a conservative ~4 chars/token. */
export const MAX_STATE_AND_QUESTIONS_CHARS = 256_000;
/** Below this remaining stage budget, a call cannot usefully start a round trip. */
export const MIN_USEFUL_CALL_MS = 20;

export function validateJevQuestions<K extends string>(questions: Record<K, JevQuestion>): void {
  for (const [key, question] of Object.entries(questions) as Array<[string, JevQuestion]>) {
    if (question.type === 'choice') {
      const optionCount = Object.keys(question.criteria || {}).length;
      if (optionCount > MAX_CHOICE_OPTIONS) {
        throw new TypeError(
          `Jev question "${key}" has ${optionCount} choice options; the maximum is ${MAX_CHOICE_OPTIONS}`,
        );
      }
      if (optionCount === 0) {
        throw new TypeError(`Jev question "${key}" is type "choice" and requires a non-empty criteria map`);
      }
    } else if (question.type === 'score') {
      const levels = Array.isArray(question.criteria) ? question.criteria.length : 0;
      if (levels < MIN_SCORE_LEVELS || levels > MAX_SCORE_LEVELS) {
        throw new TypeError(
          `Jev question "${key}" has ${levels} score levels; must be between ${MIN_SCORE_LEVELS} and ${MAX_SCORE_LEVELS}`,
        );
      }
    } else if (question.type !== 'noul') {
      throw new TypeError(`Jev question "${key}" has unknown type "${(question as { type: string }).type}"`);
    }
    if (!question.instructions || !question.instructions.trim()) {
      throw new TypeError(`Jev question "${key}" requires non-empty instructions`);
    }
  }
}

function validateStateSize(state: unknown, questions: unknown): void {
  const size = JSON.stringify({ state, questions }).length;
  if (size > MAX_STATE_AND_QUESTIONS_CHARS) {
    throw new TypeError(
      `Jev request state+questions is ${size} chars, exceeding the ${MAX_STATE_AND_QUESTIONS_CHARS} char budget cap`,
    );
  }
}

/**
 * Enforced here, not only in jevTransport.ts: JevClient is exported and constructible
 * independently of that transport helper, so any call site that builds one directly (bypassing
 * jevTransport's own https check) would otherwise send the API key over the wire in cleartext.
 * jevTransport's check stays too -- defence in depth against a different entry path.
 */
function validateHttpsBaseUrl(baseUrl: string): void {
  // The RULE lives in ../types/jevContract (shared with jevTransport, which guards a different
  // entry path). The ERROR CONTRACT stays here: reaching this function with a bad base URL is a
  // programmer error at a directly-constructed client, so it throws TypeError like the other
  // argument validators in this module -- not the transport-resolution error jevTransport raises.
  if (!isHttpsBaseUrl(baseUrl)) {
    throw new TypeError(
      `JevClient baseUrl must be a valid https URL (got "${baseUrl}"): ${HTTPS_REQUIRED_REASON}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Retry/backoff helpers — mirrors openRouterClient.ts conventions
// ---------------------------------------------------------------------------

export function calculateFullJitterDelay(
  attempt: number,
  initialDelayMs: number = 200,
  maxDelayMs: number = 2000,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt));
  return Math.floor(random() * ceiling);
}

/** 429 (rate limited) and 529 (overloaded) are the documented transient Jev statuses. */
export function isTransientJevStatus(status: number): boolean {
  return status === 429 || status === 529;
}

function statusToReason(status: number): JevUnavailableReason | null {
  switch (status) {
    case 401:
      return 'http_401';
    case 422:
      return 'http_422';
    case 429:
      return 'http_429';
    case 529:
      return 'http_529';
    default:
      // Undocumented status: the vendor contract only promises 401/422/429/529. Anything
      // else is a shape violation of the contract we were told to expect, not a status
      // this client knows how to interpret -- treat it the same as any other malformed
      // response rather than inventing a new bucket.
      return null;
  }
}

/**
 * Reject promptly when a caller cancels even if a test double fails to observe AbortSignal.
 * Shares its implementation with openRouterClient.ts's raceWithAbort (see raceWithAbort.ts)
 * so the two do not maintain diverging private copies of the same settled-flag bookkeeping,
 * listener cleanup, and orphaned-promise swallowing; this wrapper only pins Jev's own
 * cancellation error.
 */
function raceWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  return sharedRaceWithAbort(operation, signal, () => new Error('Jev request was cancelled'));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A 0-based level index as the API keys it: "0", "1", ... (no sign, no leading zeros). */
const SCORE_INDEX_KEY = /^(0|[1-9][0-9]*)$/;

/**
 * True when `key` is a score level index key in the live contract's format. The single definition
 * of that format: score consumers (e.g. the shadow triage's risk level) import this rather than
 * re-encoding it, so a future contract change is one edit here.
 */
export function isScoreIndexKey(key: string): boolean {
  return SCORE_INDEX_KEY.test(key);
}

/**
 * Validates a score answer against the question that produced it and normalizes it to the keyed
 * `JevScoreAnswer` shape. Null means malformed. Rules:
 *   - `score` and `confidence` are finite numbers.
 *   - `legend` is a non-empty object keyed by level index strings below the question's level
 *     count, with string values -- or, for back-compat, a non-empty array of strings no longer
 *     than the level count (normalized to index keys).
 *   - `probabilities` is an object whose every key names a legend entry (by index, or by the
 *     legend text for a legacy array legend) and whose every value is a finite number, so a
 *     consumer taking the argmax can never be pointed at a level the legend does not define.
 */
function normalizeScoreAnswer(question: JevScoreQuestion, a: Record<string, unknown>): JevScoreAnswer | null {
  if (!isFiniteNumber(a.score) || !isFiniteNumber(a.confidence)) return null;
  const levels = Array.isArray(question.criteria) ? question.criteria.length : 0;
  const legend: Record<string, string> = {};
  const legacyTextToIndex = new Map<string, string>();
  if (Array.isArray(a.legend)) {
    if (a.legend.length === 0 || a.legend.length > levels) return null;
    for (let index = 0; index < a.legend.length; index++) {
      const text = a.legend[index];
      if (typeof text !== 'string') return null;
      legend[String(index)] = text;
      if (!legacyTextToIndex.has(text)) legacyTextToIndex.set(text, String(index));
    }
  } else if (isPlainObject(a.legend)) {
    const entries = Object.entries(a.legend);
    if (entries.length === 0) return null;
    for (const [key, text] of entries) {
      if (!isScoreIndexKey(key) || Number(key) >= levels || typeof text !== 'string') return null;
      legend[key] = text;
    }
  } else {
    return null;
  }
  if (!isPlainObject(a.probabilities)) return null;
  const probabilities: Record<string, number> = {};
  for (const [key, probability] of Object.entries(a.probabilities)) {
    const index = Object.prototype.hasOwnProperty.call(legend, key) ? key : legacyTextToIndex.get(key);
    if (index === undefined || !isFiniteNumber(probability)) return null;
    probabilities[index] = probability;
  }
  return { type: 'score', score: a.score, confidence: a.confidence, legend, probabilities };
}

/** Validates one answer against its question; returns the (normalized) answer, or null when malformed. */
function normalizeAnswer(question: JevQuestion, answer: unknown): JevAnswer | null {
  if (!isPlainObject(answer)) return null;
  const a = answer;
  if (a.type !== question.type) return null;
  if (question.type === 'noul') {
    return isFiniteNumber(a.noul) ? (a as unknown as JevNoulAnswer) : null;
  }
  if (question.type === 'choice') {
    return typeof a.choice === 'string' &&
      typeof a.confidence === 'number' &&
      typeof a.probabilities === 'object' &&
      a.probabilities !== null
      ? (a as unknown as JevChoiceAnswer)
      : null;
  }
  if (question.type === 'score') {
    return normalizeScoreAnswer(question, a);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface JevClientOptions {
  baseUrl?: string;
  apiKey?: string;
  /** Request-side model selector: 'jev-latest' | 'jev-preview'. A concrete version cannot be requested. */
  model?: string;
  /** TYPESAFE_MODEL_PIN — the last calibrated version. Compared against the response, never sent. */
  modelPin?: string;
  fetchImplementation?: FetchImplementation;
  now?: () => number;
  /** Total ms budget shared across every ask() call made by this client instance for one pipeline run. */
  stageBudgetMs?: number;
  /** Upper bound on any single ask() call, independent of remaining stage budget. */
  perCallCapMs?: number;
  maxRetries?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DEFAULT_JEV_ORIGIN = 'https://api.typesafe.ai';
/** The System One endpoint path. The client POSTs to the base URL verbatim, so it must include this. */
export const JEV_SYSTEM_ONE_PATH = '/v1/systemone';

/**
 * The URL the client POSTs to. A base URL with no path (just the host, e.g.
 * `https://api.typesafe.ai`) gets `/v1/systemone` appended: REL-1081's org-wide shadow logged
 * every call `malformed` because TYPESAFE_BASE_URL was the bare host and the host root 404s.
 * Any URL that already has a path, query or fragment is used as given (trailing slashes
 * trimmed), so an explicit endpoint is never rewritten. An unparseable value is returned
 * unchanged for the https guard to reject.
 */
export function resolveJevEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  // `search`/`hash` read '' both when absent and when present-but-empty ("host?", "host#"), so a
  // stray empty '?' or '#' is treated as absent and dropped -- building the endpoint through the
  // URL object (not by string concatenation) keeps the path out of the query or fragment.
  if ((parsed.pathname === '' || parsed.pathname === '/') && !parsed.search && !parsed.hash) {
    parsed.pathname = JEV_SYSTEM_ONE_PATH;
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  }
  return trimmed;
}

const DEFAULT_STAGE_BUDGET_MS = 20_000;
const DEFAULT_PER_CALL_CAP_MS = 5_000;
const DEFAULT_MAX_RETRIES = 2;

export class JevClient implements JevAsker {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly modelPin: string | undefined;
  private readonly fetchImplementation: FetchImplementation;
  private readonly now: () => number;
  private readonly perCallCapMs: number;
  private readonly maxRetries: number;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  /** Deadline for this client instance's whole run, computed once at construction. */
  private readonly stageDeadline: number;

  constructor(options: JevClientOptions = {}) {
    this.baseUrl = resolveJevEndpoint(options.baseUrl || `${DEFAULT_JEV_ORIGIN}${JEV_SYSTEM_ONE_PATH}`);
    validateHttpsBaseUrl(this.baseUrl);
    this.apiKey = options.apiKey || '';
    this.model = options.model || 'jev-latest';
    this.modelPin = options.modelPin;
    this.fetchImplementation = options.fetchImplementation || ((input, init) => globalThis.fetch(input, init));
    this.now = options.now || Date.now;
    this.perCallCapMs = options.perCallCapMs ?? DEFAULT_PER_CALL_CAP_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 200;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 2000;
    this.sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.random = options.random || Math.random;
    this.stageDeadline = this.now() + (options.stageBudgetMs ?? DEFAULT_STAGE_BUDGET_MS);
  }

  private remainingBudgetMs(): number {
    return this.stageDeadline - this.now();
  }

  /** ms available to the next call, or null if the budget cannot usefully start a call. */
  private nextCallBudgetMs(): number | null {
    const remaining = this.remainingBudgetMs();
    if (remaining < MIN_USEFUL_CALL_MS) return null;
    return Math.min(this.perCallCapMs, remaining);
  }

  async ask<K extends string>(request: JevAskRequest<K>): Promise<JevOutcome<K>> {
    // Programmer errors fail loudly and are never absorbed into `unavailable`.
    validateJevQuestions(request.questions);
    validateStateSize(request.state, request.questions);

    const seam = request.seam || 'unknown';
    const questionCount = Object.keys(request.questions).length;

    return runInSpan('review_yeti_jev', async (span) => {
      span.setAttribute('review_yeti.jev.seam', seam);
      span.setAttribute('review_yeti.jev.question_count', questionCount);

      const outcome = await this.completeInternal(request);

      span.setAttribute('review_yeti.jev.duration_ms', outcome.durationMs);
      span.setAttribute('review_yeti.jev.outcome', outcome.status === 'ok' ? 'ok' : outcome.reason);
      if (outcome.status === 'ok') {
        span.setAttribute('review_yeti.jev.model', outcome.model);
        span.setAttribute('review_yeti.jev.input_tokens', outcome.usage.input_tokens);
      }

      this.recordMetrics(seam, outcome);
      return outcome;
    });
  }

  private recordMetrics<K extends string>(seam: string, outcome: JevOutcome<K>): void {
    const metrics = getMetrics();
    const outcomeLabel = outcome.status === 'ok' ? 'ok' : outcome.reason;
    metrics.jevRequests.add(1, { seam, outcome: outcomeLabel });
    metrics.jevDuration.record(outcome.durationMs / 1000, { seam, outcome: outcomeLabel });

    if (outcome.status === 'ok') {
      metrics.jevInputTokens.add(outcome.usage.input_tokens, { seam, model: outcome.model });
      const costUsd = (outcome.usage.input_tokens * JEV_INPUT_TOKEN_USD_PER_MILLION) / 1_000_000;
      metrics.jevCostUsd.add(costUsd, { seam, model: outcome.model });

      if (this.modelPin && outcome.model !== this.modelPin) {
        metrics.jevModelPinMismatch.add(1, { seam, expected: this.modelPin, actual: outcome.model });
        logger.warn('Jev response model pin mismatch: calibrated thresholds may be stale', {
          seam,
          expected: this.modelPin,
          actual: outcome.model,
        });
      }
    }
  }

  private async completeInternal<K extends string>(request: JevAskRequest<K>): Promise<JevOutcome<K>> {
    const startedAt = this.now();
    for (let attempt = 0; ; attempt++) {
      if (request.signal?.aborted) {
        return { status: 'unavailable', reason: 'timeout', durationMs: this.now() - startedAt };
      }

      const callBudgetMs = this.nextCallBudgetMs();
      if (callBudgetMs === null) {
        return { status: 'unavailable', reason: 'budget_exhausted', durationMs: this.now() - startedAt };
      }

      const attemptOutcome = await this.executeSingleAttempt(request, callBudgetMs, startedAt);
      if (attemptOutcome.status === 'ok') return attemptOutcome;

      const status = (attemptOutcome as { __httpStatus?: number }).__httpStatus;
      const transient = typeof status === 'number' && isTransientJevStatus(status);
      if (!transient || attempt >= this.maxRetries) {
        const { __httpStatus, ...outcome } = attemptOutcome as JevOutcome<K> & { __httpStatus?: number };
        return outcome;
      }

      const delay = calculateFullJitterDelay(attempt, this.initialRetryDelayMs, this.maxRetryDelayMs, this.random);
      const remaining = this.remainingBudgetMs();
      if (remaining <= 0) {
        const { __httpStatus, ...outcome } = attemptOutcome as JevOutcome<K> & { __httpStatus?: number };
        return outcome;
      }
      try {
        await raceWithAbort(this.sleep(Math.min(delay, remaining)), request.signal);
      } catch {
        return { status: 'unavailable', reason: 'timeout', durationMs: this.now() - startedAt };
      }
    }
  }

  private async executeSingleAttempt<K extends string>(
    request: JevAskRequest<K>,
    callBudgetMs: number,
    startedAt: number,
  ): Promise<(JevOutcome<K> & { __httpStatus?: number })> {
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), callBudgetMs);

    try {
      const body = JSON.stringify({ model: this.model, state: request.state, questions: request.questions });
      let response: Response;
      try {
        response = await raceWithAbort(
          this.fetchImplementation(this.baseUrl, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.apiKey}`,
              'content-type': 'application/json',
            },
            body,
            signal: controller.signal,
          }),
          request.signal,
        );
      } catch (error) {
        // Any transport-level rejection (network failure, DNS, or our own abort on
        // deadline) is presented as `timeout` -- ask() never rejects, and the reason
        // enum has no separate "network error" bucket to distinguish it from a
        // deadline that ran out waiting on the network.
        return { status: 'unavailable', reason: 'timeout', durationMs: this.now() - startedAt };
      }

      if (!response.ok) {
        const reason = statusToReason(response.status);
        if (reason === null) {
          return { status: 'unavailable', reason: 'malformed', durationMs: this.now() - startedAt };
        }
        return { status: 'unavailable', reason, durationMs: this.now() - startedAt, __httpStatus: response.status };
      }

      let parsed: unknown;
      try {
        const text = await response.text();
        parsed = JSON.parse(text);
      } catch {
        return { status: 'unavailable', reason: 'malformed', durationMs: this.now() - startedAt };
      }

      const validated = this.validateEnvelope(request.questions, parsed);
      if (!validated) {
        return { status: 'unavailable', reason: 'malformed', durationMs: this.now() - startedAt };
      }

      return {
        status: 'ok',
        answers: validated.answers as Record<K, JevAnswer>,
        model: validated.model,
        usage: validated.usage,
        durationMs: this.now() - startedAt,
      };
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private validateEnvelope<K extends string>(
    questions: Record<K, JevQuestion>,
    parsed: unknown,
  ): { model: string; answers: Record<string, JevAnswer>; usage: { input_tokens: number; output_tokens: number } } | null {
    if (!parsed || typeof parsed !== 'object') return null;
    const envelope = parsed as Record<string, unknown>;
    if (typeof envelope.model !== 'string' || !envelope.model) return null;
    if (!envelope.answers || typeof envelope.answers !== 'object') return null;
    const usage = envelope.usage as Record<string, unknown> | undefined;
    if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null;

    const answers = envelope.answers as Record<string, unknown>;
    const validatedAnswers: Record<string, JevAnswer> = {};
    for (const [key, question] of Object.entries(questions) as Array<[string, JevQuestion]>) {
      const answer = normalizeAnswer(question, answers[key]);
      if (!answer) return null;
      validatedAnswers[key] = answer;
    }

    return {
      model: envelope.model,
      answers: validatedAnswers,
      usage: { input_tokens: usage.input_tokens as number, output_tokens: usage.output_tokens as number },
    };
  }
}

/**
 * Always-unavailable client used when Jev is disabled (no configuration) or the caller
 * wants to force the "vendor withdrew" exit path. Never touches the network.
 */
export class DisabledJevClient implements JevAsker {
  async ask<K extends string>(_request: JevAskRequest<K>): Promise<JevOutcome<K>> {
    return { status: 'unavailable', reason: 'disabled', durationMs: 0 };
  }
}
