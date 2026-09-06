/**
 * Panel publication policy (2026-08-03):
 *
 * - Persona lanes publish as **issue comments** (PR conversation). They must NOT
 *   open pull-request review threads — those block merge under
 *   required_conversation_resolution and spam CI recompute.
 * - The **final** arbiter phase publishes one Pull Request Review and may attach
 *   a capped, cross-persona-deduped set of actionable inline review comments
 *   (P0/P1 only by default).
 */

import { ACTIONABLE_SEVERITIES as SHARED_ACTIONABLE_SEVERITIES, MAX_PUBLISHED_REVIEW_THREADS } from '../review/findingPublication';
import type { PanelFinding, PersonaLaneResult } from '../panel/panelEngine';
import type { PublishInlineCommentRequest } from './commentPublisher';

export const PERSONA_ISSUE_MARKER_PREFIX = '<!-- ct-review-persona';
export const FINAL_REVIEW_MARKER_PREFIX = '<!-- ct-review-final';

/**
 * Max inline review threads opened by the final (arbiter) phase.
 *
 * Aliases the shared cap rather than restating it. Both publication surfaces are bound by the same
 * merge-blocking rule under `required_conversation_resolution`, and two hand-maintained copies of
 * that number drift: raising one without the other silently gives the App and the Action different
 * merge behaviour for identical findings.
 */
export const MAX_FINAL_INLINE_COMMENTS = MAX_PUBLISHED_REVIEW_THREADS;

/**
 * Severities that may become resolve-required review threads.
 *
 * Derived from the shared list for the same reason the cap is: widening the blocking set must not
 * be possible on one publication surface only.
 */
export const ACTIONABLE_SEVERITIES = new Set<string>(SHARED_ACTIONABLE_SEVERITIES);

export type FindingWithPersona = PanelFinding & { persona: string };

export interface DedupeOptions {
  max?: number;
  severities?: Iterable<string>;
}

function normalizeTitle(title: string): string {
  return String(title || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export function findingDedupeKey(finding: FindingWithPersona): string {
  return [
    finding.path || '',
    String(finding.line ?? 0),
    finding.severity || '',
    normalizeTitle(finding.title),
  ].join('|');
}

/**
 * Keep the highest-severity unique findings across personas.
 * When several personas report the same key, merge persona ids into the body.
 */
export function dedupeActionableFindings(
  findings: FindingWithPersona[],
  options: DedupeOptions = {},
): FindingWithPersona[] {
  const max = options.max ?? MAX_FINAL_INLINE_COMMENTS;
  const allowed = new Set(
    options.severities
      ? [...options.severities].map((s) => String(s).toUpperCase())
      : [...ACTIONABLE_SEVERITIES],
  );

  const severityRank: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  const byKey = new Map<string, FindingWithPersona & { personas: string[] }>();

  for (const raw of findings) {
    const severity = String(raw.severity || 'P2').toUpperCase();
    if (!allowed.has(severity)) continue;
    if (!raw.path || !Number.isFinite(Number(raw.line)) || Number(raw.line) < 1) continue;

    const finding: FindingWithPersona = {
      ...raw,
      severity: severity as PanelFinding['severity'],
      persona: raw.persona,
    };
    const key = findingDedupeKey(finding);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...finding, personas: [finding.persona] });
      continue;
    }
    if (!existing.personas.includes(finding.persona)) {
      existing.personas.push(finding.persona);
    }
    // Prefer richer body / suggestion when present
    if ((finding.body || '').length > (existing.body || '').length) {
      existing.body = finding.body;
      existing.title = finding.title;
      if (finding.suggestion) existing.suggestion = finding.suggestion;
    } else if (finding.suggestion && !existing.suggestion) {
      existing.suggestion = finding.suggestion;
    }
    if (!existing.startLine && finding.startLine) {
      existing.startLine = finding.startLine;
    }
    if (!existing.fixOptions && finding.fixOptions) {
      existing.fixOptions = finding.fixOptions;
    }
    if (!existing.recommendation && finding.recommendation) {
      existing.recommendation = finding.recommendation;
    }
    if (existing.isArchitectural === undefined && finding.isArchitectural !== undefined) {
      existing.isArchitectural = finding.isArchitectural;
    }
  }

  const ranked = [...byKey.values()].sort((a, b) => {
    const ra = severityRank[a.severity] ?? 9;
    const rb = severityRank[b.severity] ?? 9;
    if (ra !== rb) return ra - rb;
    return a.path.localeCompare(b.path) || a.line - b.line;
  });

  return ranked.slice(0, max).map((entry) => {
    const personas = entry.personas;
    const attribution =
      personas.length > 1
        ? `\n\n**Seen by personas:** ${personas.map((p) => `\`${p}\``).join(', ')}`
        : `\n\n**Persona:** \`${personas[0]}\``;
    return {
      severity: entry.severity,
      path: entry.path,
      line: entry.line,
      title: entry.title,
      body: `${entry.body || ''}${attribution}`,
      ...(entry.startLine !== undefined ? { startLine: entry.startLine } : {}),
      ...(entry.suggestion ? { suggestion: entry.suggestion } : {}),
      ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
      ...(entry.recommendation ? { recommendation: entry.recommendation } : {}),
      ...(entry.fixOptions ? { fixOptions: entry.fixOptions } : {}),
      ...(entry.isArchitectural !== undefined ? { isArchitectural: entry.isArchitectural } : {}),
      persona: personas[0],
    };
  });
}

export function formatPersonaIssueComment(
  lane: Pick<PersonaLaneResult, 'id' | 'required' | 'providerId' | 'model' | 'decision' | 'durationMs' | 'usage' | 'costUSD' | 'findings'>,
  headSha: string,
  options?: {
    runId?: string;
    laneIndex?: number;
    laneTotal?: number;
    usageLine?: string;
    costLine?: string;
  },
): string {
  const findings = lane.findings || [];
  const decision = lane.decision === 'APPROVE' ? 'CLEAN' : 'FINDINGS';
  const lines: string[] = [
    `${PERSONA_ISSUE_MARKER_PREFIX} persona=${lane.id} head=${headSha.slice(0, 12)} -->`,
    `## Review persona report: \`${lane.id}\` (advisory)`,
    '',
    '> Not a merge gate. Persona reports are conversation comments only — they do **not** open resolve-required review threads.',
    '',
    `- Required: ${lane.required ? 'yes' : 'no'}`,
    `- Provider: \`${lane.providerId}\``,
    `- Model: \`${lane.model}\``,
    `- Decision: \`${decision}\` (\`${lane.decision}\`)`,
    `- Duration: ${lane.durationMs} ms`,
  ];

  if (options?.usageLine) lines.push(`- Tokens: ${options.usageLine}`);
  if (options?.costLine) lines.push(`- Cost: ${options.costLine}`);
  if (options?.runId) lines.push(`- Run ID: \`${options.runId}\``);
  if (options?.laneIndex && options?.laneTotal) {
    lines.push(`- Lane: \`${options.laneIndex}/${options.laneTotal}\``);
  }
  lines.push(`- Exact head: \`${headSha}\``);
  lines.push(`- Actionable findings (summary only): \`${findings.length}\``);
  lines.push('');

  if (findings.length === 0) {
    lines.push('No findings from this persona.');
  } else {
    lines.push('### Findings (summary — final phase owns line threads)');
    for (const f of findings.slice(0, 25)) {
      lines.push(
        `- **${f.severity}** \`${f.path}:${f.line}\` — ${f.title}`,
      );
    }
    if (findings.length > 25) {
      lines.push(`- …and ${findings.length - 25} more (see final review ledger).`);
    }
  }

  lines.push('');
  lines.push('<!-- /ct-review-persona -->');
  return lines.join('\n');
}

export function buildFinalInlineComments(options: {
  findings: FindingWithPersona[];
  max?: number;
  owner?: string;
  repo?: string;
  prNumber?: number;
  commitSha?: string;
}): PublishInlineCommentRequest[] {
  const deduped = dedupeActionableFindings(options.findings, { max: options.max });
  return deduped.map((finding) => ({
    ...(options.owner ? { owner: options.owner } : {}),
    ...(options.repo ? { repo: options.repo } : {}),
    ...(options.prNumber !== undefined ? { prNumber: options.prNumber } : {}),
    ...(options.commitSha ? { commitSha: options.commitSha } : {}),
    path: finding.path,
    line: finding.line,
    ...(finding.startLine !== undefined ? { startLine: finding.startLine } : {}),
    finding: {
      persona: finding.persona as any,
      severity: finding.severity === 'P0' ? 'critical' : finding.severity === 'P1' ? 'major' : 'minor',
      filePath: finding.path,
      lineNumber: finding.line,
      ...(finding.startLine !== undefined ? { startLine: finding.startLine } : {}),
      title: finding.title,
      comment: `${finding.title}\n\n${finding.body}`,
      suggestion: finding.suggestion,
      confidence: finding.confidence,
      recommendation: finding.recommendation,
      fixOptions: finding.fixOptions,
      isArchitectural: finding.isArchitectural,
    },
  }));
}

export function formatFinalReviewBody(options: {
  verdict: string;
  rationale: string;
  summary: string;
  headSha: string;
  inlineCount: number;
  totalActionableCandidates: number;
  maxInline: number;
}): string {
  const threadNote =
    options.inlineCount > 0
      ? `Opening **${options.inlineCount}** actionable review thread(s) (P0/P1, deduped, cap ${options.maxInline}). ` +
        `Persona reports were posted as issue comments only.`
      : `No P0/P1 actionable threads after cross-persona dedupe (candidates considered: ${options.totalActionableCandidates}). ` +
        `Persona reports were posted as issue comments only.`;

  return [
    `${FINAL_REVIEW_MARKER_PREFIX} head=${options.headSha.slice(0, 12)} -->`,
    `## Binding arbiter verdict: ${options.verdict}`,
    '',
    options.rationale,
    '',
    threadNote,
    '',
    options.summary,
  ].join('\n');
}
