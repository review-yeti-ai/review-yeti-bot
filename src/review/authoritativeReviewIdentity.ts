import { z } from 'zod';
import { sha256 } from './reviewCore';
import { buildReviewRunIdentity } from './reviewAdmission';
import type { ReviewRunIdentity } from './reviewRun';

const positiveInteger = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const repositoryName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u).max(201);

/** These are server-resolved immutable source descriptors, not request fields.
 * Persist digests/provenance only; never persist provider credentials here. */
export const reviewPolicySourceSchema = z.object({
  repositoryId: positiveInteger,
  repository: repositoryName,
  sha,
  path: z.string().min(1).max(512).refine((value) => !value.startsWith('/')
    && !value.split('/').some((part) => part === '' || part === '.' || part === '..')
    && !/[\\\u0000-\u001f\u007f]/u.test(value)),
  contentDigest: digest,
}).strict();

const resolvedPolicySchema = z.object({
  effectiveConfigDigest: digest,
  effectivePolicyDigest: digest,
  sources: z.array(reviewPolicySourceSchema).min(1).max(16),
}).strict();

export type TrustedResolvedReviewPolicy = z.infer<typeof resolvedPolicySchema>;

export interface AuthoritativeReviewRunIdentity extends ReviewRunIdentity {
  reviewPolicy: {
    version: 'ReviewPolicyIdentity.v1';
    repositoryId: number;
    effectivePolicyDigest: string;
    sources: TrustedResolvedReviewPolicy['sources'];
  };
}

export interface CurrentReviewCandidate {
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  open: boolean;
  draft: boolean;
}

const candidateSchema = z.object({
  repositoryId: positiveInteger,
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/u).min(1).max(100),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+$/u).min(1).max(100),
  prNumber: positiveInteger,
  headSha: sha,
  baseSha: sha,
  open: z.boolean(),
  draft: z.boolean(),
}).strict();

function normalizeSources(input: TrustedResolvedReviewPolicy['sources']): TrustedResolvedReviewPolicy['sources'] {
  const sources = z.array(reviewPolicySourceSchema).min(1).max(16).parse(input)
    .sort((left, right) => {
      const a = JSON.stringify(left); const b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  if (new Set(sources.map((source) => `${source.repositoryId}:${source.sha}:${source.path}`)).size !== sources.length) {
    throw new Error('Authoritative policy contains duplicate source identities');
  }
  return sources;
}

function requireBoundedJsonObject(value: unknown): void {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 16_384 || depth > 32) throw new Error('Trusted policy/config exceeds its structural bound');
    if (item === null || typeof item === 'boolean' || typeof item === 'string'
      || (typeof item === 'number' && Number.isFinite(item))) return;
    if (!item || typeof item !== 'object' || seen.has(item)) throw new Error('Trusted policy/config must be finite JSON');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error('Trusted policy/config must contain only JSON objects');
    }
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      // The shared canonical hash deliberately accepts plain JSON only here.
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Trusted policy/config contains an unsafe key');
      visit(child, depth + 1);
    }
    seen.delete(item);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Trusted policy/config must be resolved objects');
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 256 * 1024) throw new Error('Trusted policy/config exceeds its byte bound');
}

/** Called only after the service re-reads GitHub and resolves centrally owned
 * policy at immutable revisions. This pure boundary cannot establish trust in
 * caller-provided policy; the network admission adapter owns that obligation. */
export function buildAuthoritativeReviewIdentity(input: {
  requested: Pick<CurrentReviewCandidate, 'repositoryId' | 'owner' | 'repo' | 'prNumber' | 'headSha' | 'baseSha'>;
  current: CurrentReviewCandidate;
  policy: TrustedResolvedReviewPolicy;
}): AuthoritativeReviewRunIdentity {
  const current = candidateSchema.parse(input.current);
  const requested = candidateSchema.parse({ ...input.requested, open: true, draft: false });
  if (!current.open || ['repositoryId', 'owner', 'repo', 'prNumber', 'headSha', 'baseSha']
    .some((key) => current[key as keyof CurrentReviewCandidate] !== requested[key as keyof CurrentReviewCandidate])) {
    throw new Error('Authoritative review request does not match the current open candidate');
  }
  const policy = resolvedPolicySchema.parse(input.policy);
  const sources = normalizeSources(policy.sources);
  return {
    ...buildReviewRunIdentity({ ...current, configDigest: policy.effectiveConfigDigest }),
    reviewPolicy: {
      version: 'ReviewPolicyIdentity.v1', repositoryId: current.repositoryId,
      effectivePolicyDigest: policy.effectivePolicyDigest, sources,
    },
  };
}

/** Fingerprints a trusted prepared policy/config without storing their content.
 * Selection and normalization remain with the central policy owner. */
export function fingerprintEffectiveReviewConfig(effectiveConfig: unknown): string {
  requireBoundedJsonObject(effectiveConfig);
  // The worker can verify its actual config with this same function without
  // receiving repository credentials or resolving mutable policy references.
  // Immutable source provenance remains bound by the outer policy/run identity.
  return sha256({ version: 'ReviewConfigFingerprint.v1', config: effectiveConfig });
}

export function fingerprintTrustedReviewPolicy(input: {
  effectiveConfig: unknown;
  effectivePolicy: unknown;
  sources: TrustedResolvedReviewPolicy['sources'];
}): TrustedResolvedReviewPolicy {
  const sources = normalizeSources(input.sources);
  requireBoundedJsonObject(input.effectivePolicy);
  const effectiveConfigDigest = fingerprintEffectiveReviewConfig(input.effectiveConfig);
  return {
    effectiveConfigDigest,
    effectivePolicyDigest: sha256({ version: 'ReviewPolicyFingerprint.v1', sources, effectiveConfigDigest, policy: input.effectivePolicy }),
    sources,
  };
}
