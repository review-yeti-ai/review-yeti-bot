/**
 * activeChangesLedger.ts
 *
 * Sliding Active Changes Knowledge Ledger & Context Compactor.
 * Keeps agent LLM context trim by compacting completed diff analyses into
 * high-density semantic snippets (~40-80 tokens), discarding thousands of raw
 * diff lines and chain-of-thought scratchpad tokens.
 */

export interface DiffKnowledgeSnippet {
  filename: string;
  verdict: 'approved' | 'action_required' | 'neutral';
  summary: string;
  symbolsModified: string[];
  breakingRisks: string[];
  securityNotes?: string;
  findingFingerprints: string[];
}

export interface CompactLedgerSnapshot {
  totalDiffsEvaluated: number;
  activeKnowledgeTokens: number;
  snippets: DiffKnowledgeSnippet[];
  globalSecurityWarnings: string[];
  accumulatedFindings: string[];
}

export class ActiveChangesLedger {
  private snippets = new Map<string, DiffKnowledgeSnippet>();
  private globalWarnings: string[] = [];
  private accumulatedFindings: string[] = [];

  /**
   * Compacts and records the outcome of a completed diff task.
   * Discards raw diff lines, AST blobs, and scratchpads.
   */
  recordDiffKnowledge(snippet: DiffKnowledgeSnippet): void {
    this.snippets.set(snippet.filename, snippet);

    if (snippet.securityNotes) {
      this.globalWarnings.push(`[${snippet.filename}] ${snippet.securityNotes}`);
    }

    for (const fp of snippet.findingFingerprints) {
      if (!this.accumulatedFindings.includes(fp)) {
        this.accumulatedFindings.push(fp);
      }
    }
  }

  /**
   * Generates a trim, high-density markdown context block for downstream tasks.
   * Typically under 200–500 tokens total, even for large 20-file PRs.
   */
  toTrimContextPrompt(): string {
    if (this.snippets.size === 0) {
      return 'Prior changes context: None (First task in pipeline).';
    }

    const lines: string[] = ['### Active PR Changes Knowledge (Compacted Prior Diffs):'];

    for (const [filename, s] of this.snippets.entries()) {
      const symbols = s.symbolsModified.length > 0 ? ` (Symbols: ${s.symbolsModified.join(', ')})` : '';
      const risks = s.breakingRisks.length > 0 ? ` [Risks: ${s.breakingRisks.join('; ')}]` : '';
      lines.push(`- **${filename}** [${s.verdict.toUpperCase()}]: ${s.summary}${symbols}${risks}`);
    }

    if (this.globalWarnings.length > 0) {
      lines.push('\n**Active Cross-File Alerts:**');
      for (const w of this.globalWarnings) {
        lines.push(`- ⚠️ ${w}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Returns a snapshot of the ledger for audit and terminal receipt creation.
   */
  getSnapshot(): CompactLedgerSnapshot {
    const serialized = this.toTrimContextPrompt();
    const tokenEstimate = Math.ceil(serialized.length / 4);

    return {
      totalDiffsEvaluated: this.snippets.size,
      activeKnowledgeTokens: tokenEstimate,
      snippets: Array.from(this.snippets.values()),
      globalSecurityWarnings: [...this.globalWarnings],
      accumulatedFindings: [...this.accumulatedFindings],
    };
  }

  /**
   * Computes the overall verdict across all evaluated diffs.
   */
  getOverallVerdict(): 'success' | 'action_required' | 'neutral' {
    let hasActionRequired = false;
    let hasApproved = false;

    for (const s of this.snippets.values()) {
      if (s.verdict === 'action_required') {
        hasActionRequired = true;
      }
      if (s.verdict === 'approved') {
        hasApproved = true;
      }
    }

    if (hasActionRequired) return 'action_required';
    if (hasApproved) return 'success';
    return 'neutral';
  }
}
