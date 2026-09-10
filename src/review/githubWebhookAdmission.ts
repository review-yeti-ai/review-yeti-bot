import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RequestWithRawBody } from '../github/webhookServer';
import type { ReviewDispatchRepository } from '../persistence/reviewDispatchRepository';
import { TERMINAL_DEADLINE_MS } from '../config/terminalDeadline';
import type { GitHubWebhookConfig } from '../auth/githubWebhookConfig';
import type { AuthoritativeReviewAdmission } from './authoritativeServiceContracts';
import { buildReviewRunIdentity } from './reviewAdmission';

const positiveInteger = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const repositoryName = z.string().min(3).max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const repository = z.object({
  id: positiveInteger,
  name: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u),
  full_name: repositoryName,
  owner: z.object({
    id: positiveInteger,
    login: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u),
  }).passthrough(),
}).passthrough();
const pullRequestWebhook = z.object({
  action: z.enum(['opened', 'synchronize', 'reopened', 'ready_for_review']),
  number: positiveInteger,
  installation: z.object({ id: positiveInteger }).passthrough(),
  repository,
  pull_request: z.object({
    number: positiveInteger,
    state: z.literal('open'),
    draft: z.literal(false),
    head: z.object({ sha }).passthrough(),
    base: z.object({ sha, repo: z.object({ full_name: repositoryName }).passthrough() }).passthrough(),
  }).passthrough(),
}).passthrough();

export interface GitHubWebhookAdmissionOptions {
  config: GitHubWebhookConfig;
  admission: Pick<ReviewDispatchRepository, 'admit'>;
  authoritativePublishing?: AuthoritativeReviewAdmission;
  now?: () => number;
  mergeGroupGate?(payload: unknown): Promise<{ checkId: number; conclusion: 'success' | 'failure'; constituents: number }>;
}

function header(request: RequestWithRawBody, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

/** Admit a signed, allowlisted GitHub App pull_request webhook directly. */
export function createGitHubWebhookAdmissionHandler(options: GitHubWebhookAdmissionOptions) {
  const now = options.now || Date.now;
  const authoritativeIds = new Set(options.authoritativePublishing?.repositoryIds || []);
  return async (request: RequestWithRawBody): Promise<Record<string, unknown>> => {
    const eventName = header(request, 'x-github-event');
    const delivery = header(request, 'x-github-delivery');
    if (!options.config.admissionEnabled) return { status: 'ignored', reason: 'admission_paused' };
    if (!request.rawBody || !delivery || delivery.length > 256) {
      throw new Error('GitHub webhook identity is unavailable');
    }
    if (eventName === 'merge_group') {
      if (!options.mergeGroupGate) throw new Error('Merge-group webhook gate is unavailable');
      const result = await options.mergeGroupGate(request.body);
      return { status: result.conclusion, checkId: result.checkId, constituents: result.constituents };
    }
    if (eventName !== 'pull_request') return { status: 'ignored', reason: 'unsupported_event' };
    const parsed = pullRequestWebhook.safeParse(request.body);
    if (!parsed.success) return { status: 'ignored', reason: 'unsupported_pull_request_state' };
    const payload = parsed.data;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const repositoryId = payload.repository.id;
    const ownerId = payload.repository.owner.id;
    const pr = payload.pull_request;
    if (payload.number !== pr.number || payload.repository.full_name !== `${owner}/${repo}`
      || pr.base.repo.full_name !== payload.repository.full_name
      || !options.config.repositoryIds.has(String(repositoryId))
      || !options.config.ownerIds.has(String(ownerId))) {
      throw new Error('GitHub webhook repository identity is not enrolled');
    }
    const requested = {
      repositoryId, owner, repo, prNumber: pr.number,
      headSha: pr.head.sha, baseSha: pr.base.sha,
    };
    const authoritative = options.authoritativePublishing;
    if (authoritative?.acceptNewRequests === false && authoritativeIds.has(repositoryId)) {
      throw new Error('Authoritative review admission is paused');
    }
    const resolved = authoritative && authoritativeIds.has(repositoryId)
      ? await authoritative.resolver.resolve(requested) : undefined;
    const receivedAt = now();
    const admission = await options.admission.admit({
      deliveryId: `github-webhook:${delivery}`,
      eventName,
      repositoryId,
      installationId: payload.installation.id,
      receivedAt,
      terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
      payloadDigest: createHash('sha256').update(request.rawBody).digest('hex'),
      publicationMode: 'app-gate',
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
