export const LIFECYCLE_SUBJECT_PREFIX = 'ct.review.lifecycle.v1';
export const PROGRESS_SUBJECT_PREFIX = 'ct.review.progress.v1';
export const RESUME_SUBJECT_PREFIX = 'ct.review.v1.resume';

export const MAX_REVIEW_EVENT_SUBJECT_SUFFIX_LENGTH = 64;
export const REVIEW_EVENT_SUBJECT_TOKEN_PATTERN_SOURCE = String.raw`[a-z0-9][a-z0-9_-]*`;
const REVIEW_EVENT_SUBJECT_SUFFIX_PATTERN = new RegExp(
  `^${REVIEW_EVENT_SUBJECT_TOKEN_PATTERN_SOURCE}(?:\\.${REVIEW_EVENT_SUBJECT_TOKEN_PATTERN_SOURCE})*$`,
  'u',
);
export const RESUME_SUBJECT_SUFFIX_PATTERN = /^[a-zA-Z0-9_-]+$/u;

export function resumeSubjectFor(runId: string): string {
  return `${RESUME_SUBJECT_PREFIX}.${runId}`;
}

/**
 * Review event subjects have a fixed prefix and a bounded, literal NATS
 * subject suffix. Keeping this predicate here gives every producer the same
 * wildcard and token-safety contract.
 */
export function isReviewEventSubject(subject: unknown): subject is string {
  if (typeof subject !== 'string') return false;

  for (const prefix of [LIFECYCLE_SUBJECT_PREFIX, PROGRESS_SUBJECT_PREFIX]) {
    const prefixWithSeparator = `${prefix}.`;
    if (!subject.startsWith(prefixWithSeparator)) continue;

    const suffix = subject.slice(prefixWithSeparator.length);
    return suffix.length > 0
      && suffix.length <= MAX_REVIEW_EVENT_SUBJECT_SUFFIX_LENGTH
      && REVIEW_EVENT_SUBJECT_SUFFIX_PATTERN.test(suffix);
  }

  const resumePrefixWithSeparator = `${RESUME_SUBJECT_PREFIX}.`;
  if (subject.startsWith(resumePrefixWithSeparator)) {
    const suffix = subject.slice(resumePrefixWithSeparator.length);
    return suffix.length > 0
      && suffix.length <= MAX_REVIEW_EVENT_SUBJECT_SUFFIX_LENGTH
      && RESUME_SUBJECT_SUFFIX_PATTERN.test(suffix);
  }

  return false;
}
