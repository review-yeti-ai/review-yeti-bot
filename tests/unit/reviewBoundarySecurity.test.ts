import { describe, expect, it } from 'vitest';
import { ReviewConversation } from '../../src/chat/reviewConversation';
import { createPRSnapshot, assertSnapshotCurrent } from '../../src/review/prSnapshot';
import { sanitizeFinding } from '../../src/review/reviewCore';
import { resolveSubmoduleDecision } from '../../src/review/submodulePolicy';
import { resolveEffectivePolicy } from '../../src/policy/effectivePolicy';
import { TenantBoundary } from '../../src/policy/tenantBoundary';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const run = {
  runId: 'run_security',
  identity: { owner: 'o', repo: 'r', prNumber: 1, headSha, baseSha, snapshotDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64) },
  identityDigest: 'e'.repeat(64),
  effectivePolicyDigest: 'd'.repeat(64),
  effectiveConfigDigest: 'd'.repeat(64),
  indexEpoch: 1,
  status: 'succeeded' as const,
  stage: 'complete' as const,
  attempt: 1,
  artifacts: {},
  createdAt: 1,
  updatedAt: 1,
};

describe('review boundary security contracts', () => {
  it('rejects findings outside the changed-file and changed-line boundary', () => {
    const changedFiles = [{ path: 'src/a.ts', patch: '@@ -1,1 +10,1 @@\n+const safe = true;\n' }];
    expect(sanitizeFinding({ severity: 'P1', path: 'src/other.ts', line: 10, title: 'x', body: 'x' }, changedFiles)).toBeNull();
    expect(sanitizeFinding({ severity: 'P1', path: 'src/a.ts', line: 11, title: 'x', body: 'x' }, changedFiles)).toBeNull();
  });

  it('rejects stale snapshots and uncited conversations', () => {
    const snapshot = createPRSnapshot({ owner: 'o', repo: 'r', prNumber: 1, headSha, baseSha, configRef: baseSha, configDigest: 'd'.repeat(64), engineVersion: 'test', changedFiles: [] });
    expect(() => assertSnapshotCurrent(snapshot, { headSha: 'f'.repeat(40), baseSha })).toThrow(/head SHA/i);
    expect(new ReviewConversation().answer('explain', { id: 'f', path: 'src/a.ts', line: 1, body: 'finding' }, run as any)).toMatchObject({ kind: 'rejected', citations: [] });
  });

  it('fails closed for an unpinned submodule transition', () => {
    expect(resolveSubmoduleDecision({ path: 'vendor/lib', mode: '160000', isSubmodule: true, newSha: 'not-a-sha' }, { mode: 'metadata_only', require_pinned_commit: true })).toMatchObject({ decision: 'BLOCK' });
  });

  it('does not allow lower policy layers to disable platform fail-closed flags', () => {
    const effective = resolveEffectivePolicy([
      { name: 'platform', values: { requireEvidence: true, failClosed: true } },
      { name: 'repository', values: { requireEvidence: false, failClosed: false } },
    ]);
    expect(effective.policy.requireEvidence).toBe(true);
    expect(effective.policy.failClosed).toBe(true);
    const enabled = resolveEffectivePolicy([
      { name: 'platform', values: { allowRecursiveSubmodules: false } },
      { name: 'repository', values: { allowRecursiveSubmodules: true } },
    ]);
    expect(enabled.policy.allowRecursiveSubmodules).toBe(true);
  });

  it('matches GitHub repository authorization case-insensitively', () => {
    expect(() => new TenantBoundary().assertAccess(
      { tenantId: 'tenant-a', repositories: ['CallTelemetry/CT-Review-Bot'] },
      { tenantId: 'tenant-a', owner: 'calltelemetry', repo: 'ct-review-bot' },
    )).not.toThrow();
  });
});
