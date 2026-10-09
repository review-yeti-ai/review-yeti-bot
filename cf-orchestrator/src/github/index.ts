/**
 * github/index.ts
 *
 * Central export for Cloudflare Edge-native GitHub App authentication,
 * Check Run publishing ("Review Yeti" and "Review Yeti Gate"), and
 * PR sticky comment management.
 */

export {
  signGitHubAppJwt,
  getInstallationToken,
  clearCachedToken,
  importRsaPrivateKey,
  type GitHubAuthEnv,
} from './githubAppAuth.js';

export {
  REVIEW_WORKER_CHECK_NAME,
  REVIEW_GATE_CHECK_NAME,
  REVIEW_REFRESH_ACTION,
  createPendingChecks,
  completeChecks,
  deriveWorkerExternalId,
  deriveGateExternalId,
  formatCheckAnnotations,
  type CheckFinding,
  type CheckAnnotation,
  type PendingCheckOptions,
  type CompleteCheckOptions,
  type CheckPublisherResult,
} from './edgeCheckPublisher.js';

export {
  STICKY_OVERVIEW_MARKER,
  ALT_STICKY_OVERVIEW_MARKER,
  formatStickyCommentMarkdown,
  findExistingStickyComment,
  publishStickyComment,
  type StickyCommentFinding,
  type StickyCommentMetrics,
  type StickyCommentOptions,
  type StickyCommentResult,
} from './stickyCommentPublisher.js';

export {
  buildGitHubReviewPayload,
  publishGitHubPullRequestReview,
  formatSuggestionBody,
  type InlineFindingSuggestion,
  type GitHubReviewPayload,
  type GitHubReviewComment,
} from '../reviewPublisher.js';
