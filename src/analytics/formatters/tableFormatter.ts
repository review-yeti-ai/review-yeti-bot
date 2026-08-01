import { Formatter, FormatterOptions, SessionRecord, SessionKPIs, SessionDetail } from '../types';

export class TableFormatter implements Formatter {
  public formatSessions(sessions: SessionRecord[], _options?: FormatterOptions): string {
    if (sessions.length === 0) {
      return 'No sessions found.';
    }

    const headers = ['ID', 'VERDICT', 'TURNS', 'COST ($)', 'TOKENS', 'TITLE'];
    const rows: string[][] = sessions.map((s) => [
      s.id,
      s.lastVerdict,
      `${s.totalTurns}/${s.maxTurns}`,
      `$${s.costUSD.toFixed(4)}`,
      (s.tokens?.total || 0).toString(),
      s.title.length > 40 ? s.title.slice(0, 37) + '...' : s.title,
    ]);

    return this.renderTable(headers, rows);
  }

  public formatKPIs(kpis: SessionKPIs, _options?: FormatterOptions): string {
    const lines: string[] = [];
    lines.push('=== SESSION ANALYTICS KPI SUMMARY ===');
    lines.push('');

    const headers = ['METRIC', 'VALUE'];
    const rows: string[][] = [
      ['Total Sessions', kpis.totalSessions.toString()],
      ['Total Turns', kpis.totalTurns.toString()],
      ['Avg Turns / Session', kpis.avgTurnsPerSession.toString()],
      ['Pass Rate (%)', `${kpis.passRatePercent}%`],
      ['Total Cost (USD)', `$${kpis.totalCostUSD.toFixed(4)}`],
      ['Avg Duration (ms)', `${kpis.avgDurationMs} ms`],
      ['Turn Budget Utilization', `${kpis.turnBudgetUtilizationPercent}%`],
      ['Findings Resolution Rate', `${kpis.findingsResolutionRatePercent}%`],
      ['P0 / P1 / P2 Findings', `${kpis.totalFindings.p0} / ${kpis.totalFindings.p1} / ${kpis.totalFindings.p2}`],
      ['Total Tokens Burned', kpis.totalTokens.total.toLocaleString()],
    ];

    lines.push(this.renderTable(headers, rows));
    return lines.join('\n');
  }

  public formatDetail(detail: SessionDetail, _options?: FormatterOptions): string {
    const lines: string[] = [];
    lines.push(`=== SESSION DETAIL: ${detail.id} ===`);
    lines.push(`Title:      ${detail.title}`);
    lines.push(`Repo:       ${detail.owner}/${detail.repo}`);
    lines.push(`PR:         #${detail.prNumber}`);
    lines.push(`Branch:     ${detail.branch}`);
    lines.push(`Verdict:    ${detail.lastVerdict}`);
    lines.push(`Turns:      ${detail.totalTurns} of ${detail.maxTurns}`);
    lines.push(`Cost:       $${detail.costUSD.toFixed(4)}`);
    lines.push(`Latency:    ${detail.latencyMs} ms`);
    lines.push(`Created:    ${detail.createdAt}`);
    lines.push(`Updated:    ${detail.updatedAt}`);
    lines.push('');

    if (detail.findingsDelta) {
      lines.push('--- FINDINGS DELTA ---');
      lines.push(
        `Initial: ${detail.findingsDelta.initialFindings} | Latest: ${detail.findingsDelta.latestFindings} | Resolved: ${detail.findingsDelta.resolvedFindings} | New: ${detail.findingsDelta.newFindings} | Persistent: ${detail.findingsDelta.persistentFindings}`
      );
      lines.push('');
    }

    lines.push('--- TURN TIMELINE ---');
    const headers = ['TURN', 'HEAD SHA', 'VERDICT', 'FINDINGS', 'TIMESTAMP'];
    const rows = (detail.history || []).map((h) => [
      h.turn.toString(),
      h.headSha ? h.headSha.slice(0, 7) : '—',
      h.verdict,
      h.findingsCount.toString(),
      h.timestamp,
    ]);
    lines.push(this.renderTable(headers, rows));

    return lines.join('\n');
  }

  private renderTable(headers: string[], rows: string[][]): string {
    const colWidths = headers.map((h, i) => {
      let maxLen = h.length;
      for (const row of rows) {
        if (row[i] && row[i].length > maxLen) {
          maxLen = row[i].length;
        }
      }
      return maxLen;
    });

    const formatRow = (cells: string[]) =>
      cells.map((cell, i) => cell.padEnd(colWidths[i])).join('  |  ');

    const separator = colWidths.map((w) => '-'.repeat(w)).join('--+--');

    const lines: string[] = [];
    lines.push(formatRow(headers));
    lines.push(separator);
    for (const row of rows) {
      lines.push(formatRow(row));
    }

    return lines.join('\n');
  }
}
