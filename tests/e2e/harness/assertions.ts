import { expect } from 'vitest';
import { MockGithubServer } from './mockGithubServer';
import { StateManager, TestEnvironmentContext } from './stateManager';

export class E2EAssertions {
  /**
   * Asserts that a PR review summary was posted to MockGithubServer with expected decision.
   */
  static assertPrReviewSubmitted(
    mockGithub: MockGithubServer,
    prNumber: number,
    expectedDecision: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  ): void {
    const reviews = mockGithub.getRecordedReviews(prNumber);
    expect(reviews.length).toBeGreaterThan(0);
    const latestReview = reviews[reviews.length - 1];
    expect(latestReview.event).toBe(expectedDecision);
  }

  /**
   * Asserts inline diff comments count and specific finding contents.
   */
  static assertInlineCommentsCount(
    mockGithub: MockGithubServer,
    prNumber: number,
    expectedCount: number
  ): void {
    const comments = mockGithub.getRecordedInlineComments(prNumber);
    expect(comments.length).toBe(expectedCount);
  }

  /**
   * Asserts DB finding tracking state across commit SHAs (incremental diff assertion).
   */
  static assertDbTrackedFindingStatus(
    stateMgr: StateManager,
    ctx: TestEnvironmentContext,
    prId: number,
    filePath: string,
    lineNumber: number,
    expectedStatus: 'identified' | 'resolved'
  ): void {
    const findings = stateMgr.getTrackedFindings(ctx, prId);
    const match = findings.find((f) => f.file_path === filePath && f.line_number === lineNumber);
    expect(match).toBeDefined();
    expect(match?.status).toBe(expectedStatus);
  }
}
