import type { Env, ReviewRunSpec } from './types.js';
import {
  assertNoBlockingPriorOutcome,
} from './operatorPriorOutcome.js';
import {
  deriveGateExternalId,
  deriveWorkerExternalId,
  REVIEW_GATE_CHECK_NAME,
  REVIEW_WORKER_CHECK_NAME,
  signGitHubAppJwt,
} from './github/index.js';
import type {
  OperatorPassthroughCheckReceipt,
  OperatorPassthroughIdentity,
  OperatorPassthroughPolicyIdentity,
  OperatorPassthroughPolicySource,
  OperatorPassthroughReceipt,
  OperatorPassthroughResult,
  OperatorPassthroughState,
  OperatorPassthroughTarget,
} from './operatorPassthroughTypes.js';
import {
  AUTHORITATIVE_REVIEW_APP_ID,
  PUBLIC_REVIEW_APP_ID,
  isPublicReviewRepository,
  reviewAppIdForRepository,
} from './reviewAppAuthority.js';
import { fetchRepositoriesFromDb } from './storage/d1Client.js';

const APP_ID = AUTHORITATIVE_REVIEW_APP_ID;
const DEADLINE_MS = 15_000;
const POLICY_MAX_BYTES = 256 * 1024;
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/u;
const SHA_RE = /^[a-f0-9]{40}$/iu;
const DIGEST_RE = /^[a-f0-9]{64}$/u;
const REVIEW_TITLE = 'Review Yeti: SHIP (passthrough: no review performed)';
const GATE_TITLE = 'Review Yeti Gate: SHIP (passthrough: no review performed)';
const PASSTHROUGH_EXTERNAL_SUFFIX = ':review-mode=passthrough:op2';
const SUMMARY_SENTENCE = 'review-mode=passthrough. Operator SHIP disposition; no semantic review was run; zero lanes were started.';

type Stage = 'review' | 'gate';
type ErrorCode =
  | 'pause_binding_unavailable'
  | 'service_configuration_unavailable'
  | 'app_identity_unavailable'
  | 'repository_not_enrolled'
  | 'current_repository_unavailable'
  | 'current_pr_unavailable'
  | 'current_candidate_changed'
  | 'policy_source_unavailable'
  | 'policy_not_current'
  | 'authoritative_read_unavailable'
  | 'durable_state_unavailable'
  | 'prior_outcome_unavailable'
  | 'prior_semantic_block'
  | 'prior_do_unavailable'
  | 'prior_do_identity_mismatch'
  | 'prior_outcome_unknown'
  | 'prior_review_active'
  | 'prior_queue_state_unavailable'
  | 'prior_review_state_unavailable'
  | 'prior_review_history_incomplete'
  | 'prior_check_state_unavailable'
  | 'prior_check_history_incomplete'
  | 'prior_check_identity_unverified'
  | 'prior_check_pair_incomplete'
  | 'prior_check_metadata_unavailable'
  | 'prior_semantic_findings'
  | 'prior_semantic_outcome_unknown'
  | 'check_publication_unavailable'
  | 'check_identity_unverified'
  | 'check_readback_unavailable'
  | 'check_summary_unverified'
  | 'audit_unavailable'
  | 'cancel_requested'
  | 'deadline_exceeded';

class PassthroughUnavailable extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = 'PassthroughUnavailable';
  }
}

export interface OperatorPassthroughOptions {
  /** Test seam. Production callers use the Edge fetch implementation. */
  fetchFn?: typeof fetch;
  /** Test seam; production always uses the fixed 15 second contract. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface RepositoryIdentity {
  repositoryId: number;
  owner: string;
  repo: string;
  appId: number;
}

interface CurrentCandidate extends OperatorPassthroughTarget {
  repositoryId: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  open: true;
  draft: false;
  isPrivate: boolean;
}

interface CurrentPolicy {
  identity: OperatorPassthroughPolicyIdentity;
  policyDigest: string;
}

interface PublishedCheck extends OperatorPassthroughCheckReceipt {
  annotationsCount: 0;
}

interface DeadlineContext {
  signal: AbortSignal;
  sourceRunId?: string;
  deadlineAt: number;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  run<T>(operation: () => Promise<T>): Promise<T>;
  guard(): Promise<void>;
  dispose(): void;
}

function unavailable(code: ErrorCode): never {
  throw new PassthroughUnavailable(code);
}

function safeName(value: unknown): value is string {
  return typeof value === 'string' && NAME_RE.test(value) && value !== '.' && value !== '..';
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function stableJson(value: unknown, depth = 0, nodeCount = { value: 0 }): string {
  nodeCount.value += 1;
  if (nodeCount.value > 16_384 || depth > 32) unavailable('policy_source_unavailable');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((child) => stableJson(child, depth + 1, nodeCount)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key], depth + 1, nodeCount)}`).join(',')}}`;
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function makeDeadline(env: Env, options: OperatorPassthroughOptions, sourceRunId?: string): DeadlineContext {
  const timeoutMs = options.timeoutMs ?? DEADLINE_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEADLINE_MS) {
    unavailable('service_configuration_unavailable');
  }
  const controller = new AbortController();
  const deadlineAt = performance.now() + timeoutMs;
  let endedBy: 'caller' | 'deadline' | undefined;
  const fromCaller = () => {
    if (endedBy === undefined) endedBy = 'caller';
    controller.abort();
  };
  options.signal?.addEventListener('abort', fromCaller, { once: true });
  if (options.signal?.aborted) fromCaller();
  const timer = setTimeout(() => {
    if (endedBy === undefined) endedBy = 'deadline';
    controller.abort();
  }, timeoutMs);

  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (controller.signal.aborted || performance.now() >= deadlineAt) {
      unavailable(endedBy === 'caller' ? 'cancel_requested' : 'deadline_exceeded');
    }
    const operationPromise = Promise.resolve().then(() => {
      if (controller.signal.aborted || performance.now() >= deadlineAt) {
        unavailable(endedBy === 'caller' ? 'cancel_requested' : 'deadline_exceeded');
      }
      return operation();
    });
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new PassthroughUnavailable(endedBy === 'caller' ? 'cancel_requested' : 'deadline_exceeded'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const result = await Promise.race([operationPromise, aborted]);
      if (controller.signal.aborted || performance.now() >= deadlineAt) {
        unavailable(endedBy === 'caller' ? 'cancel_requested' : 'deadline_exceeded');
      }
      return result;
    } catch (error) {
      if (error instanceof PassthroughUnavailable) throw error;
      if (controller.signal.aborted || performance.now() >= deadlineAt) {
        unavailable(endedBy === 'caller' ? 'cancel_requested' : 'deadline_exceeded');
      }
      throw error;
    } finally {
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  };

  const guard = async (): Promise<void> => {
    if (controller.signal.aborted || performance.now() >= deadlineAt) {
      unavailable(endedBy === 'caller' ? 'cancel_requested' : 'deadline_exceeded');
    }
    if (!sourceRunId) return;
    if (!/^run_[A-Za-z0-9_-]{1,128}$/u.test(sourceRunId)
      || !env.REVIEW_RUN?.idFromName || !env.REVIEW_RUN?.get) unavailable('durable_state_unavailable');
    const source = env.REVIEW_RUN.get(env.REVIEW_RUN.idFromName(sourceRunId));
    const response = await run(() => source.fetch('http://do/status'));
    if (!response.ok) unavailable('durable_state_unavailable');
    const status = await run(() => response.json()) as any;
    if (status.cancelRequested || status.phase === 'Cancelled') unavailable('cancel_requested');
  };

  const fetchImplementation = options.fetchFn || fetch;
  return {
    signal: controller.signal,
    sourceRunId,
    deadlineAt,
    run,
    guard,
    fetch: (url, init = {}) => run(async () => {
      await guard();
      return fetchImplementation(url, { ...init, signal: controller.signal });
    }),
    dispose: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', fromCaller);
      controller.abort();
    },
  };
}

function parseTarget(input: OperatorPassthroughTarget): OperatorPassthroughTarget {
  if (!isRecord(input) || !exactKeys(input, ['owner', 'repo', 'prNumber'])
    || !safeName(input.owner) || !safeName(input.repo)
    || !Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) {
    unavailable('authoritative_read_unavailable');
  }
  return { owner: input.owner, repo: input.repo, prNumber: input.prNumber };
}

function parseRepositoryIdentities(env: Env): RepositoryIdentity[] {
  const raw = env.OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES;
  if (typeof raw !== 'string' || raw.length === 0 || new TextEncoder().encode(raw).byteLength > 8_192) {
    unavailable('service_configuration_unavailable');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { unavailable('service_configuration_unavailable'); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) unavailable('service_configuration_unavailable');
  const ids = new Set<number>();
  const names = new Set<string>();
  const identities: RepositoryIdentity[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry) || !exactKeys(entry, ['repositoryId', 'owner', 'repo'])
      || !Number.isSafeInteger(entry.repositoryId) || Number(entry.repositoryId) <= 0
      || !safeName(entry.owner) || !safeName(entry.repo)) unavailable('service_configuration_unavailable');
    const baseIdentity = { repositoryId: Number(entry.repositoryId), owner: entry.owner as string, repo: entry.repo as string };
    let appId: number;
    try { appId = reviewAppIdForRepository(baseIdentity); }
    catch { unavailable('service_configuration_unavailable'); }
    const identity: RepositoryIdentity = { ...baseIdentity, appId };
    const name = `${identity.owner}/${identity.repo}`.toLowerCase();
    if (ids.has(identity.repositoryId) || names.has(name)) unavailable('service_configuration_unavailable');
    ids.add(identity.repositoryId);
    names.add(name);
    identities.push(identity);
  }
  return identities;
}

export async function resolveRepositoryIdentities(
  env: Env,
  context?: DeadlineContext
): Promise<RepositoryIdentity[]> {
  const staticIdentities = parseRepositoryIdentities(env);
  const names = new Set<string>(staticIdentities.map((i) => `${i.owner}/${i.repo}`.toLowerCase()));
  const ids = new Set<number>(staticIdentities.map((i) => i.repositoryId));
  const merged: RepositoryIdentity[] = [...staticIdentities];

  try {
    const fetchPromise = fetchRepositoriesFromDb(env.DB, { passthroughOnly: true });
    const dbRepos = await (context ? context.run(() => fetchPromise) : fetchPromise);
    for (const record of dbRepos) {
      if (record.passthroughEnabled === false) continue;
      const name = `${record.owner}/${record.repo}`.toLowerCase();
      if (names.has(name)) continue;
      const baseIdentity = {
        repositoryId: record.repositoryId ?? 0,
        owner: record.owner,
        repo: record.repo,
      };
      let appId: number;
      try {
        appId = reviewAppIdForRepository(baseIdentity);
      } catch {
        continue;
      }
      const identity: RepositoryIdentity = { ...baseIdentity, appId };
      names.add(name);
      if (identity.repositoryId > 0) {
        ids.add(identity.repositoryId);
      }
      merged.push(identity);
    }
  } catch {
    // If DB is not available or throws, preserve static identities
  }

  return merged;
}

function parsePolicySource(env: Env): OperatorPassthroughPolicySource {
  const raw = env.OPERATOR_PASSTHROUGH_POLICY_SOURCE;
  if (typeof raw !== 'string' || raw.length === 0 || new TextEncoder().encode(raw).byteLength > 8_192) {
    unavailable('service_configuration_unavailable');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { unavailable('service_configuration_unavailable'); }
  if (!isRecord(parsed) || !exactKeys(parsed, ['repositoryId', 'owner', 'repo', 'ref', 'path'])
    || !Number.isSafeInteger(parsed.repositoryId) || Number(parsed.repositoryId) <= 0
    || !safeName(parsed.owner) || !safeName(parsed.repo)
    || parsed.ref !== 'main'
    || typeof parsed.path !== 'string' || parsed.path !== 'policy/review-yeti.json') {
    unavailable('service_configuration_unavailable');
  }
  return {
    repositoryId: Number(parsed.repositoryId),
    owner: parsed.owner as string,
    repo: parsed.repo as string,
    ref: parsed.ref,
    path: parsed.path,
  };
}

function requireServiceApp(env: Env, appId: number): { appId: number; privateKey: string } {
  const isPublicApp = appId === PUBLIC_REVIEW_APP_ID;
  const configuredId = isPublicApp ? env.REVIEW_YETI_PUBLIC_TARGET_APP_ID : env.GITHUB_APP_ID;
  const privateKey = isPublicApp ? env.REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY : env.GITHUB_APP_PRIVATE_KEY;
  if (Number(configuredId) !== appId || typeof privateKey !== 'string' || !privateKey.trim()) {
    unavailable('app_identity_unavailable');
  }
  return { appId, privateKey };
}

async function readJson(context: DeadlineContext, url: string, token: string, code: ErrorCode): Promise<any> {
  const response = await context.fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'review-yeti-cf-orchestrator',
    },
  });
  if (!response.ok) unavailable(code);
  try { return await context.run(() => response.json()); } catch (error) {
    if (error instanceof PassthroughUnavailable) throw error;
    unavailable(code);
  }
}

async function scopedInstallationToken(
  env: Env,
  owner: string,
  repo: string,
  appId: number,
  context: DeadlineContext
): Promise<string> {
  const { privateKey } = requireServiceApp(env, appId);
  const cacheKey = `operator-passthrough-v2:${appId}:${owner.toLowerCase()}/${repo.toLowerCase()}`;
  if (env.AUTH_CACHE?.get) {
    try {
      const cached = await context.run(() => env.AUTH_CACHE.get(cacheKey));
      if (typeof cached === 'string' && cached.startsWith('ghs_') && !cached.startsWith('ghs_dummy_')
        && !cached.startsWith('ghs_ephemeral_')) return cached;
    } catch (error) {
      if (error instanceof PassthroughUnavailable) throw error;
      // A cache miss or cache outage does not change the service-owned app identity.
    }
  }

  let jwt: string;
  try { jwt = await context.run(() => signGitHubAppJwt(String(appId), privateKey)); }
  catch (error) {
    if (error instanceof PassthroughUnavailable) throw error;
    unavailable('app_identity_unavailable');
  }
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const installation = await readJson(context,
    `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/installation`, jwt,
    owner === 'calltelemetry' && repo === 'ct-review-actions' ? 'policy_source_unavailable' : 'app_identity_unavailable');
  const installationId = Number(installation?.id);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    unavailable(owner === 'calltelemetry' && repo === 'ct-review-actions' ? 'policy_source_unavailable' : 'app_identity_unavailable');
  }
  const tokenResponse = await context.fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'review-yeti-cf-orchestrator',
    },
    body: JSON.stringify({ repositories: [repo] }),
  });
  if (!tokenResponse.ok) unavailable(owner === 'calltelemetry' && repo === 'ct-review-actions' ? 'policy_source_unavailable' : 'app_identity_unavailable');
  let tokenData: any;
  try { tokenData = await context.run(() => tokenResponse.json()); }
  catch (error) {
    if (error instanceof PassthroughUnavailable) throw error;
    unavailable('app_identity_unavailable');
  }
  const token = tokenData?.token;
  if (typeof token !== 'string' || !token.startsWith('ghs_') || token.startsWith('ghs_dummy_')
    || token.startsWith('ghs_ephemeral_')) unavailable('app_identity_unavailable');
  if (env.AUTH_CACHE?.put) {
    try { await context.run(() => env.AUTH_CACHE.put(cacheKey, token, { expirationTtl: 3_000 })); }
    catch (error) {
      if (error instanceof PassthroughUnavailable) throw error;
      // Cache persistence is optional; the scoped token is already valid for this operation.
    }
  }
  return token;
}

async function currentCandidate(
  target: OperatorPassthroughTarget,
  identities: RepositoryIdentity[],
  token: string,
  context: DeadlineContext
): Promise<CurrentCandidate> {
  const expected = identities.find((identity) =>
    `${identity.owner}/${identity.repo}`.toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase());
  if (!expected) unavailable('repository_not_enrolled');
  const base = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const repository = await readJson(context, base, token, 'current_repository_unavailable');
  const repositoryId = Number(repository?.id);
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0
    || (expected.repositoryId > 0 && repositoryId !== expected.repositoryId)
    || owner !== expected.owner || repo !== expected.repo
    || String(repository.full_name || '').toLowerCase() !== `${expected.owner}/${expected.repo}`.toLowerCase()) {
    unavailable('repository_not_enrolled');
  }
  if (expected.repositoryId === 0) {
    expected.repositoryId = repositoryId;
  }
  if (typeof repository.private !== 'boolean') unavailable('current_repository_unavailable');
  if (isPublicReviewRepository(expected) && repository.private !== false) unavailable('current_candidate_changed');
  const pull = await readJson(context, `${base}/pulls/${target.prNumber}`, token, 'current_pr_unavailable');
  const headSha = pull?.head?.sha;
  const baseSha = pull?.base?.sha;
  const baseRef = pull?.base?.ref;
  if (pull?.number !== target.prNumber || pull?.state !== 'open' || pull?.draft !== false
    || Number(pull?.base?.repo?.id) !== repositoryId || !SHA_RE.test(headSha || '')
    || !SHA_RE.test(baseSha || '') || typeof baseRef !== 'string' || !/^[A-Za-z0-9_./-]{1,256}$/u.test(baseRef)) {
    unavailable('current_candidate_changed');
  }
  return {
    owner,
    repo,
    prNumber: target.prNumber,
    repositoryId,
    headSha: headSha.toLowerCase(),
    baseSha: baseSha.toLowerCase(),
    baseRef,
    open: true,
    draft: false,
    isPrivate: repository.private,
  };
}

function base64Utf8(encoded: string): string {
  let binary: string;
  try { binary = atob(encoded.replace(/\s+/gu, '')); }
  catch { unavailable('policy_source_unavailable'); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { unavailable('policy_source_unavailable'); }
}

async function currentPolicy(
  candidate: CurrentCandidate,
  source: OperatorPassthroughPolicySource,
  token: string,
  context: DeadlineContext
): Promise<CurrentPolicy> {
  const base = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;
  const repository = await readJson(context, base, token, 'policy_source_unavailable');
  if (Number(repository?.id) !== source.repositoryId || repository?.full_name !== `${source.owner}/${source.repo}`
    || repository?.default_branch !== source.ref) unavailable('policy_not_current');
  const commit = await readJson(context, `${base}/commits/${encodeURIComponent(source.ref)}`, token, 'policy_source_unavailable');
  const revision = commit?.sha;
  if (!SHA_RE.test(revision || '')) unavailable('policy_source_unavailable');
  const contentResponse = await readJson(context,
    `${base}/contents/${source.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(revision)}`,
    token, 'policy_source_unavailable');
  if (contentResponse?.path !== source.path || contentResponse?.encoding !== 'base64'
    || typeof contentResponse?.content !== 'string') unavailable('policy_source_unavailable');
  const content = base64Utf8(contentResponse.content);
  if (new TextEncoder().encode(content).byteLength > POLICY_MAX_BYTES) unavailable('policy_source_unavailable');
  let policy: unknown;
  try { policy = JSON.parse(content); } catch { unavailable('policy_source_unavailable'); }
  const policySchema = isRecord(policy) ? policy.schema : undefined;
  if (!isRecord(policy) || typeof policySchema !== 'string'
    || !/^[a-z0-9][a-z0-9-]*\.review-policy\.v1$/u.test(policySchema)
    || !isRecord(policy.review_yeti)
    || typeof policy.review_yeti.personas !== 'string' || !policy.review_yeti.personas.trim()
    || policy.review_yeti.personas.length > 2_000) {
    unavailable('policy_source_unavailable');
  }
  const reviewPolicy = policy.review_yeti;
  if ((reviewPolicy.profile !== undefined && !['chill', 'balanced', 'assertive'].includes(reviewPolicy.profile))
    || (reviewPolicy.severity_policy !== undefined && reviewPolicy.severity_policy !== 'review-yeti-severity.v2')
    || !isRecord(reviewPolicy.budget)
    || !Number.isSafeInteger(reviewPolicy.budget.max_investigation_turns)
    || reviewPolicy.budget.max_investigation_turns < 1 || reviewPolicy.budget.max_investigation_turns > 100
    || (reviewPolicy.budget.max_reviewed_lockfile_patch_chars !== undefined
      && (!Number.isSafeInteger(reviewPolicy.budget.max_reviewed_lockfile_patch_chars)
        || reviewPolicy.budget.max_reviewed_lockfile_patch_chars < 20_000
        || reviewPolicy.budget.max_reviewed_lockfile_patch_chars > 65_536))) {
    unavailable('policy_source_unavailable');
  }
  const overrides = policy.repository_overrides === undefined ? {} : policy.repository_overrides;
  if (!isRecord(overrides)) unavailable('policy_source_unavailable');
  if (Object.keys(overrides).some((name) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(name))) {
    unavailable('policy_source_unavailable');
  }
  const targetName = `${candidate.owner}/${candidate.repo}`.toLowerCase();
  const matchingOverrides = Object.entries(overrides)
    .filter(([name]) => name.toLowerCase() === targetName);
  if (matchingOverrides.length > 1 || (matchingOverrides[0] && !isRecord(matchingOverrides[0][1]))) {
    unavailable('policy_source_unavailable');
  }
  const selectedOverride = matchingOverrides[0]?.[1] as Record<string, unknown> | undefined;
  if (selectedOverride?.severity_policy !== undefined
    && selectedOverride.severity_policy !== 'review-yeti-severity.v2') unavailable('policy_source_unavailable');
  const policyIdentity: OperatorPassthroughPolicyIdentity = {
    ...source,
    sha: revision.toLowerCase(),
    contentDigest: await digest(content),
  };
  const policyDigest = await digest(stableJson({
    version: 'OperatorPassthroughEffectivePolicy.v1',
    targetRepository: { repositoryId: candidate.repositoryId, owner: candidate.owner, repo: candidate.repo },
    source: policyIdentity,
    effectivePolicy: {
      policyContentDigest: policyIdentity.contentDigest,
      selectedRepositoryOverride: selectedOverride ?? null,
    },
  }));
  return { identity: policyIdentity, policyDigest };
}

async function policyRevisionIsCurrent(
  source: OperatorPassthroughPolicySource,
  expected: OperatorPassthroughPolicyIdentity,
  token: string,
  context: DeadlineContext
): Promise<boolean> {
  const base = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;
  const repository = await readJson(context, base, token, 'policy_source_unavailable');
  if (Number(repository?.id) !== source.repositoryId || repository?.full_name !== `${source.owner}/${source.repo}`
    || repository?.default_branch !== source.ref) return false;
  const commit = await readJson(context, `${base}/commits/${encodeURIComponent(source.ref)}`, token, 'policy_source_unavailable');
  return typeof commit?.sha === 'string' && commit.sha.toLowerCase() === expected.sha;
}

async function shaIdentity(identity: OperatorPassthroughIdentity): Promise<{ publicationId: string; runId: string }> {
  const publicationId = await digest(stableJson(identity));
  return { publicationId, runId: `run_${publicationId.slice(0, 32)}` };
}

function sameCandidate(left: CurrentCandidate, right: CurrentCandidate): boolean {
  return left.repositoryId === right.repositoryId && left.owner === right.owner && left.repo === right.repo
    && left.prNumber === right.prNumber && left.headSha === right.headSha && left.baseSha === right.baseSha
    && left.baseRef === right.baseRef && left.open === right.open && left.draft === right.draft
    && left.isPrivate === right.isPrivate;
}

function identityFrom(candidate: CurrentCandidate, policy: CurrentPolicy): OperatorPassthroughIdentity {
  return {
    version: 'OperatorPassthroughIdentity.v2',
    repositoryId: candidate.repositoryId,
    owner: candidate.owner,
    repo: candidate.repo,
    prNumber: candidate.prNumber,
    headSha: candidate.headSha,
    baseSha: candidate.baseSha,
    baseRef: candidate.baseRef,
    isPrivate: candidate.isPrivate,
    appId: reviewAppIdForRepository(candidate),
    policyDigest: policy.policyDigest,
    policySource: policy.identity,
  };
}

function reviewSpec(identity: OperatorPassthroughIdentity, runId: string): ReviewRunSpec {
  return {
    runId,
    owner: identity.owner,
    repo: identity.repo,
    prNumber: identity.prNumber,
    headSha: identity.headSha,
    baseSha: identity.baseSha,
    installationId: 0,
    publicationMode: 'publishing',
  };
}

function checkExternalId(stage: Stage, runId: string, identity: OperatorPassthroughIdentity): Promise<string> {
  if (stage === 'review') return Promise.resolve(deriveWorkerExternalId(runId, 1));
  return deriveGateExternalId({ owner: identity.owner, repo: identity.repo, headSha: identity.headSha, runId, executionAttempt: 1 });
}

function checkTitle(stage: Stage): string { return stage === 'review' ? REVIEW_TITLE : GATE_TITLE; }
function checkName(stage: Stage): typeof REVIEW_WORKER_CHECK_NAME | typeof REVIEW_GATE_CHECK_NAME {
  return stage === 'review' ? REVIEW_WORKER_CHECK_NAME : REVIEW_GATE_CHECK_NAME;
}

function checkSummary(identity: OperatorPassthroughIdentity, runId: string, publicationId: string, auditDigest: string): string {
  return [
    SUMMARY_SENTENCE,
    `Publication ID: ${publicationId}`,
    `Audit digest: ${auditDigest}`,
    `Repository: ${identity.owner}/${identity.repo} (ID ${identity.repositoryId})`,
    `Pull request: #${identity.prNumber}`,
    `Head: ${identity.headSha}`,
    `Base: ${identity.baseSha} (${identity.baseRef})`,
    `Current policy digest: ${identity.policyDigest}`,
    `Policy source: ${identity.policySource.owner}/${identity.policySource.repo}@${identity.policySource.sha}:${identity.policySource.path}`,
    `Review run identity: ${runId}`,
  ].join('\n');
}

async function externalIds(identity: OperatorPassthroughIdentity, runId: string): Promise<{ worker: string; gate: string }> {
  return {
    worker: `${await checkExternalId('review', runId, identity)}${PASSTHROUGH_EXTERNAL_SUFFIX}`,
    gate: `${await checkExternalId('gate', runId, identity)}${PASSTHROUGH_EXTERNAL_SUFFIX}`,
  };
}

function checkIdentityMatches(
  check: any,
  stage: Stage,
  identity: OperatorPassthroughIdentity,
  externalId: string,
  auditDigest: string
): PublishedCheck {
  const name = checkName(stage);
  if (!isRecord(check) || !Number.isSafeInteger(Number(check.id)) || Number(check.id) <= 0
    || Number(check.app?.id) !== identity.appId || check.name !== name || check.external_id !== externalId
    || String(check.head_sha || '').toLowerCase() !== identity.headSha
    || !isRecord(check.output) || typeof check.output.title !== 'string' || typeof check.output.summary !== 'string') {
    unavailable('check_identity_unverified');
  }
  const summaryText = check.output.summary as string;
  const annotationsCount = check.output.annotations_count;
  if (!Number.isSafeInteger(annotationsCount) || annotationsCount < 0 || annotationsCount > 0) {
    unavailable('check_summary_unverified');
  }
  if (!summaryText.includes(SUMMARY_SENTENCE) || !summaryText.includes(`Current policy digest: ${identity.policyDigest}`)
    || !summaryText.includes(`Head: ${identity.headSha}`) || !summaryText.includes(`Base: ${identity.baseSha}`)) {
    unavailable('check_summary_unverified');
  }
  if (auditDigest && !summaryText.includes(`Audit digest: ${auditDigest}`)) unavailable('check_summary_unverified');
  const status = check.status;
  const conclusion = check.conclusion;
  if (status !== 'in_progress' && status !== 'completed') unavailable('check_identity_unverified');
  if (status === 'completed' && conclusion !== 'success' && conclusion !== 'failure') unavailable('check_identity_unverified');
  return {
    id: Number(check.id),
    appId: Number(check.app.id),
    name,
    externalId,
    headSha: identity.headSha,
    status,
    conclusion: conclusion ?? null,
    title: String(check.output.title),
    summary: summaryText,
    annotationsCount: 0,
  } as PublishedCheck;
}

async function computeAuditDigest(
  identity: OperatorPassthroughIdentity,
  publicationId: string,
  runId: string,
  priorControlRunIds: string[],
  externalIdPair: { worker: string; gate: string }
): Promise<string> {
  return digest(stableJson({
    version: 'OperatorPassthroughAudit.v1',
    identity,
    publicationId,
    runId,
    priorControlRunIds,
    checks: {
      worker: { appId: identity.appId, name: REVIEW_WORKER_CHECK_NAME, externalId: externalIdPair.worker },
      gate: { appId: identity.appId, name: REVIEW_GATE_CHECK_NAME, externalId: externalIdPair.gate },
    },
    reviewStarted: false,
    expectedLanes: 0,
    completedLanes: 0,
  }));
}

function githubHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'review-yeti-cf-orchestrator' };
}

async function listChecks(
  identity: OperatorPassthroughIdentity,
  token: string,
  context: DeadlineContext
): Promise<any[]> {
  const all: any[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = `https://api.github.com/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}`
      + `/commits/${encodeURIComponent(identity.headSha)}/check-runs?filter=all&per_page=100&page=${page}`;
    const response = await context.fetch(url, { headers: githubHeaders(token) });
    if (!response.ok) unavailable('check_readback_unavailable');
    const payload = await context.run(() => response.json()) as any;
    if (!Array.isArray(payload?.check_runs) || !Number.isSafeInteger(payload.total_count)) unavailable('check_readback_unavailable');
    all.push(...payload.check_runs);
    const next = response.headers.get('Link')?.includes('rel="next"') === true;
    if (!next) {
      if (payload.total_count > all.length) unavailable('check_readback_unavailable');
      return all;
    }
  }
  unavailable('check_readback_unavailable');
}

function findCheckByExternalId(
  checks: any[],
  stage: Stage,
  identity: OperatorPassthroughIdentity,
  externalId: string,
  auditDigest: string
): PublishedCheck | null {
  const matching = checks.filter((check) => check?.external_id === externalId);
  if (matching.length === 0) return null;
  if (matching.length !== 1) unavailable('check_identity_unverified');
  return checkIdentityMatches(matching[0], stage, identity, externalId, auditDigest);
}

async function getCheckById(
  id: number,
  stage: Stage,
  identity: OperatorPassthroughIdentity,
  externalId: string,
  auditDigest: string,
  token: string,
  context: DeadlineContext
): Promise<PublishedCheck> {
  const response = await context.fetch(`https://api.github.com/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}/check-runs/${id}`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) unavailable('check_readback_unavailable');
  const check = await context.run(() => response.json());
  return checkIdentityMatches(check, stage, identity, externalId, auditDigest);
}

function doStub(env: Env, runId: string) {
  if (!env.REVIEW_RUN?.idFromName || !env.REVIEW_RUN?.get) unavailable('durable_state_unavailable');
  return env.REVIEW_RUN.get(env.REVIEW_RUN.idFromName(runId));
}

async function doRequest<T>(
  env: Env,
  runId: string,
  path: string,
  method: 'GET' | 'POST',
  context: DeadlineContext,
  body?: unknown
): Promise<T> {
  const stub = doStub(env, runId);
  let response: Response;
  try {
    await context.guard();
    response = await context.run(() => stub.fetch(`http://do${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    }));
  } catch (error) {
    if (error instanceof PassthroughUnavailable) throw error;
    unavailable('durable_state_unavailable');
  }
  if (!response.ok) unavailable('durable_state_unavailable');
  try { return await context.run(() => response.json()) as T; }
  catch (error) {
    if (error instanceof PassthroughUnavailable) throw error;
    unavailable('durable_state_unavailable');
  }
}

async function readDurableState(env: Env, runId: string, context: DeadlineContext): Promise<{
  state: OperatorPassthroughState | null;
  link: string | null;
}> {
  const result = await doRequest<{ state?: OperatorPassthroughState | null; link?: string | null }>(
    env, runId, '/operator-passthrough/read', 'GET', context);
  return { state: result.state ?? null, link: result.link ?? null };
}

function stateMatches(state: OperatorPassthroughState | null, identity: OperatorPassthroughIdentity,
  publicationId: string, runId: string): state is OperatorPassthroughState {
  return !!state && state.version === 'OperatorPassthroughState.v2' && state.runId === runId
    && state.publicationId === publicationId && stableJson(state.identity) === stableJson(identity);
}

async function readDurableSuccessReceipt(
  env: Env,
  context: DeadlineContext,
  identity: OperatorPassthroughIdentity,
  runId: string,
  publicationId: string,
  expected: OperatorPassthroughReceipt
): Promise<OperatorPassthroughReceipt> {
  const readback = await readDurableState(env, runId, context);
  if (!stateMatches(readback.state, identity, publicationId, runId)) unavailable('audit_unavailable');
  if (readback.state.cancelRequested) unavailable('cancel_requested');
  const receipt = readback.state.receipt;
  if (!receipt || receipt.status !== 'succeeded' || !receipt.mergeEligible || receipt.publicationState !== 'published'
    || receipt.runId !== runId || receipt.publicationId !== publicationId
    || receipt.repositoryId !== identity.repositoryId || receipt.owner !== identity.owner || receipt.repo !== identity.repo
    || receipt.prNumber !== identity.prNumber || receipt.headSha !== identity.headSha || receipt.baseSha !== identity.baseSha
    || receipt.appId !== identity.appId || receipt.policyDigest !== identity.policyDigest
    || receipt.auditDigest !== expected.auditDigest || receipt.workerCheckId !== expected.workerCheckId
    || receipt.gateCheckId !== expected.gateCheckId || receipt.mergeEligible !== true) unavailable('audit_unavailable');
  return receipt;
}

function failureReceipt(
  identity: OperatorPassthroughIdentity | null,
  runId: string | null,
  publicationId: string | null,
  errorCode: ErrorCode,
  state: OperatorPassthroughState | null = null,
  publicationReceiptAvailable = false
): OperatorPassthroughReceipt | null {
  if (!identity || !runId || !publicationId) return null;
  return {
    version: 'OperatorPassthroughReceipt.v2',
    status: 'unavailable',
    reason: 'operator_global_passthrough',
    errorCode,
    runId,
    publicationId,
    repositoryId: identity.repositoryId,
    owner: identity.owner,
    repo: identity.repo,
    prNumber: identity.prNumber,
    headSha: identity.headSha,
    baseSha: identity.baseSha,
    baseRef: identity.baseRef,
    appId: identity.appId,
    policyDigest: identity.policyDigest,
    policySource: identity.policySource,
    reviewStarted: false,
    expectedLanes: 0,
    completedLanes: 0,
    candidateState: 'current',
    verdict: 'unavailable',
    publicationState: 'unavailable',
    publicationReceiptAvailable,
    publicationIdempotent: true,
    auditDigest: null,
    workerCheckId: state?.stages.review.checkId ?? null,
    gateCheckId: state?.stages.gate.checkId ?? null,
    priorControlRunIds: state?.priorControlRunIds ?? [],
    findingsCount: 0,
    mergeEligible: false,
    recordedAt: new Date().toISOString(),
  };
}

function responseFromReceipt(receipt: OperatorPassthroughReceipt | null, fallbackCode: ErrorCode = 'authoritative_read_unavailable'): OperatorPassthroughResult {
  if (!receipt) {
    return {
      version: 'OperatorPassthroughReceipt.v2' as const,
      status: 'unavailable' as const,
      reason: 'operator_global_passthrough' as const,
      errorCode: fallbackCode,
      runId: null,
      publicationId: null,
      repositoryId: null,
      owner: null,
      repo: null,
      prNumber: null,
      headSha: null,
      baseSha: null,
      baseRef: null,
      appId: 0,
      policyDigest: null,
      policySource: null,
      reviewStarted: false as const,
      expectedLanes: 0 as const,
      completedLanes: 0 as const,
      candidateState: 'unavailable' as const,
      verdict: 'unavailable' as const,
      publicationState: 'unavailable' as const,
      publicationReceiptAvailable: false,
      publicationIdempotent: true as const,
      auditDigest: null,
      workerCheckId: null,
      gateCheckId: null,
      priorControlRunIds: [],
      findingsCount: 0 as const,
      mergeEligible: false,
    };
  }
  return receipt;
}

async function persistFailure(
  env: Env,
  context: DeadlineContext,
  identity: OperatorPassthroughIdentity | null,
  runId: string | null,
  publicationId: string | null,
  errorCode: ErrorCode,
  state: OperatorPassthroughState | null
): Promise<OperatorPassthroughReceipt | null> {
  const receipt = failureReceipt(identity, runId, publicationId, errorCode, state, false);
  if (!receipt || !stateMatches(state, identity!, publicationId!, runId!)) return receipt;
  try {
    const saved = await doRequest<{ accepted?: boolean }>(env, runId!, '/operator-passthrough/receipt', 'POST', context, {
      version: 'OperatorPassthroughReceiptWrite.v1', publicationId, receipt,
    });
    if (!saved.accepted) return receipt;
    const readback = await readDurableState(env, runId!, context);
    if (!stateMatches(readback.state, identity!, publicationId!, runId!)
      || stableJson(readback.state.receipt) !== stableJson({ ...receipt, publicationReceiptAvailable: true })) {
      // The stored receipt has publicationReceiptAvailable=false because the storage
      // readback itself is the proof. Update it once after the actual read succeeds.
      const confirmed = { ...receipt, publicationReceiptAvailable: true };
      const second = await doRequest<{ accepted?: boolean }>(env, runId!, '/operator-passthrough/receipt', 'POST', context, {
        version: 'OperatorPassthroughReceiptWrite.v1', publicationId, receipt: confirmed,
      });
      if (!second.accepted) return receipt;
      const verified = await readDurableState(env, runId!, context);
      if (!stateMatches(verified.state, identity!, publicationId!, runId!)
        || stableJson(verified.state.receipt) !== stableJson(confirmed)) return receipt;
      return confirmed;
    }
    return receipt;
  } catch {
    return receipt;
  }
}

async function verifyCheckPair(
  identity: OperatorPassthroughIdentity,
  runId: string,
  publicationId: string,
  auditDigest: string,
  reviewCheckId: number,
  gateCheckId: number,
  token: string,
  context: DeadlineContext
): Promise<{ worker: PublishedCheck; gate: PublishedCheck }> {
  const external = await externalIds(identity, runId);
  const listed = await listChecks(identity, token, context);
  const workerByExternal = findCheckByExternalId(listed, 'review', identity, external.worker, auditDigest);
  const gateByExternal = findCheckByExternalId(listed, 'gate', identity, external.gate, auditDigest);
  if (!workerByExternal || !gateByExternal || workerByExternal.id !== reviewCheckId || gateByExternal.id !== gateCheckId) {
    unavailable('check_readback_unavailable');
  }
  const worker = await getCheckById(reviewCheckId, 'review', identity, external.worker, auditDigest, token, context);
  const gate = await getCheckById(gateCheckId, 'gate', identity, external.gate, auditDigest, token, context);
  if (worker.status !== 'completed' || worker.conclusion !== 'success'
    || gate.status !== 'completed' || gate.conclusion !== 'success'
    || worker.annotationsCount !== 0 || gate.annotationsCount !== 0
    || worker.title !== REVIEW_TITLE || gate.title !== GATE_TITLE) unavailable('check_readback_unavailable');
  const expectedSummary = checkSummary(identity, runId, publicationId, auditDigest);
  if (worker.summary !== expectedSummary || gate.summary !== expectedSummary) unavailable('check_summary_unverified');
  return { worker, gate };
}

async function loadExistingCheck(
  env: Env,
  runId: string,
  publicationId: string,
  identity: OperatorPassthroughIdentity,
  stage: Stage,
  externalId: string,
  auditDigest: string,
  token: string,
  context: DeadlineContext,
  state: OperatorPassthroughState
): Promise<PublishedCheck> {
  const checkId = state.stages[stage].checkId;
  if (checkId !== null) return getCheckById(checkId, stage, identity, externalId, auditDigest, token, context);

  const listed = await listChecks(identity, token, context);
  const match = findCheckByExternalId(listed, stage, identity, externalId, auditDigest);
  const mutation = await doRequest<{ accepted?: boolean; action?: string; reason?: string; state?: OperatorPassthroughState }>(
    env, runId, '/operator-passthrough/stage', 'POST', context,
    { version: 'OperatorPassthroughStageMutation.v1', publicationId, stage, action: 'create-start' });
  if (!mutation.accepted) unavailable(mutation.reason === 'cancel_requested' ? 'cancel_requested' : 'durable_state_unavailable');
  if (match) {
    const bound = await doRequest<{ accepted?: boolean; state?: OperatorPassthroughState }>(
      env, runId, '/operator-passthrough/stage', 'POST', context,
      { version: 'OperatorPassthroughStageMutation.v1', publicationId, stage, action: 'created', checkId: match.id });
    if (!bound.accepted) unavailable('durable_state_unavailable');
    return match;
  }
  if (mutation.action !== 'create') unavailable('check_readback_unavailable');

  const summary = checkSummary(identity, runId, publicationId, auditDigest);
  const response = await context.fetch(`https://api.github.com/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}/check-runs`, {
    method: 'POST',
    headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: checkName(stage),
      head_sha: identity.headSha,
      external_id: externalId,
      status: 'in_progress',
      output: { title: checkTitle(stage), summary },
    }),
  });
  let created: PublishedCheck | null = null;
  if (response.ok) {
    try {
      const raw = await context.run(() => response.json());
      created = checkIdentityMatches(raw, stage, identity, externalId, auditDigest);
    } catch (error) {
      if (error instanceof PassthroughUnavailable) throw error;
    }
  }
  if (!created) {
    // A lost/failed POST acknowledgement is ambiguous. Reconcile the stable external
    // identity and never repeat the POST for a stage already marked `creating`.
    const reconciled = findCheckByExternalId(await listChecks(identity, token, context), stage, identity, externalId, auditDigest);
    if (!reconciled) unavailable('check_publication_unavailable');
    created = reconciled;
  }
  const bound = await doRequest<{ accepted?: boolean }>(env, runId, '/operator-passthrough/stage', 'POST', context, {
    version: 'OperatorPassthroughStageMutation.v1', publicationId, stage, action: 'created', checkId: created.id,
  });
  if (!bound.accepted) unavailable('durable_state_unavailable');
  return created;
}

async function completeCheck(
  env: Env,
  runId: string,
  publicationId: string,
  identity: OperatorPassthroughIdentity,
  stage: Stage,
  externalId: string,
  auditDigest: string,
  check: PublishedCheck,
  token: string,
  context: DeadlineContext
): Promise<void> {
  const expectedSummary = checkSummary(identity, runId, publicationId, auditDigest);
  const current = await getCheckById(check.id, stage, identity, externalId, auditDigest, token, context);
  if (current.status === 'completed') {
    if (current.conclusion !== 'success' || current.title !== checkTitle(stage) || current.summary !== expectedSummary
      || current.annotationsCount !== 0) unavailable('check_publication_unavailable');
    const marked = await doRequest<{ accepted?: boolean }>(env, runId, '/operator-passthrough/stage', 'POST', context, {
      version: 'OperatorPassthroughStageMutation.v1', publicationId, stage, action: 'patched', checkId: check.id,
    });
    if (!marked.accepted) unavailable('durable_state_unavailable');
    return;
  }
  const reservation = await doRequest<{ accepted?: boolean; action?: string; reason?: string }>(env, runId,
    '/operator-passthrough/stage', 'POST', context,
    { version: 'OperatorPassthroughStageMutation.v1', publicationId, stage, action: 'patch-start', checkId: check.id });
  if (!reservation.accepted) unavailable(reservation.reason === 'cancel_requested' ? 'cancel_requested' : 'durable_state_unavailable');
  const response = await context.fetch(`https://api.github.com/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}/check-runs/${check.id}`, {
    method: 'PATCH',
    headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'completed',
      conclusion: 'success',
      output: { title: checkTitle(stage), summary: expectedSummary },
    }),
  });
  let updated: PublishedCheck | null = null;
  if (response.ok) {
    try { updated = checkIdentityMatches(await context.run(() => response.json()), stage, identity, externalId, auditDigest); }
    catch (error) { if (error instanceof PassthroughUnavailable) throw error; }
  }
  if (!updated || updated.status !== 'completed' || updated.conclusion !== 'success'
    || updated.title !== checkTitle(stage) || updated.summary !== expectedSummary || updated.annotationsCount !== 0) {
    // A partial PATCH is retryable because the durable check id is known; a second
    // attempt updates that same check and is never permitted to create another one.
    try {
      updated = await getCheckById(check.id, stage, identity, externalId, auditDigest, token, context);
    } catch { unavailable('check_publication_unavailable'); }
  }
  if (!updated) unavailable('check_publication_unavailable');
  if (updated.status !== 'completed' || updated.conclusion !== 'success'
    || updated.title !== checkTitle(stage) || updated.summary !== expectedSummary || updated.annotationsCount !== 0) {
    unavailable('check_publication_unavailable');
  }
  const marked = await doRequest<{ accepted?: boolean; reason?: string }>(env, runId, '/operator-passthrough/stage', 'POST', context, {
    version: 'OperatorPassthroughStageMutation.v1', publicationId, stage, action: 'patched', checkId: check.id,
  });
  if (!marked.accepted) unavailable(marked.reason === 'cancel_requested' ? 'cancel_requested' : 'durable_state_unavailable');
}

async function writeReceiptAndReadBack(
  env: Env,
  context: DeadlineContext,
  identity: OperatorPassthroughIdentity,
  runId: string,
  publicationId: string,
  receipt: OperatorPassthroughReceipt,
  priorControlRunIds: string[],
  token: string
): Promise<OperatorPassthroughReceipt> {
  const saved = await doRequest<{ accepted?: boolean }>(env, runId, '/operator-passthrough/receipt', 'POST', context, {
    version: 'OperatorPassthroughReceiptWrite.v1', publicationId, receipt,
  });
  if (!saved.accepted) unavailable('audit_unavailable');
  const readback = await readDurableState(env, runId, context);
  if (!stateMatches(readback.state, identity, publicationId, runId)
    || readback.state.receipt?.status !== 'succeeded'
    || readback.state.receipt.auditDigest !== receipt.auditDigest
    || readback.state.receipt.workerCheckId !== receipt.workerCheckId
    || readback.state.receipt.gateCheckId !== receipt.gateCheckId
    || readback.state.receipt.policyDigest !== identity.policyDigest
    || !readback.state.receipt.mergeEligible) unavailable('audit_unavailable');
  if (readback.state.cancelRequested) unavailable('cancel_requested');
  await assertPriorOutcomeUnchanged(env, identity, readback.state, priorControlRunIds, token, context);
  return readDurableSuccessReceipt(env, context, identity, runId, publicationId, receipt);
}

async function resolveIdentity(
  env: Env,
  target: OperatorPassthroughTarget,
  context: DeadlineContext
): Promise<{ candidate: CurrentCandidate; identity: OperatorPassthroughIdentity; runId: string; publicationId: string; token: string; policyToken: string; source: OperatorPassthroughPolicySource }> {
  if (env.OPERATOR_GLOBAL_PASSTHROUGH !== 'true') unavailable('pause_binding_unavailable');
  const requested = parseTarget(target);
  const identities = await resolveRepositoryIdentities(env, context);
  const source = parsePolicySource(env);
  const enrolledByName = identities.find((entry) =>
    `${entry.owner}/${entry.repo}`.toLowerCase() === `${requested.owner}/${requested.repo}`.toLowerCase());
  if (!enrolledByName) unavailable('repository_not_enrolled');
  const token = await scopedInstallationToken(env, enrolledByName.owner, enrolledByName.repo, enrolledByName.appId, context);
  const candidate = await currentCandidate(requested, identities, token, context);
  const sourceAppId = reviewAppIdForRepository(source);
  const policyToken = await scopedInstallationToken(env, source.owner, source.repo, sourceAppId, context);
  const policy = await currentPolicy(candidate, source, policyToken, context);
  const identity = identityFrom(candidate, policy);
  const derived = await shaIdentity(identity);
  return { candidate, identity, runId: derived.runId, publicationId: derived.publicationId, token, policyToken, source };
}

async function currentCoordinatesStillMatch(
  env: Env,
  candidate: CurrentCandidate,
  identity: OperatorPassthroughIdentity,
  targetToken: string,
  policyToken: string,
  source: OperatorPassthroughPolicySource,
  context: DeadlineContext
): Promise<boolean> {
  if (env.OPERATOR_GLOBAL_PASSTHROUGH !== 'true') return false;
  const identities = await resolveRepositoryIdentities(env, context);
  const current = await currentCandidate({ owner: candidate.owner, repo: candidate.repo, prNumber: candidate.prNumber },
    identities, targetToken, context);
  if (!sameCandidate(candidate, current)) return false;
  return policyRevisionIsCurrent(source, identity.policySource, policyToken, context);
}

async function recheckCurrentPriorOutcome(
  env: Env,
  identity: OperatorPassthroughIdentity,
  state: OperatorPassthroughState,
  token: string,
  context: DeadlineContext
): Promise<string[]> {
  const external = await externalIds(identity, state.runId);
  try {
    return await context.run(() => assertNoBlockingPriorOutcome(
      env,
      reviewSpec(identity, state.runId),
      token,
      identity.appId,
      context.fetch as unknown as typeof fetch,
      {
        allowCurrentPublisherTerminal: true,
        currentPassthroughChecks: {
          appId: identity.appId,
          workerExternalId: external.worker,
          gateExternalId: external.gate,
        },
        sourceRunId: state.sourceRunId,
      },
    ));
  } catch (error) {
    if (error instanceof PassthroughUnavailable) throw error;
    const code = error instanceof Error && /^prior_[a-z_]+$/u.test(error.message)
      ? error.message as ErrorCode : 'prior_outcome_unavailable';
    unavailable(code);
  }
}

async function assertPriorOutcomeUnchanged(
  env: Env,
  identity: OperatorPassthroughIdentity,
  state: OperatorPassthroughState,
  expectedRunIds: string[],
  token: string,
  context: DeadlineContext
): Promise<void> {
  const current = await recheckCurrentPriorOutcome(env, identity, state, token, context);
  if (stableJson(current) !== stableJson(expectedRunIds)) unavailable('prior_outcome_unavailable');
}

async function reserveAndCheckPriorOutcome(
  env: Env,
  identity: OperatorPassthroughIdentity,
  runId: string,
  publicationId: string,
  token: string,
  context: DeadlineContext
): Promise<{ state: OperatorPassthroughState; priorControlRunIds: string[] }> {
  const spec = reviewSpec(identity, runId);
  await context.guard();
  const initResponse = await context.run(() => doStub(env, runId).fetch('http://do/init', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec),
  }));
  if (!initResponse.ok) unavailable('durable_state_unavailable');
  const initialized = await context.run(() => initResponse.json()) as any;
  const durableSpec = initialized?.state?.spec;
  if (durableSpec?.runId !== runId || durableSpec?.owner !== identity.owner || durableSpec?.repo !== identity.repo
    || durableSpec?.prNumber !== identity.prNumber || durableSpec?.headSha !== identity.headSha
    || durableSpec?.baseSha !== identity.baseSha || initialized?.state?.cancelRequested
    || initialized?.state?.phase === 'Cancelled') unavailable('durable_state_unavailable');

  const reservation = await doRequest<{ accepted?: boolean; reason?: string; state?: OperatorPassthroughState }>(env, runId,
    '/operator-passthrough/reserve', 'POST', context,
    { version: 'OperatorPassthroughReservation.v1', runId, publicationId, identity, sourceRunId: context.sourceRunId || null });
  if (!reservation.accepted || !stateMatches(reservation.state ?? null, identity, publicationId, runId)) {
    unavailable(reservation.reason === 'cancel_requested' ? 'cancel_requested' : 'durable_state_unavailable');
  }
  let state = reservation.state!;
  if (state.cancelRequested || initialized?.state?.cancelRequested) unavailable('cancel_requested');
  const priorControlRunIds = await recheckCurrentPriorOutcome(env, identity, state, token, context);
  if (state.priorOutcomeChecked) {
    if (stableJson(priorControlRunIds) !== stableJson(state.priorControlRunIds)) unavailable('prior_outcome_unavailable');
    return { state, priorControlRunIds: state.priorControlRunIds };
  }
  const admitted = await doRequest<{ accepted?: boolean; state?: OperatorPassthroughState }>(env, runId,
    '/operator-passthrough/admission', 'POST', context,
    { version: 'OperatorPassthroughAdmission.v1', publicationId, priorControlRunIds });
  if (!admitted.accepted || !stateMatches(admitted.state ?? null, identity, publicationId, runId)
    || !admitted.state?.priorOutcomeChecked) unavailable('durable_state_unavailable');
  state = admitted.state;
  return { state, priorControlRunIds: state.priorControlRunIds };
}

function verifyExpectedCandidate(
  candidate: CurrentCandidate,
  expected?: Partial<Pick<CurrentCandidate, 'headSha' | 'baseSha'>>
): void {
  if (!expected) return;
  if ((expected.headSha && expected.headSha.toLowerCase() !== candidate.headSha)
    || (expected.baseSha && expected.baseSha.toLowerCase() !== candidate.baseSha)) {
    unavailable('current_candidate_changed');
  }
}

async function makeSuccessReceipt(
  identity: OperatorPassthroughIdentity,
  runId: string,
  publicationId: string,
  auditDigest: string,
  priorControlRunIds: string[],
  checks: { worker: PublishedCheck; gate: PublishedCheck }
): Promise<OperatorPassthroughReceipt> {
  const toReceiptCheck = (check: PublishedCheck): OperatorPassthroughCheckReceipt => ({
    id: check.id,
    appId: check.appId,
    name: check.name,
    externalId: check.externalId,
    headSha: check.headSha,
    status: 'completed',
    conclusion: 'success',
    annotationsCount: check.annotationsCount as 0,
    title: check.title,
    summary: check.summary,
  });
  return {
    version: 'OperatorPassthroughReceipt.v2',
    status: 'succeeded',
    reason: 'operator_global_passthrough',
    runId,
    publicationId,
    repositoryId: identity.repositoryId,
    owner: identity.owner,
    repo: identity.repo,
    prNumber: identity.prNumber,
    headSha: identity.headSha,
    baseSha: identity.baseSha,
    baseRef: identity.baseRef,
    appId: identity.appId,
    policyDigest: identity.policyDigest,
    policySource: identity.policySource,
    reviewStarted: false,
    expectedLanes: 0,
    completedLanes: 0,
    candidateState: 'current',
    verdict: 'SHIP',
    publicationState: 'published',
    publicationReceiptAvailable: true,
    publicationIdempotent: true,
    auditDigest,
    workerCheckId: checks.worker.id,
    gateCheckId: checks.gate.id,
    checks: { worker: toReceiptCheck(checks.worker), gate: toReceiptCheck(checks.gate) },
    priorControlRunIds,
    findingsCount: 0,
    mergeEligible: true,
    recordedAt: new Date().toISOString(),
  };
}

async function readPublishedWithContext(
  env: Env,
  resolved: Awaited<ReturnType<typeof resolveIdentity>>,
  context: DeadlineContext,
  expected?: Partial<Pick<CurrentCandidate, 'headSha' | 'baseSha'>>
): Promise<OperatorPassthroughResult> {
  verifyExpectedCandidate(resolved.candidate, expected);
  const durable = await readDurableState(env, resolved.runId, context);
  const state = durable.state;
  if (!stateMatches(state, resolved.identity, resolved.publicationId, resolved.runId)) {
    return responseFromReceipt(failureReceipt(resolved.identity, resolved.runId, resolved.publicationId,
      'durable_state_unavailable', state), 'durable_state_unavailable');
  }
  if (state.cancelRequested) {
    return failureReceipt(resolved.identity, resolved.runId, resolved.publicationId, 'cancel_requested', state)!;
  }
  const receipt = state.receipt;
  if (!receipt || receipt.status !== 'succeeded' || !receipt.mergeEligible || receipt.publicationState !== 'published'
    || receipt.appId !== resolved.identity.appId || receipt.policyDigest !== resolved.identity.policyDigest
    || receipt.auditDigest === null || receipt.workerCheckId === null || receipt.gateCheckId === null) {
    return failureReceipt(resolved.identity, resolved.runId, resolved.publicationId,
      'check_readback_unavailable', state, true)!;
  }
  const pair = await verifyCheckPair(resolved.identity, resolved.runId, resolved.publicationId, receipt.auditDigest,
    receipt.workerCheckId, receipt.gateCheckId, resolved.token, context);
  if (!await currentCoordinatesStillMatch(env, resolved.candidate, resolved.identity, resolved.token,
    resolved.policyToken, resolved.source, context)) {
    return failureReceipt(resolved.identity, resolved.runId, resolved.publicationId, 'current_candidate_changed', state, true)!;
  }
  const currentDurable = await readDurableState(env, resolved.runId, context);
  if (!stateMatches(currentDurable.state, resolved.identity, resolved.publicationId, resolved.runId)) {
    return failureReceipt(resolved.identity, resolved.runId, resolved.publicationId, 'audit_unavailable', currentDurable.state, false)!;
  }
  if (currentDurable.state.cancelRequested) {
    return failureReceipt(resolved.identity, resolved.runId, resolved.publicationId, 'cancel_requested', currentDurable.state, false)!;
  }
  if (currentDurable.state.receipt?.auditDigest !== receipt.auditDigest
    || currentDurable.state.receipt?.workerCheckId !== pair.worker.id
    || currentDurable.state.receipt?.gateCheckId !== pair.gate.id
    || currentDurable.state.receipt?.mergeEligible !== true) {
    return failureReceipt(resolved.identity, resolved.runId, resolved.publicationId, 'audit_unavailable', currentDurable.state, false)!;
  }
  try {
    await assertPriorOutcomeUnchanged(env, resolved.identity, currentDurable.state!,
      currentDurable.state!.priorControlRunIds, resolved.token, context);
  } catch (error) {
    const code = error instanceof PassthroughUnavailable ? error.code : 'prior_outcome_unavailable';
    return failureReceipt(resolved.identity, resolved.runId, resolved.publicationId, code, currentDurable.state, true)!;
  }
  try {
    return await readDurableSuccessReceipt(env, context, resolved.identity, resolved.runId, resolved.publicationId, receipt);
  } catch (error) {
    const code = error instanceof PassthroughUnavailable ? error.code : 'durable_state_unavailable';
    return failureReceipt(resolved.identity, resolved.runId, resolved.publicationId, code, null, false)!;
  }
}

async function publishWithContext(
  env: Env,
  target: OperatorPassthroughTarget,
  context: DeadlineContext,
  expected?: Partial<Pick<CurrentCandidate, 'headSha' | 'baseSha'>>
): Promise<OperatorPassthroughResult> {
  let identity: OperatorPassthroughIdentity | null = null;
  let runId: string | null = null;
  let publicationId: string | null = null;
  let durableState: OperatorPassthroughState | null = null;
  try {
    const resolved = await resolveIdentity(env, parseTarget(target), context);
    ({ identity, runId, publicationId } = resolved);
    verifyExpectedCandidate(resolved.candidate, expected);
    const admission = await reserveAndCheckPriorOutcome(env, identity, runId, publicationId, resolved.token, context);
    durableState = admission.state;
    if (durableState.cancelRequested) unavailable('cancel_requested');
    if (durableState.receipt?.status === 'succeeded') {
      return await readPublishedWithContext(env, resolved, context, expected);
    }

    const external = await externalIds(identity, runId);
    const auditDigest = await computeAuditDigest(identity, publicationId, runId, admission.priorControlRunIds, external);
    const worker = await loadExistingCheck(env, runId, publicationId, identity, 'review', external.worker,
      auditDigest, resolved.token, context, durableState);
    const afterWorker = await readDurableState(env, runId, context);
    durableState = afterWorker.state;
    if (!stateMatches(durableState, identity, publicationId, runId) || durableState.cancelRequested) unavailable('cancel_requested');

    const gate = await loadExistingCheck(env, runId, publicationId, identity, 'gate', external.gate,
      auditDigest, resolved.token, context, durableState);
    const afterGate = await readDurableState(env, runId, context);
    durableState = afterGate.state;
    if (!stateMatches(durableState, identity, publicationId, runId) || durableState.cancelRequested) unavailable('cancel_requested');

    await completeCheck(env, runId, publicationId, identity, 'review', external.worker, auditDigest, worker, resolved.token, context);
    await completeCheck(env, runId, publicationId, identity, 'gate', external.gate, auditDigest, gate, resolved.token, context);
    const pair = await verifyCheckPair(identity, runId, publicationId, auditDigest, worker.id, gate.id, resolved.token, context);

    if (!await currentCoordinatesStillMatch(env, resolved.candidate, identity, resolved.token,
      resolved.policyToken, resolved.source, context)) unavailable('current_candidate_changed');
    const preReceipt = await readDurableState(env, runId, context);
    if (!stateMatches(preReceipt.state, identity, publicationId, runId) || preReceipt.state.cancelRequested) unavailable('cancel_requested');

    const success = await makeSuccessReceipt(identity, runId, publicationId, auditDigest,
      admission.priorControlRunIds, pair);
    return await writeReceiptAndReadBack(env, context, identity, runId, publicationId, success,
      admission.priorControlRunIds, resolved.token);
  } catch (error) {
    const errorCode: ErrorCode = error instanceof PassthroughUnavailable
      ? error.code
      : (error instanceof Error && error.message === 'prior_semantic_block' ? 'prior_semantic_block' : 'authoritative_read_unavailable');
    const failed = await persistFailure(env, context, identity, runId, publicationId, errorCode, durableState);
    return responseFromReceipt(failed || failureReceipt(identity, runId, publicationId, errorCode, durableState), errorCode);
  }
}

async function readForTargetWithContext(
  env: Env,
  target: OperatorPassthroughTarget,
  context: DeadlineContext,
  expected?: Partial<Pick<CurrentCandidate, 'headSha' | 'baseSha'>>
): Promise<OperatorPassthroughResult> {
  try {
    const resolved = await resolveIdentity(env, parseTarget(target), context);
    return await readPublishedWithContext(env, resolved, context, expected);
  } catch (error) {
    const errorCode: ErrorCode = error instanceof PassthroughUnavailable ? error.code : 'authoritative_read_unavailable';
    return responseFromReceipt(null, errorCode);
  }
}

async function publishOperatorPassthroughForTargetInternal(
  env: Env,
  target: OperatorPassthroughTarget,
  options: OperatorPassthroughOptions = {},
  expected?: Partial<Pick<CurrentCandidate, 'headSha' | 'baseSha'>>,
  sourceRunId?: string
): Promise<OperatorPassthroughResult> {
  const context = makeDeadline(env, options, sourceRunId);
  try { return await publishWithContext(env, target, context, expected); }
  catch (error) {
    const code = error instanceof PassthroughUnavailable ? error.code : 'authoritative_read_unavailable';
    return responseFromReceipt(null, code);
  } finally { context.dispose(); }
}

export async function publishOperatorPassthroughForTarget(
  env: Env,
  target: OperatorPassthroughTarget,
  options: OperatorPassthroughOptions = {},
  expected?: Partial<Pick<CurrentCandidate, 'headSha' | 'baseSha'>>
): Promise<OperatorPassthroughResult> {
  return publishOperatorPassthroughForTargetInternal(env, target, options, expected);
}

export async function readOperatorPassthroughForTarget(
  env: Env,
  target: OperatorPassthroughTarget,
  expected?: Partial<Pick<CurrentCandidate, 'headSha' | 'baseSha'>>,
  options: OperatorPassthroughOptions = {}
): Promise<OperatorPassthroughResult> {
  const context = makeDeadline(env, options);
  try { return await readForTargetWithContext(env, target, context, expected); }
  catch (error) {
    const code = error instanceof PassthroughUnavailable ? error.code : 'authoritative_read_unavailable';
    return responseFromReceipt(null, code);
  } finally { context.dispose(); }
}

async function readByRunIdWithContext(
  env: Env,
  runId: string,
  context: DeadlineContext,
  depth = 0
): Promise<OperatorPassthroughResult | null> {
  if (depth > 1 || !/^run_[A-Za-z0-9_-]{1,128}$/u.test(runId)) return null;
  const stored = await readDurableState(env, runId, context);
  if (stored.link && stored.link !== runId) {
    const sourceStatusResponse = await context.run(() => doStub(env, runId).fetch('http://do/status'));
    if (!sourceStatusResponse.ok) return responseFromReceipt(null, 'durable_state_unavailable');
    const sourceStatus = await context.run(() => sourceStatusResponse.json()) as any;
    if (sourceStatus.cancelRequested || sourceStatus.phase === 'Cancelled') {
      return responseFromReceipt(null, 'cancel_requested');
    }
    return readByRunIdWithContext(env, stored.link, context, depth + 1);
  }
  if (stored.link === runId) return responseFromReceipt(null, 'durable_state_unavailable');
  const state = stored.state;
  if (!state || state.version !== 'OperatorPassthroughState.v2' || state.runId !== runId) return null;
  const receipt = await readForTargetWithContext(env, {
    owner: state.identity.owner,
    repo: state.identity.repo,
    prNumber: state.identity.prNumber,
  }, context, { headSha: state.identity.headSha, baseSha: state.identity.baseSha });
  if (receipt.runId !== runId) return responseFromReceipt(null, 'current_candidate_changed');
  return receipt;
}

export async function readOperatorPassthroughByRunId(
  env: Env,
  runId: string,
  options: OperatorPassthroughOptions = {}
): Promise<OperatorPassthroughResult | null> {
  if (!/^run_[A-Za-z0-9_-]{1,128}$/u.test(runId)) return null;
  const context = makeDeadline(env, options);
  try { return await readByRunIdWithContext(env, runId, context); }
  catch (error) {
    const code = error instanceof PassthroughUnavailable ? error.code : 'authoritative_read_unavailable';
    return responseFromReceipt(null, code);
  } finally { context.dispose(); }
}

/** Backward-compatible workflow entrypoint; the supplied run tuple is ignored. */
export async function publishOperatorPassthrough(
  env: Env,
  spec: ReviewRunSpec,
  options: OperatorPassthroughOptions = {}
): Promise<OperatorPassthroughResult> {
  if (!/^run_[A-Za-z0-9_-]{1,128}$/u.test(spec.runId)) return responseFromReceipt(null, 'durable_state_unavailable');
  const original = doStub(env, spec.runId);
  try {
    // Preserve cancellation on the authenticated workflow's own run ID. The
    // tuple here is stored only for that run's status and cancellation; the
    // paused publisher independently resolves current GitHub coordinates.
    const initialized = await original.fetch('http://do/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec),
    });
    if (!initialized.ok) return responseFromReceipt(null, 'durable_state_unavailable');
    const sourceStatusResponse = await original.fetch('http://do/status');
    if (!sourceStatusResponse.ok) return responseFromReceipt(null, 'durable_state_unavailable');
    const sourceStatus = await sourceStatusResponse.json() as any;
    if (sourceStatus.cancelRequested || sourceStatus.phase === 'Cancelled') return responseFromReceipt(null, 'cancel_requested');
  } catch {
    return responseFromReceipt(null, 'durable_state_unavailable');
  }

  const target = { owner: spec.owner, repo: spec.repo, prNumber: spec.prNumber };
  const receipt = await publishOperatorPassthroughForTargetInternal(env, target, options, undefined, spec.runId);
  if (receipt.status !== 'succeeded' || !receipt.runId || !receipt.owner || !receipt.repo || !receipt.prNumber) return receipt;

  const invalidatePublishedReceipt = async (): Promise<OperatorPassthroughResult> => {
    try {
      const published = doStub(env, receipt.runId!);
      await published.fetch('http://do/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'source_workflow_cancelled' }),
      });
    } catch {
      return responseFromReceipt(null, 'cancel_requested');
    }
    return readOperatorPassthroughForTarget(env, {
      owner: receipt.owner!, repo: receipt.repo!, prNumber: receipt.prNumber!,
    }, { headSha: receipt.headSha, baseSha: receipt.baseSha });
  };

  if (spec.runId === receipt.runId) return receipt;
  try {
    const sourceAfterPublication = await original.fetch('http://do/status');
    if (!sourceAfterPublication.ok) return await invalidatePublishedReceipt();
    const sourceStatus = await sourceAfterPublication.json() as any;
    if (sourceStatus.cancelRequested || sourceStatus.phase === 'Cancelled') return await invalidatePublishedReceipt();
    const linkResponse = await original.fetch('http://do/operator-passthrough/link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'OperatorPassthroughLink.v1', publicationRunId: receipt.runId }),
    });
    if (!linkResponse.ok || !(await linkResponse.json() as any).accepted) return await invalidatePublishedReceipt();
  } catch {
    return await invalidatePublishedReceipt();
  }
  return receipt;
}
