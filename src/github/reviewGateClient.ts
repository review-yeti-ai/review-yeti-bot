import { createHash } from 'node:crypto';
import type { ReviewGateCoordinates } from '../review/reviewGateContracts';
export type { ReviewGateCoordinates } from '../review/reviewGateContracts';

export const REVIEW_GATE_CHECK_NAME = 'Review Yeti Gate';
export const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
export const MAX_CHECK_RUN_PAGES = 100;
export const CHECK_RUN_PAGE_SIZE = 100;
export const MAX_CHECK_RUN_COUNT = MAX_CHECK_RUN_PAGES * CHECK_RUN_PAGE_SIZE;
export const MIN_REQUEST_TIMEOUT_MS = 250;
export const MAX_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_RECONCILE_TIMEOUT_MS = 30_000;
export const MAX_RECONCILE_TIMEOUT_MS = 30_000;
/** Per response, counted from streamed UTF-8 bytes, never Content-Length. */
export const MAX_GATE_RESPONSE_BYTES = 2 * 1024 * 1024;

const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const SAFE_ASCII = /^[\x21-\x7e]+$/u;
const EXACT_SHA = /^[a-f0-9]{40}$/u;
const EXACT_POLICY_DIGEST = /^[a-f0-9]{64}$/u;
const EXACT_RUN_ID = /^run_[a-f0-9]{32}$/u;

export type ReviewGatePendingStatus = 'queued' | 'in_progress';
export type ReviewGateTerminalConclusion = 'success' | 'failure' | 'cancelled' | 'timed_out';
export type ReviewGateObservedConclusion = ReviewGateTerminalConclusion
  | 'action_required'
  | 'neutral'
  | 'skipped'
  | 'stale';

export interface ReviewGateClientOptions {
  /** A repository-scoped GitHub App installation token. */
  token: string;
  /** The numeric App id whose check runs may satisfy this gate. */
  expectedAppId: number;
  /** Defaults to api.github.com. Enterprise API prefixes are supported. */
  baseUrl?: string;
  /** Test seam and transport boundary; it is never retried by this client. */
  fetchImplementation?: typeof fetch;
  /** Alias retained for callers that name the seam after the platform API. */
  fetch?: typeof fetch;
  /** Each complete HTTP request (fetch and body) has its own hard deadline. */
  timeoutMs?: number;
  /** The complete reconcile operation is bounded independently of page count. */
  reconcileTimeoutMs?: number;
}

export interface ReviewGateCheck {
  id: number;
  name: typeof REVIEW_GATE_CHECK_NAME;
  appId: number;
  headSha: string;
  externalId: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: ReviewGateObservedConclusion | null;
  htmlUrl?: string;
}

export interface ReviewGateCheckMetadata {
  detailsUrl?: string;
  title?: string;
  summary?: string;
}

export interface ReviewGateCreateRequest extends ReviewGateCheckMetadata {
  coordinates: ReviewGateCoordinates;
  status?: ReviewGatePendingStatus;
}

export type ReviewGateProgressUpdate = ReviewGateCheckMetadata & {
  status: ReviewGatePendingStatus;
  conclusion?: never;
};

export type ReviewGateTerminalUpdate = ReviewGateCheckMetadata & {
  conclusion: ReviewGateTerminalConclusion;
  status?: never;
};

export type ReviewGateUpdate = ReviewGateProgressUpdate | ReviewGateTerminalUpdate;

export interface ReviewGateUpdateRequest {
  coordinates: ReviewGateCoordinates;
  checkId: number;
  update: ReviewGateUpdate;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function cancelBody(body: { cancel(): Promise<unknown> } | null): void {
  try { void body?.cancel().catch(() => undefined); } catch { /* Best effort, never awaited. */ }
}

function requiredText(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || CONTROL_CHARACTER.test(value)) {
    throw new Error(`GitHub Review Yeti gate ${field} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`GitHub Review Yeti gate ${field} is invalid`);
  }
  return value;
}

function validateCoordinates(input: ReviewGateCoordinates): ReviewGateCoordinates {
  if (!input || typeof input !== 'object') throw new Error('GitHub Review Yeti gate coordinates are invalid');
  const owner = requiredText(input.owner, 'owner', 100);
  const repo = requiredText(input.repo, 'repo', 100);
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) {
    throw new Error('GitHub Review Yeti gate repository identity is invalid');
  }
  const headSha = requiredText(input.headSha, 'head SHA', 256);
  const baseSha = requiredText(input.baseSha, 'base SHA', 256);
  const policyDigest = requiredText(input.policyDigest, 'policy digest', 512);
  const runId = requiredText(input.runId, 'run id', 512);
  const attemptId = requiredText(input.attemptId, 'attempt id', 512);
  if (!EXACT_SHA.test(headSha) || !EXACT_SHA.test(baseSha)) {
    throw new Error('GitHub Review Yeti gate commit identity is invalid');
  }
  if (!EXACT_POLICY_DIGEST.test(policyDigest)) {
    throw new Error('GitHub Review Yeti gate policy digest is invalid');
  }
  if (!EXACT_RUN_ID.test(runId)) {
    throw new Error('GitHub Review Yeti gate run id is invalid');
  }
  if (!SAFE_ASCII.test(attemptId)) throw new Error('GitHub Review Yeti gate attempt id is invalid');
  return {
    owner,
    repo,
    repositoryId: positiveInteger(input.repositoryId, 'repository id'),
    prNumber: positiveInteger(input.prNumber, 'pull request number'),
    headSha,
    baseSha,
    policyDigest,
    runId,
    attemptId,
    executionAttempt: positiveInteger(input.executionAttempt, 'execution attempt'),
  };
}

function validateBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('GitHub Review Yeti gate API base URL is invalid');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('GitHub Review Yeti gate API base URL must be HTTPS without credentials, query, or fragment');
  }
  return parsed.toString().replace(/\/+$/u, '');
}

function validateMetadata(metadata: ReviewGateCheckMetadata): ReviewGateCheckMetadata {
  const result: ReviewGateCheckMetadata = {};
  if (metadata.detailsUrl !== undefined) result.detailsUrl = requiredText(metadata.detailsUrl, 'details URL', 2_000);
  if (metadata.title !== undefined) result.title = requiredText(metadata.title, 'check title', 1_000);
  if (metadata.summary !== undefined) result.summary = requiredText(metadata.summary, 'check summary', 65_000);
  return result;
}

function outputFor(metadata: ReviewGateCheckMetadata, defaultTitle: string, defaultSummary: string): Record<string, string> {
  return {
    title: metadata.title ?? defaultTitle,
    summary: metadata.summary ?? defaultSummary,
  };
}

function checkRunFrom(value: unknown): ReviewGateCheck | undefined {
  const item = record(value);
  const app = record(item?.app);
  const id = item?.id;
  const name = item?.name;
  const appId = app?.id;
  const headSha = item?.head_sha;
  const externalId = item?.external_id;
  const status = item?.status;
  const conclusion = item?.conclusion;
  if (!Number.isSafeInteger(id) || (id as number) <= 0
    || name !== REVIEW_GATE_CHECK_NAME
    || !Number.isSafeInteger(appId) || (appId as number) <= 0
    || typeof headSha !== 'string' || typeof externalId !== 'string'
    || (status !== 'queued' && status !== 'in_progress' && status !== 'completed')
    || ((status === 'completed') !== (typeof conclusion === 'string'))
    || (conclusion !== null && conclusion !== undefined
      && conclusion !== 'success'
      && conclusion !== 'failure'
      && conclusion !== 'cancelled'
      && conclusion !== 'timed_out'
      && conclusion !== 'action_required'
      && conclusion !== 'neutral'
      && conclusion !== 'skipped'
      && conclusion !== 'stale')) {
    return undefined;
  }
  return {
    id: id as number,
    name: REVIEW_GATE_CHECK_NAME,
    appId: appId as number,
    headSha,
    externalId,
    status,
    conclusion: conclusion === undefined ? null : conclusion as ReviewGateObservedConclusion | null,
    ...(typeof item?.html_url === 'string' ? { htmlUrl: item.html_url } : {}),
  };
}

function coordinatesExternalId(coordinates: ReviewGateCoordinates): string {
  const normalized = validateCoordinates(coordinates);
  const canonical = JSON.stringify([
    normalized.owner,
    normalized.repo,
    normalized.repositoryId,
    normalized.prNumber,
    normalized.headSha,
    normalized.baseSha,
    normalized.policyDigest,
    normalized.runId,
    normalized.attemptId,
    normalized.executionAttempt,
  ]);
  return `review-yeti-gate:v1:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** Derives the immutable GitHub `external_id` for one review attempt. */
export function deriveReviewGateExternalId(coordinates: ReviewGateCoordinates): string {
  return coordinatesExternalId(coordinates);
}

function hasExactIdentity(
  value: unknown,
  coordinates: ReviewGateCoordinates,
  expectedAppId: number,
  externalId: string,
): boolean {
  const item = record(value);
  const app = record(item?.app);
  return item?.name === REVIEW_GATE_CHECK_NAME
    && app?.id === expectedAppId
    && item?.head_sha === coordinates.headSha
    && item?.external_id === externalId;
}

function assertExactIdentity(
  value: unknown,
  coordinates: ReviewGateCoordinates,
  expectedAppId: number,
  externalId: string,
  message: string,
): ReviewGateCheck {
  if (!hasExactIdentity(value, coordinates, expectedAppId, externalId)) throw new Error(message);
  const check = checkRunFrom(value);
  if (!check || check.appId !== expectedAppId || check.headSha !== coordinates.headSha || check.externalId !== externalId) {
    throw new Error(message);
  }
  return check;
}

function assertUpdate(value: unknown): ReviewGateUpdate {
  if (!value || typeof value !== 'object') throw new Error('GitHub Review Yeti gate update is invalid');
  const candidate = value as ReviewGateUpdate;
  const metadata = validateMetadata(candidate);
  if ('conclusion' in candidate && candidate.conclusion !== undefined) {
    if (candidate.status !== undefined
      || (candidate.conclusion !== 'success'
        && candidate.conclusion !== 'failure'
        && candidate.conclusion !== 'cancelled'
        && candidate.conclusion !== 'timed_out')) {
      throw new Error('GitHub Review Yeti gate terminal update is invalid');
    }
    return { ...metadata, conclusion: candidate.conclusion };
  }
  if (candidate.status !== 'queued' && candidate.status !== 'in_progress') {
    throw new Error('GitHub Review Yeti gate progress update is invalid');
  }
  return { ...metadata, status: candidate.status };
}

export class GitHubReviewGateClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly expectedAppId: number;
  private readonly timeoutMs: number;
  private readonly reconcileTimeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: ReviewGateClientOptions) {
    if (!/^ghs_[^\s]+$/u.test(options.token)) {
      throw new Error('GitHub Review Yeti gate requires a ghs_ installation token');
    }
    this.token = options.token;
    this.expectedAppId = positiveInteger(options.expectedAppId, 'expected App id');
    this.baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_GITHUB_API_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs)
      || this.timeoutMs < MIN_REQUEST_TIMEOUT_MS
      || this.timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      throw new Error(`GitHub Review Yeti gate timeout must be between ${MIN_REQUEST_TIMEOUT_MS}ms and ${MAX_REQUEST_TIMEOUT_MS}ms`);
    }
    this.reconcileTimeoutMs = options.reconcileTimeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.reconcileTimeoutMs)
      || this.reconcileTimeoutMs < MIN_REQUEST_TIMEOUT_MS
      || this.reconcileTimeoutMs > MAX_RECONCILE_TIMEOUT_MS) {
      throw new Error(`GitHub Review Yeti gate reconcile timeout must be between ${MIN_REQUEST_TIMEOUT_MS}ms and ${MAX_RECONCILE_TIMEOUT_MS}ms`);
    }
    this.fetchImplementation = options.fetchImplementation ?? options.fetch ?? globalThis.fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('Authorization', `Bearer ${this.token}`);
    headers.set('User-Agent', 'review-yeti-gate-client[bot]');
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');

    const controller = new AbortController();
    const deadline = performance.now() + timeoutMs;
    const timedOut = () => new Error('GitHub Review Yeti gate request timed out');
    const checkDeadline = () => {
      if (controller.signal.aborted || performance.now() >= deadline) throw timedOut();
    };
    let cleanupBody: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(timedOut()); }, timeoutMs);
    });
    const execute = async (): Promise<T> => {
      let response: Response;
      try {
        checkDeadline();
        response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
          ...init,
          headers,
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        checkDeadline();
        // Do not include the transport error: custom fetch implementations can
        // accidentally include the token or an untrusted provider response.
        throw new Error('GitHub Review Yeti gate request failed');
      }
      // A fetch that ignores abort may resolve after this request has returned.
      // Dispose its late body without ever reading it or continuing to a write.
      if (controller.signal.aborted) { cancelBody(response.body); throw timedOut(); }
      cleanupBody = () => cancelBody(response.body);
      checkDeadline();
      if (response.redirected) throw new Error('GitHub Review Yeti gate request failed');
      if (!response.ok) throw new Error(`GitHub Review Yeti gate request failed HTTP ${response.status}`);
      try {
        if (!response.body) throw new Error();
        const reader = response.body.getReader();
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          cancelBody(reader);
          try { reader.releaseLock(); } catch { /* Pending cancellation cannot extend the deadline. */ }
        };
        cleanupBody = cleanup;
        try {
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          while (true) {
            const chunk = await reader.read();
            checkDeadline();
            if (chunk.done) break;
            if (!(chunk.value instanceof Uint8Array)) throw new Error();
            bytes += chunk.value.byteLength;
            if (bytes > MAX_GATE_RESPONSE_BYTES) throw new Error();
            if (chunk.value.byteLength) chunks.push(chunk.value);
          }
          // Never call a response-provided json()/text() method. Only bounded,
          // complete, valid UTF-8 reaches the local synchronous JSON parser.
          const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) as T;
          checkDeadline();
          return data;
        } finally { cleanup(); if (cleanupBody === cleanup) cleanupBody = undefined; }
      } catch {
        checkDeadline();
        throw new Error('GitHub Review Yeti gate response was invalid');
      }
    };
    try {
      return await Promise.race([execute(), expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      cleanupBody?.();
    }
  }

  private async listCheckRuns(coordinates: ReviewGateCoordinates, deadline: number): Promise<unknown[]> {
    const result: unknown[] = [];
    const seenCheckIds = new Set<number>();
    let totalCount: number | undefined;
    for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error('GitHub Review Yeti gate reconciliation deadline exceeded');
      const data = await this.request<unknown>(
        `/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}/commits/${encodeURIComponent(coordinates.headSha)}/check-runs?check_name=${encodeURIComponent(REVIEW_GATE_CHECK_NAME)}&filter=all&per_page=${CHECK_RUN_PAGE_SIZE}&page=${page}`,
        { method: 'GET' },
        Math.min(this.timeoutMs, remainingMs),
      );
      const body = record(data);
      const checkRuns = body?.check_runs;
      if (!Array.isArray(checkRuns) || checkRuns.length > CHECK_RUN_PAGE_SIZE) {
        throw new Error('GitHub Review Yeti gate check-run page was invalid');
      }
      if (body?.truncated === true || body?.incomplete_results === true) {
        throw new Error('GitHub Review Yeti gate check-run pagination was truncated');
      }
      for (const candidate of checkRuns) {
        const candidateRecord = record(candidate);
        const candidateId = candidateRecord?.id;
        if (!Number.isSafeInteger(candidateId) || (candidateId as number) <= 0) {
          throw new Error('GitHub Review Yeti gate check-run page identity was invalid');
        }
        if (seenCheckIds.has(candidateId as number)) {
          throw new Error('GitHub Review Yeti gate check-run pagination repeated an entry');
        }
        seenCheckIds.add(candidateId as number);
      }
      result.push(...checkRuns);

      if (body?.total_count !== undefined) {
        if (!Number.isSafeInteger(body.total_count) || (body.total_count as number) < 0) {
          throw new Error('GitHub Review Yeti gate check-run total was invalid');
        }
        if ((body.total_count as number) > MAX_CHECK_RUN_COUNT) {
          throw new Error('GitHub Review Yeti gate check-run total exceeded the pagination bound');
        }
        if (totalCount === undefined) totalCount = body.total_count as number;
        if (totalCount !== body.total_count) {
          throw new Error('GitHub Review Yeti gate check-run total changed during pagination');
        }
        if (result.length > totalCount) {
          throw new Error('GitHub Review Yeti gate check-run total was inconsistent');
        }
        if (result.length === totalCount) return result;
        continue;
      }
      if (checkRuns.length < CHECK_RUN_PAGE_SIZE) return result;
    }
    // A full final page at the bound may still have a next page. Treat that as
    // incomplete rather than allowing absence of a match to become authority.
    throw new Error('GitHub Review Yeti gate check-run pagination exhausted');
  }

  /**
   * Finds the one exact App-owned check for the supplied immutable attempt.
   * A same-named check from another App, head, or attempt is never authority.
   * `null` means no exact match was observed in this bounded snapshot; it is
   * not proof that a prior uncertain create was absent, and never authorizes a
   * follow-up create by this client.
   */
  async reconcile(coordinates: ReviewGateCoordinates): Promise<ReviewGateCheck | null> {
    const normalizedCoordinates = validateCoordinates(coordinates);
    const externalId = coordinatesExternalId(normalizedCoordinates);
    const deadline = Date.now() + this.reconcileTimeoutMs;
    const matches: ReviewGateCheck[] = [];
    for (const candidate of await this.listCheckRuns(normalizedCoordinates, deadline)) {
      if (!hasExactIdentity(candidate, normalizedCoordinates, this.expectedAppId, externalId)) continue;
      const check = checkRunFrom(candidate);
      if (!check) throw new Error('GitHub Review Yeti gate matching check identity was invalid');
      matches.push(check);
    }
    if (matches.length > 1) throw new Error('GitHub Review Yeti gate has duplicate exact check runs');
    return matches[0] ?? null;
  }

  /**
   * Creates a non-terminal check after the caller has durably recorded its
   * creation intent. This method deliberately performs one POST only; an
   * uncertain acknowledgement must be recovered by reconcile(), never retried.
   */
  async createPending(coordinates: ReviewGateCoordinates, options?: Omit<ReviewGateCreateRequest, 'coordinates'>): Promise<ReviewGateCheck>;
  async createPending(request: ReviewGateCreateRequest): Promise<ReviewGateCheck>;
  async createPending(
    coordinatesOrRequest: ReviewGateCoordinates | ReviewGateCreateRequest,
    options: Omit<ReviewGateCreateRequest, 'coordinates'> = {},
  ): Promise<ReviewGateCheck> {
    const request: ReviewGateCreateRequest = 'coordinates' in coordinatesOrRequest
      ? coordinatesOrRequest
      : { coordinates: coordinatesOrRequest, ...options };
    const coordinates = validateCoordinates(request.coordinates);
    const metadata = validateMetadata(request);
    const status = request.status ?? 'queued';
    if (status !== 'queued' && status !== 'in_progress') {
      throw new Error('GitHub Review Yeti gate pending status is invalid');
    }
    const data = await this.request<unknown>(
      `/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}/check-runs`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: REVIEW_GATE_CHECK_NAME,
          head_sha: coordinates.headSha,
          external_id: coordinatesExternalId(coordinates),
          status,
          ...(metadata.detailsUrl ? { details_url: metadata.detailsUrl } : {}),
          output: outputFor(metadata, 'Review Yeti Gate pending', 'Review Yeti has not completed this attempt.'),
        }),
      },
    );
    const created = assertExactIdentity(
      data,
      coordinates,
      this.expectedAppId,
      coordinatesExternalId(coordinates),
      'GitHub Review Yeti gate create response did not match the immutable check identity',
    );
    if (created.status === 'completed' || created.conclusion !== null) {
      throw new Error('GitHub Review Yeti gate create response was terminal');
    }
    return created;
  }

  async updateExisting(request: ReviewGateUpdateRequest): Promise<ReviewGateCheck>;
  async updateExisting(coordinates: ReviewGateCoordinates, checkId: number, update: ReviewGateUpdate): Promise<ReviewGateCheck>;
  async updateExisting(
    coordinatesOrRequest: ReviewGateCoordinates | ReviewGateUpdateRequest,
    checkId?: number,
    update?: ReviewGateUpdate,
  ): Promise<ReviewGateCheck> {
    const request: ReviewGateUpdateRequest = 'coordinates' in coordinatesOrRequest
      ? coordinatesOrRequest
      : { coordinates: coordinatesOrRequest, checkId: checkId as number, update: update as ReviewGateUpdate };
    const coordinates = validateCoordinates(request.coordinates);
    const validCheckId = positiveInteger(request.checkId, 'check id');
    const desired = assertUpdate(request.update);
    const externalId = coordinatesExternalId(coordinates);

    const existing = assertExactIdentity(
      await this.request<unknown>(
        `/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}/check-runs/${validCheckId}`,
        { method: 'GET' },
      ),
      coordinates,
      this.expectedAppId,
      externalId,
      'GitHub Review Yeti gate existing check identity did not match',
    );
    if (existing.id !== validCheckId) throw new Error('GitHub Review Yeti gate existing check id did not match');

    const terminal = 'conclusion' in desired;
    const metadata = validateMetadata(desired);
    const body: Record<string, unknown> = {
      status: terminal ? 'completed' : desired.status,
      ...(terminal ? { conclusion: desired.conclusion, completed_at: new Date().toISOString() } : {}),
      ...(metadata.detailsUrl ? { details_url: metadata.detailsUrl } : {}),
      ...(metadata.title !== undefined || metadata.summary !== undefined
        ? { output: outputFor(metadata, 'Review Yeti Gate', 'Review Yeti gate state updated.') }
        : {}),
    };
    const updated = assertExactIdentity(
      await this.request<unknown>(
        `/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}/check-runs/${existing.id}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      ),
      coordinates,
      this.expectedAppId,
      externalId,
      'GitHub Review Yeti gate update response did not match the immutable check identity',
    );
    if (updated.id !== existing.id
      || updated.status !== (terminal ? 'completed' : desired.status)
      || (terminal && updated.conclusion !== desired.conclusion)) {
      throw new Error('GitHub Review Yeti gate update response did not match the requested state');
    }
    return updated;
  }
}

export { GitHubReviewGateClient as ReviewGateClient };
