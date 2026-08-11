import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadReviewWorkflowFixture } from '../support/reviewWorkflowFixtures';

const root = path.resolve(__dirname, '../fixtures/review-workflows');
const files = fs.readdirSync(root).filter((file) => file.endsWith('.json')).sort();

describe('review workflow scenario expectation matrix', () => {
  it.each(files)('defines an internally consistent receipt contract for %s', (file) => {
    const fixture = loadReviewWorkflowFixture(path.join(root, file));
    const expected = fixture.expected;
    const modelResponses = fixture.model.responses as any;
    const githubResponses = fixture.github.responses as any;
    const memoryResponse = fixture.memory.providerResponse as any;
    const lanes = Array.isArray(modelResponses?.lanes) ? modelResponses.lanes : [];
    const ledger = String(githubResponses?.ledger || '');
    const provider = String(memoryResponse?.status || '');

    if (fixture.id === 'replay-dead-letter') {
      expect(expected).toMatchObject({ verdict: 'REPLAY_DEAD_LETTER', mergeEligible: false, outboxState: 'dead-letter' });
      return;
    }
    if (fixture.id === 'publication-race') {
      expect(expected).toMatchObject({ verdict: 'STALE_HEAD', publishedReviewCount: 0, mergeEligible: false });
      return;
    }
    if (fixture.id === 'partial-review') {
      expect(lanes).toContain('error');
      expect(expected).toMatchObject({ verdict: 'INCOMPLETE_REVIEW', coverageStatus: 'partial', mergeEligible: false });
      return;
    }
    if (['provider-malformed', 'provider-unavailable'].includes(fixture.id)) {
      expect(['malformed', 'unavailable']).toContain(provider);
      expect(expected).toMatchObject({ verdict: 'SHIP', mergeEligible: true, publishedReviewCount: 1 });
      return;
    }
    if (['ignored-unauthorized', 'open-finding-carried', 'resolved-and-reopened'].includes(fixture.id)) {
      expect(lanes).toContain('finding');
      expect(['ignore-not-authorized', 'open-finding', 'reopened-finding']).toContain(ledger);
      expect(expected).toMatchObject({ verdict: 'CHANGES_REQUESTED', mergeEligible: false, publishedThreadCount: 1 });
      return;
    }
    if (fixture.id === 'ignored-authorized') {
      expect(ledger).toBe('ignored-authorized');
      expect(expected).toMatchObject({ verdict: 'SHIP', mergeEligible: true, publishedThreadCount: 0 });
      return;
    }
    if (fixture.id === 'intelligence-evaluation') {
      // This fixture's harness never wires a real navigation/evidence token, so bounded
      // evidence tooling is genuinely unavailable for the run -- coverageStatus reflects that
      // honestly (degraded-tooling) rather than silently claiming full evidence-backed coverage.
      // See src/review/reviewOutcome.js deriveReceiptOutcome's evidenceEnabled degradation path.
      expect(expected).toMatchObject({ verdict: 'SHIP', coverageStatus: 'degraded-tooling', mergeEligible: true, publishedReviewCount: 1 });
      return;
    }
    expect(expected).toMatchObject({ verdict: 'SHIP', coverageStatus: 'complete', mergeEligible: true, publishedReviewCount: 1 });
  });

  it('keeps all forbidden strings absent from every serialized fixture', () => {
    for (const file of files) {
      const fixture = loadReviewWorkflowFixture(path.join(root, file));
      const sanitizedFixture = { ...fixture, expected: { ...fixture.expected, forbiddenStrings: [] } };
      const serialized = JSON.stringify(sanitizedFixture);
      for (const forbidden of fixture.expected.forbiddenStrings) expect(serialized).not.toContain(forbidden);
    }
  });
});
