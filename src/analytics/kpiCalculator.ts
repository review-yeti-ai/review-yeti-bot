import { SessionRecord, SessionKPIs, SessionFinding, FindingsDelta } from './types';

export function computeFindingsDelta(
  initialFindings: SessionFinding[],
  latestFindings: SessionFinding[]
): FindingsDelta {
  const getFindingKey = (f: SessionFinding): string => {
    const sev = (f.severity || '').toUpperCase();
    const pathStr = (f.path || '').toLowerCase();
    const lineStr = f.line ?? 0;
    const titleStr = (f.title || '').trim().toLowerCase();
    return `${sev}:${pathStr}:${lineStr}:${titleStr}`;
  };

  const initialKeys = new Set(initialFindings.map(getFindingKey));
  const latestKeys = new Set(latestFindings.map(getFindingKey));

  let persistent = 0;
  let resolved = 0;

  for (const key of initialKeys) {
    if (latestKeys.has(key)) {
      persistent++;
    } else {
      resolved++;
    }
  }

  let newFindings = 0;
  for (const key of latestKeys) {
    if (!initialKeys.has(key)) {
      newFindings++;
    }
  }

  const initialCount = initialFindings.length;
  const latestCount = latestFindings.length;
  const netChange = latestCount - initialCount;

  return {
    initialFindings: initialCount,
    latestFindings: latestCount,
    resolvedFindings: resolved,
    newFindings: newFindings,
    persistentFindings: persistent,
    netChange,
  };
}

export function calculateKPIs(sessions: SessionRecord[]): SessionKPIs {
  const totalSessions = sessions.length;
  if (totalSessions === 0) {
    return {
      totalSessions: 0,
      totalTurns: 0,
      avgTurnsPerSession: 0,
      verdictCounts: { SHIP: 0, NACK: 0, COMMENT: 0, FIX_FIRST: 0 },
      passRatePercent: 0,
      totalFindings: { p0: 0, p1: 0, p2: 0, total: 0 },
      totalCostUSD: 0,
      totalTokens: { prompt: 0, completion: 0, total: 0 },
      avgDurationMs: 0,
      turnBudgetUtilizationPercent: 0,
      findingsResolutionRatePercent: 100,
    };
  }

  let totalTurns = 0;
  let shipCount = 0;
  const verdictCounts: Record<string, number> = {
    SHIP: 0,
    NACK: 0,
    COMMENT: 0,
    FIX_FIRST: 0,
  };

  let p0 = 0;
  let p1 = 0;
  let p2 = 0;
  let totalCostUSD = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokensSum = 0;
  let totalDurationMs = 0;
  let turnBudgetUtilSum = 0;

  let totalInitialFindings = 0;
  let totalResolvedFindings = 0;

  for (const s of sessions) {
    totalTurns += s.totalTurns || 1;

    const verdict = (s.lastVerdict || 'SHIP').toUpperCase();
    verdictCounts[verdict] = (verdictCounts[verdict] || 0) + 1;

    if (verdict === 'SHIP' || verdict === 'APPROVE' || verdict === 'PASSED') {
      shipCount++;
    }

    const findings = s.findings || [];
    for (const f of findings) {
      const sev = (f.severity || '').toUpperCase();
      if (sev === 'P0' || sev === 'CRITICAL' || sev === 'HIGH') {
        p0++;
      } else if (sev === 'P1' || sev === 'MEDIUM') {
        p1++;
      } else if (sev === 'P2' || sev === 'LOW' || sev === 'NIT') {
        p2++;
      } else {
        p1++;
      }
    }

    totalCostUSD += s.costUSD || 0;
    promptTokens += s.tokens?.prompt || 0;
    completionTokens += s.tokens?.completion || 0;
    totalTokensSum += s.tokens?.total || (s.tokens?.prompt || 0) + (s.tokens?.completion || 0);
    totalDurationMs += s.latencyMs || 0;

    const maxTurns = s.maxTurns || 20;
    turnBudgetUtilSum += ((s.totalTurns || 1) / maxTurns) * 100;

    if (s.findingsDelta) {
      totalInitialFindings += s.findingsDelta.initialFindings;
      totalResolvedFindings += s.findingsDelta.resolvedFindings;
    }
  }

  const avgTurnsPerSession = Number((totalTurns / totalSessions).toFixed(2));
  const passRatePercent = Number(((shipCount / totalSessions) * 100).toFixed(2));
  const avgDurationMs = Math.round(totalDurationMs / totalSessions);
  const turnBudgetUtilizationPercent = Number((turnBudgetUtilSum / totalSessions).toFixed(2));

  const findingsResolutionRatePercent =
    totalInitialFindings > 0
      ? Number(((totalResolvedFindings / totalInitialFindings) * 100).toFixed(2))
      : 100;

  return {
    totalSessions,
    totalTurns,
    avgTurnsPerSession,
    verdictCounts,
    passRatePercent,
    totalFindings: {
      p0,
      p1,
      p2,
      total: p0 + p1 + p2,
    },
    totalCostUSD: Number(totalCostUSD.toFixed(4)),
    totalTokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: totalTokensSum,
    },
    avgDurationMs,
    turnBudgetUtilizationPercent,
    findingsResolutionRatePercent,
  };
}
