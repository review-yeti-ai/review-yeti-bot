export interface ReviewYetiPassthroughEnvironment {
  REVIEW_YETI_PASSTHROUGH?: string;
}

/** Process-wide, centrally managed stop for admitting new Review Yeti work. */
export function reviewYetiPassthroughEnabledFromEnv(
  environment: NodeJS.ProcessEnv | ReviewYetiPassthroughEnvironment,
): boolean {
  const value = environment.REVIEW_YETI_PASSTHROUGH;
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('REVIEW_YETI_PASSTHROUGH must be exactly true or false');
}
