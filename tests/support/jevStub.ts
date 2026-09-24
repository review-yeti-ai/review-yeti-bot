import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JEV_UNAVAILABLE_REASONS } from '../../src/gateway/jevClient';
import type {
  JevAnswer,
  JevAskRequest,
  JevAsker,
  JevChoiceQuestion,
  JevNoulQuestion,
  JevOutcome,
  JevQuestion,
  JevScoreQuestion,
  JevUnavailableReason,
} from '../../src/gateway/jevClient';

/**
 * There is no JS equivalent of TypeSafe's Python `system-one-adapter`, so this is it: a test
 * double for Jev with three modes.
 *
 *   1. Cassette playback, keyed by a hash of the canonical {state, questions} — the default
 *      for unit tests. Mirrors the versioned-JSON, explicit-error-class conventions of
 *      src/evaluation/reviewCassetteEngine.ts.
 *   2. Forced failure for every `unavailable` reason — the exit path if the vendor withdraws,
 *      so it must be permanently exercised (see tests/unit/jevStub.test.ts).
 *   3. An LLM-backed adapter behind an env flag, hard-gated on NODE_ENV !== 'production'.
 */

// ---------------------------------------------------------------------------
// Canonical request hashing
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

/** Deterministic, order-independent key for a Jev request, used to look up cassette fixtures. */
export function hashJevRequest(state: unknown, questions: unknown): string {
  const canonical = JSON.stringify(canonicalize({ state, questions }));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// Cassette schema & errors (mirrors src/evaluation/reviewCassetteEngine.ts conventions)
// ---------------------------------------------------------------------------

export class JevCassetteError extends Error {
  public readonly code: string;
  constructor(message: string, code: string = 'JEV_CASSETTE_ERROR') {
    super(message);
    this.name = 'JevCassetteError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class JevCassetteNotFoundError extends JevCassetteError {
  constructor(cassettePath: string) {
    super(`Jev cassette not found at ${cassettePath}`, 'JEV_CASSETTE_NOT_FOUND');
    this.name = 'JevCassetteNotFoundError';
  }
}

export class JevCassetteMissError extends JevCassetteError {
  constructor(hash: string, cassettePath: string) {
    super(
      `No Jev cassette interaction for request hash ${hash} in ${cassettePath}. ` +
        'Record a fixture for this {state, questions} pair rather than silently degrading a unit test.',
      'JEV_CASSETTE_MISS',
    );
    this.name = 'JevCassetteMissError';
  }
}

export class JevCassetteValidationError extends JevCassetteError {
  constructor(details: string) {
    super(`Jev cassette schema validation failed: ${details}`, 'JEV_CASSETTE_VALIDATION_ERROR');
    this.name = 'JevCassetteValidationError';
  }
}

export interface JevCassetteEntry {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface JevCassette {
  version: 1;
  /** Keyed by hashJevRequest(state, questions). */
  interactions: Record<string, JevCassetteEntry>;
}

function assertValidJevCassette(obj: unknown): asserts obj is JevCassette {
  if (!obj || typeof obj !== 'object') throw new JevCassetteValidationError('cassette must be a non-null object');
  const c = obj as Partial<JevCassette>;
  if (c.version !== 1) throw new JevCassetteValidationError(`expected version 1, got ${String(c.version)}`);
  if (!c.interactions || typeof c.interactions !== 'object') {
    throw new JevCassetteValidationError('missing interactions map');
  }
}

export function loadJevCassette(cassettePath: string): JevCassette {
  if (!fs.existsSync(cassettePath)) throw new JevCassetteNotFoundError(cassettePath);
  const parsed = JSON.parse(fs.readFileSync(cassettePath, 'utf8'));
  assertValidJevCassette(parsed);
  return parsed;
}

export function writeJevCassette(cassettePath: string, cassette: JevCassette): void {
  fs.mkdirSync(path.dirname(cassettePath), { recursive: true });
  fs.writeFileSync(cassettePath, `${JSON.stringify(cassette, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Mode 1: cassette playback
// ---------------------------------------------------------------------------

export interface JevCassetteStubOptions {
  cassettePath: string;
  now?: () => number;
}

export interface JevCassetteStub extends JevAsker {
  assertComplete(): void;
  consumedHashes: readonly string[];
}

export function createCassetteJevStub(options: JevCassetteStubOptions): JevCassetteStub {
  const cassette = loadJevCassette(options.cassettePath);
  const now = options.now || Date.now;
  const consumed = new Set<string>();

  return {
    async ask<K extends string>(request: JevAskRequest<K>): Promise<JevOutcome<K>> {
      const startedAt = now();
      const hash = hashJevRequest(request.state, request.questions);
      const entry = cassette.interactions[hash];
      if (!entry) throw new JevCassetteMissError(hash, options.cassettePath);
      consumed.add(hash);
      return {
        status: 'ok',
        model: entry.model,
        answers: entry.answers as Record<K, JevAnswer>,
        usage: entry.usage,
        durationMs: now() - startedAt,
      };
    },
    get consumedHashes() {
      return Array.from(consumed);
    },
    assertComplete() {
      const unconsumed = Object.keys(cassette.interactions).filter((hash) => !consumed.has(hash));
      if (unconsumed.length > 0) {
        throw new JevCassetteError(
          `Unconsumed Jev cassette interactions in ${options.cassettePath}: ${unconsumed.join(', ')}`,
          'JEV_CASSETTE_UNCONSUMED',
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mode 2: forced failure
// ---------------------------------------------------------------------------

export function createFailingJevStub(reason: JevUnavailableReason, options: { now?: () => number } = {}): JevAsker {
  const now = options.now || Date.now;
  return {
    async ask<K extends string>(_request: JevAskRequest<K>): Promise<JevOutcome<K>> {
      const startedAt = now();
      return { status: 'unavailable', reason, durationMs: now() - startedAt };
    },
  };
}

/**
 * One stub per JevUnavailableReason. This is the exit path if the vendor withdraws entirely,
 * so every reason must be permanently exercised rather than left as an assumption.
 */
export function createAllFailureJevStubs(
  reasons: readonly JevUnavailableReason[] = JEV_UNAVAILABLE_REASONS,
  options: { now?: () => number } = {},
): Record<JevUnavailableReason, JevAsker> {
  return Object.fromEntries(reasons.map((reason) => [reason, createFailingJevStub(reason, options)])) as Record<
    JevUnavailableReason,
    JevAsker
  >;
}

// ---------------------------------------------------------------------------
// Mode 3: LLM-backed adapter (dev/test only)
// ---------------------------------------------------------------------------

/** Minimal shape of the existing model client this stub routes through (see ReviewModelClient). */
export interface LlmBackedModelClient {
  complete(request: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    responseFormat?: Record<string, unknown>;
    timeoutMs: number;
    stream?: boolean;
  }): Promise<{ content: string; usage?: { prompt?: number; completion?: number } | null }>;
}

export interface LlmBackedJevStubOptions {
  client: LlmBackedModelClient;
  model: string;
  now?: () => number;
  /** Overridable for tests; defaults to process.env.NODE_ENV. */
  nodeEnv?: string;
  timeoutMs?: number;
}

function jevAnswerJsonSchema(question: JevQuestion): Record<string, unknown> {
  if (question.type === 'noul') {
    const q = question as JevNoulQuestion;
    void q;
    return {
      type: 'object',
      properties: { type: { const: 'noul' }, noul: { type: 'number', minimum: 0, maximum: 1 } },
      required: ['type', 'noul'],
      additionalProperties: false,
    };
  }
  if (question.type === 'choice') {
    const q = question as JevChoiceQuestion;
    return {
      type: 'object',
      properties: {
        type: { const: 'choice' },
        choice: { type: 'string', enum: Object.keys(q.criteria) },
        probabilities: { type: 'object' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['type', 'choice', 'probabilities', 'confidence'],
      additionalProperties: false,
    };
  }
  // The live score contract (REL-1100, captured from jev-1.13.0): `legend` and `probabilities`
  // are objects keyed by the 0-based criteria index as a string, and `score` is continuous in
  // [0,1] -- not a level number.
  const q = question as JevScoreQuestion;
  const indexKeys = q.criteria.map((_criterion, index) => String(index));
  return {
    type: 'object',
    properties: {
      type: { const: 'score' },
      score: { type: 'number', minimum: 0, maximum: 1 },
      legend: {
        type: 'object',
        properties: Object.fromEntries(q.criteria.map((criterion, index) => [String(index), { const: criterion }])),
        required: indexKeys,
        additionalProperties: false,
      },
      probabilities: {
        type: 'object',
        properties: Object.fromEntries(indexKeys.map((key) => [key, { type: 'number', minimum: 0, maximum: 1 }])),
        required: indexKeys,
        additionalProperties: false,
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['type', 'score', 'legend', 'probabilities', 'confidence'],
    additionalProperties: false,
  };
}

function buildJevAnswerResponseFormat(key: string, question: JevQuestion): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: `jev_stub_answer_${key}`,
      strict: true,
      schema: jevAnswerJsonSchema(question),
    },
  };
}

/**
 * Routes each question through the existing model client, coercing its JSON output into a
 * JevAnswer. Hard-gated on NODE_ENV !== 'production': an LLM-backed "Jev" in production would
 * silently violate every latency and cost assumption the real Jev API guarantees, while still
 * reporting itself as Jev in telemetry.
 */
export function createLlmBackedJevStub(options: LlmBackedJevStubOptions): JevAsker {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv === 'production') {
    throw new Error(
      'createLlmBackedJevStub is a test double and refuses to run under NODE_ENV=production: ' +
        'it would silently violate Jev\'s latency/cost assumptions while still reporting Jev telemetry',
    );
  }

  const now = options.now || Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    async ask<K extends string>(request: JevAskRequest<K>): Promise<JevOutcome<K>> {
      const startedAt = now();
      try {
        const answers: Record<string, JevAnswer> = {};
        let inputTokens = 0;
        let outputTokens = 0;

        for (const [key, question] of Object.entries(request.questions) as Array<[string, JevQuestion]>) {
          const stateText = typeof request.state === 'string' ? request.state : JSON.stringify(request.state);
          const completion = await options.client.complete({
            model: options.model,
            messages: [
              {
                role: 'system',
                content:
                  'You are a stand-in for the Jev typed-decision model. Respond with JSON only, matching the ' +
                  'supplied schema. Choose only from the options given; never invent new ones.',
              },
              {
                role: 'user',
                content: `State:\n${stateText}\n\nQuestion "${key}": ${question.instructions}\n${JSON.stringify(question)}`,
              },
            ],
            responseFormat: buildJevAnswerResponseFormat(key, question),
            timeoutMs,
            stream: false,
          });

          const parsed = JSON.parse(completion.content) as JevAnswer;
          if (!parsed || parsed.type !== question.type) {
            throw new Error(`LLM-backed Jev stub produced a type mismatch for question "${key}"`);
          }
          answers[key] = parsed;
          inputTokens += completion.usage?.prompt ?? 0;
          outputTokens += completion.usage?.completion ?? 0;
        }

        return {
          status: 'ok',
          answers: answers as Record<K, JevAnswer>,
          model: `llm-backed-jev-stub/${options.model}`,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          durationMs: now() - startedAt,
        };
      } catch {
        // The underlying LLM did not produce a usable answer -- this is a shape violation of
        // the contract this stub promises, same as a real malformed Jev response.
        return { status: 'unavailable', reason: 'malformed', durationMs: now() - startedAt };
      }
    },
  };
}
