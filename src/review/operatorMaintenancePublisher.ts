import { z } from 'zod';
import {
  CHECK_CONTEXT_GATE, CHECK_CONTEXT_RAW_REVIEW,
  type GitHubInstallationClient, type OperatorMaintenanceCheckInput,
} from '../github/installationClient';
import type { OperatorMaintenanceRepository, OperatorMaintenanceResult,
  OperatorMaintenanceIdentity, OperatorMaintenancePolicyResolution, OperatorMaintenanceReceiptV1 } from './operatorMaintenanceContracts';
import { createOperatorMaintenanceIntentId, operatorMaintenanceIdentitySchema,
  operatorMaintenanceReceiptSchema, OperatorMaintenanceTargetChangedError } from './operatorMaintenanceContracts';
import type { AuthoritativePublishingResolver, RequestedReviewCandidate } from './authoritativePublishingResolver';
import type { AuthoritativePublishingResolution } from './authoritativePublishingResolver';
import { sha256 } from './reviewCore';

const targetSha = z.string().regex(/^[a-f0-9]{40}$/u);
const positiveInteger = z.number().int().positive().safe();
const repositoryName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u).refine((value) => value !== '.' && value !== '..');

export type OperatorMaintenanceRequest = {
  source: OperatorMaintenanceReceiptV1['source'];
  candidate: RequestedReviewCandidate;
} | {
  source: 'github-app-webhook';
  mergeGroup: {
    identity: OperatorMaintenanceIdentity;
    policyPullRequest: { repositoryId: number; owner: string; repo: string; prNumber: number; headSha: string };
    /** Re-read the authenticated merge queue before each external side effect. */
    verifyCurrent: () => Promise<void>;
  };
};

export interface OperatorMaintenancePublisherOptions {
  enabled: boolean;
  expectedAppIdFor(identity: Pick<OperatorMaintenanceIdentity, 'repositoryId' | 'owner' | 'repo'>): number;
  repositoryIds: readonly number[];
  resolver: Pick<AuthoritativePublishingResolver, 'resolve' | 'resolveCurrent'>;
  repository: OperatorMaintenanceRepository;
  clientFor(identity: Pick<OperatorMaintenanceIdentity, 'repositoryId' | 'owner' | 'repo'>,
    expectedAppId: number): Promise<Pick<GitHubInstallationClient,
      'reconcileOperatorMaintenanceCheck' | 'publishOperatorMaintenanceCheck' | 'completeOperatorMaintenanceCheck'
    >>;
  verifyMergeGroupCurrent?(identity: OperatorMaintenanceIdentity,
    policyResolution: OperatorMaintenancePolicyResolution): Promise<void>;
  now?: () => number;
  leaseMs?: number;
}

const PREFIX = 'operator-maintenance:v1:';
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_SWEEP_LIMIT = 20;

function checkExternalId(intentId: string, stage: 'raw' | 'gate'): string {
  return `review-yeti-maintenance:v1:${intentId.slice(PREFIX.length)}:${stage}`;
}

function samePolicy(left: OperatorMaintenanceReceiptV1['policy'], right: AuthoritativePublishingResolution['prepared']['policy']): boolean {
  return left.effectivePolicyDigest === right.effectivePolicyDigest
    && left.effectiveConfigDigest === right.effectiveConfigDigest
    && JSON.stringify(left.sources) === JSON.stringify(right.sources);
}

function summary(receipt: OperatorMaintenanceReceiptV1, stage: 'raw' | 'gate'): string {
  const lines = [
    'review-mode=passthrough',
    'review-completed=false',
    'decision=SHIP',
    'reason=operator_global_passthrough',
    `intent-id=${receipt.intentId}`,
    `subject-kind=${receipt.identity.subject.kind}`,
    `repository-id=${receipt.identity.repositoryId}`,
    `head-sha=${receipt.identity.headSha}`,
    `base-sha=${receipt.identity.baseSha}`,
    `source=${receipt.source}`,
    `operator-config-digest=${receipt.authority.configDigest}`,
    `effective-policy-digest=${receipt.policy.effectivePolicyDigest}`,
    `effective-config-digest=${receipt.policy.effectiveConfigDigest}`,
    `policy-source-count=${receipt.policy.sources.length}`,
  ];
  for (const [index, source] of receipt.policy.sources.entries()) {
    lines.push(`policy-source.${index}.repository-id=${source.repositoryId}`);
    lines.push(`policy-source.${index}.repository-base64url=${Buffer.from(source.repository, 'utf8').toString('base64url')}`);
    lines.push(`policy-source.${index}.sha=${source.sha}`);
    lines.push(`policy-source.${index}.path-base64url=${Buffer.from(source.path, 'utf8').toString('base64url')}`);
    lines.push(`policy-source.${index}.content-digest=${source.contentDigest}`);
  }
  if (receipt.identity.subject.kind === 'pull_request') {
    lines.push(`pull-request-number=${receipt.identity.subject.prNumber}`);
  } else {
    lines.push(`head-ref-base64url=${Buffer.from(receipt.identity.subject.headRef, 'utf8').toString('base64url')}`);
    lines.push(`base-ref-base64url=${Buffer.from(receipt.identity.subject.baseRef, 'utf8').toString('base64url')}`);
    const policyResolution = receipt.policyResolution;
    if (!policyResolution) throw new Error('Merge-group maintenance receipt has no policy-resolution pull request');
    lines.push(`policy-resolution-pr-number=${policyResolution.prNumber}`);
    lines.push(`policy-resolution-pr-head-sha=${policyResolution.headSha}`);
    lines.push(`policy-resolution-pr-base-sha=${policyResolution.baseSha}`);
  }
  lines.push(`check-kind=${stage}`);
  return lines.join('\n');
}

function targetIdentity(resolved: AuthoritativePublishingResolution, requested: RequestedReviewCandidate): OperatorMaintenanceIdentity {
  return operatorMaintenanceIdentitySchema.parse({
    repositoryId: resolved.current.repositoryId,
    owner: resolved.current.owner,
    repo: resolved.current.repo,
    headSha: resolved.current.headSha,
    baseSha: resolved.current.baseSha,
    subject: { kind: 'pull_request', prNumber: requested.prNumber },
  });
}

function assertReviewable(resolved: AuthoritativePublishingResolution, expected: {
  repositoryId: number; owner: string; repo: string; prNumber: number; headSha?: string; baseSha?: string;
}): void {
  const current = resolved.current;
  if (!current.open || current.draft !== false
    || current.repositoryId !== expected.repositoryId || current.owner !== expected.owner
    || current.repo !== expected.repo || current.prNumber !== expected.prNumber
    || (expected.headSha !== undefined && current.headSha !== expected.headSha)
    || (expected.baseSha !== undefined && current.baseSha !== expected.baseSha)) {
    throw new OperatorMaintenanceTargetChangedError();
  }
}

export class OperatorMaintenancePublisher {
  private readonly now: () => number;
  private readonly leaseMs: number;
  private cursor?: string;

  constructor(private readonly options: OperatorMaintenancePublisherOptions) {
    this.now = options.now || Date.now;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1_000 || this.leaseMs > 5 * 60_000) {
      throw new Error('Operator maintenance lease duration is invalid');
    }
  }

  async request(input: OperatorMaintenanceRequest): Promise<OperatorMaintenanceResult> {
    if (!this.options.enabled) throw new Error('Operator maintenance mode is disabled');
    const admission = await this.resolveCurrent(input);
    const expectedAppId = this.options.expectedAppIdFor(admission.identity);
    if (!Number.isSafeInteger(expectedAppId) || expectedAppId <= 0
      || !this.options.repositoryIds.includes(admission.identity.repositoryId)) {
      throw new Error('Operator maintenance identity is outside the enrolled App authority');
    }
    const intentId = createOperatorMaintenanceIntentId(admission.identity);
    const digest = intentId.slice(PREFIX.length);
    const authorityDigest = sha256({ version: 'OperatorMaintenanceAuthority.v1',
      setting: 'REVIEW_YETI_PASSTHROUGH', enabled: true });
    const receipt = operatorMaintenanceReceiptSchema.parse({
      version: 'OperatorMaintenanceReceipt.v1', intentId, source: input.source,
      mode: 'passthrough', decision: 'SHIP', reason: 'operator_global_passthrough', reviewCompleted: false,
      identity: admission.identity,
      ...(admission.policyResolution ? { policyResolution: admission.policyResolution } : {}),
      authority: { kind: 'trusted-runtime-operator-config', setting: 'REVIEW_YETI_PASSTHROUGH', configDigest: authorityDigest },
      policy: admission.resolved.prepared.policy,
      checks: {
        raw: { name: CHECK_CONTEXT_RAW_REVIEW, appId: expectedAppId, externalId: checkExternalId(intentId, 'raw') },
        gate: { name: CHECK_CONTEXT_GATE, appId: expectedAppId, externalId: checkExternalId(intentId, 'gate') },
      },
    }) as OperatorMaintenanceReceiptV1;
    const canonical = await this.options.repository.reserve(receipt);
    return this.publishReserved(canonical, input);
  }

  /** Reclaims one bounded page of durable intents from the existing service
   * timer. Stable cursor ordering prevents one transient target from starving
   * later pending rows. */
  async runOnce(limit = DEFAULT_SWEEP_LIMIT): Promise<void> {
    if (!this.options.enabled) return;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Operator maintenance sweep limit is invalid');
    }
    let pending = await this.options.repository.listPending(limit, this.cursor);
    if (pending.length === 0 && this.cursor !== undefined) {
      this.cursor = undefined;
      pending = await this.options.repository.listPending(limit);
    }
    if (pending.length === 0) return;
    this.cursor = pending[pending.length - 1].intentId;
    let hadFailure = false;
    for (const receipt of pending) {
      try {
        const input = this.requestForReceipt(receipt);
        const current = await this.resolvePersisted(receipt, input);
        if (JSON.stringify(current.identity) !== JSON.stringify(receipt.identity)
          || JSON.stringify(current.policyResolution) !== JSON.stringify(receipt.policyResolution)
          || !samePolicy(receipt.policy, current.resolved.prepared.policy)) {
          await this.options.repository.markStale(receipt.intentId, new Date(this.now()));
          continue;
        }
        await this.publishReserved(receipt, input);
      } catch (error) {
        if (error instanceof OperatorMaintenanceTargetChangedError) {
          await this.options.repository.markStale(receipt.intentId, new Date(this.now()));
        } else {
          hadFailure = true;
        }
      }
    }
    if (hadFailure) throw new Error('One or more operator maintenance intents remain pending');
  }

  private requestForReceipt(receipt: OperatorMaintenanceReceiptV1): OperatorMaintenanceRequest {
    if (receipt.identity.subject.kind === 'pull_request') {
      if (receipt.policyResolution) throw new Error('Pull-request maintenance has unexpected policy-resolution coordinates');
      return { source: receipt.source, candidate: {
        repositoryId: receipt.identity.repositoryId, owner: receipt.identity.owner, repo: receipt.identity.repo,
        prNumber: receipt.identity.subject.prNumber, headSha: receipt.identity.headSha, baseSha: receipt.identity.baseSha,
      } };
    }
    const policyResolution = receipt.policyResolution;
    if (!policyResolution || receipt.source !== 'github-app-webhook' || !this.options.verifyMergeGroupCurrent) {
      throw new Error('Merge-group maintenance cannot be retried without its trusted queue verifier');
    }
    return { source: 'github-app-webhook', mergeGroup: {
      identity: receipt.identity,
      policyPullRequest: { ...policyResolution },
      verifyCurrent: () => this.options.verifyMergeGroupCurrent!(receipt.identity, policyResolution),
    } };
  }

  private async resolvePersisted(receipt: OperatorMaintenanceReceiptV1,
    input: OperatorMaintenanceRequest): Promise<{
      identity: OperatorMaintenanceIdentity; resolved: AuthoritativePublishingResolution;
      policyResolution?: OperatorMaintenancePolicyResolution;
    }> {
    if ('candidate' in input && receipt.identity.subject.kind === 'pull_request') {
      const target = input.candidate;
      const resolved = await this.options.resolver.resolveCurrent({
        repositoryId: target.repositoryId, owner: target.owner, repo: target.repo, prNumber: target.prNumber,
      });
      assertReviewable(resolved, target);
      return { identity: targetIdentity(resolved, target), resolved };
    }
    return this.resolveCurrent(input);
  }

  private async publishReserved(canonical: OperatorMaintenanceReceiptV1,
    input: OperatorMaintenanceRequest): Promise<OperatorMaintenanceResult> {
    const expectedAppId = canonical.checks.raw.appId;
    const client = await this.options.clientFor(canonical.identity, expectedAppId);
    const raw = await this.publishStage('raw', canonical, client, () => this.resolveCurrent(input));
    if (raw === 'pending') return { status: 'pending', receipt: canonical };
    const gate = await this.publishStage('gate', canonical, client, () => this.resolveCurrent(input));
    return { status: gate === 'published' ? 'published' : 'pending', receipt: canonical };
  }

  private async resolveCurrent(input: OperatorMaintenanceRequest): Promise<{
    identity: OperatorMaintenanceIdentity; resolved: AuthoritativePublishingResolution;
    policyResolution?: OperatorMaintenancePolicyResolution;
  }> {
    if ('candidate' in input) {
      const target = z.object({
        repositoryId: positiveInteger, owner: repositoryName, repo: repositoryName,
        prNumber: positiveInteger, headSha: targetSha, baseSha: targetSha,
      }).strict().parse(input.candidate);
      if (!this.options.repositoryIds.includes(target.repositoryId)) throw new Error('Operator maintenance target is not enrolled');
      const resolved = await this.options.resolver.resolve(target);
      assertReviewable(resolved, target);
      return { identity: targetIdentity(resolved, target), resolved };
    }

    const identity = operatorMaintenanceIdentitySchema.parse(input.mergeGroup.identity);
    const target = input.mergeGroup.policyPullRequest;
    if (identity.subject.kind !== 'merge_group' || target.repositoryId !== identity.repositoryId
      || target.owner !== identity.owner || target.repo !== identity.repo
      || !positiveInteger.safeParse(target.prNumber).success || !targetSha.safeParse(target.headSha).success
      || !this.options.repositoryIds.includes(identity.repositoryId)) {
      throw new Error('Operator maintenance merge-group identity is invalid');
    }
    await input.mergeGroup.verifyCurrent();
    const resolved = await this.options.resolver.resolveCurrent({
      repositoryId: target.repositoryId, owner: target.owner, repo: target.repo, prNumber: target.prNumber,
    });
    assertReviewable(resolved, target);
    await input.mergeGroup.verifyCurrent();
    return { identity, resolved, policyResolution: {
      repositoryId: resolved.current.repositoryId, owner: resolved.current.owner, repo: resolved.current.repo,
      prNumber: resolved.current.prNumber, headSha: resolved.current.headSha, baseSha: resolved.current.baseSha,
    } };
  }

  private async publishStage(stage: 'raw' | 'gate', receipt: OperatorMaintenanceReceiptV1,
    client: Pick<GitHubInstallationClient, 'reconcileOperatorMaintenanceCheck' | 'publishOperatorMaintenanceCheck'
      | 'completeOperatorMaintenanceCheck'>,
    revalidate: () => Promise<{ identity: OperatorMaintenanceIdentity; resolved: AuthoritativePublishingResolution;
      policyResolution?: OperatorMaintenancePolicyResolution }>): Promise<'published' | 'pending'> {
    const claim = stage === 'raw'
      ? await this.options.repository.claimRaw(receipt.intentId, new Date(this.now()), this.leaseMs)
      : await this.options.repository.claimGate(receipt.intentId, new Date(this.now()), this.leaseMs);
    if (claim.kind === 'busy') return 'pending';
    if (claim.kind === 'stale' || claim.kind === 'blocked') return 'pending';

    const check = stage === 'raw' ? receipt.checks.raw : receipt.checks.gate;
    const expected: OperatorMaintenanceCheckInput = {
      owner: receipt.identity.owner, repo: receipt.identity.repo, headSha: receipt.identity.headSha,
      expectedAppId: check.appId, name: stage === 'raw' ? CHECK_CONTEXT_RAW_REVIEW : CHECK_CONTEXT_GATE,
      externalId: check.externalId,
      intentId: receipt.intentId,
      title: 'SHIP: operator passthrough; review bypassed',
      summary: summary(receipt, stage),
    };
    const validateReceiptStillCurrent = async (): Promise<void> => {
      let current: Awaited<ReturnType<typeof revalidate>>;
      try { current = await revalidate(); }
      catch (error) {
        if (error instanceof OperatorMaintenanceTargetChangedError) {
          await this.options.repository.markStale(receipt.intentId, new Date(this.now()));
        }
        throw error;
      }
      if (JSON.stringify(current.identity) !== JSON.stringify(receipt.identity)
        || JSON.stringify(current.policyResolution) !== JSON.stringify(receipt.policyResolution)
        || !samePolicy(receipt.policy, current.resolved.prepared.policy)
        || sha256({ version: 'OperatorMaintenanceAuthority.v1', setting: 'REVIEW_YETI_PASSTHROUGH', enabled: this.options.enabled })
          !== receipt.authority.configDigest) {
        await this.options.repository.markStale(receipt.intentId, new Date(this.now()));
        throw new OperatorMaintenanceTargetChangedError();
      }
    };

    if (claim.kind === 'bound') {
      let found = await client.reconcileOperatorMaintenanceCheck(expected);
      if (!found || found.id !== claim.checkId) throw new Error('Persisted operator check cannot be reconciled');
      if (found.state === 'in_progress') found = await client.completeOperatorMaintenanceCheck(expected, found.id);
      if (found.state !== 'completed') throw new Error('Persisted operator check is not complete');
      await validateReceiptStillCurrent();
      return 'published';
    }

    // Every first attempt and every reclaimed lease reconciles GitHub first.
    await validateReceiptStillCurrent();
    let found = await client.reconcileOperatorMaintenanceCheck(expected);
    if (found) {
      if (found.state === 'in_progress') found = await client.completeOperatorMaintenanceCheck(expected, found.id);
      if (found.state !== 'completed') throw new Error('Reconciled operator check is not complete');
      if (stage === 'raw') await this.options.repository.bindRaw(receipt.intentId, claim.leaseToken, found.id, new Date(this.now()));
      else await this.options.repository.bindGate(receipt.intentId, claim.leaseToken, found.id, new Date(this.now()));
      return 'published';
    }
    await validateReceiptStillCurrent();
    const created = await client.publishOperatorMaintenanceCheck(expected);
    if (created.state !== 'completed') throw new Error('Operator maintenance check publication is incomplete');
    if (stage === 'raw') await this.options.repository.bindRaw(receipt.intentId, claim.leaseToken, created.id, new Date(this.now()));
    else await this.options.repository.bindGate(receipt.intentId, claim.leaseToken, created.id, new Date(this.now()));
    return 'published';
  }
}
