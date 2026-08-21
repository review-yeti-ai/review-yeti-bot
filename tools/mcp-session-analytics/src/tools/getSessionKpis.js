/** @typedef {{getSessions: (filter?: object) => Array<object>}} SessionRepository */

/** @param {object} input @param {SessionRepository} repository */
export async function handleGetSessionKpis(input = {}, repository) {
  if (!repository || typeof repository.getSessions !== 'function') {
    throw new Error('session repository is required');
  }
  const sessions = repository.getSessions({
    owner: typeof input.owner === 'string' ? input.owner : undefined,
    repo: typeof input.repo === 'string' ? input.repo : undefined,
  });
  const shipped = sessions.filter((session) => session.lastVerdict === 'SHIP').length;
  const totalCostUSD = sessions.reduce((sum, session) => sum + (Number(session.costUSD) || 0), 0);
  const totalLatencyMs = sessions.reduce((sum, session) => sum + (Number(session.latencyMs) || 0), 0);
  return {
    totalSessions: sessions.length,
    passRatePercent: sessions.length ? Math.round((shipped / sessions.length) * 100) : 0,
    totalCostUSD,
    averageLatencyMs: sessions.length ? Math.round(totalLatencyMs / sessions.length) : 0,
  };
}
