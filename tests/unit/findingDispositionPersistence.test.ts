import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';
import { durableFindingIdFor, type FindingDispositionEvent } from '../../src/review/findingDisposition';
import { recordTrustedPrReviewCompletion, type ReviewLifecycleQueryable } from '../../src/persistence/reviewPrLifecycleRepository';

const runId = `run_${'1'.repeat(32)}`;
const headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40), digest = 'd'.repeat(64);
const lifecycleId = '00000000-0000-4000-8000-000000000001';
const fingerprint = `fp1_${'f'.repeat(24)}`;
const findingId = durableFindingIdFor(lifecycleId, fingerprint);
const findingEventId = '00000000-0000-4000-8000-000000000002';
const fixedEventId = '00000000-0000-4000-8000-000000000003';

function dispositions(): FindingDispositionEvent[] {
  const common = { version: 'PrFindingDisposition.v1' as const, findingId, fingerprint, path: 'src/auth.ts',
    runId, executionAttempt: 1, headSha, baseSha, policyDigest: digest, configDigest: digest,
    contextDigest: digest, affectedContextDigest: digest, evidenceDigest: digest };
  return [
    { ...common, kind: 'author_explanation', provenance: { actorType: 'human', actorDigest: digest,
      source: 'github_review_thread', receiptDigest: digest, sourceIdDigest: digest },
      explanation: { text: 'This follows the documented contract.', trust: 'untrusted' } },
    { ...common, kind: 'adjudicated_false_positive', provenance: { actorType: 'service', actorDigest: digest,
      source: 'grounded_verifier', receiptDigest: digest },
      adjudication: { method: 'independent_grounded_verifier', status: 'contradicted', proofDigest: digest } },
    { ...common, kind: 'accepted_convention', provenance: { actorType: 'human', actorDigest: digest,
      source: 'trusted_operator_adjudication', receiptDigest: digest, sourceIdDigest: digest, permission: 'maintain' },
      adjudication: { method: 'authorized_human', conventionId: 'naming-contract', status: 'accepted', proofDigest: digest } },
    { ...common, kind: 'fixed', provenance: { actorType: 'service', actorDigest: digest,
      source: 'grounded_verifier', receiptDigest: digest },
      adjudication: { method: 'independent_grounded_verifier', status: 'contradicted', proofDigest: digest,
        priorFindingEventId: findingEventId, changedContextDigest: digest } },
    { ...common, kind: 'regressed', provenance: { actorType: 'service', actorDigest: digest,
      source: 'grounded_verifier', receiptDigest: digest },
      adjudication: { method: 'independent_grounded_verifier', status: 'confirmed', proofDigest: digest,
        priorFixedEventId: fixedEventId, rootCauseEvidenceKey: 'per-review-cause-key', causalScope: 'introduced' } },
  ];
}

describe('append-only lifecycle disposition persistence', () => {
  it('persists each typed disposition as a distinct exact-review event with actor provenance', async () => {
    const inserts: Array<{ values: unknown[]; payload: Record<string, unknown> }> = [];
    const client: ReviewLifecycleQueryable = { query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('UPDATE review_pr_review_reservations')) return { rows: [{ lifecycle_id: lifecycleId,
        reservation_id: '00000000-0000-4000-8000-000000000004', head_sha: headSha, base_sha: baseSha,
        policy_digest: digest, config_digest: digest, context_digest: digest }] };
      if (sql.startsWith('SELECT repository_id, owner, repo, pr_number FROM review_pr_lifecycles')) return {
        rows: [{ repository_id: 123, owner: 'example', repo: 'project', pr_number: 42 }],
      };
      if (sql.includes('FROM review_pr_lifecycles WHERE lifecycle_id = $1')) return {
        rows: [{ repository_id: 123, owner: 'example', repo: 'project', pr_number: 42 }],
      };
      if (sql.startsWith('INSERT INTO review_pr_lifecycle_events')) {
        const payload = JSON.parse(String(values[17])) as Record<string, unknown>;
        inserts.push({ values, payload });
        return { rows: [{ event_id: '00000000-0000-4000-8000-000000000005' }] };
      }
      if (sql.startsWith('SELECT r.reservation_id, r.lifecycle_id, l.repository_id')) return {
        rows: [{ reservation_id: '00000000-0000-4000-8000-000000000004', lifecycle_id: lifecycleId,
          repository_id: 123, pr_number: 42, head_sha: headSha, base_sha: baseSha,
          policy_digest: digest, config_digest: digest, context_digest: digest, owner: 'example', repo: 'project' }],
      };
      if (sql.startsWith('SELECT durable_finding_id FROM review_semantic_finding_events')) {
        return { rows: [{ durable_finding_id: findingId }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }) };

    await recordTrustedPrReviewCompletion(client, { runId, executionAttempt: 1, status: 'failed',
      completionDigest: digest, decisionReceipt: { gate: 'failure' }, findings: [], dispositions: dispositions(), at: 1_800_000_000_000 });

    const rows = inserts.filter(({ payload }) => payload.version === 'PrFindingDisposition.v1');
    expect(rows.map(({ values }) => values[4])).toEqual([
      'finding.disposition.author_explanation', 'finding.disposition.adjudicated_false_positive',
      'finding.disposition.accepted_convention', 'finding.disposition.fixed', 'finding.disposition.regressed',
    ]);
    expect(rows.map(({ payload }) => payload.kind)).toEqual([
      'author_explanation', 'adjudicated_false_positive', 'accepted_convention', 'fixed', 'regressed',
    ]);
    expect(rows[0]?.payload).toMatchObject({ explanation: { trust: 'untrusted' },
      provenance: { actorType: 'human', source: 'github_review_thread' } });
    expect(rows[2]?.payload).toMatchObject({
      provenance: { actorType: 'human', source: 'trusted_operator_adjudication', permission: 'maintain' },
    });
    expect(rows.map(({ values }) => values[15])).toEqual([digest, digest, digest, digest, digest]);
    expect(new Set(rows.map(({ values }) => values[3])).size).toBe(5);
    expect(rows.every(({ values, payload }) => sha256(canonicalJson(payload)) === values[14])).toBe(true);
  });

  it('refuses a disposition bound to another head or policy', async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.startsWith('UPDATE review_pr_review_reservations')) return { rows: [{ lifecycle_id: lifecycleId,
        reservation_id: '00000000-0000-4000-8000-000000000004', head_sha: headSha, base_sha: baseSha,
        policy_digest: digest, config_digest: digest, context_digest: digest }] };
      if (sql.startsWith('SELECT repository_id, owner, repo, pr_number FROM review_pr_lifecycles')) return {
        rows: [{ repository_id: 123, owner: 'example', repo: 'project', pr_number: 42 }],
      };
      if (sql.includes('FROM review_pr_lifecycles WHERE lifecycle_id = $1')) return {
        rows: [{ repository_id: 123, owner: 'example', repo: 'project', pr_number: 42 }],
      };
      if (sql.startsWith('INSERT INTO review_pr_lifecycle_events')) return { rows: [{ event_id: '00000000-0000-4000-8000-000000000005' }] };
      if (sql.startsWith('SELECT r.reservation_id, r.lifecycle_id, l.repository_id')) return {
        rows: [{ reservation_id: '00000000-0000-4000-8000-000000000004', lifecycle_id: lifecycleId,
          repository_id: 123, pr_number: 42, head_sha: headSha, base_sha: baseSha,
          policy_digest: digest, config_digest: digest, context_digest: digest, owner: 'example', repo: 'project' }],
      };
      if (sql.startsWith('SELECT durable_finding_id FROM review_semantic_finding_events')) return { rows: [{ durable_finding_id: findingId }] };
      throw new Error(`unexpected query: ${sql}`);
    }) };
    const mismatched = { ...dispositions()[0]!, headSha: 'c'.repeat(40) };

    await expect(recordTrustedPrReviewCompletion(client, { runId, executionAttempt: 1, status: 'failed',
      completionDigest: digest, decisionReceipt: {}, findings: [], dispositions: [mismatched], at: 1_800_000_000_000 }))
      .rejects.toThrow('does not match the admitted review context');
  });

  it('assigns separate opaque durable IDs to same-text occurrences without using their per-review keys as IDs', async () => {
    const semanticRows: unknown[][] = [];
    let generatedFindingEvent = 20;
    const client: ReviewLifecycleQueryable = { query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('UPDATE review_pr_review_reservations')) return { rows: [{ lifecycle_id: lifecycleId,
        reservation_id: '00000000-0000-4000-8000-000000000004', head_sha: headSha, base_sha: baseSha,
        policy_digest: digest, config_digest: digest, context_digest: digest }] };
      if (sql.includes('FROM review_pr_lifecycles WHERE lifecycle_id = $1')) return {
        rows: [{ repository_id: 123, owner: 'example', repo: 'project', pr_number: 42 }],
      };
      if (sql.startsWith('INSERT INTO review_pr_lifecycle_events')) return { rows: [{ event_id: randomUuidForTest() }] };
      if (sql.startsWith('SELECT r.reservation_id, r.lifecycle_id, l.repository_id')) return {
        rows: [{ reservation_id: '00000000-0000-4000-8000-000000000004', lifecycle_id: lifecycleId,
          repository_id: 123, pr_number: 42, head_sha: headSha, base_sha: baseSha,
          policy_digest: digest, config_digest: digest, context_digest: digest, owner: 'example', repo: 'project' }],
      };
      if (sql.startsWith('SELECT finding_event_id, durable_finding_id, first_seen_head')) return { rows: [] };
      if (sql.startsWith('INSERT INTO review_semantic_finding_events')) {
        semanticRows.push(values);
        generatedFindingEvent += 1;
        return { rows: [{ finding_event_id: `00000000-0000-4000-8000-${String(generatedFindingEvent).padStart(12, '0')}` }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }) };
    const rootA = 'first-occurrence-context-key';
    const rootB = 'second-occurrence-context-key';
    const finding = (rootCauseEvidenceKey: string, line: number) => ({
      fingerprint, rootCauseEvidenceKey, path: 'src/auth.ts', line, severity: 'P1', disposition: 'new', blocking: true,
      affectedContextDigest: digest, sourceEvidence: { title: 'Authorization bypass', line }, provenance: {},
    });

    await recordTrustedPrReviewCompletion(client, { runId, executionAttempt: 1, status: 'failed',
      completionDigest: digest, decisionReceipt: { gate: 'failure' }, findings: [finding(rootA, 12), finding(rootB, 80)],
      at: 1_800_000_000_000 });

    expect(semanticRows).toHaveLength(2);
    expect(semanticRows[0]?.[3]).not.toBe(semanticRows[1]?.[3]);
    expect(semanticRows[0]?.[6]).not.toBe(semanticRows[1]?.[6]);
    expect([semanticRows[0]?.[6], semanticRows[1]?.[6]]).not.toContain(rootA);
    expect([semanticRows[0]?.[6], semanticRows[1]?.[6]]).not.toContain(rootB);
  });
});

let uuidSequence = 0;
function randomUuidForTest(): string {
  uuidSequence += 1;
  return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, '0')}`;
}
