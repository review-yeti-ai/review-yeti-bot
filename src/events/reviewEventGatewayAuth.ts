import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { reviewEventRunIdSchema } from './reviewEventRunId';

/**
 * Authentication for the event gateway is deliberately independent from the
 * application's permissive dashboard/session middleware.  This module has no
 * session, role, GitHub, or Express dependency: callers must first validate a
 * session and then pass the resulting scoped principal to
 * createReviewEventGrant().
 */

export const REVIEW_EVENT_GATEWAY_GRANT_SCHEMA = 'review-yeti-live-grant.v1' as const;
export const REVIEW_EVENT_GATEWAY_GRANT_ALGORITHM = 'HS256' as const;
export const REVIEW_EVENT_GATEWAY_MAX_GRANT_TTL_SECONDS = 300;
export const REVIEW_EVENT_GATEWAY_DEFAULT_GRANT_TTL_SECONDS = 60;

const LEGACY_PUBLIC_TOKENS = new Set(['demo_token_public', 'public_viewer_token']);
const TOKEN_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[^\u0000-\u001f\u007f\s]{1,256}$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/iu;

export interface ReviewEventIdentity {
  /** Numeric GitHub repository identity, never an owner/repo string alone. */
  repositoryId: number;
  /** The durable review run identity. */
  runId: string;
  /** Exact base revision bound to the run. */
  baseSha: string;
  /** Exact head revision bound to the run. */
  headSha: string;
}

export interface ReviewEventServiceCredential {
  /** Non-secret credential label used for audit metadata. */
  id: string;
  /** SHA-256 digest of the bearer value; raw bearer values are not accepted. */
  tokenDigest: string;
  /** Explicit numeric repository allowlist. */
  repositoryIds: readonly number[];
  /** Optional exact run allowlist. Omitted means any run in repositoryIds. */
  runIds?: readonly string[];
}

/** The minimum scope an already-authenticated application principal must hold. */
export interface ReviewEventScopedPrincipal {
  subject: string;
  repositoryIds: readonly number[];
  runIds?: readonly string[];
}

export interface ReviewEventServicePrincipal extends ReviewEventScopedPrincipal {
  kind: 'service';
}

export interface ReviewEventGrantPrincipal extends ReviewEventScopedPrincipal {
  kind: 'grant';
  identity: ReviewEventIdentity;
  expiresAt: number;
}

export type ReviewEventPrincipal = ReviewEventServicePrincipal | ReviewEventGrantPrincipal;

export type ReviewEventAuthenticationFailureReason = 'missing' | 'invalid' | 'query_token_rejected';

export type ReviewEventAuthentication =
  | { kind: 'unauthenticated'; reason: ReviewEventAuthenticationFailureReason }
  | { kind: 'authenticated'; principal: ReviewEventPrincipal };

export type ReviewEventAuthorization =
  | { kind: 'authorized'; principal: ReviewEventPrincipal }
  | {
      kind: 'authenticated_foreign_run';
      principal: ReviewEventPrincipal;
      reason: 'repository_scope' | 'run_scope' | 'grant_identity_mismatch';
    };

export interface ReviewEventAuthConfigInput {
  serviceCredentials: readonly ReviewEventServiceCredential[];
  /** Dedicated HMAC key shared by the app grant issuer and read-only gateway. */
  grantSecret?: string;
  now?: () => number;
}

export interface ReviewEventAuthConfig {
  readonly serviceCredentials: readonly ReviewEventServiceCredential[];
  readonly grantSecret?: string;
  readonly now: () => number;
}

export interface ReviewEventAuthRequest {
  /** The only accepted bearer transport. */
  authorization?: string | null;
  /** Presence is rejected; credentials never arrive in a URL. */
  queryToken?: string | null;
}

export interface ReviewEventGrant {
  token: string;
  /** NumericDate seconds, matching the signed payload's expires_at claim. */
  expiresAt: number;
  identity: ReviewEventIdentity;
  subject: string;
}

export interface ReviewEventGrantOptions {
  /** Milliseconds since Unix epoch. */
  now?: number;
  ttlSeconds?: number;
}

export interface ReviewEventGrantVerificationOptions {
  /** Milliseconds since Unix epoch. */
  now?: number;
}

export class ReviewEventGatewayAuthConfigError extends Error {
  public readonly name = 'ReviewEventGatewayAuthConfigError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireSafeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
    throw new ReviewEventGatewayAuthConfigError(`${field} must be a bounded non-whitespace identifier`);
  }
  return value;
}

function requireRepositoryId(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ReviewEventGatewayAuthConfigError(`${field} must be a positive numeric repository ID`);
  }
  return value;
}

function requireRunId(value: unknown, field: string): string {
  const parsed = reviewEventRunIdSchema.safeParse(value);
  if (!parsed.success) throw new ReviewEventGatewayAuthConfigError(`${field} must be a canonical durable run ID`);
  return parsed.data;
}

function normalizeRepositoryIds(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ReviewEventGatewayAuthConfigError(`${field} must contain at least one repository ID`);
  }
  const result = Array.from(new Set(value.map((entry) => requireRepositoryId(entry, field))));
  if (result.length === 0) {
    throw new ReviewEventGatewayAuthConfigError(`${field} must contain at least one repository ID`);
  }
  return result;
}

function normalizeRunIds(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ReviewEventGatewayAuthConfigError(`${field} must be omitted or contain at least one run ID`);
  }
  return Array.from(new Set(value.map((entry) => requireRunId(entry, field))));
}

function requireTokenDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TOKEN_DIGEST_PATTERN.test(value)) {
    throw new ReviewEventGatewayAuthConfigError(`${field} must be a lowercase SHA-256 tokenDigest`);
  }
  return value;
}

function requireHmacSecret(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32) {
    throw new ReviewEventGatewayAuthConfigError('grantSecret must contain at least 32 UTF-8 bytes');
  }
  return value;
}

function normalizeCredential(value: unknown, index: number): ReviewEventServiceCredential {
  if (!isRecord(value)) {
    throw new ReviewEventGatewayAuthConfigError(`serviceCredentials[${index}] must be an object`);
  }
  if ('token' in value || 'rawToken' in value || 'raw_token' in value) {
    throw new ReviewEventGatewayAuthConfigError(
      `serviceCredentials[${index}] must provide tokenDigest; raw bearer values are not accepted`,
    );
  }
  const id = requireSafeId(value.id, `serviceCredentials[${index}].id`);
  const tokenDigest = requireTokenDigest(
    value.tokenDigest ?? value.token_digest,
    `serviceCredentials[${index}].tokenDigest`,
  );
  const repositoryIds = normalizeRepositoryIds(
    value.repositoryIds ?? value.repository_ids,
    `serviceCredentials[${index}].repositoryIds`,
  );
  const runIds = normalizeRunIds(value.runIds ?? value.run_ids, `serviceCredentials[${index}].runIds`);
  return Object.freeze({
    id,
    tokenDigest,
    repositoryIds: Object.freeze(repositoryIds),
    ...(runIds ? { runIds: Object.freeze(runIds) } : {}),
  });
}

function normalizeCredentials(value: unknown): ReviewEventServiceCredential[] {
  if (!Array.isArray(value)) {
    throw new ReviewEventGatewayAuthConfigError('serviceCredentials must be a JSON array');
  }
  const credentials = value.map(normalizeCredential);
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const credential of credentials) {
    if (ids.has(credential.id)) {
      throw new ReviewEventGatewayAuthConfigError(`duplicate service credential id: ${credential.id}`);
    }
    if (digests.has(credential.tokenDigest)) {
      throw new ReviewEventGatewayAuthConfigError('duplicate service credential digest');
    }
    ids.add(credential.id);
    digests.add(credential.tokenDigest);
  }
  return credentials;
}

/**
 * Parse the JSON value intended for REVIEW_EVENT_GATEWAY_SERVICE_CREDENTIALS.
 * An absent value produces no credentials, which is fail-closed at request
 * time; a malformed configured value throws so startup cannot look healthy.
 */
export function parseReviewEventServiceCredentials(raw: string | undefined): ReviewEventServiceCredential[] {
  if (raw === undefined || raw.trim() === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReviewEventGatewayAuthConfigError('serviceCredentials must be valid JSON');
  }
  return normalizeCredentials(parsed);
}

/** Validate and freeze configuration before it is used by a server. */
export function createReviewEventAuthConfig(input: ReviewEventAuthConfigInput): ReviewEventAuthConfig {
  if (!isRecord(input)) {
    throw new ReviewEventGatewayAuthConfigError('auth configuration must be an object');
  }
  const serviceCredentials = normalizeCredentials(input.serviceCredentials);
  const grantSecret = input.grantSecret === undefined ? undefined : requireHmacSecret(input.grantSecret);
  return Object.freeze({
    serviceCredentials: Object.freeze(serviceCredentials),
    ...(grantSecret ? { grantSecret } : {}),
    now: input.now ?? Date.now,
  });
}

export function sha256TokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compare variable-length input without an early length-dependent
 * timingSafeEqual call. The padded comparison is followed by an exact-length
 * check, so both bearer digests and HMACs use the same constant-time boundary.
 */
function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.byteLength, right.byteLength);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  paddedLeft.set(left);
  paddedRight.set(right);
  const equal = timingSafeEqual(paddedLeft, paddedRight);
  return left.byteLength === right.byteLength && equal;
}

function constantTimeStringEqual(left: string, right: string): boolean {
  return constantTimeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function hasQueryCredential(value: string | null | undefined): boolean {
  return value !== undefined && value !== null;
}

function authenticatedServicePrincipal(credential: ReviewEventServiceCredential): ReviewEventServicePrincipal {
  return {
    kind: 'service',
    subject: credential.id,
    repositoryIds: credential.repositoryIds,
    ...(credential.runIds ? { runIds: credential.runIds } : {}),
  };
}

/**
 * Authenticate only the explicit gateway transports. Query strings and the
 * legacy public demo values are rejected even if an outer application
 * middleware would otherwise accept them.
 */
export function authenticateReviewEventRequest(
  request: ReviewEventAuthRequest,
  config: ReviewEventAuthConfig,
): ReviewEventAuthentication {
  if (hasQueryCredential(request.queryToken)) {
    return { kind: 'unauthenticated', reason: 'query_token_rejected' };
  }

  const authorization = request.authorization;
  if (authorization === undefined || authorization === null || authorization.length === 0) {
    return { kind: 'unauthenticated', reason: 'missing' };
  }
  const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization);
  if (!match) {
    return { kind: 'unauthenticated', reason: 'invalid' };
  }
  const token = match[1];

  // Always compare against every configured digest before applying the
  // legacy-token rejection. This keeps the credential comparison boundary
  // constant-time and prevents a demo value from becoming configurable.
  const digest = sha256TokenDigest(token);
  let matchedCredential: ReviewEventServiceCredential | undefined;
  for (const credential of config.serviceCredentials) {
    if (constantTimeStringEqual(digest, credential.tokenDigest)) {
      matchedCredential = credential;
    }
  }
  if (matchedCredential && !LEGACY_PUBLIC_TOKENS.has(token)) {
    return { kind: 'authenticated', principal: authenticatedServicePrincipal(matchedCredential) };
  }

  if (config.grantSecret && !LEGACY_PUBLIC_TOKENS.has(token)) {
    const grant = verifyReviewEventGrant(token, config.grantSecret, { now: config.now() });
    if (grant) return { kind: 'authenticated', principal: grant };
  }

  return { kind: 'unauthenticated', reason: 'invalid' };
}

function validateIdentity(value: unknown): ReviewEventIdentity {
  if (!isRecord(value)) {
    throw new ReviewEventGatewayAuthConfigError('grant identity must be an object');
  }
  const repositoryId = requireRepositoryId(value.repositoryId, 'identity.repositoryId');
  const runId = requireRunId(value.runId, 'identity.runId');
  const baseSha = value.baseSha;
  const headSha = value.headSha;
  if (typeof baseSha !== 'string' || !SHA_PATTERN.test(baseSha)) {
    throw new ReviewEventGatewayAuthConfigError('identity.baseSha must be an exact 40-character SHA');
  }
  if (typeof headSha !== 'string' || !SHA_PATTERN.test(headSha)) {
    throw new ReviewEventGatewayAuthConfigError('identity.headSha must be an exact 40-character SHA');
  }
  return { repositoryId, runId, baseSha, headSha };
}

function validateScopedPrincipal(principal: ReviewEventScopedPrincipal): ReviewEventScopedPrincipal {
  if (!isRecord(principal)) {
    throw new ReviewEventGatewayAuthConfigError('scoped principal must be an object');
  }
  const subject = requireSafeId(principal.subject, 'principal.subject');
  const repositoryIds = normalizeRepositoryIds(principal.repositoryIds, 'principal.repositoryIds');
  const runIds = normalizeRunIds(principal.runIds, 'principal.runIds');
  return { subject, repositoryIds, ...(runIds ? { runIds } : {}) };
}

function requireGrantTtl(ttlSeconds: number): number {
  if (!Number.isSafeInteger(ttlSeconds)
    || ttlSeconds < 1
    || ttlSeconds > REVIEW_EVENT_GATEWAY_MAX_GRANT_TTL_SECONDS) {
    throw new ReviewEventGatewayAuthConfigError(
      `ttlSeconds must be an integer from 1 to ${REVIEW_EVENT_GATEWAY_MAX_GRANT_TTL_SECONDS}`,
    );
  }
  return ttlSeconds;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBase64urlJson(value: string): unknown | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > 8192) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function grantMac(secret: string, unsignedToken: string): Buffer {
  return createHmac('sha256', secret).update(unsignedToken, 'utf8').digest();
}

/**
 * Issue a short-lived, single-run grant from an already authenticated
 * principal. The principal must carry a numeric repository scope and, when it
 * carries runIds, the exact run must be included. Base/head are always bound
 * in the signed identity even when the issuer's normal service scope is repo-wide.
 */
export function createReviewEventGrant(
  principal: ReviewEventScopedPrincipal,
  identityInput: ReviewEventIdentity,
  secret: string,
  options: ReviewEventGrantOptions = {},
): ReviewEventGrant {
  const scopedPrincipal = validateScopedPrincipal(principal);
  if ('kind' in principal && principal.kind === 'grant') {
    throw new ReviewEventGatewayAuthConfigError('a grant cannot issue another grant');
  }
  const identity = validateIdentity(identityInput);
  if (!scopedPrincipal.repositoryIds.includes(identity.repositoryId)) {
    throw new ReviewEventGatewayAuthConfigError('principal lacks repository scope for grant identity');
  }
  if (scopedPrincipal.runIds && !scopedPrincipal.runIds.includes(identity.runId)) {
    throw new ReviewEventGatewayAuthConfigError('principal lacks run scope for grant identity');
  }
  const hmacSecret = requireHmacSecret(secret);
  const nowMs = options.now ?? Date.now();
  if (!Number.isFinite(nowMs)) {
    throw new ReviewEventGatewayAuthConfigError('grant clock must be finite');
  }
  const issuedAt = Math.floor(nowMs / 1000);
  const ttlSeconds = requireGrantTtl(options.ttlSeconds ?? REVIEW_EVENT_GATEWAY_DEFAULT_GRANT_TTL_SECONDS);
  const expiresAt = issuedAt + ttlSeconds;
  const header = { alg: REVIEW_EVENT_GATEWAY_GRANT_ALGORITHM, typ: 'JWT' } as const;
  const payload = {
    schema: REVIEW_EVENT_GATEWAY_GRANT_SCHEMA,
    subject: scopedPrincipal.subject,
    repository_id: identity.repositoryId,
    run_id: identity.runId,
    base_sha: identity.baseSha,
    head_sha: identity.headSha,
    issued_at: issuedAt,
    expires_at: expiresAt,
    jti: randomBytes(16).toString('hex'),
  };
  const unsigned = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const token = `${unsigned}.${grantMac(hmacSecret, unsigned).toString('base64url')}`;
  return { token, expiresAt, identity, subject: scopedPrincipal.subject };
}

interface ReviewEventGrantPayload {
  schema: typeof REVIEW_EVENT_GATEWAY_GRANT_SCHEMA;
  subject: string;
  repository_id: number;
  run_id: string;
  base_sha: string;
  head_sha: string;
  issued_at: number;
  expires_at: number;
  jti: string;
}

function parseGrantPayload(value: unknown): ReviewEventGrantPayload | null {
  if (!isRecord(value)
    || value.schema !== REVIEW_EVENT_GATEWAY_GRANT_SCHEMA
    || typeof value.subject !== 'string'
    || typeof value.repository_id !== 'number'
    || typeof value.run_id !== 'string'
    || typeof value.base_sha !== 'string'
    || typeof value.head_sha !== 'string'
    || typeof value.issued_at !== 'number'
    || typeof value.expires_at !== 'number'
    || typeof value.jti !== 'string') {
    return null;
  }
  try {
    const identity = validateIdentity({
      repositoryId: value.repository_id,
      runId: value.run_id,
      baseSha: value.base_sha,
      headSha: value.head_sha,
    });
    requireSafeId(value.subject, 'grant.subject');
    requireSafeId(value.jti, 'grant.jti');
    if (!Number.isSafeInteger(value.issued_at) || !Number.isSafeInteger(value.expires_at)) return null;
    if (value.expires_at <= value.issued_at) return null;
    if (value.expires_at - value.issued_at > REVIEW_EVENT_GATEWAY_MAX_GRANT_TTL_SECONDS) return null;
    return {
      schema: REVIEW_EVENT_GATEWAY_GRANT_SCHEMA,
      subject: value.subject,
      repository_id: identity.repositoryId,
      run_id: identity.runId,
      base_sha: identity.baseSha,
      head_sha: identity.headSha,
      issued_at: value.issued_at,
      expires_at: value.expires_at,
      jti: value.jti,
    };
  } catch {
    return null;
  }
}

/** Return null for every malformed, forged, wrong-secret, or expired grant. */
export function verifyReviewEventGrant(
  token: string,
  secret: string,
  options: ReviewEventGrantVerificationOptions = {},
): ReviewEventGrantPrincipal | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 16_384) return null;
  let hmacSecret: string;
  try {
    hmacSecret = requireHmacSecret(secret);
  } catch {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encodedSignature)) return null;
  const expectedMac = grantMac(hmacSecret, `${encodedHeader}.${encodedPayload}`);
  let suppliedMac: Buffer;
  try {
    suppliedMac = Buffer.from(encodedSignature, 'base64url');
  } catch {
    suppliedMac = Buffer.alloc(0);
  }
  const macMatches = constantTimeEqual(suppliedMac, expectedMac);
  if (!macMatches || suppliedMac.toString('base64url') !== encodedSignature) return null;

  const header = decodeBase64urlJson(encodedHeader);
  if (!isRecord(header) || header.alg !== REVIEW_EVENT_GATEWAY_GRANT_ALGORITHM || header.typ !== 'JWT') {
    return null;
  }
  const payload = parseGrantPayload(decodeBase64urlJson(encodedPayload));
  if (!payload) return null;
  const nowMs = options.now ?? Date.now();
  if (!Number.isFinite(nowMs)) return null;
  const nowSeconds = Math.floor(nowMs / 1000);
  if (payload.issued_at > nowSeconds + 5 || payload.expires_at <= nowSeconds) return null;

  const identity: ReviewEventIdentity = {
    repositoryId: payload.repository_id,
    runId: payload.run_id,
    baseSha: payload.base_sha,
    headSha: payload.head_sha,
  };
  return {
    kind: 'grant',
    subject: payload.subject,
    repositoryIds: [identity.repositoryId],
    runIds: [identity.runId],
    identity,
    expiresAt: payload.expires_at,
  };
}

/**
 * Apply a principal's scope after the authoritative run identity has been
 * loaded. A valid principal with a foreign scope remains distinguishable from
 * a missing/invalid principal so HTTP callers can use 404 versus 401.
 */
export function authorizeReviewEventAccess(
  principal: ReviewEventPrincipal,
  identityInput: ReviewEventIdentity,
): ReviewEventAuthorization {
  let identity: ReviewEventIdentity;
  try {
    identity = validateIdentity(identityInput);
  } catch {
    return {
      kind: 'authenticated_foreign_run',
      principal,
      reason: 'grant_identity_mismatch',
    };
  }

  if (principal.kind === 'grant') {
    const exact = principal.identity.repositoryId === identity.repositoryId
      && principal.identity.runId === identity.runId
      && principal.identity.baseSha === identity.baseSha
      && principal.identity.headSha === identity.headSha;
    return exact
      ? { kind: 'authorized', principal }
      : { kind: 'authenticated_foreign_run', principal, reason: 'grant_identity_mismatch' };
  }

  if (!principal.repositoryIds.includes(identity.repositoryId)) {
    return { kind: 'authenticated_foreign_run', principal, reason: 'repository_scope' };
  }
  if (principal.runIds && !principal.runIds.includes(identity.runId)) {
    return { kind: 'authenticated_foreign_run', principal, reason: 'run_scope' };
  }
  return { kind: 'authorized', principal };
}
