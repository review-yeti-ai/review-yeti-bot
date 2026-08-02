/** @typedef {{getSessions: (filter?: object) => Array<object>}} SessionRepository */

/**
 * Search the durable review-session repository without exposing credentials or
 * filesystem details to the MCP transport.
 * @param {object} input
 * @param {SessionRepository} repository
 */
export async function handleSearchSessions(input = {}, repository) {
  if (!repository || typeof repository.getSessions !== 'function') {
    throw new Error('session repository is required');
  }
  const sessions = repository.getSessions({
    owner: typeof input.owner === 'string' ? input.owner : undefined,
    repo: typeof input.repo === 'string' ? input.repo : undefined,
    verdict: typeof input.verdict === 'string' ? input.verdict : undefined,
    status: typeof input.status === 'string' ? input.status : undefined,
  });
  return { total: sessions.length, sessions };
}
