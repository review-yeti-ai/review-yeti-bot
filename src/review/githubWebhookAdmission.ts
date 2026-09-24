import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ReviewDispatchRepository } from '../persistence/reviewDispatchRepository';
import { TERMINAL_DEADLINE_MS } from '../config/terminalDeadline';
import type { GitHubWebhookConfig } from '../auth/githubWebhookConfig';
import type { AuthoritativeReviewAdmission } from './authoritativeServiceContracts';
import { buildReviewRunIdentity, deriveReviewRunId } from './reviewAdmission';
import { sha256 } from './reviewCore';
import {
  AUTHORITATIVE_REVIEW_APP_ID, AUTHORITATIVE_REVIEW_APP_SLUG, AUTHORITATIVE_REVIEW_CHECK_NAME,
} from '../auth/authoritativeServiceIdentity';
import {
  githubWebhookRepositorySchema, requireEnrolledGitHubWebhookRepository, UnenrolledGitHubWebhookIdentityError,
} from '../auth/githubWebhookIdentity';
import { MergeGroupGateInProgressError } from './mergeGroupGate';
import {
  isRecoverableFailureTitle,
  REVIEW_REFRESH_ACTION,
} from './reviewRecoveryPolicy';
import { isTriggerActionAllowed } from '../config/configLoader';

export const OPT_OUT_LABELS = ['review-yeti:skip', 'wip', 'skip-review'] as const;
export const OPT_IN_LABELS = ['review-yeti', 'ct-review', 'ai-review'] as const;

export function isOptOutLabel(label: string): boolean {
  const norm = label.toLowerCase().trim();
  return OPT_OUT_LABELS.some((opt) => norm === opt);
}

export function isOptInLabel(label: string): boolean {
  const norm = label.toLowerCase().trim();
  return OPT_IN_LABELS.some((opt) => norm === opt);
}

export function hasOptOutLabel(labels: readonly string[]): boolean {
  return labels.some((l) => isOptOutLabel(l));
}

export function hasOptInLabel(labels: readonly string[]): boolean {
  return labels.some((l) => isOptInLabel(l));
}

export function extractLabelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) => (typeof l === 'string' ? l : (typeof l === 'object' && l && 'name' in l ? String(l.name) : '')))
    .filter(Boolean);
}

const positiveInteger = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const pullRequestWebhook = z.object({
  action: z.enum(['opened', 'synchronize', 'reopened', 'ready_for_review']),
  number: positiveInteger,
  installation: z.object({ id: positiveInteger }).passthrough(),
  repository: githubWebhookRepositorySchema,
  pull_request: z.object({
    number: positiveInteger,
    state: z.literal('open'),
    draft: z.literal(false),
    head: z.object({ sha }).passthrough(),
    base: z.object({ sha, repo: z.object({ full_name: z.string().min(3).max(201) }).passthrough() }).passthrough(),
    labels: z.array(z.unknown()).optional(),
  }).passthrough(),
}).passthrough();

// REL-896: a closed PR (merged or not) carries neither an open state nor a
// draft flag, so it cannot satisfy pullRequestWebhook above -- it is parsed
// and routed separately, before that schema ever sees it.
const closedPullRequestWebhook = z.object({
  action: z.literal('closed'),
  number: positiveInteger,
  installation: z.object({ id: positiveInteger }).passthrough(),
  repository: githubWebhookRepositorySchema,
  pull_request: z.object({
    number: positiveInteger,
    state: z.literal('closed'),
    merged: z.boolean(),
    base: z.object({ repo: z.object({ full_name: z.string().min(3).max(201) }).passthrough() }).passthrough(),
  }).passthrough(),
}).passthrough();

const convertedToDraftPullRequestWebhook = z.object({
  action: z.literal('converted_to_draft'),
  number: positiveInteger,
  installation: z.object({ id: positiveInteger }).passthrough(),
  repository: githubWebhookRepositorySchema,
  pull_request: z.object({
    number: positiveInteger,
    base: z.object({ repo: z.object({ full_name: z.string().min(3).max(201) }).passthrough() }).passthrough(),
  }).passthrough(),
}).passthrough();

const REFRESH_ACTION_IDENTIFIER = REVIEW_REFRESH_ACTION.identifier;
const refreshExternalId = z.string()
  .regex(/^run_[a-f0-9]{32}:a[1-9][0-9]*$/u)
  .refine((value) => Number.isSafeInteger(Number(value.slice(value.lastIndexOf(':a') + 2))));
const checkRunRepositoryReference = z.union([
  z.object({
    full_name: z.string().min(3).max(201),
  }).passthrough(),
  // GitHub's live check_run.rerequested payload uses this compact repository
  // shape for associated pull requests. It does not include full_name.
  z.object({
    id: positiveInteger,
    url: z.string().url(),
    name: z.string().min(1).max(100),
  }).passthrough(),
]);
const recoverableCheckRun = z.object({
  id: positiveInteger,
  name: z.literal(AUTHORITATIVE_REVIEW_CHECK_NAME),
  head_sha: sha,
  status: z.literal('completed'),
  conclusion: z.literal('failure'),
  external_id: refreshExternalId,
  app: z.object({
    id: z.literal(AUTHORITATIVE_REVIEW_APP_ID),
    slug: z.literal(AUTHORITATIVE_REVIEW_APP_SLUG),
  }).passthrough(),
  output: z.object({
    title: z.string().refine((value) => isRecoverableFailureTitle(value)),
  }).passthrough(),
  // GitHub leaves this array empty for fork pushes. Refuse to guess the PR
  // coordinates in that case: refresh is only valid for a single exact head.
  pull_requests: z.array(z.object({
    number: positiveInteger,
    head: z.object({
      sha,
      repo: checkRunRepositoryReference,
    }).passthrough(),
    base: z.object({
      sha,
      repo: checkRunRepositoryReference,
    }).passthrough(),
  }).passthrough()).length(1),
}).passthrough();
const refreshCheckRunWebhook = z.discriminatedUnion('action', [z.object({
  action: z.literal('requested_action'),
  installation: z.object({ id: positiveInteger }).passthrough(),
  repository: githubWebhookRepositorySchema,
  requested_action: z.object({ identifier: z.literal(REFRESH_ACTION_IDENTIFIER) }).passthrough(),
  check_run: recoverableCheckRun,
}).passthrough(), z.object({
  action: z.literal('rerequested'),
  installation: z.object({ id: positiveInteger }).passthrough(),
  repository: githubWebhookRepositorySchema,
  check_run: recoverableCheckRun,
}).passthrough()]);

export interface GitHubWebhookAdmissionOptions {
  config: GitHubWebhookConfig;
  admission: Pick<ReviewDispatchRepository, 'admit' | 'terminalizeRunsForClosedPullRequest'> &
    Partial<Pick<ReviewDispatchRepository, 'cancelRunsForPullRequest' | 'advanceDebounceAvailableAt'>>;
  authoritativePublishing?: AuthoritativeReviewAdmission;
  now?: () => number;
  mergeGroupGate?(payload: unknown): Promise<{ checkId: number; conclusion: 'success' | 'failure'; constituents: number }>;
  resolveRepositoryConfig?: (params: {
    repositoryId: number;
    owner: string;
    repo: string;
    headSha?: string;
  }) => Promise<{ auto_review?: { triggers?: string[]; enabled?: boolean } } | null | undefined> | { auto_review?: { triggers?: string[]; enabled?: boolean } } | null | undefined;
}

export interface GitHubWebhookAdmissionEvent {
  eventName: string;
  deliveryId: string;
  rawBody: Buffer;
  body: unknown;
  signature256?: string;
}

function checkRunRepositoryMatches(
  reference: z.infer<typeof checkRunRepositoryReference>,
  repository: z.infer<typeof githubWebhookRepositorySchema>,
): boolean {
  const fields = reference as Record<string, unknown>;
  const expected = {
    full_name: repository.full_name,
    id: repository.id,
    name: repository.name,
    url: `https://api.github.com/repos/${repository.full_name}`,
  } as const;
  for (const [key, value] of Object.entries(expected)) {
    if (Object.hasOwn(fields, key) && fields[key] !== value) return false;
  }
  return fields.full_name === expected.full_name
    || (fields.id === expected.id && fields.name === expected.name && fields.url === expected.url);
}

/** Admit signed, allowlisted GitHub App review events directly. */
export function createGitHubWebhookAdmissionHandler(options: GitHubWebhookAdmissionOptions) {
  const now = options.now || Date.now;
  const authoritativeIds = new Set(options.authoritativePublishing?.repositoryIds || []);
  return async (event: GitHubWebhookAdmissionEvent): Promise<Record<string, unknown>> => {
    const { eventName, deliveryId: delivery } = event;
    if (!options.config.admissionEnabled) return { status: 'ignored', reason: 'admission_paused' };
    if (!Buffer.isBuffer(event.rawBody) || !delivery || delivery.length > 256) {
      throw new Error('GitHub webhook identity is unavailable');
    }
    if (eventName === 'merge_group') {
      const action = event.body && typeof event.body === 'object' && !Array.isArray(event.body)
        ? (event.body as Record<string, unknown>).action : undefined;
      if (typeof action === 'string' && action.length > 0 && action !== 'checks_requested') {
        return { status: 'ignored', reason: 'unsupported_merge_group_action' };
      }
      if (!options.mergeGroupGate) throw new Error('Merge-group webhook gate is unavailable');
      let result;
      try { result = await options.mergeGroupGate(event.body); }
      catch (error) {
        if (error instanceof UnenrolledGitHubWebhookIdentityError) return { status: 'ignored', reason: 'not_enrolled' };
        if (error instanceof MergeGroupGateInProgressError) return { status: 'accepted', reason: 'merge_group_in_progress' };
        throw error;
      }
      return { status: result.conclusion, checkId: result.checkId, constituents: result.constituents };
    }
    if (eventName === 'check_run') {
      const parsed = refreshCheckRunWebhook.safeParse(event.body);
      if (!parsed.success) return { status: 'ignored', reason: 'unsupported_refresh_request' };
      const payload = parsed.data;
      let enrolled;
      try { enrolled = requireEnrolledGitHubWebhookRepository(payload.repository, options.config); }
      catch (error) {
        if (error instanceof UnenrolledGitHubWebhookIdentityError) return { status: 'ignored', reason: 'not_enrolled' };
        throw error;
      }
      const pr = payload.check_run.pull_requests[0];
      const { owner, repo } = enrolled;
      if (payload.repository.full_name !== `${owner}/${repo}`
        || !checkRunRepositoryMatches(pr.head.repo, payload.repository)
        || !checkRunRepositoryMatches(pr.base.repo, payload.repository)
        || pr.head.sha !== payload.check_run.head_sha) {
        return { status: 'ignored', reason: 'not_enrolled' };
      }
      const requested = {
        repositoryId: payload.repository.id, owner, repo, prNumber: pr.number,
        headSha: pr.head.sha, baseSha: pr.base.sha,
      };
      const legacyIdentity = buildReviewRunIdentity(requested);
      const attemptSeparator = payload.check_run.external_id.lastIndexOf(':a');
      const runId = payload.check_run.external_id.slice(0, attemptSeparator);
      const retryAfterExecutionAttempt = Number(payload.check_run.external_id.slice(attemptSeparator + 2));
      const authoritative = options.authoritativePublishing;
      const hasAuthoritativeIdentity = authoritative !== undefined
        && authoritativeIds.has(payload.repository.id);
      // GitHub's native re-request action carries no separately named action
      // identifier. Admit it only where the service can re-read and bind the
      // exact current candidate/policy; legacy enrollment must keep using the
      // explicit Review Yeti refresh button instead.
      if (payload.action === 'rerequested' && !hasAuthoritativeIdentity) {
        return { status: 'ignored', reason: 'native_rerequest_requires_authoritative_identity' };
      }
      if (authoritative?.acceptNewRequests === false && authoritativeIds.has(payload.repository.id)) {
        return { status: 'ignored', reason: 'authoritative_admission_paused' };
      }
      const resolved = authoritative && hasAuthoritativeIdentity
        ? await authoritative.resolver.resolve(requested) : undefined;
      const expectedIdentity = resolved?.identity || legacyIdentity;
      const expectedRunId = deriveReviewRunId(expectedIdentity);
      if (expectedRunId !== runId) {
        return { status: 'ignored', reason: 'refresh_identity_mismatch' };
      }
      const receivedAt = now();
      const admission = await options.admission.admit({
        deliveryId: `github-webhook:${delivery}`,
        eventName,
        repositoryId: payload.repository.id,
        installationId: payload.installation.id,
        receivedAt,
        terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
        payloadDigest: createHash('sha256').update(event.rawBody).digest('hex'),
        publicationMode: 'app-gate',
        centralActionDispatch: false,
        // The signed App check_run/requested_action payload is the dedicated
        // recovery authority. The repository still requires exact persisted
        // attempt evidence before re-arming the durable run.
        retryRequested: true,
        retryAfterExecutionAttempt,
        identity: resolved?.identity || legacyIdentity,
        ...(resolved && authoritative ? {
          effectivePolicyDigest: resolved.prepared.policy.effectivePolicyDigest,
          authoritativeGate: { expectedAppId: authoritative.expectedAppId, prepared: resolved.prepared },
        } : {}),
      });
      return {
        status: admission.status,
        deliveryId: delivery,
        prNumber: pr.number,
        headSha: pr.head.sha,
        reason: 'refresh_requested',
      };
    }
    if (eventName === 'issue_comment') {
      const body = event.body as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return { status: 'ignored', reason: 'unsupported_event' };
      const rawAction = typeof body.action === 'string' ? body.action : undefined;
      if (rawAction !== 'created') return { status: 'ignored', reason: 'unsupported_comment_action' };

      const commentObj = body.comment as Record<string, unknown> | undefined;
      const commentBody = String(commentObj?.body || '').trim();
      const isReviewCommand = /(?:^|\s)\/review\b/i.test(commentBody) || /(?:^|\s)@(review-yeti|review-yeti-bot|ct-review|ct-review-bot)\b/i.test(commentBody);
      if (!isReviewCommand) return { status: 'ignored', reason: 'not_review_command' };

      const issueObj = body.issue as Record<string, unknown> | undefined;
      const isPr = Boolean(issueObj?.pull_request || body.pull_request);
      if (!isPr) return { status: 'ignored', reason: 'comment_not_on_pull_request' };
      const prNumber = Number(issueObj?.number || (body.pull_request as any)?.number);
      const isClosed = issueObj?.state === 'closed' || (body.pull_request as any)?.state === 'closed';
      if (isClosed) return { status: 'ignored', reason: 'pull_request_not_open', deliveryId: delivery, prNumber };

      const parsedRepo = githubWebhookRepositorySchema.safeParse(body.repository);
      if (!parsedRepo.success) return { status: 'ignored', reason: 'invalid_repository_payload' };

      let enrolled;
      try { enrolled = requireEnrolledGitHubWebhookRepository(parsedRepo.data, options.config); }
      catch (error) {
        if (error instanceof UnenrolledGitHubWebhookIdentityError) return { status: 'ignored', reason: 'not_enrolled' };
        throw error;
      }

      const { owner, repo } = enrolled;
      const repositoryId = parsedRepo.data.id;
      const prHead = (issueObj?.head || (issueObj?.pull_request as any)?.head || (body.pull_request as any)?.head) as { sha?: string } | undefined;
      const headSha = prHead?.sha;
      const receivedAt = now();

      const repoConfig = options.resolveRepositoryConfig
        ? await options.resolveRepositoryConfig({ repositoryId, owner, repo, headSha })
        : undefined;
      if (repoConfig?.auto_review?.enabled === false) {
        return { status: 'ignored', reason: 'auto_review_disabled', deliveryId: delivery, prNumber };
      }
      if (!isTriggerActionAllowed(repoConfig?.auto_review?.triggers, 'issue_comment', { isCommand: true })) {
        return { status: 'ignored', reason: 'trigger_not_configured', deliveryId: delivery, prNumber };
      }

      if (options.admission.advanceDebounceAvailableAt) {
        const advanced = await options.admission.advanceDebounceAvailableAt(repositoryId, prNumber, headSha, receivedAt);
        if (advanced.advanced) {
          return {
            status: 'accepted',
            deliveryId: delivery,
            prNumber,
            headSha,
            reason: 'debounce_advanced',
            runId: advanced.runId,
          };
        }
      }

      const prBase = ((body.pull_request as any)?.base || (issueObj?.pull_request as any)?.base || (issueObj as any)?.base) as { sha?: string; repo?: { full_name?: string } } | undefined;
      if (headSha && prBase?.sha && body.installation) {
        const installationId = Number((body.installation as any)?.id);
        const requested = { repositoryId, owner, repo, prNumber, headSha, baseSha: prBase.sha };
        const authoritative = options.authoritativePublishing;
        const resolved = authoritative && authoritativeIds.has(repositoryId)
          ? await authoritative.resolver.resolve(requested) : undefined;
        const admission = await options.admission.admit({
          deliveryId: `github-webhook:${delivery}`,
          eventName,
          repositoryId,
          installationId,
          receivedAt,
          terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
          payloadDigest: createHash('sha256').update(event.rawBody).digest('hex'),
          publicationMode: 'app-gate',
          centralActionDispatch: false,
          debounce: false,
          identity: resolved?.identity || buildReviewRunIdentity(requested),
          ...(resolved && authoritative ? {
            effectivePolicyDigest: resolved.prepared.policy.effectivePolicyDigest,
            authoritativeGate: { expectedAppId: authoritative.expectedAppId, prepared: resolved.prepared },
          } : {}),
        });
        return {
          status: admission.status,
          deliveryId: delivery,
          prNumber,
          headSha,
          reason: 'review_command',
        };
      }

      return { status: 'ignored', reason: 'no_debounced_run_to_advance', deliveryId: delivery, prNumber };
    }

    if (eventName !== 'pull_request') return { status: 'ignored', reason: 'unsupported_event' };
    const rawAction = event.body && typeof event.body === 'object' && !Array.isArray(event.body)
      ? (event.body as Record<string, unknown>).action : undefined;
    // REL-896: a closed PR (merged or not) has no open/draft invariant to
    // check and admits nothing new -- it only terminalizes whatever is still
    // in flight. Route it before the opened/synchronize/reopened/
    // ready_for_review schema below, whose behaviour stays byte-for-byte
    // unchanged for every other action.
    if (rawAction === 'closed') {
      const parsedClosed = closedPullRequestWebhook.safeParse(event.body);
      if (!parsedClosed.success) return { status: 'ignored', reason: 'unsupported_pull_request_state' };
      const closedPayload = parsedClosed.data;
      let closedEnrolled;
      try { closedEnrolled = requireEnrolledGitHubWebhookRepository(closedPayload.repository, options.config); }
      catch (error) {
        if (error instanceof UnenrolledGitHubWebhookIdentityError) return { status: 'ignored', reason: 'not_enrolled' };
        throw error;
      }
      const { owner: closedOwner, repo: closedRepo } = closedEnrolled;
      if (closedPayload.number !== closedPayload.pull_request.number
        || closedPayload.pull_request.base.repo.full_name !== closedPayload.repository.full_name) {
        return { status: 'ignored', reason: 'not_enrolled' };
      }
      const closedReceivedAt = now();
      const closed = await options.admission.terminalizeRunsForClosedPullRequest({
        repositoryId: closedPayload.repository.id,
        owner: closedOwner,
        repo: closedRepo,
        prNumber: closedPayload.pull_request.number,
        merged: closedPayload.pull_request.merged,
        now: closedReceivedAt,
        deliveryId: `github-webhook:${delivery}`,
      });
      if (closed.terminalizedRunIds.length === 0) {
        // Idempotent no-op: either a redelivery of a close already processed,
        // or a PR with no in-flight run at all. Never an error.
        return { status: 'ignored', reason: 'no_in_flight_runs', deliveryId: delivery, prNumber: closedPayload.pull_request.number };
      }
      return {
        status: 'accepted',
        deliveryId: delivery,
        prNumber: closedPayload.pull_request.number,
        reason: 'pull_request_closed',
        terminalized: closed.terminalizedRunIds.length,
      };
    }

    if (rawAction === 'converted_to_draft') {
      const parsedDraft = convertedToDraftPullRequestWebhook.safeParse(event.body);
      if (!parsedDraft.success) return { status: 'ignored', reason: 'unsupported_pull_request_state' };
      const draftPayload = parsedDraft.data;
      let draftEnrolled;
      try { draftEnrolled = requireEnrolledGitHubWebhookRepository(draftPayload.repository, options.config); }
      catch (error) {
        if (error instanceof UnenrolledGitHubWebhookIdentityError) return { status: 'ignored', reason: 'not_enrolled' };
        throw error;
      }
      if (draftPayload.number !== draftPayload.pull_request.number
        || draftPayload.pull_request.base.repo.full_name !== draftPayload.repository.full_name) {
        return { status: 'ignored', reason: 'not_enrolled' };
      }
      const draftReceivedAt = now();
      const cancelled = options.admission.cancelRunsForPullRequest
        ? await options.admission.cancelRunsForPullRequest(draftPayload.repository.id, draftPayload.pull_request.number, 'converted_to_draft', draftReceivedAt)
        : { cancelledRunIds: [] };
      return {
        status: 'accepted',
        deliveryId: delivery,
        prNumber: draftPayload.pull_request.number,
        reason: 'converted_to_draft',
        cancelled: cancelled.cancelledRunIds.length,
      };
    }

    if (rawAction === 'labeled') {
      const body = event.body as any;
      const parsedRepo = githubWebhookRepositorySchema.safeParse(body?.repository);
      if (!parsedRepo.success) return { status: 'ignored', reason: 'unsupported_pull_request_state' };
      let enrolled;
      try { enrolled = requireEnrolledGitHubWebhookRepository(parsedRepo.data, options.config); }
      catch (error) {
        if (error instanceof UnenrolledGitHubWebhookIdentityError) return { status: 'ignored', reason: 'not_enrolled' };
        throw error;
      }
      const { owner, repo } = enrolled;
      const repositoryId = parsedRepo.data.id;
      const pr = body?.pull_request;
      if (!pr || typeof pr !== 'object') return { status: 'ignored', reason: 'unsupported_pull_request_state' };
      const prNumber = Number(pr.number || body.number);
      const labelName = String(body.label?.name || body.label || '').trim();
      const prLabels = extractLabelNames(pr.labels);
      const receivedAt = now();

      if (isOptOutLabel(labelName) || hasOptOutLabel(prLabels)) {
        if (options.admission.cancelRunsForPullRequest) {
          await options.admission.cancelRunsForPullRequest(repositoryId, prNumber, 'opt_out_label', receivedAt);
        }
        return { status: 'ignored', reason: 'opt_out_label_present', deliveryId: delivery, prNumber };
      }

      if (isOptInLabel(labelName)) {
        if (pr.draft === true) {
          return { status: 'ignored', reason: 'draft_pr', deliveryId: delivery, prNumber };
        }
        const repoConfig = options.resolveRepositoryConfig
          ? await options.resolveRepositoryConfig({ repositoryId, owner, repo, headSha: pr.head?.sha })
          : undefined;
        if (repoConfig?.auto_review?.enabled === false) {
          return { status: 'ignored', reason: 'auto_review_disabled', deliveryId: delivery, prNumber };
        }
        if (!isTriggerActionAllowed(repoConfig?.auto_review?.triggers, 'labeled', { isTag: true, label: labelName })) {
          return { status: 'ignored', reason: 'trigger_not_configured', deliveryId: delivery, prNumber };
        }
        if (options.admission.advanceDebounceAvailableAt && pr.head?.sha) {
          const advanced = await options.admission.advanceDebounceAvailableAt(repositoryId, prNumber, pr.head.sha, receivedAt);
          if (advanced.advanced) {
            return {
              status: 'accepted',
              deliveryId: delivery,
              prNumber,
              headSha: pr.head.sha,
              reason: 'debounce_advanced',
              runId: advanced.runId,
            };
          }
        }
        if (pr.head?.sha && pr.base?.sha && body.installation) {
          const requested = { repositoryId, owner, repo, prNumber, headSha: pr.head.sha, baseSha: pr.base.sha };
          const authoritative = options.authoritativePublishing;
          const resolved = authoritative && authoritativeIds.has(repositoryId)
            ? await authoritative.resolver.resolve(requested) : undefined;
          const admission = await options.admission.admit({
            deliveryId: `github-webhook:${delivery}`,
            eventName,
            repositoryId,
            installationId: Number(body.installation.id),
            receivedAt,
            terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
            payloadDigest: createHash('sha256').update(event.rawBody).digest('hex'),
            publicationMode: 'app-gate',
            centralActionDispatch: false,
            debounce: false,
            identity: resolved?.identity || buildReviewRunIdentity(requested),
            ...(resolved && authoritative ? {
              effectivePolicyDigest: resolved.prepared.policy.effectivePolicyDigest,
              authoritativeGate: { expectedAppId: authoritative.expectedAppId, prepared: resolved.prepared },
            } : {}),
          });
          return { status: admission.status, deliveryId: delivery, prNumber, headSha: pr.head.sha };
        }
      }
      return { status: 'ignored', reason: 'unsupported_pull_request_state' };
    }

    if (rawAction === 'unlabeled') {
      const body = event.body as any;
      const parsedRepo = githubWebhookRepositorySchema.safeParse(body?.repository);
      if (!parsedRepo.success) return { status: 'ignored', reason: 'unsupported_pull_request_state' };
      let enrolled;
      try { enrolled = requireEnrolledGitHubWebhookRepository(parsedRepo.data, options.config); }
      catch (error) {
        if (error instanceof UnenrolledGitHubWebhookIdentityError) return { status: 'ignored', reason: 'not_enrolled' };
        throw error;
      }
      const { owner, repo } = enrolled;
      const repositoryId = parsedRepo.data.id;
      const pr = body?.pull_request;
      if (!pr || typeof pr !== 'object') return { status: 'ignored', reason: 'unsupported_pull_request_state' };
      const prNumber = Number(pr.number || body.number);
      const labelName = String(body.label?.name || body.label || '').trim();
      const prLabels = extractLabelNames(pr.labels);
      const receivedAt = now();

      if (isOptOutLabel(labelName)) {
        if (hasOptOutLabel(prLabels)) {
          return { status: 'ignored', reason: 'opt_out_label_present', deliveryId: delivery, prNumber };
        }
        if (pr.draft === true) {
          return { status: 'ignored', reason: 'draft_pr', deliveryId: delivery, prNumber };
        }
        const repoConfig = options.resolveRepositoryConfig
          ? await options.resolveRepositoryConfig({ repositoryId, owner, repo, headSha: pr.head?.sha })
          : undefined;
        if (repoConfig?.auto_review?.enabled === false) {
          return { status: 'ignored', reason: 'auto_review_disabled', deliveryId: delivery, prNumber };
        }
        if (!isTriggerActionAllowed(repoConfig?.auto_review?.triggers, 'synchronize')) {
          return { status: 'ignored', reason: 'trigger_not_configured', deliveryId: delivery, prNumber };
        }
        if (pr.head?.sha && pr.base?.sha && body.installation) {
          const requested = { repositoryId, owner, repo, prNumber, headSha: pr.head.sha, baseSha: pr.base.sha };
          const authoritative = options.authoritativePublishing;
          const resolved = authoritative && authoritativeIds.has(repositoryId)
            ? await authoritative.resolver.resolve(requested) : undefined;
          const admission = await options.admission.admit({
            deliveryId: `github-webhook:${delivery}`,
            eventName,
            repositoryId,
            installationId: Number(body.installation.id),
            receivedAt,
            terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
            payloadDigest: createHash('sha256').update(event.rawBody).digest('hex'),
            publicationMode: 'app-gate',
            centralActionDispatch: false,
            debounce: false,
            identity: resolved?.identity || buildReviewRunIdentity(requested),
            ...(resolved && authoritative ? {
              effectivePolicyDigest: resolved.prepared.policy.effectivePolicyDigest,
              authoritativeGate: { expectedAppId: authoritative.expectedAppId, prepared: resolved.prepared },
            } : {}),
          });
          return { status: admission.status, deliveryId: delivery, prNumber, headSha: pr.head.sha, reason: 'opt_out_label_removed' };
        }
      }
      return { status: 'ignored', reason: 'unsupported_pull_request_state' };
    }

    const parsed = pullRequestWebhook.safeParse(event.body);
    if (!parsed.success) return { status: 'ignored', reason: 'unsupported_pull_request_state' };
    const payload = parsed.data;
    let enrolled;
    try { enrolled = requireEnrolledGitHubWebhookRepository(payload.repository, options.config); }
    catch (error) {
      if (error instanceof UnenrolledGitHubWebhookIdentityError) return { status: 'ignored', reason: 'not_enrolled' };
      throw error;
    }
    const { owner, repo } = enrolled;
    const repositoryId = payload.repository.id;
    const pr = payload.pull_request;
    if (payload.number !== pr.number || pr.base.repo.full_name !== payload.repository.full_name) {
      return { status: 'ignored', reason: 'not_enrolled' };
    }

    const prLabels = extractLabelNames(pr.labels);
    const receivedAt = now();
    if (hasOptOutLabel(prLabels)) {
      if (options.admission.cancelRunsForPullRequest) {
        await options.admission.cancelRunsForPullRequest(repositoryId, pr.number, 'opt_out_label', receivedAt);
      }
      return { status: 'ignored', reason: 'opt_out_label_present', deliveryId: delivery, prNumber: pr.number };
    }

    const repoConfig = options.resolveRepositoryConfig
      ? await options.resolveRepositoryConfig({ repositoryId, owner, repo, headSha: pr.head.sha })
      : undefined;
    if (repoConfig?.auto_review?.enabled === false) {
      return { status: 'ignored', reason: 'auto_review_disabled', deliveryId: delivery, prNumber: pr.number };
    }
    if (!isTriggerActionAllowed(repoConfig?.auto_review?.triggers, payload.action)) {
      return { status: 'ignored', reason: 'trigger_not_configured', deliveryId: delivery, prNumber: pr.number };
    }

    const requested = {
      repositoryId, owner, repo, prNumber: pr.number,
      headSha: pr.head.sha, baseSha: pr.base.sha,
    };
    const authoritative = options.authoritativePublishing;
    if (authoritative?.acceptNewRequests === false && authoritativeIds.has(repositoryId)) {
      return { status: 'ignored', reason: 'authoritative_admission_paused' };
    }
    const resolved = authoritative && authoritativeIds.has(repositoryId)
      ? await authoritative.resolver.resolve(requested) : undefined;
    const debounce = (payload.action === 'synchronize');
    const admission = await options.admission.admit({
      deliveryId: `github-webhook:${delivery}`,
      eventName,
      repositoryId,
      installationId: payload.installation.id,
      receivedAt,
      terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
      payloadDigest: createHash('sha256').update(event.rawBody).digest('hex'),
      publicationMode: 'app-gate',
      centralActionDispatch: false,
      debounce,
      identity: resolved?.identity || buildReviewRunIdentity(requested),
      ...(resolved && authoritative ? {
        effectivePolicyDigest: resolved.prepared.policy.effectivePolicyDigest,
        authoritativeGate: { expectedAppId: authoritative.expectedAppId, prepared: resolved.prepared },
      } : {}),
    });
    return {
      status: admission.status,
      deliveryId: delivery,
      prNumber: pr.number,
      headSha: pr.head.sha,
    };
  };
}
