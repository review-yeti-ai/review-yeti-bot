import { describe, expect, it } from 'vitest';
import { runReviewWorkflowFixture } from '../support/reviewWorkflowHarness';

describe('cassette-backed review workflow harness', () => {
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

  it('continues with an unavailable provider while preserving the GitHub-ledger-only review path', async () => {
    const receipt = await runReviewWorkflowFixture('provider-unavailable', { memoryAvailable: false });
    expect(receipt).toMatchObject({ verdict: 'SHIP', publication: { success: true }, memory: { query: { status: 'unavailable' } }, outbox: { state: 'pending' } });
  });

  it('is byte-repeatable for the same fixture under a frozen clock', async () => {
    const first = await runReviewWorkflowFixture('fresh-clean');
    const second = await runReviewWorkflowFixture('fresh-clean');
    expect(first.outboxPayload).toEqual(second.outboxPayload);
    const canonical = (receipt: any) => ({
      ...receipt,
      startedAt: 0,
      finishedAt: 0,
      outbox: { ...receipt.outbox, path: '<outbox>' },
      actionOutputs: receipt.actionOutputs.replace(/memory-outbox-path=.*\n/u, 'memory-outbox-path=<outbox>\n'),
    });
    expect(canonical(first)).toEqual(canonical(second));
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
    const canonical = (value: any) => ({
      ...value,
      startedAt: 0,
      finishedAt: 0,
      outbox: { ...value.outbox, path: '<outbox>' },
      actionOutputs: value.actionOutputs.replace(/memory-outbox-path=.*\n/u, 'memory-outbox-path=<outbox>\n'),
    });
    expect(canonical(receipt)).toEqual(canonical(repeat));
  });
});
