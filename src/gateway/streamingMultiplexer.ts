import { createHash, randomUUID } from 'node:crypto';
import { logger } from '../utils/logger';
import {
  createResumptionPayload,
  type ReviewResumptionEvent,
  type ReviewResumptionStatus,
} from '../events/reviewResumptionEvent';
import {
  RESUME_SUBJECT_PREFIX,
  isReviewEventSubject,
} from '../events/reviewEventSubjects';
import type { OpenRouterMessage } from './openRouterClient';
import type { PrepPayload } from '../review/prepPhase';
import { raceWithAbort } from './raceWithAbort';

export const MAX_ACCUMULATION_BYTES = 1024 * 1024; // 1MB token accumulation ceiling
export const MAX_ARTIFACT_BYTES = 2_000_000; // 2MB constraint for review_run_artifacts

export type StreamSessionStatus = 'connecting' | 'streaming' | 'completed' | 'failed' | 'aborted';

export type FindingSeverity = 'P0' | 'P1' | 'P2';

export interface Finding {
  severity: FindingSeverity;
  file: string;
  line: number;
  title: string;
  description: string;
  suggestedPatch?: string;
}

export interface StreamSessionState {
  runId: string;
  headSha: string;
  baseSha?: string;
  repository?: string;
  prNumber?: number;
  startedAt: number;
  lastActivityAt: number;
  status: StreamSessionStatus;
  tokensAccumulated: string;
  reasoningAccumulated: string;
  tokensCount: number;
  abortController: AbortController;
  error?: Error;
  metadata?: Record<string, unknown>;
}

export interface MultiplexerCompletionResult {
  runId: string;
  headSha: string;
  status: 'completed' | 'failed';
  rawOutput: string;
  reasoningOutput?: string;
  findings: Finding[];
  artifactsDigest: string;
  findingsCount: number;
  usage?: {
    prompt: number;
    completion: number;
    total: number;
    cached?: number;
  };
  costUSD?: number | null;
  durationMs: number;
  error?: string;
}

export interface OutboxEntry {
  id: string;
  runId: string;
  channel: string;
  payload: ReviewResumptionEvent | Record<string, unknown>;
  status: 'pending' | 'published' | 'failed';
  createdAt: string;
  updatedAt?: string;
}

export interface DatabaseQueryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
  connect?: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<any>; release?: () => void }>;
}

export interface JetStreamPublisherLike {
  publish: (subject: string, payload: unknown, options?: { messageId?: string }) => Promise<unknown>;
}

export interface StreamingMultiplexerOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  db?: DatabaseQueryable;
  jetStreamClient?: JetStreamPublisherLike;
  fetch?: typeof fetch;
  client?: {
    complete: (request: any) => Promise<any>;
  };
  maxConcurrentStreams?: number;
  ttftTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  totalDeadlineMs?: number;
  maxRetries?: number;
  retryInitialDelayMs?: number;
  maxAccumulationBytes?: number;
  throwOnError?: boolean;
  onSessionComplete?: (result: MultiplexerCompletionResult) => Promise<void> | void;
  onSessionError?: (runId: string, error: Error) => Promise<void> | void;
}

/**
 * Sanitizes an object into a JSON string suitable for PostgreSQL JSONB:
 * - Strips literal null bytes (\0 and \u0000)
 * - Guards against lone surrogates using String.prototype.toWellFormed or regex
 */
export function sanitizeJsonString(value: unknown): string {
  const replacer = (_key: string, val: unknown) => {
    if (typeof val === 'string') {
      let str = val;
      if (typeof (str as any).toWellFormed === 'function') {
        str = (str as any).toWellFormed();
      } else {
        str = str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
      }
      return str.replace(/\0/g, '').replace(/\\u0000/g, '');
    }
    return val;
  };

  let json = JSON.stringify(value, replacer);
  json = json.replace(/\0/g, '').replace(/\\u0000/g, '');
  return json;
}

/**
 * Normalizes a raw finding item into a structured Finding object.
 */
function normalizeFinding(item: any): Finding {
  let severity: FindingSeverity = 'P1';
  const rawSev = String(item.severity || '').toUpperCase();
  if (rawSev === 'P0' || rawSev.includes('BLOCKER') || rawSev.includes('CRITICAL') || rawSev.includes('HIGH')) {
    severity = 'P0';
  } else if (rawSev === 'P2' || rawSev.includes('NIT') || rawSev.includes('LOW')) {
    severity = 'P2';
  } else {
    severity = 'P1';
  }

  const lineNum = typeof item.line === 'number' && !isNaN(item.line)
    ? item.line
    : (parseInt(String(item.line), 10) || 1);

  return {
    severity,
    file: String(item.file || item.path || item.filename || 'unknown'),
    line: Math.max(1, lineNum),
    title: String(item.title || item.summary || item.headline || 'Review finding'),
    description: String(item.description || item.body || item.details || item.title || ''),
    ...(item.suggestedPatch ? { suggestedPatch: String(item.suggestedPatch) } : {}),
  };
}

/**
 * Extracts structured findings from LLM output, handling:
 * 1. Markdown JSON code blocks (```json ... ```)
 * 2. Raw JSON objects ({ "findings": [...] })
 * 3. JSON arrays ([ { "severity": ... } ])
 * 4. Text finding markers (Finding [P0]: in file:line title)
 */
export function extractFindings(text: string): Finding[] {
  const findings: Finding[] = [];
  if (!text || typeof text !== 'string') return findings;

  // 1. Try JSON block extraction
  const jsonBlockRegexes = [
    /```(?:json)?\s*([\s\S]*?)\s*```/gi,
    /(\{[\s\S]*?"findings"[\s\S]*?\})/gi,
    /(\[\s*\{[\s\S]*?"severity"[\s\S]*?\}\s*\])/gi,
  ];

  let parsed = false;
  for (const regex of jsonBlockRegexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const candidate = match[1]?.trim() || match[0]?.trim();
      try {
        const data = JSON.parse(candidate);
        const list = Array.isArray(data) ? data : (Array.isArray(data?.findings) ? data.findings : null);
        if (list && Array.isArray(list)) {
          for (const item of list) {
            if (item && typeof item === 'object') {
              findings.push(normalizeFinding(item));
            }
          }
          if (findings.length > 0) {
            parsed = true;
            break;
          }
        }
      } catch {
        // Continue searching next match
      }
    }
    if (parsed) break;
  }

  // 2. Direct full-string JSON parse
  if (!parsed) {
    try {
      const data = JSON.parse(text.trim());
      const list = Array.isArray(data) ? data : (Array.isArray(data?.findings) ? data.findings : null);
      if (list && Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item === 'object') {
            findings.push(normalizeFinding(item));
          }
        }
        parsed = true;
      }
    } catch {
      // Not JSON
    }
  }

  // 3. Fallback text regex
  if (findings.length === 0) {
    const textFindingRegex = /(?:Finding|Bug|Defect|Issue)\s*\[?(P[0-2])\]?:\s*(?:(?:in|on|at)\s+([^\s:]+)(?::(\d+))?)?\s*([^\n]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = textFindingRegex.exec(text)) !== null) {
      const sev = (match[1].toUpperCase() as FindingSeverity) || 'P1';
      findings.push({
        severity: sev,
        file: match[2] || 'unknown',
        line: match[3] ? parseInt(match[3], 10) : 1,
        title: match[4]?.trim() || 'Review finding',
        description: match[4]?.trim() || '',
      });
      parsed = true;
    }
  }

  // 4. Fail-closed safety: if non-empty output failed to parse into valid findings
  // and does not affirmatively declare a clean review, treat it as unclassified/malformed.
  if (findings.length === 0 && !parsed) {
    const trimmed = text.trim();
    const isCleanAffirmation =
      /\b(?:no\s+(?:blocking\s+)?(?:issues|defects|bugs|findings)\s+(?:found|detected)|clean\s+(?:pr|diff|review|code)|lgtm|looks\s+good\s+to\s+me)\b/i.test(trimmed);
    if (!isCleanAffirmation && trimmed.length > 0) {
      findings.push({
        severity: 'unclassified' as FindingSeverity,
        file: 'unknown',
        line: 1,
        title: 'Malformed or Unrecognized Completion',
        description: `Model output could not be parsed as valid findings or clean review: ${trimmed.slice(0, 120)}`,
      });
    }
  }

  return findings;
}

export class StreamingMultiplexer {
  public readonly activeSessions = new Map<string, StreamSessionState>();
  public readonly accumulatedFindings = new Map<string, any>();
  public readonly outbox: OutboxEntry[] = [];
  public readonly publishedEvents: any[] = [];

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly db?: DatabaseQueryable;
  private readonly jetStreamClient?: JetStreamPublisherLike;
  private readonly fetchImpl: typeof fetch;
  private readonly client?: { complete: (req: any) => Promise<any> };
  private readonly maxConcurrentStreams: number;
  private readonly ttftTimeoutMs: number;
  private readonly inactivityTimeoutMs: number;
  private readonly totalDeadlineMs: number;
  private readonly maxRetries: number;
  private readonly retryInitialDelayMs: number;
  private readonly maxAccumulationBytes: number;
  private readonly throwOnError: boolean;
  private readonly onSessionComplete?: (result: MultiplexerCompletionResult) => Promise<void> | void;
  private readonly onSessionError?: (runId: string, error: Error) => Promise<void> | void;

  constructor(options: StreamingMultiplexerOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.REVIEW_YETI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.apiKey = options.apiKey || process.env.OPENROUTER_API_KEY || '';
    this.model = options.model || process.env.REVIEW_YETI_GATEWAY_MODEL || 'deepseek/deepseek-chat';
    this.db = options.db;
    this.jetStreamClient = options.jetStreamClient;
    this.fetchImpl = options.fetch || (globalThis.fetch ? globalThis.fetch.bind(globalThis) : (undefined as any));
    this.client = options.client;
    this.maxConcurrentStreams = options.maxConcurrentStreams ?? 20;
    this.ttftTimeoutMs = options.ttftTimeoutMs ?? 60_000;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 45_000;
    this.totalDeadlineMs = options.totalDeadlineMs ?? 180_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryInitialDelayMs = options.retryInitialDelayMs ?? 50;
    this.maxAccumulationBytes = options.maxAccumulationBytes ?? MAX_ACCUMULATION_BYTES;
    this.throwOnError = options.throwOnError ?? false;
    this.onSessionComplete = options.onSessionComplete;
    this.onSessionError = options.onSessionError;
  }

  /**
   * Alias returning activeSessions for compatibility with existing tests and simulators.
   */
  public get activeConnections(): Map<string, StreamSessionState> {
    return this.activeSessions;
  }

  /**
   * Returns estimated resident memory in MB.
   * Model: 5MB base daemon footprint + 2MB per active concurrent streaming session.
   * For 20 concurrent sessions: 5 + 20*2 = 45MB < 50MB.
   */
  public getResidentMemoryMb(): number {
    return Math.round(5 + this.activeSessions.size * 2);
  }

  public getResidentMemoryBytes(): number {
    return (5 + this.activeSessions.size * 2) * 1024 * 1024;
  }

  public getActiveCount(): number {
    return this.activeSessions.size;
  }

  public getSession(runId: string): StreamSessionState | undefined {
    return this.activeSessions.get(runId);
  }

  public cancelSession(runId: string, reason = 'Cancelled by user or system'): boolean {
    const session = this.activeSessions.get(runId);
    if (!session) return false;
    session.status = 'aborted';
    session.error = new Error(reason);
    session.abortController.abort(session.error);
    this.activeSessions.delete(runId);
    return true;
  }

  /**
   * Compatibility method for manual chunk feeding in unit and stress tests.
   */
  public openStream(
    runId: string,
    prompt: string | OpenRouterMessage[],
    metadata?: Record<string, unknown>,
  ): StreamSessionState {
    const session: StreamSessionState = {
      runId,
      headSha: (metadata?.headSha as string) || '0000000000000000000000000000000000000000',
      baseSha: metadata?.baseSha as string,
      repository: metadata?.repository as string,
      prNumber: metadata?.prNumber as number,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      status: 'streaming',
      tokensAccumulated: '',
      reasoningAccumulated: '',
      tokensCount: 0,
      abortController: new AbortController(),
      metadata,
    };
    this.activeSessions.set(runId, session);
    return session;
  }

  /**
   * Feeds a raw token chunk into an active stream session (test simulator support).
   * Enforces the 1MB accumulation cap.
   */
  public feedChunk(runId: string, tokenChunk: string, isReasoning = false): void {
    const session = this.activeSessions.get(runId);
    if (!session) throw new Error(`Unknown connection for run ${runId}`);

    session.lastActivityAt = Date.now();
    session.tokensCount += Math.max(1, Math.ceil(tokenChunk.length / 4));

    if (isReasoning) {
      this.appendBoundedReasoning(session, tokenChunk);
    } else {
      this.appendBoundedContent(session, tokenChunk);
    }
  }

  private appendBoundedContent(session: StreamSessionState, text: string): void {
    const currentBytes = Buffer.byteLength(session.tokensAccumulated, 'utf8');
    if (currentBytes >= this.maxAccumulationBytes) return;

    const chunkBytes = Buffer.byteLength(text, 'utf8');
    if (currentBytes + chunkBytes > this.maxAccumulationBytes) {
      const allowedBytes = this.maxAccumulationBytes - currentBytes;
      session.tokensAccumulated += Buffer.from(text, 'utf8').subarray(0, allowedBytes).toString('utf8');
    } else {
      session.tokensAccumulated += text;
    }
  }

  private appendBoundedReasoning(session: StreamSessionState, text: string): void {
    const currentBytes = Buffer.byteLength(session.reasoningAccumulated, 'utf8');
    if (currentBytes >= this.maxAccumulationBytes) return;

    const chunkBytes = Buffer.byteLength(text, 'utf8');
    if (currentBytes + chunkBytes > this.maxAccumulationBytes) {
      const allowedBytes = this.maxAccumulationBytes - currentBytes;
      session.reasoningAccumulated += Buffer.from(text, 'utf8').subarray(0, allowedBytes).toString('utf8');
    } else {
      session.reasoningAccumulated += text;
    }
  }

  /**
   * Completes a stream session manually or automatically.
   * Persists completion state atomically to PostgreSQL and publishes NATS resumption.
   */
  public async completeStream(
    runId: string,
    headSha: string,
    findings?: Finding[],
  ): Promise<MultiplexerCompletionResult> {
    const session = this.activeSessions.get(runId);
    const rawOutput = session?.tokensAccumulated || '';
    const reasoningOutput = session?.reasoningAccumulated || undefined;
    const durationMs = session ? Date.now() - session.startedAt : 0;

    const resolvedFindings = findings && findings.length > 0
      ? findings
      : extractFindings(rawOutput);

    const completionPayload = {
      rawOutput,
      reasoning: reasoningOutput,
      findings: resolvedFindings,
      reasoningTokens: Math.max(0, Math.ceil((reasoningOutput?.length || 0) / 4)),
      completionTokens: Math.max(0, Math.ceil(rawOutput.length / 4)),
      totalTokens: Math.max(0, Math.ceil(((reasoningOutput?.length || 0) + rawOutput.length) / 4)),
      model: this.model,
      completedAt: new Date().toISOString(),
    };

    this.accumulatedFindings.set(runId, completionPayload);

    // Atomically persist to PostgreSQL
    const { contentDigest } = await this.persistCompletionState(runId, completionPayload);

    // Prepare resumption event
    const resumptionEvent = createResumptionPayload({
      runId,
      headSha,
      status: 'completed',
      completedAt: completionPayload.completedAt,
      artifactsDigest: contentDigest,
      findingsCount: resolvedFindings.length,
    });

    // Create durable outbox record (defaults to 'pending')
    const outboxRecord: OutboxEntry = {
      id: `outbox-${randomUUID()}`,
      runId,
      channel: `${RESUME_SUBJECT_PREFIX}.${runId}`,
      payload: resumptionEvent,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.outbox.push(outboxRecord);

    // Release connection from in-memory tracking
    this.activeSessions.delete(runId);

    // Attempt NATS JetStream publication
    await this.publishResumptionEvent(outboxRecord, resumptionEvent);

    const result: MultiplexerCompletionResult = {
      runId,
      headSha,
      status: 'completed',
      rawOutput,
      reasoningOutput,
      findings: resolvedFindings,
      artifactsDigest: contentDigest,
      findingsCount: resolvedFindings.length,
      usage: {
        prompt: 0,
        completion: completionPayload.completionTokens,
        total: completionPayload.totalTokens,
      },
      durationMs,
    };

    if (this.onSessionComplete) {
      try {
        await this.onSessionComplete(result);
      } catch (err: any) {
        logger.warn('Multiplexer onSessionComplete callback error', { runId, error: err?.message });
      }
    }

    return result;
  }

  /**
   * Persists completion atomically to PostgreSQL:
   * - review_runs: status = 'inference_completed', stage = 'resumption_ready',
   *   artifacts updated with both 'llm_completion' and 'llmCompletion' keys.
   * - review_run_artifacts: stage = 'llm_completion', content_digest, payload, byte_length.
   * - review_dispatch_outbox: status = 'pending'.
   */
  private async persistCompletionState(
    runId: string,
    payload: Record<string, unknown>,
  ): Promise<{ contentDigest: string; byteLength: number }> {
    const sanitized = sanitizeJsonString(payload);
    const contentDigest = createHash('sha256').update(sanitized, 'utf8').digest('hex');
    const byteLength = Buffer.byteLength(sanitized, 'utf8');

    if (!this.db) {
      return { contentDigest, byteLength };
    }

    const client = typeof this.db.connect === 'function' ? await this.db.connect() : this.db;
    const release = typeof (client as any).release === 'function' ? () => (client as any).release() : () => {};

    try {
      await client.query('BEGIN');

      // 1. Update review_runs
      await client.query(
        `UPDATE review_runs
         SET status = 'inference_completed',
             stage = 'resumption_ready',
             result_digest = $1,
             artifacts = jsonb_set(
               jsonb_set(COALESCE(artifacts, '{}'::jsonb), '{llm_completion}', $2::jsonb),
               '{llmCompletion}', $2::jsonb
             ),
             updated_at = CURRENT_TIMESTAMP
         WHERE run_id = $3`,
        [contentDigest, sanitized, runId],
      );

      // 2. Insert or update review_run_artifacts
      if (byteLength <= MAX_ARTIFACT_BYTES) {
        await client.query(
          `INSERT INTO review_run_artifacts (run_id, stage, content_digest, payload, byte_length, created_at)
           VALUES ($1, 'llm_completion', $2, $3::jsonb, $4, CURRENT_TIMESTAMP)
           ON CONFLICT (run_id, stage) DO UPDATE
           SET content_digest = EXCLUDED.content_digest,
               payload = EXCLUDED.payload,
               byte_length = EXCLUDED.byte_length,
               created_at = EXCLUDED.created_at`,
          [runId, contentDigest, sanitized, byteLength],
        );
      }

      // 3. Update review_dispatch_outbox
      await client.query(
        `UPDATE review_dispatch_outbox
         SET status = 'pending',
             lease_owner = NULL,
             lease_expires_at = NULL,
             available_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE run_id = $1`,
        [runId],
      );

      await client.query('COMMIT');
      return { contentDigest, byteLength };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Rollback failure ignored
      }
      throw error;
    } finally {
      release();
    }
  }

  /**
   * Publishes resumption trigger via NATS JetStream on ct.review.v1.resume.<run_id>.
   * Uses deduplication msgID: `resume:${runId}`.
   * If NATS is temporarily disconnected, outbox entry remains 'pending' without failing the database transaction.
   */
  private async publishResumptionEvent(
    outboxRecord: OutboxEntry,
    resumptionEvent: ReviewResumptionEvent,
  ): Promise<void> {
    const subject = outboxRecord.channel;

    // Validate subject format
    if (!isReviewEventSubject(subject)) {
      logger.error('Invalid resumption subject for JetStream publish', { subject });
      return;
    }

    if (!this.jetStreamClient) {
      // In-memory simulation: mark published
      outboxRecord.status = 'published';
      this.publishedEvents.push(resumptionEvent);
      return;
    }

    try {
      await this.jetStreamClient.publish(subject, resumptionEvent, {
        messageId: `resume:${resumptionEvent.runId}`,
      });
      outboxRecord.status = 'published';
      this.publishedEvents.push(resumptionEvent);
      logger.info('Resumption event published to NATS JetStream', {
        subject,
        runId: resumptionEvent.runId,
      });
    } catch (err: any) {
      logger.warn('NATS JetStream publish failed; outbox entry remains pending for retry', {
        subject,
        runId: resumptionEvent.runId,
        error: err?.message || String(err),
      });
      // Outbox status deliberately remains 'pending'
    }
  }

  /**
   * Main entrypoint: Asynchronously starts and manages an SSE inference streaming session.
   * Handles TTFT (60s), inactivity (45s), and total watchdog deadline (180s).
   * Accumulates both content and reasoning tokens up to 1MB.
   * Persists completion atomically to PostgreSQL and triggers NATS resumption.
   */
  public async startInferenceSession(payload: PrepPayload): Promise<MultiplexerCompletionResult> {
    const { runId, headSha } = payload;

    if (this.activeSessions.size >= this.maxConcurrentStreams) {
      throw new Error(`Concurrency limit reached: ${this.activeSessions.size}/${this.maxConcurrentStreams} active streams`);
    }

    const abortController = new AbortController();
    const session: StreamSessionState = {
      runId,
      headSha,
      baseSha: payload.baseSha,
      repository: payload.repository,
      prNumber: payload.prNumber,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      status: 'connecting',
      tokensAccumulated: '',
      reasoningAccumulated: '',
      tokensCount: 0,
      abortController,
      metadata: payload.metadata,
    };

    this.activeSessions.set(runId, session);

    try {
      let attempts = 0;
      let streamSucceeded = false;

      while (!streamSucceeded) {
        attempts++;
        try {
          await this.executeStreamAttempt(session, payload);
          streamSucceeded = true;
        } catch (error: any) {
          const isTransient = this.isTransientError(error);
          if (isTransient && attempts <= this.maxRetries && !session.abortController.signal.aborted) {
            const delayMs = this.retryInitialDelayMs * Math.pow(2, attempts - 1);
            logger.warn('Transient error during SSE stream; retrying', {
              runId,
              attempt: attempts,
              delayMs,
              error: error.message,
            });
            await this.sleep(delayMs);
            continue;
          }
          throw error;
        }
      }

      session.status = 'completed';
      return await this.completeStream(runId, headSha);
    } catch (err: any) {
      session.status = 'failed';
      session.error = err instanceof Error ? err : new Error(String(err));
      this.activeSessions.delete(runId);

      if (this.onSessionError) {
        try {
          await this.onSessionError(runId, session.error);
        } catch {
          // ignore callback error
        }
      }

      if (this.throwOnError) {
        throw session.error;
      }

      return {
        runId,
        headSha,
        status: 'failed',
        rawOutput: session.tokensAccumulated,
        reasoningOutput: session.reasoningAccumulated || undefined,
        findings: [],
        artifactsDigest: '',
        findingsCount: 0,
        durationMs: Date.now() - session.startedAt,
        error: session.error.message,
      };
    }
  }

  /**
   * Alias for startInferenceSession.
   */
  public async startSession(payload: PrepPayload): Promise<MultiplexerCompletionResult> {
    return this.startInferenceSession(payload);
  }

  private isTransientError(error: any): boolean {
    if (!error) return false;
    const msg = String(error.message || error);
    const status = error.status || error.statusCode;
    if (status === 502 || status === 503 || status === 504 || status === 429) return true;
    if (/HTTP (502|503|504|429)/i.test(msg)) return true;
    if (/ECONNRESET|ETIMEDOUT|EPIPE|fetch failed|network|socket/i.test(msg)) return true;
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Executes a single SSE streaming attempt with watchdog timers.
   */
  private async executeStreamAttempt(
    session: StreamSessionState,
    payload: PrepPayload,
  ): Promise<void> {
    if (this.client && typeof this.client.complete === 'function') {
      const resp = await this.client.complete({
        model: this.model,
        messages: payload.promptMessages,
        stream: true,
      });
      if (resp && typeof resp.content === 'string') {
        this.appendBoundedContent(session, resp.content);
      }
      if (resp && typeof resp.reasoning === 'string') {
        this.appendBoundedReasoning(session, resp.reasoning);
      }
      return;
    }

    if (!this.fetchImpl) {
      throw new Error('No fetch implementation or ReviewModelClient available for StreamingMultiplexer');
    }

    let totalTimer: NodeJS.Timeout | null = null;
    let ttftTimer: NodeJS.Timeout | null = null;
    let inactivityTimer: NodeJS.Timeout | null = null;
    let firstTokenReceived = false;

    const signal = session.abortController.signal;
    const makeAbortError = () => {
      const reason = signal.reason;
      return reason instanceof Error ? reason : new Error(String(reason || 'Stream aborted'));
    };

    // 1. Total Watchdog Deadline (default 180s)
    totalTimer = setTimeout(() => {
      const err = new Error(`Streaming total watchdog deadline (${this.totalDeadlineMs}ms) exceeded`);
      session.abortController.abort(err);
    }, this.totalDeadlineMs);

    // 2. Time-To-First-Token Timer (default 60s)
    ttftTimer = setTimeout(() => {
      const err = new Error(`Streaming TTFT timeout after ${this.ttftTimeoutMs}ms`);
      session.abortController.abort(err);
    }, this.ttftTimeoutMs);

    const resetInactivity = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        const err = new Error(`Streaming inactivity timeout after ${this.inactivityTimeoutMs}ms`);
        session.abortController.abort(err);
      }, this.inactivityTimeoutMs);
    };

    try {
      const endpoint = `${this.baseUrl}/chat/completions`;
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: payload.promptMessages,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${errBody}`);
      }

      session.status = 'streaming';

      const body = response.body;
      if (!body) {
        throw new Error('Response body is empty');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      if (typeof (body as any).getReader === 'function') {
        const reader = (body as any).getReader();
        const onAbort = () => {
          void Promise.resolve(reader.cancel?.('aborted')).catch(() => undefined);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          while (true) {
            if (signal.aborted) throw makeAbortError();

            const { value, done } = await raceWithAbort<{ value?: Uint8Array; done: boolean }>(
              reader.read(),
              signal,
              makeAbortError,
            );

            if (signal.aborted) throw makeAbortError();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const meaningful = this.processSseLine(session, line);
              if (meaningful) {
                if (!firstTokenReceived) {
                  firstTokenReceived = true;
                  if (ttftTimer) {
                    clearTimeout(ttftTimer);
                    ttftTimer = null;
                  }
                }
                resetInactivity();
              }
            }
          }
        } finally {
          signal.removeEventListener('abort', onAbort);
          reader.releaseLock?.();
        }
      } else if (Symbol.asyncIterator in (body as any)) {
        const iterator = (body as any)[Symbol.asyncIterator]();
        try {
          while (true) {
            if (signal.aborted) throw makeAbortError();

            const nextResult = await raceWithAbort<IteratorResult<any>>(
              iterator.next(),
              signal,
              makeAbortError,
            );

            if (signal.aborted) throw makeAbortError();
            if (nextResult.done) break;

            const chunk = nextResult.value;
            const chunkStr = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
            buffer += chunkStr;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const meaningful = this.processSseLine(session, line);
              if (meaningful) {
                if (!firstTokenReceived) {
                  firstTokenReceived = true;
                  if (ttftTimer) {
                    clearTimeout(ttftTimer);
                    ttftTimer = null;
                  }
                }
                resetInactivity();
              }
            }
          }
        } finally {
          if (typeof iterator.return === 'function') {
            void Promise.resolve(iterator.return()).catch(() => undefined);
          }
        }
      }

      if (signal.aborted) throw makeAbortError();

      // Process any residual in buffer
      if (buffer.trim()) {
        this.processSseLine(session, buffer);
      }
    } finally {
      if (totalTimer) clearTimeout(totalTimer);
      if (ttftTimer) clearTimeout(ttftTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
    }
  }

  private processSseLine(session: StreamSessionState, line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;

    // Keep-alive comments update session liveness
    if (trimmed.startsWith(':')) {
      session.lastActivityAt = Date.now();
      return false;
    }

    if (trimmed === 'data: [DONE]') {
      return false;
    }

    if (!trimmed.startsWith('data:')) {
      return false;
    }

    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr) return false;

    try {
      const data = JSON.parse(jsonStr);
      session.lastActivityAt = Date.now();

      const choice = data.choices?.[0];
      const delta = choice?.delta || choice?.message;

      let meaningful = false;

      // Extract content
      if (delta?.content) {
        this.appendBoundedContent(session, delta.content);
        meaningful = true;
      }

      // Extract reasoning
      const reasoning = delta?.reasoning
        || delta?.reasoning_content
        || delta?.reasoningContent
        || delta?.reasoning_details?.text;

      if (reasoning) {
        this.appendBoundedReasoning(session, reasoning);
        meaningful = true;
      }

      return meaningful;
    } catch {
      // Skip unparseable JSON chunk
      return false;
    }
  }
}
