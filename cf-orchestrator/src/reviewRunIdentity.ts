import type { ReviewRunSpec } from './types.js';

export async function reviewRunSpecDigest(spec: Pick<ReviewRunSpec, 'runId' | 'owner' | 'repo' | 'prNumber' | 'headSha' | 'baseSha'>): Promise<string> {
  const identity = JSON.stringify([
    spec.runId,
    spec.owner.toLowerCase(),
    spec.repo.toLowerCase(),
    spec.prNumber,
    spec.headSha,
    spec.baseSha,
  ]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
