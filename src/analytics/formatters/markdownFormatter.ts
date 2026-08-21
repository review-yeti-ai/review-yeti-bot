import { Formatter, FormatterOptions, SessionRecord, SessionKPIs, SessionDetail } from '../types';

export class MarkdownFormatter implements Formatter {
  public formatSessions(sessions: SessionRecord[], _options?: FormatterOptions): string {
    const lines: string[] = [];
    lines.push(`# 📋 Review Sessions (${sessions.length})`);
    lines.push('');
    lines.push('| Session ID | Title | Verdict | Turns | Cost (USD) | Tokens | Updated |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');

    for (const s of sessions) {
      const tokensStr = (s.tokens?.total || 0).toLocaleString();
      const costStr = `$${s.costUSD.toFixed(4)}`;
      const turnStr = `${s.totalTurns}/${s.maxTurns}`;
      lines.push(
        `| \`${s.id}\` | ${this.escapeMd(s.title)} | \`${s.lastVerdict}\` | ${turnStr} | ${costStr} | ${tokensStr} | ${s.updatedAt.slice(0, 10)} |`
      );
    }

    return lines.join('\n');
  }

  public formatKPIs(kpis: SessionKPIs, _options?: FormatterOptions): string {
    const lines: string[] = [];
    lines.push('# 📊 Session Analytics KPIs');
    lines.push('');
    lines.push('### 📈 Summary Metrics');
    lines.push('| Metric | Value |');
    lines.push('| --- | --- |');
    lines.push(`| **Total Sessions** | ${kpis.totalSessions} |`);
    lines.push(`| **Total Turns** | ${kpis.totalTurns} |`);
    lines.push(`| **Avg Turns / Session** | ${kpis.avgTurnsPerSession} |`);
    lines.push(`| **Pass Rate** | ${kpis.passRatePercent}% |`);
    lines.push(`| **Total Cost** | $${kpis.totalCostUSD.toFixed(4)} |`);
    lines.push(`| **Avg Duration** | ${kpis.avgDurationMs} ms |`);
    lines.push(`| **Turn Budget Utilization** | ${kpis.turnBudgetUtilizationPercent}% |`);
    lines.push(`| **Findings Resolution Rate** | ${kpis.findingsResolutionRatePercent}% |`);
    lines.push('');

    lines.push('### 🏷️ Verdict Breakdown');
    lines.push('| Verdict | Count |');
    lines.push('| --- | --- |');
    for (const [k, v] of Object.entries(kpis.verdictCounts)) {
      lines.push(`| \`${k}\` | ${v} |`);
    }
    lines.push('');

    lines.push('### 🐛 Findings Summary');
    lines.push('| Severity | Count |');
    lines.push('| --- | --- |');
    lines.push(`| P0 (Critical/High) | ${kpis.totalFindings.p0} |`);
    lines.push(`| P1 (Medium) | ${kpis.totalFindings.p1} |`);
    lines.push(`| P2 (Low/Nit) | ${kpis.totalFindings.p2} |`);
    lines.push(`| **Total** | **${kpis.totalFindings.total}** |`);
    lines.push('');

    lines.push('### 🪙 Tokens Burned');
    lines.push('| Category | Token Count |');
    lines.push('| --- | --- |');
    lines.push(`| Prompt Tokens | ${kpis.totalTokens.prompt.toLocaleString()} |`);
    lines.push(`| Completion Tokens | ${kpis.totalTokens.completion.toLocaleString()} |`);
    lines.push(`| **Total Tokens** | **${kpis.totalTokens.total.toLocaleString()}** |`);

    return lines.join('\n');
  }

  public formatDetail(detail: SessionDetail, _options?: FormatterOptions): string {
    const lines: string[] = [];
    lines.push(`# 🔍 Session Detail: \`${detail.id}\``);
    lines.push('');
    lines.push(`- **Title**: ${this.escapeMd(detail.title)}`);
    lines.push(`- **Repository**: \`${detail.owner}/${detail.repo}\``);
    lines.push(`- **PR Number**: #${detail.prNumber}`);
    lines.push(`- **Branch**: \`${detail.branch}\``);
    lines.push(`- **Latest Verdict**: \`${detail.lastVerdict}\``);
    lines.push(`- **Turns Recorded**: ${detail.totalTurns} of ${detail.maxTurns}`);
    lines.push(`- **Total Cost**: $${detail.costUSD.toFixed(4)}`);
    lines.push(`- **Total Latency**: ${detail.latencyMs} ms`);
    lines.push(`- **Created**: ${detail.createdAt}`);
    lines.push(`- **Updated**: ${detail.updatedAt}`);
    lines.push('');

    if (detail.findingsDelta) {
      lines.push('### 📉 Findings Delta Summary');
      lines.push('| Metric | Value |');
      lines.push('| --- | --- |');
      lines.push(`| Initial Findings | ${detail.findingsDelta.initialFindings} |`);
      lines.push(`| Latest Findings | ${detail.findingsDelta.latestFindings} |`);
      lines.push(`| Resolved Findings | ${detail.findingsDelta.resolvedFindings} |`);
      lines.push(`| New Findings | ${detail.findingsDelta.newFindings} |`);
      lines.push(`| Persistent Findings | ${detail.findingsDelta.persistentFindings} |`);
      lines.push(`| Net Change | ${detail.findingsDelta.netChange} |`);
      lines.push('');
    }

    lines.push('### 🔄 Turn Execution Timeline');
    lines.push('| Turn | Head SHA | Verdict | Findings | Timestamp |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const h of detail.history || []) {
      const sha = h.headSha ? `\`${h.headSha.slice(0, 7)}\`` : '—';
      lines.push(`| ${h.turn} | ${sha} | \`${h.verdict}\` | ${h.findingsCount} | ${h.timestamp} |`);
    }

    if (detail.findings && detail.findings.length > 0) {
      lines.push('');
      lines.push('### 🚨 Current Active Findings');
      lines.push('| Severity | Path | Line | Title | Persona |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const f of detail.findings) {
        lines.push(
          `| \`${f.severity}\` | \`${f.path}\` | ${f.line ?? '—'} | ${this.escapeMd(f.title)} | ${f.persona || '—'} |`
        );
      }
    }

    return lines.join('\n');
  }

  private escapeMd(str: string): string {
    return (str || '').replace(/\|/g, '\\|');
  }
}
