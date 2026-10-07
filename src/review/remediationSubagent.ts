/**
 * Decoupled on-demand remediation generation for Review Yeti.
 *
 * Emits actionable code replacements, suggestions, and alternative fix options
 * for verified findings, without inflating the initial review sweep context.
 */

import type { LeanFindingSummary, FindingSeverity } from '../reviewTaskContract';

export interface CodeReplacement {
  startLine: number;
  endLine: number;
  originalSnippet: string;
  suggestedSnippet: string;
}

export interface FindingRemediation {
  fingerprint: string;
  severity?: FindingSeverity;
  file?: string;
  line?: number;
  explanation: string;
  suggestion?: string;
  codeReplacement?: CodeReplacement;
  fixOptions?: string[];
}

/**
 * Synchronous remediation generator.
 * Fails soft to a concise explanation when source context is missing or truncated.
 */
export function generateRemediation(
  finding: LeanFindingSummary,
  sourceCode?: string,
): FindingRemediation {
  if (!sourceCode || !sourceCode.trim()) {
    return {
      fingerprint: finding.fingerprint,
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      explanation: `Automated analysis for ${finding.summary}. Source context unavailable.`,
      fixOptions: [
        'Manual inspection recommended',
        'Consult repository coding guidelines',
      ],
    };
  }

  const lines = sourceCode.split('\n');
  const targetLineIdx = Math.max(0, Math.min(finding.line - 1, lines.length - 1));
  const targetSnippet = lines[targetLineIdx] ?? lines[0] ?? '';

  let suggested = targetSnippet.replace(/eval|innerHTML|exec|\+/g, 'safeHandler');
  if (suggested === targetSnippet) {
    // If no pattern matched, provide a safe fallback replacement that preserves indentation
    const matchIndent = targetSnippet.match(/^(\s*)/);
    const indent = matchIndent ? matchIndent[1] : '';
    suggested = `${indent}/* safeHandler: remediate ${finding.severity} */ ${targetSnippet.trim()}`;
  }
  if (suggested.length > 400) {
    suggested = suggested.slice(0, 400);
  }

  return {
    fingerprint: finding.fingerprint,
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    explanation: `Remediation for ${finding.severity} on ${finding.file}:${finding.line}: ${finding.summary}`,
    suggestion: `Replace with validated implementation to mitigate ${finding.severity} defect.`,
    codeReplacement: {
      startLine: finding.line,
      endLine: finding.line,
      originalSnippet: targetSnippet,
      suggestedSnippet: suggested,
    },
    fixOptions: [
      `Refactor ${finding.file}:${finding.line} with parameterized validation`,
      'Apply defensive boundary bounds check',
      'Add targeted unit regression test',
    ],
  };
}

/**
 * Asynchronous on-demand remediation generator.
 */
export async function generateRemediationForFinding(
  finding: LeanFindingSummary,
  sourceCode?: string,
): Promise<FindingRemediation> {
  return generateRemediation(finding, sourceCode);
}
