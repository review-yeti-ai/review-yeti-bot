import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import fs from 'node:fs';
import path from 'node:path';
import { runReviewWorkflowFixture } from '../support/reviewWorkflowHarness';
import { loadReviewWorkflowFixture } from '../support/reviewWorkflowFixtures';

const reviewEventSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../schemas/review-event.v1.schema.json'), 'utf8'));
const validateReviewEventSchema = new Ajv2020({ strict: false, validateFormats: false }).compile(reviewEventSchema);

function canonicalReceipt(value: any) {
  const artifacts = value.reviewDispatch?.artifacts;
  return {
    ...value,
    startedAt: 0,
    finishedAt: 0,
    outbox: { ...value.outbox, path: '<outbox>' },
    reviewDispatch: artifacts
      ? { ...value.reviewDispatch, artifacts: { ...artifacts, artifactDirectory: '<artifacts>', receiptPath: '<receipt>', manifestPath: '<manifest>' } }
      : value.reviewDispatch,
    actionOutputs: value.actionOutputs
      .replace(/memory-outbox-path=.*\n/u, 'memory-outbox-path=<outbox>\n')
      .replace(/review-dispatch-receipt-path=.*\n/u, 'review-dispatch-receipt-path=<receipt>\n')
      .replace(/review-dispatch-manifest-path=.*\n/u, 'review-dispatch-manifest-path=<manifest>\n'),
  };
}

describe('cassette-backed review workflow harness', () => {
  it('resolves the immutable base SHA before applying an opted-in trusted review policy', async () => {
    const receipt = await runReviewWorkflowFixture('fresh-clean', { reviewIntelligence: true });
    expect(receipt.verdict).toBe('SHIP');
    expect(receipt.headSha).toBe('a'.repeat(40));
  });

  it('uses the repository_dispatch target head instead of the central runner SHA for policy verification', async () => {
    const receipt = await runReviewWorkflowFixture('fresh-clean', { reviewIntelligence: true, repositoryDispatch: true });
    expect(receipt).toMatchObject({ verdict: 'SHIP', headSha: 'a'.repeat(40) });
  });

  it('executes the intelligence-evaluation fixture at the pipeline boundary with its exact head and selected provider', async () => {
    const fixture = loadReviewWorkflowFixture(path.resolve(__dirname, '../fixtures/review-workflows/intelligence-evaluation.json'));
    const receipt = await runReviewWorkflowFixture('intelligence-evaluation', { memoryAvailable: false });
    expect(receipt).toMatchObject({
      verdict: fixture.expected.verdict,
      provider: fixture.config.provider,
      headSha: fixture.event.headSha,
      coverage: { status: fixture.expected.coverageStatus, mergeEligible: fixture.expected.mergeEligible },
      publication: { success: fixture.expected.publishedReviewCount > 0 },
      memory: { query: { status: fixture.expected.memoryQueryStatus }, write: { status: fixture.expected.memoryWriteStatus } },
      outbox: { state: fixture.expected.outboxState },
    });
  });

  it('keeps Action-resolved target SHAs when a repository_dispatch payload conflicts', async () => {
    const receipt = await runReviewWorkflowFixture('fresh-clean', {
      reviewIntelligence: true,
      repositoryDispatch: true,
      conflictingDispatchPayload: true,
    });
    expect(receipt).toMatchObject({ verdict: 'SHIP', headSha: 'a'.repeat(40) });
  });

  it('runs the real pipeline boundary from fixture input through publication and memory write', async () => {
    const receipt = await runReviewWorkflowFixture('fresh-clean');
    expect(receipt).toMatchObject({
      verdict: 'SHIP',
      coverage: { mergeEligible: true, completedPersonas: 2, totalPersonas: 2 },
      publication: { success: true },
      provider: 'mem0',
      memory: { query: { status: 'empty' }, write: { status: 'accepted' } },
      outbox: { state: 'accepted' },
    });
    expect(receipt.outbox.path).toMatch(/sessions[\\/].+\.memory-outbox\.json$/u);
    expect(receipt.actionOutputs).toContain('memory-provider=mem0');
    expect(receipt.actionOutputs).toContain('memory-query-status=empty');
    expect(receipt.actionOutputs).toContain('memory-write-status=accepted');
  });

  it('publishes reviewing before terminal dashboard state without changing the verdict or GitHub publication', async () => {
    const receipt = await runReviewWorkflowFixture('fresh-clean', { dashboardStatus: 202 });

    expect(receipt).toMatchObject({
      verdict: 'SHIP',
      publication: { success: true },
      dashboard: { status: 'accepted', attempts: 1 },
      dashboardStarted: { status: 'accepted', attempts: 1 },
    });
    expect(receipt.dashboardEvents).toHaveLength(2);
    expect(receipt.dashboardEvents[0]).toMatchObject({
      repository: { fullName: 'acme/review-yeti' },
      pullRequest: { number: 42, headSha: 'a'.repeat(40) },
      eventType: 'review.started',
      review: {
        status: 'reviewing',
        severityCounts: { p0: 0, p1: 0, p2: 0 },
        personas: [],
      },
    });
    expect(receipt.dashboardEvents[1]).toMatchObject({
      eventType: 'review.completed',
      repository: { fullName: 'acme/review-yeti' },
      pullRequest: { number: 42, headSha: 'a'.repeat(40) },
      review: { status: 'completed', verdict: 'SHIP', personas: expect.any(Array) },
    });
    expect(receipt.dashboardEvents[1].review.findings).toBeUndefined();
    expect(receipt.dashboardEvents[1].review.rationale).toBeUndefined();
    expect(receipt.dashboardEvents[1].review.personas.every((persona: any) => (
      persona.turnCount === 1
      && persona.findingCount === 0
      && persona.p0 === 0
      && persona.p1 === 0
      && persona.p2 === 0
    ))).toBe(true);
    expect(receipt.dashboardEvents[0].eventId).not.toBe(receipt.dashboardEvents[1].eventId);
    expect(receipt.dashboardEvents[0].workflow).toEqual(receipt.dashboardEvents[1].workflow);
    const firstFanout = receipt.pipelineOrder.indexOf('fanout');
    const startedDelivery = receipt.pipelineOrder.indexOf('dashboard:review.started');
    const terminalDelivery = receipt.pipelineOrder.lastIndexOf('dashboard:review.completed');
    expect(startedDelivery).toBeGreaterThanOrEqual(0);
    expect(firstFanout).toBeGreaterThan(startedDelivery);
    expect(terminalDelivery).toBeGreaterThan(firstFanout);
    expect(validateReviewEventSchema(receipt.dashboardEvents[0])).toBe(true);
    expect(validateReviewEventSchema.errors).toBeNull();
    expect(validateReviewEventSchema(receipt.dashboardEvents[1])).toBe(true);
    expect(validateReviewEventSchema.errors).toBeNull();
  });

  it('keeps the review green and GitHub publication successful when dashboard delivery fails', async () => {
    const receipt = await runReviewWorkflowFixture('fresh-clean', { dashboardStatus: 500 });

    expect(receipt).toMatchObject({
      verdict: 'SHIP',
      publication: { success: true },
      dashboard: { status: 'failed', attempts: 3 },
      dashboardStarted: { status: 'failed', attempts: 3 },
    });
    expect(receipt.dashboardEvents).toHaveLength(6);
    expect(receipt.dashboardEvents.slice(0, 3).every((event: any) => event.eventType === 'review.started')).toBe(true);
    expect(receipt.dashboardEvents.slice(3).every((event: any) => event.eventType === 'review.completed')).toBe(true);
  });

  it('continues with an unavailable provider while preserving the GitHub-ledger-only review path', async () => {
    const receipt = await runReviewWorkflowFixture('provider-unavailable', { memoryAvailable: false });
    expect(receipt).toMatchObject({ verdict: 'SHIP', publication: { success: true }, memory: { query: { status: 'unavailable' } }, outbox: { state: 'pending' } });
  });

  it('is byte-repeatable for the same fixture under a frozen clock', async () => {
    const first = await runReviewWorkflowFixture('fresh-clean');
    const second = await runReviewWorkflowFixture('fresh-clean');
    expect(first.outboxPayload).toEqual(second.outboxPayload);
    expect(canonicalReceipt(first)).toEqual(canonicalReceipt(second));
  });

  it.each([
    'ignored-authorized',
    'ignored-unauthorized',
    'open-finding-carried',
    'partial-review',
    'provider-malformed',
    'publication-race',
    'replay-dead-letter',
    'resolved-and-reopened',
    'runner-cancelled',
    'stale-head',
  ])('executes the real pipeline boundary for the %s fixture with a sanitized receipt', async (fixtureId) => {
    const receipt = await runReviewWorkflowFixture(fixtureId);
    const repeat = await runReviewWorkflowFixture(fixtureId);
    expect(receipt).toMatchObject({
      provider: 'mem0',
      publication: { success: true },
      memory: { query: expect.objectContaining({ status: expect.any(String) }) },
      outbox: { path: expect.stringMatching(/sessions[\\/].+\.memory-outbox\.json$/u) },
    });
    expect(JSON.stringify(receipt)).not.toMatch(/fixture-(?:memory|openrouter)-key|authorization|api_key/iu);
    expect(receipt.outboxPayload).toEqual(repeat.outboxPayload);
    expect(canonicalReceipt(receipt)).toEqual(canonicalReceipt(repeat));
  });
});
