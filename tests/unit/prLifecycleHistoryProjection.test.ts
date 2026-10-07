import { describe, expect, it, vi } from 'vitest';
import { projectPrLifecycleHistoryEvent } from '../../src/api/prLifecycleHistoryRoute';
import { HttpPrLifecycleHistorySource } from '../../src/review/prLifecycleHistoryHttp';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION } from '../../src/review/groundedEvidenceV2';
import { buildReviewPlanningHistoryContext } from '../../src/review/prReviewPlanningContext';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';

const identity = { repositoryId: 123, owner: 'example', repo: 'candidate', prNumber: 42,
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64) };
const runId = `run_${'1'.repeat(32)}`;
const priorRunId = `run_${'2'.repeat(32)}`;
const snapshotId = '00000000-0000-4000-8000-000000000001';

function lifecycleRow(eventId: string, eventType: 'review.failed' | 'review.completion_recorded') {
  const completion = eventType === 'review.completion_recorded';
  const payload = { status: 'failed', decisionReceipt: {
    ...(completion ? { evidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION } : {}),
    serviceCoverage: { coverageComplete: true, quorumSatisfied: true },
  } };
  return projectPrLifecycleHistoryEvent({ event_id: eventId, event_type: eventType, run_id: priorRunId,
    execution_attempt: 1, head_sha: identity.headSha, base_sha: identity.baseSha,
    policy_digest: identity.policyDigest, config_digest: identity.configDigest,
    context_digest: 'e'.repeat(64), evidence_digest: sha256(canonicalJson(payload)),
    verification_status: 'insufficient', payload });
}

describe('PR lifecycle completion projection', () => {
  it('roundtrips failure and completion events and keeps complete failed coverage available for repair', async () => {
    const events = [lifecycleRow('00000000-0000-4000-8000-000000000002', 'review.failed'),
      lifecycleRow('00000000-0000-4000-8000-000000000003', 'review.completion_recorded')];
    expect(events[0]).not.toHaveProperty('completionStatus');
    expect(events[0]).not.toHaveProperty('coverageComplete');
    expect(events[0]).not.toHaveProperty('quorumSatisfied');
    expect(events[1]).toMatchObject({ completionStatus: 'failed', coverageComplete: true, quorumSatisfied: true,
      evidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION });
    const snapshot = { version: 'PrLifecycleHistorySnapshot.v1', snapshotId, runId, executionAttempt: 2,
      ...identity, contextDigest: 'f'.repeat(64), eventCount: events.length, findingCount: 0,
      eventOmittedCount: 0, findingOmittedCount: 0, legacyOmittedCount: 0,
      authenticatedDisputes: { status: 'complete', disputes: [], paths: [] },
      eventsDigest: sha256(canonicalJson(events.map((event) => event.eventId))),
      findingsDigest: sha256(canonicalJson([])), expiresAt: '2026-10-07T00:00:00.000Z' };
    const eventPage = { version: 'PrLifecycleHistoryPage.v1', snapshotId, collection: 'events', offset: 0,
      limit: 100, totalCount: events.length, capturedCount: events.length, rows: events,
      hasMore: false, nextOffset: null };
    const fetchImplementation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(request.version === 'PrLifecycleHistorySnapshotRequest.v1' ? snapshot : eventPage),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const history = await new HttpPrLifecycleHistorySource({ token: 'ghs_history_projection_fixture',
      completionEndpoint: 'https://dispatch.example.invalid/api/dispatch/completion', runId, executionAttempt: 2,
      identity, fetchImplementation: fetchImplementation as typeof fetch }).read();

    expect(history.status).toBe('complete');
    const planning = buildReviewPlanningHistoryContext({ history,
      threadSnapshot: { source: 'service', headSha: identity.headSha, complete: true, omittedCount: 0, threads: [] },
      expectedHeadSha: identity.headSha, expectedBaseSha: identity.baseSha,
      expectedPolicyDigest: identity.policyDigest, expectedConfigDigest: identity.configDigest });
    expect(planning.evidenceSemanticsCompatibility).toMatchObject({ completionStatus: 'failed',
      completionCoverageComplete: true, completionQuorumSatisfied: true,
      compatibleForCheckpointReuse: true, compatibleForCoverageReuse: true });
  });
});
