import { describe, it, expect } from 'vitest';
import { runReviewWorkflowFixture } from '../support/reviewWorkflowHarness';

describe('overview brief receipt', () => {
  it('is disabled under a deterministic model adapter and never blocks the review', async () => {
    const receipt = await runReviewWorkflowFixture('fresh-clean');
    // Fixture runs use a scripted modelClient, so the orientation pre-pass is
    // skipped: personas behave exactly as before the feature existed.
    expect(receipt.overview).toEqual({ enabled: false, present: false });
    expect(receipt.verdict).toBe('SHIP');
  }, 120_000);
});
