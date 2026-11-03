import type { OperatorPassthroughIdentity } from './operatorPassthroughTypes.js';

export const OPERATOR_PASSTHROUGH_EXTERNAL_SUFFIX = ':review-mode=passthrough:op2';
export const OPERATOR_PASSTHROUGH_SUMMARY_SENTENCE =
  'review-mode=passthrough. Operator SHIP disposition; no semantic review was run; zero lanes were started.';
export const OPERATOR_PASSTHROUGH_REVIEW_TITLE = 'Review Yeti: SHIP (passthrough: no review performed)';
export const OPERATOR_PASSTHROUGH_GATE_TITLE = 'Review Yeti Gate: SHIP (passthrough: no review performed)';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** Must stay aligned with the publisher's identity-derived publication/run IDs. */
export async function operatorPassthroughPublicationId(identity: OperatorPassthroughIdentity): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(identity))));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function operatorPassthroughCheckSummary(
  identity: OperatorPassthroughIdentity,
  runId: string,
  publicationId: string,
  auditDigest: string
): string {
  return [
    OPERATOR_PASSTHROUGH_SUMMARY_SENTENCE,
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
