/** @typedef {{getSessionById: (id: string) => object|null}} SessionRepository */

/** @param {object} input @param {SessionRepository} repository */
export async function handleGetSessionDetails(input = {}, repository) {
  if (!repository || typeof repository.getSessionById !== 'function') {
    throw new Error('session repository is required');
  }
  if (typeof input.sessionId !== 'string' || !input.sessionId) {
    throw new Error('sessionId is required');
  }
  const session = repository.getSessionById(input.sessionId);
  if (!session) throw new Error(`session '${input.sessionId}' not found`);

  const maxTurns = Number(session.maxTurns) || 0;
  const totalTurns = Number(session.totalTurns) || 0;
  return {
    ...session,
    turnBudgetUtilizationPercent: maxTurns > 0 ? Math.round((totalTurns / maxTurns) * 100) : 0,
    turnTimeline: Array.isArray(session.history) ? session.history : [],
  };
}
