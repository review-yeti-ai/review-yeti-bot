import { Formatter, FormatterOptions, SessionRecord, SessionKPIs, SessionDetail } from '../types';

export class OKFFormatter implements Formatter {
  public formatSessions(sessions: SessionRecord[], _options?: FormatterOptions): string {
    const lines: string[] = [];
    lines.push('=== OKF: SESSION ANALYTICS LIST ===');
    lines.push(`meta.total_records: ${sessions.length}`);
    lines.push('records:');

    for (const s of sessions) {
      lines.push(`  - id: "${s.id}"`);
      lines.push(`    owner: "${s.owner}"`);
      lines.push(`    repo: "${s.repo}"`);
      lines.push(`    pr_number: ${s.prNumber}`);
      lines.push(`    title: "${s.title.replace(/"/g, '\\"')}"`);
      lines.push(`    verdict: ${s.lastVerdict}`);
      lines.push(`    turns: ${s.totalTurns}/${s.maxTurns}`);
      lines.push(`    cost_usd: ${s.costUSD}`);
      lines.push(`    tokens_total: ${s.tokens?.total || 0}`);
      lines.push(`    findings_count: ${s.findings?.length || 0}`);
      lines.push(`    updated_at: "${s.updatedAt}"`);
    }

    lines.push('=== END OKF ===');
    return lines.join('\n');
  }

  public formatKPIs(kpis: SessionKPIs, _options?: FormatterOptions): string {
    const lines: string[] = [];
    lines.push('=== OKF: SESSION KEY PERFORMANCE INDICATORS ===');
    lines.push(`kpi.total_sessions: ${kpis.totalSessions}`);
    lines.push(`kpi.total_turns: ${kpis.totalTurns}`);
    lines.push(`kpi.avg_turns_per_session: ${kpis.avgTurnsPerSession}`);
    lines.push(`kpi.pass_rate_percent: ${kpis.passRatePercent}%`);
    lines.push(`kpi.total_cost_usd: $${kpis.totalCostUSD.toFixed(4)}`);
    lines.push(`kpi.avg_duration_ms: ${kpis.avgDurationMs}ms`);
    lines.push(`kpi.turn_budget_utilization_percent: ${kpis.turnBudgetUtilizationPercent}%`);
    lines.push(`kpi.findings_resolution_rate_percent: ${kpis.findingsResolutionRatePercent}%`);
    lines.push('kpi.tokens:');
    lines.push(`  prompt: ${kpis.totalTokens.prompt}`);
    lines.push(`  completion: ${kpis.totalTokens.completion}`);
    lines.push(`  total: ${kpis.totalTokens.total}`);
    lines.push('kpi.verdicts:');
    for (const [k, v] of Object.entries(kpis.verdictCounts)) {
      lines.push(`  ${k.toLowerCase()}: ${v}`);
    }
    lines.push('kpi.findings_summary:');
    lines.push(`  p0: ${kpis.totalFindings.p0}`);
    lines.push(`  p1: ${kpis.totalFindings.p1}`);
    lines.push(`  p2: ${kpis.totalFindings.p2}`);
    lines.push(`  total: ${kpis.totalFindings.total}`);
    lines.push('=== END OKF ===');
    return lines.join('\n');
  }

  public formatDetail(detail: SessionDetail, _options?: FormatterOptions): string {
    const lines: string[] = [];
    lines.push('=== OKF: SESSION DETAIL ===');
    lines.push(`session.id: "${detail.id}"`);
    lines.push(`session.owner: "${detail.owner}"`);
    lines.push(`session.repo: "${detail.repo}"`);
    lines.push(`session.pr_number: ${detail.prNumber}`);
    lines.push(`session.title: "${detail.title.replace(/"/g, '\\"')}"`);
    lines.push(`session.branch: "${detail.branch}"`);
    lines.push(`session.last_verdict: ${detail.lastVerdict}`);
    lines.push(`session.total_turns: ${detail.totalTurns}/${detail.maxTurns}`);
    lines.push(`session.cost_usd: ${detail.costUSD}`);
    lines.push(`session.latency_ms: ${detail.latencyMs}`);
    lines.push(`session.created_at: "${detail.createdAt}"`);
    lines.push(`session.updated_at: "${detail.updatedAt}"`);

    if (detail.findingsDelta) {
      lines.push('session.findings_delta:');
      lines.push(`  initial: ${detail.findingsDelta.initialFindings}`);
      lines.push(`  latest: ${detail.findingsDelta.latestFindings}`);
      lines.push(`  resolved: ${detail.findingsDelta.resolvedFindings}`);
      lines.push(`  new: ${detail.findingsDelta.newFindings}`);
      lines.push(`  persistent: ${detail.findingsDelta.persistentFindings}`);
      lines.push(`  net_change: ${detail.findingsDelta.netChange}`);
    }

    lines.push('session.history:');
    for (const h of detail.history || []) {
      lines.push(`  - turn: ${h.turn}`);
      lines.push(`    head_sha: "${h.headSha}"`);
      lines.push(`    verdict: ${h.verdict}`);
      lines.push(`    findings_count: ${h.findingsCount}`);
      lines.push(`    timestamp: "${h.timestamp}"`);
    }

    lines.push('=== END OKF ===');
    return lines.join('\n');
  }
}
