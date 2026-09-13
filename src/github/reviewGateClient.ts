import {
  deriveReviewCheckExternalId,
  REVIEW_CI_CHECK_NAME,
  REVIEW_GATE_CHECK_NAME,
  validateCheckRunTitle,
  validateReviewCheckCoordinates,
  type ReviewCheckCoordinates,
  type ReviewCheckName,
  type ReviewCiCheckCoordinates,
  type ReviewGateCheck,
  type ReviewGateObservedConclusion,
  type ReviewGatePendingStatus,
  type ReviewGateTerminalConclusion,
} from '../review/reviewCheckIdentity';
import type { ReviewGateCoordinates } from '../review/reviewGateContracts';
export type { ReviewGateCoordinates } from '../review/reviewGateContracts';
// Backward-compatible exports for the shared typed client surface. Domain
// identity remains owned by reviewCheckIdentity, not this GitHub transport.
export {
  deriveReviewCiCheckExternalId,
  deriveReviewGateExternalId,
  MAX_CHECK_RUN_TITLE_CHARACTERS,
  REVIEW_CI_CHECK_NAME,
  REVIEW_GATE_CHECK_NAME,
  validateCheckRunTitle,
} from '../review/reviewCheckIdentity';
export type {
  ReviewCheckCoordinates,
  ReviewCheckName,
  ReviewCiCheckCoordinates,
  ReviewGateCheck,
  ReviewGateObservedConclusion,
  ReviewGatePendingStatus,
  ReviewGateTerminalConclusion,
} from '../review/reviewCheckIdentity';

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

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
export interface ReviewGateClientOptions {
  /** Trusted service selection only; the review gate remains the default. */
  checkName?: ReviewCheckName;
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

export interface ReviewGateCheckMetadata {
  detailsUrl?: string;
  title?: string;
  summary?: string;
}

export interface ReviewGateCreateRequest extends ReviewGateCheckMetadata {
  coordinates: ReviewGateCoordinates;
  status?: ReviewGatePendingStatus;
}

export interface ReviewCiCheckCreateRequest extends ReviewGateCheckMetadata {
  coordinates: ReviewCiCheckCoordinates;
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

export interface ReviewCiCheckUpdateRequest {
  coordinates: ReviewCiCheckCoordinates;
  checkId: number;
  update: ReviewGateUpdate;
}

export type ReviewCheckUpdateRequest = ReviewGateUpdateRequest | ReviewCiCheckUpdateRequest;

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
  if (metadata.title !== undefined) result.title = validateCheckRunTitle(metadata.title);
  if (metadata.summary !== undefined) result.summary = requiredText(metadata.summary, 'check summary', 65_000);
  return result;
}

function outputFor(
  metadata: ReviewGateCheckMetadata,
  defaultTitle: string,
  defaultSummary: string,
  defaultText?: string,
): Record<string, string> {
  return {
    title: metadata.title ?? defaultTitle,
    summary: metadata.summary ?? defaultSummary,
    ...(defaultText !== undefined ? { text: defaultText } : {}),
  };
}

function checkRunFrom(value: unknown, checkName: ReviewCheckName): ReviewGateCheck | undefined {
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
    || name !== checkName
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
    name: checkName,
    appId: appId as number,
    headSha,
    externalId,
    status,
    conclusion: conclusion === undefined ? null : conclusion as ReviewGateObservedConclusion | null,
    ...(typeof item?.html_url === 'string' ? { htmlUrl: item.html_url } : {}),
  };
}

function hasExactIdentity(
  value: unknown,
  coordinates: ReviewCheckCoordinates,
  expectedAppId: number,
  externalId: string,
  checkName: ReviewCheckName,
): boolean {
  const item = record(value);
  const app = record(item?.app);
  return item?.name === checkName
    && app?.id === expectedAppId
    && item?.head_sha === coordinates.headSha
    && item?.external_id === externalId;
}

function assertExactIdentity(
  value: unknown,
  coordinates: ReviewCheckCoordinates,
  expectedAppId: number,
  externalId: string,
  message: string,
  checkName: ReviewCheckName,
): ReviewGateCheck {
  if (!hasExactIdentity(value, coordinates, expectedAppId, externalId, checkName)) throw new Error(message);
  const check = checkRunFrom(value, checkName);
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
  private readonly checkName: ReviewCheckName;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly expectedAppId: number;
  private readonly timeoutMs: number;
  private readonly reconcileTimeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: ReviewGateClientOptions) {
    this.checkName = options.checkName ?? REVIEW_GATE_CHECK_NAME;
    if ((this.checkName !== REVIEW_GATE_CHECK_NAME && this.checkName !== REVIEW_CI_CHECK_NAME)
      || (this.checkName === REVIEW_CI_CHECK_NAME && options.expectedAppId !== 4385771)) {
      throw new Error('Untrusted service check identity');
    }
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
    if (this.checkName === REVIEW_CI_CHECK_NAME) headers.set('X-GitHub-Api-Version', '2022-11-28');
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

  private async listCheckRuns(coordinates: ReviewCheckCoordinates, deadline: number): Promise<unknown[]> {
    const result: unknown[] = [];
    const seenCheckIds = new Set<number>();
    let totalCount: number | undefined;
    for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error('GitHub Review Yeti gate reconciliation deadline exceeded');
      const data = await this.request<unknown>(
        `/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}/commits/${encodeURIComponent(coordinates.headSha)}/check-runs?check_name=${encodeURIComponent(this.checkName)}&filter=all&per_page=${CHECK_RUN_PAGE_SIZE}&page=${page}`,
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
  private async reconcileCheck(coordinates: ReviewCheckCoordinates): Promise<ReviewGateCheck | null> {
    const normalizedCoordinates = validateReviewCheckCoordinates(coordinates, this.checkName);
    const externalId = deriveReviewCheckExternalId(normalizedCoordinates, this.checkName);
    const deadline = Date.now() + this.reconcileTimeoutMs;
    const matches: ReviewGateCheck[] = [];
    for (const candidate of await this.listCheckRuns(normalizedCoordinates, deadline)) {
      if (!hasExactIdentity(candidate, normalizedCoordinates, this.expectedAppId, externalId, this.checkName)) continue;
      const check = checkRunFrom(candidate, this.checkName);
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
  async reconcile(coordinates: ReviewGateCoordinates): Promise<ReviewGateCheck | null> {
    return this.reconcileCheck(coordinates);
  }

  async reconcileCi(coordinates: ReviewCiCheckCoordinates): Promise<ReviewGateCheck | null> {
    return this.reconcileCheck(coordinates);
  }

  private async createPendingCheck(
    coordinatesOrRequest: ReviewCheckCoordinates | ReviewGateCreateRequest | ReviewCiCheckCreateRequest,
    options: Omit<ReviewGateCreateRequest, 'coordinates'> = {},
  ): Promise<ReviewGateCheck> {
    const request = ('coordinates' in coordinatesOrRequest
      ? coordinatesOrRequest
      : { coordinates: coordinatesOrRequest, ...options }) as ReviewGateCreateRequest | ReviewCiCheckCreateRequest;
    const coordinates = validateReviewCheckCoordinates(request.coordinates, this.checkName);
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
          name: this.checkName,
          head_sha: coordinates.headSha,
          external_id: deriveReviewCheckExternalId(coordinates, this.checkName),
          status,
          ...(metadata.detailsUrl ? { details_url: metadata.detailsUrl } : {}),
          output: outputFor(metadata, `${this.checkName} pending`, 'Review Yeti has not completed this attempt.'),
        }),
      },
    );
    const created = assertExactIdentity(
      data,
      coordinates,
      this.expectedAppId,
      deriveReviewCheckExternalId(coordinates, this.checkName),
      'GitHub Review Yeti gate create response did not match the immutable check identity',
      this.checkName,
    );
    if (created.status === 'completed' || created.conclusion !== null) {
      throw new Error('GitHub Review Yeti gate create response was terminal');
    }
    return created;
  }

  async createPending(coordinates: ReviewGateCoordinates, options?: Omit<ReviewGateCreateRequest, 'coordinates'>): Promise<ReviewGateCheck>;
  async createPending(request: ReviewGateCreateRequest): Promise<ReviewGateCheck>;
  async createPending(
    coordinatesOrRequest: ReviewGateCoordinates | ReviewGateCreateRequest,
    options: Omit<ReviewGateCreateRequest, 'coordinates'> = {},
  ): Promise<ReviewGateCheck> {
    return this.createPendingCheck(coordinatesOrRequest, options);
  }

  async createCiPending(coordinates: ReviewCiCheckCoordinates, options?: Omit<ReviewCiCheckCreateRequest, 'coordinates'>): Promise<ReviewGateCheck>;
  async createCiPending(request: ReviewCiCheckCreateRequest): Promise<ReviewGateCheck>;
  async createCiPending(
    coordinatesOrRequest: ReviewCiCheckCoordinates | ReviewCiCheckCreateRequest,
    options: Omit<ReviewCiCheckCreateRequest, 'coordinates'> = {},
  ): Promise<ReviewGateCheck> {
    return this.createPendingCheck(coordinatesOrRequest, options);
  }

  private async updateExistingCheck(
    coordinatesOrRequest: ReviewCheckCoordinates | ReviewCheckUpdateRequest,
    checkId?: number,
    update?: ReviewGateUpdate,
  ): Promise<ReviewGateCheck> {
    const request = ('coordinates' in coordinatesOrRequest
      ? coordinatesOrRequest
      : { coordinates: coordinatesOrRequest, checkId: checkId as number, update: update as ReviewGateUpdate }) as ReviewCheckUpdateRequest;
    const coordinates = validateReviewCheckCoordinates(request.coordinates, this.checkName);
    const validCheckId = positiveInteger(request.checkId, 'check id');
    const desired = assertUpdate(request.update);
    const externalId = deriveReviewCheckExternalId(coordinates, this.checkName);

    const existing = assertExactIdentity(
      await this.request<unknown>(
        `/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}/check-runs/${validCheckId}`,
        { method: 'GET' },
      ),
      coordinates,
      this.expectedAppId,
      externalId,
      'GitHub Review Yeti gate existing check identity did not match',
      this.checkName,
    );
    if (existing.id !== validCheckId) throw new Error('GitHub Review Yeti gate existing check id did not match');

    const terminal = 'conclusion' in desired;
    const metadata = validateMetadata(desired);
    const body: Record<string, unknown> = {
      status: terminal ? 'completed' : desired.status,
      ...(terminal ? { conclusion: desired.conclusion, completed_at: new Date().toISOString() } : {}),
      ...(metadata.detailsUrl ? { details_url: metadata.detailsUrl } : {}),
      ...(terminal && this.checkName === REVIEW_GATE_CHECK_NAME && desired.conclusion === 'success'
        ? { output: outputFor(
          metadata,
          'Review Yeti Gate: Approved (SHIP)',
          'Review Yeti completed this attempt and the policy eligibility gate passed.',
          'Terminal conclusion: success.',
        ) }
        : metadata.title !== undefined || metadata.summary !== undefined
          ? { output: outputFor(metadata, this.checkName, 'Review Yeti gate state updated.') }
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
      this.checkName,
    );
    if (updated.id !== existing.id
      || updated.status !== (terminal ? 'completed' : desired.status)
      || (terminal && updated.conclusion !== desired.conclusion)) {
      throw new Error('GitHub Review Yeti gate update response did not match the requested state');
    }
    return updated;
  }

  async updateExisting(request: ReviewGateUpdateRequest): Promise<ReviewGateCheck>;
  async updateExisting(coordinates: ReviewGateCoordinates, checkId: number, update: ReviewGateUpdate): Promise<ReviewGateCheck>;
  async updateExisting(
    coordinatesOrRequest: ReviewGateCoordinates | ReviewGateUpdateRequest,
    checkId?: number,
    update?: ReviewGateUpdate,
  ): Promise<ReviewGateCheck> {
    return this.updateExistingCheck(coordinatesOrRequest, checkId, update);
  }

  async updateCiExisting(request: ReviewCiCheckUpdateRequest): Promise<ReviewGateCheck>;
  async updateCiExisting(coordinates: ReviewCiCheckCoordinates, checkId: number, update: ReviewGateUpdate): Promise<ReviewGateCheck>;
  async updateCiExisting(
    coordinatesOrRequest: ReviewCiCheckCoordinates | ReviewCiCheckUpdateRequest,
    checkId?: number,
    update?: ReviewGateUpdate,
  ): Promise<ReviewGateCheck> {
    return this.updateExistingCheck(coordinatesOrRequest, checkId, update);
  }
}

export { GitHubReviewGateClient as ReviewGateClient };
