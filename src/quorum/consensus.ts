import { Persona, CtReviewConfig } from '../config/schema';
import { mefEngineResult, PersonaFinding } from './mefEngine';
import { evaluateQuorum, QuorumEvaluationResult } from './quorumEngine';
import { TicketValidationResult, validateTicketLinkage } from '../ticket/ticketValidator';
import { ConstitutionEvaluationResult, evaluateConstitution, ParsedConstitution } from '../constitution/constitutionEngine';
import { DiffStateManager, IncomingHunkInput, ProcessPRUpdateResult } from '../persistence/diffStateManager';
import { TrackedFinding } from '../persistence/db';

export type SeverityLevel = 'critical' | 'major' | 'minor' | 'nit';
export type QuorumDecision = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface InlineReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side: 'RIGHT';
  body: string;
}

export interface QuorumConsensusInput {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  config: CtReviewConfig;
  hunks?: IncomingHunkInput[];
  mefResult?: mefEngineResult;
  personaFindingsMap?: Record<Persona, PersonaFinding[]>;
  ticketResult?: TicketValidationResult;
  constitutionResult?: ConstitutionEvaluationResult;
  prTitle?: string;
  prBody?: string;
  changedFiles?: Array<{ path: string; patch?: string; content?: string }>;
  constitution?: ParsedConstitution;
}

export interface QuorumResult {
  summary: string;
  decision: QuorumDecision;
  findings: PersonaFinding[];
  activeFindings: PersonaFinding[];
  filteredNits: PersonaFinding[];
  resolvedFindings: TrackedFinding[];
  suppressedFindingHashes: string[];
  ticketValidation: TicketValidationResult;
  constitutionCompliance: ConstitutionEvaluationResult;
  formattedMarkdown: string;
  inlineComments: InlineReviewComment[];
  stats: {
    totalFindingsRaw: number;
    totalFindingsDeduplicated: number;
    activeFindingsCount: number;
    filteredNitsCount: number;
    resolvedFindingsCount: number;
    suppressedFindingsCount: number;
    personasExecuted: Persona[];
    approvingPersonas: Persona[];
    requestingChangesPersonas: Persona[];
    tokensUsed: number;
  };
}

const SEVERITY_PRECEDENCE: Record<SeverityLevel, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  nit: 1,
};

const PERSONA_PRECEDENCE: Record<Persona, number> = {
  security: 4,
  architecture: 3,
  performance: 2,
  quality: 1,
};

export function deduplicateAcrossPersonas(findings: PersonaFinding[]): PersonaFinding[] {
  if (!findings || findings.length === 0) return [];

  const deduplicated: PersonaFinding[] = [];

  for (const newFinding of findings) {
    let merged = false;

    for (let i = 0; i < deduplicated.length; i++) {
      const existing = deduplicated[i];

      // Same file path check
      if (existing.filePath !== newFinding.filePath) continue;

      // Line number overlap tolerance check (+/- 2 lines)
      const existingStart = existing.lineNumber;
      const existingEnd = existing.endLineNumber || existing.lineNumber;
      const newStart = newFinding.lineNumber;
      const newEnd = newFinding.endLineNumber || newFinding.lineNumber;

      const lineOverlap =
        Math.max(existingStart, newStart) <= Math.min(existingEnd, newEnd) + 2 &&
        Math.abs(existingStart - newStart) <= 2;

      // Snippet / Rule / Comment similarity check
      const sameRule = Boolean(existing.ruleId && newFinding.ruleId && existing.ruleId === newFinding.ruleId);
      const snippetOverlap = Boolean(
        existing.codeSnippet &&
          newFinding.codeSnippet &&
          existing.codeSnippet.trim().toLowerCase() === newFinding.codeSnippet.trim().toLowerCase()
      );
      const commentOverlap = existing.comment.toLowerCase().includes(newFinding.comment.toLowerCase().slice(0, 15)) ||
        newFinding.comment.toLowerCase().includes(existing.comment.toLowerCase().slice(0, 15));

      if (sameRule || snippetOverlap || commentOverlap || lineOverlap) {
        // Merge findings
        merged = true;
        const exSevScore = SEVERITY_PRECEDENCE[existing.severity] || 0;
        const newSevScore = SEVERITY_PRECEDENCE[newFinding.severity] || 0;
        const exPersonaScore = PERSONA_PRECEDENCE[existing.persona] || 0;
        const newPersonaScore = PERSONA_PRECEDENCE[newFinding.persona] || 0;

        const coSponsors = new Set<Persona>([
          ...(existing.coSponsoringPersonas || []),
          existing.persona,
          newFinding.persona,
        ]);

        let primaryFinding: PersonaFinding;
        let secondaryFinding: PersonaFinding;

        if (newSevScore > exSevScore || (newSevScore === exSevScore && newPersonaScore > exPersonaScore)) {
          primaryFinding = newFinding;
          secondaryFinding = existing;
        } else {
          primaryFinding = existing;
          secondaryFinding = newFinding;
        }

        coSponsors.delete(primaryFinding.persona);

        const mergedSuggestion = primaryFinding.suggestion || secondaryFinding.suggestion;
        const mergedRuleId = primaryFinding.ruleId || secondaryFinding.ruleId;
        const mergedSnippet = primaryFinding.codeSnippet || secondaryFinding.codeSnippet || '';

        deduplicated[i] = {
          ...primaryFinding,
          suggestion: mergedSuggestion,
          ruleId: mergedRuleId,
          codeSnippet: mergedSnippet,
          coSponsoringPersonas: Array.from(coSponsors),
        };
        break;
      }
    }

    if (!merged) {
      deduplicated.push({ ...newFinding });
    }
  }

  return deduplicated;
}

export function formatInlineComments(findings: PersonaFinding[]): InlineReviewComment[] {
  return findings.map((f) => {
    const personaIcon: Record<Persona, string> = {
      security: '🛡️ Security',
      architecture: '🏗️ Architecture',
      performance: '⚡ Performance',
      quality: '🎨 Quality',
    };

    const coSponsorText = f.coSponsoringPersonas && f.coSponsoringPersonas.length > 0
      ? ` *(co-sponsored by ${f.coSponsoringPersonas.map((p) => `\`${p}\``).join(', ')})*`
      : '';

    let body = `### ${personaIcon[f.persona] || f.persona} [${f.severity.toUpperCase()}]: ${f.comment}\n`;
    body += `**Persona**: \`${f.persona}\`${coSponsorText} | **Severity**: \`${f.severity.toUpperCase()}\``;
    if (f.ruleId) {
      body += ` | **Rule**: \`${f.ruleId}\``;
    }
    body += `\n\n${f.comment}\n`;

    if (f.suggestion) {
      body += `\n\`\`\`suggestion\n${f.suggestion}\n\`\`\`\n`;
    }

    body += `\n---\n*Flagged by ct-review-bot Quorum Engine*`;

    return {
      path: f.filePath,
      line: f.lineNumber,
      side: 'RIGHT',
      body,
    };
  });
}

export function buildPRSummaryMarkdown(params: {
  decision: QuorumDecision;
  ticketResult: TicketValidationResult;
  constitutionResult: ConstitutionEvaluationResult;
  minApprovals: number;
  configuredPersonas: Persona[];
  executedPersonas: Persona[];
  failedPersonas: Persona[];
  approvingPersonas: Persona[];
  requestingChangesPersonas: Persona[];
  activeFindings: PersonaFinding[];
  filteredNits: PersonaFinding[];
  resolvedFindingsCount?: number;
  tokensUsed: number;
}): string {
  const {
    decision,
    ticketResult,
    constitutionResult,
    minApprovals,
    configuredPersonas,
    executedPersonas,
    approvingPersonas,
    requestingChangesPersonas,
    activeFindings,
    filteredNits,
    resolvedFindingsCount = 0,
    tokensUsed,
  } = params;

  let decisionBadge = '🟢 **APPROVED**';
  if (decision === 'REQUEST_CHANGES') {
    decisionBadge = '🔴 **CHANGES REQUESTED**';
  } else if (decision === 'COMMENT') {
    decisionBadge = '🟡 **COMMENT ONLY**';
  }

  const personaIcons: Record<Persona, string> = {
    security: '🛡️ Security',
    architecture: '🏗️ Architecture',
    performance: '⚡ Performance',
    quality: '🎨 Quality',
  };

  const personaRows = configuredPersonas
    .map((p) => {
      const isExecuted = executedPersonas.includes(p);
      const isApproving = approvingPersonas.includes(p);
      const isRequesting = requestingChangesPersonas.includes(p);

      let statusStr = '✅ Approve';
      if (!isExecuted) {
        statusStr = '⚠️ Execution Failed';
      } else if (isRequesting) {
        statusStr = '❌ Request Changes';
      } else if (!isApproving) {
        statusStr = '🟡 Advisory Comment';
      }

      const pActiveCount = activeFindings.filter((f) => f.persona === p).length;
      const pNitCount = filteredNits.filter((f) => f.persona === p).length;

      return `| ${personaIcons[p] || p} | ${statusStr} | ${pActiveCount} | ${pNitCount} |`;
    })
    .join('\n');

  // Governance Section
  const ticketIcon = ticketResult.valid ? '✅' : ticketResult.mode === 'strict' ? '❌' : '⚠️';
  const ticketStatusStr = ticketResult.valid
    ? `VALID (Found: ${ticketResult.ticketsFound.join(', ') || 'None'})`
    : `INVALID (${ticketResult.error || 'No tickets linked'}) [Mode: ${ticketResult.mode}]`;

  const constIcon = constitutionResult.compliant ? '✅' : constitutionResult.bypassed ? '🟡' : '❌';
  let constStatusStr = constitutionResult.compliant
    ? 'COMPLIANT'
    : constitutionResult.bypassed
    ? 'BYPASSED'
    : 'NON-COMPLIANT';

  if (constitutionResult.violations && constitutionResult.violations.length > 0) {
    constStatusStr += `\n` + constitutionResult.violations.map((v) => `  - 🚨 ${v}`).join('\n');
  }

  // Active Findings Section
  let activeFindingsBlock = '_No blocking findings identified._';
  if (activeFindings.length > 0) {
    activeFindingsBlock = activeFindings
      .map((f, idx) => {
        const ruleStr = f.ruleId ? ` [\`${f.ruleId}\`]` : '';
        const coSponsor = f.coSponsoringPersonas && f.coSponsoringPersonas.length > 0
          ? ` *(co-sponsored by ${f.coSponsoringPersonas.join(', ')})*`
          : '';

        let block = `### ${idx + 1}. ${personaIcons[f.persona] || f.persona}: \`${f.filePath}\` (Line ${f.lineNumber}) - ${f.severity.toUpperCase()}${ruleStr}${coSponsor}\n`;
        block += `> ${f.comment}\n`;

        if (f.suggestion) {
          block += `\n\`\`\`suggestion\n${f.suggestion}\n\`\`\`\n`;
        }

        return block;
      })
      .join('\n---\n');
  }

  // Filtered Nits Section
  let nitsBlock = '_No suppressed nits or style recommendations._';
  if (filteredNits.length > 0) {
    nitsBlock = filteredNits
      .map(
        (f) =>
          `- **\`${f.filePath}\`:${f.lineNumber}** [${f.persona}]: ${f.comment}`
      )
      .join('\n');
  }

  return `# 🤖 ct-review-bot Quorum Review Summary

### Verdict: ${decisionBadge}

| Persona | Status | Active Findings | Nits Filtered |
|---|---|:---:|:---:|
${personaRows}

*Quorum Requirement*: Minimum **${minApprovals} approval(s)** required (Achieved: **${approvingPersonas.length}** approving persona(s)).

---

### 📋 Governance & Policy Checks
- **Ticket Linkage**: ${ticketIcon} ${ticketStatusStr}
- **Constitution Compliance**: ${constIcon} ${constStatusStr}

---

### ⚠️ Key Active Findings (${activeFindings.length})

${activeFindingsBlock}

---

<details>
<summary>💡 Suppressed Nits & Minor Style Notes (${filteredNits.length})</summary>

${nitsBlock}

</details>

---

### 📊 Summary Statistics
- **Total Raw Findings**: ${activeFindings.length + filteredNits.length}
- **Active Findings**: ${activeFindings.length}
- **Filtered Nits**: ${filteredNits.length}
- **Previously Resolved Items**: ${resolvedFindingsCount}
- **LLM Tokens Used**: ${tokensUsed.toLocaleString()}
`;
}

export async function aggregateQuorumConsensus(
  input: QuorumConsensusInput,
  diffStateManager?: DiffStateManager
): Promise<QuorumResult> {
  const {
    repoOwner,
    repoName,
    prNumber,
    headSha,
    baseSha,
    config,
    hunks = [],
    mefResult,
    prTitle = '',
    prBody = '',
    changedFiles = [],
    constitution,
  } = input;

  const minApprovals = config.quorum?.minApprovals ?? 2;
  const configuredPersonas: Persona[] = config.quorum?.personas || [
    'security',
    'architecture',
    'performance',
    'quality',
  ];

  // 1. Ticket Linkage Validation
  const ticketValidation: TicketValidationResult =
    input.ticketResult ||
    validateTicketLinkage({
      title: prTitle,
      body: prBody,
      config: config.ticketEnforcement,
    });

  // 2. Operational Constitution Compliance Check
  let constitutionCompliance: ConstitutionEvaluationResult;
  if (input.constitutionResult) {
    constitutionCompliance = input.constitutionResult;
  } else if (constitution) {
    constitutionCompliance = evaluateConstitution({
      constitution,
      config: config.constitution,
      prTitle,
      prBody,
      changedFiles,
    });
  } else {
    constitutionCompliance = { compliant: true, violations: [] };
  }

  // 3. Raw Findings Collection from mefResult or personaFindingsMap
  let rawFindings: PersonaFinding[] = [];
  let executedPersonas: Persona[] = [];
  let failedPersonas: Persona[] = [];
  let tokensUsed = 0;

  if (mefResult) {
    rawFindings = mefResult.allFindings || [];
    executedPersonas = mefResult.stats?.personasExecuted || [];
    failedPersonas = mefResult.stats?.personasFailed || [];
    tokensUsed = mefResult.stats?.totalTokensUsed || 0;
  } else if (input.personaFindingsMap) {
    for (const p of Object.keys(input.personaFindingsMap) as Persona[]) {
      if (configuredPersonas.includes(p)) {
        const pFindings = input.personaFindingsMap[p] || [];
        rawFindings.push(...pFindings);
        executedPersonas.push(p);
      }
    }
  }

  // 4. Cross-Persona Deduplication
  const deduplicatedFindings = deduplicateAcrossPersonas(rawFindings);

  // 5. Incremental Diff Delta Filtering Integration
  let activeFindings: PersonaFinding[] = [];
  let filteredNits: PersonaFinding[] = [];
  let resolvedFindings: TrackedFinding[] = [];
  let suppressedFindingHashes: string[] = [];

  if (diffStateManager && (hunks.length > 0 || deduplicatedFindings.length > 0)) {
    const incomingQuorumFindings = deduplicatedFindings.map((f) => ({
      filePath: f.filePath,
      startLine: f.lineNumber,
      endLine: f.endLineNumber || f.lineNumber,
      persona: f.persona,
      severity: f.severity,
      comment: f.comment,
      ruleId: f.ruleId,
      codeSnippet: f.codeSnippet || f.suggestion || '',
    }));

    const processResult: ProcessPRUpdateResult = await diffStateManager.processPRCommitUpdate({
      repoOwner,
      repoName,
      prNumber,
      headSha,
      baseSha,
      hunks,
      quorumFindings: incomingQuorumFindings,
    });

    resolvedFindings = processResult.resolvedFindings || [];
    suppressedFindingHashes = processResult.suppressedFindingHashes || [];

    for (const f of deduplicatedFindings) {
      if (f.severity === 'nit') {
        filteredNits.push(f);
      } else {
        activeFindings.push(f);
      }
    }
  } else {
    for (const f of deduplicatedFindings) {
      if (f.severity === 'nit') {
        filteredNits.push(f);
      } else {
        activeFindings.push(f);
      }
    }
  }

  // 6. Persona Voting & Decision Evaluation
  const evalPersonas = executedPersonas.length > 0 ? executedPersonas : configuredPersonas;
  const personaFindingsMapForEval: Record<string, PersonaFinding[]> = {};
  for (const p of evalPersonas) {
    personaFindingsMapForEval[p] = activeFindings.filter((f) => f.persona === p);
  }

  const quorumEval: QuorumEvaluationResult = evaluateQuorum({
    minApprovals,
    configuredPersonas: evalPersonas,
    personaFindings: personaFindingsMapForEval,
  });

  const approvingPersonas: Persona[] = (quorumEval.approvingPersonas || []) as Persona[];
  const requestingChangesPersonas: Persona[] = (quorumEval.requestingChangesPersonas || []) as Persona[];

  let decision: QuorumDecision = quorumEval.decision;

  // Verdict Override Logic:
  // Strict ticket failure OR constitution violation OR active critical/major finding triggers REQUEST_CHANGES
  if (!ticketValidation.valid && ticketValidation.mode === 'strict') {
    decision = 'REQUEST_CHANGES';
  } else if (!constitutionCompliance.compliant && !constitutionCompliance.bypassed) {
    decision = 'REQUEST_CHANGES';
  } else if (activeFindings.some((f) => f.severity === 'critical' || f.severity === 'major')) {
    decision = 'REQUEST_CHANGES';
  } else if (approvingPersonas.length >= minApprovals) {
    decision = 'APPROVE';
  } else {
    decision = 'COMMENT';
  }

  // 7. Inline Comments & Summary Markdown Generation
  const inlineComments = formatInlineComments(activeFindings);
  const formattedMarkdown = buildPRSummaryMarkdown({
    decision,
    ticketResult: ticketValidation,
    constitutionResult: constitutionCompliance,
    minApprovals,
    configuredPersonas,
    executedPersonas,
    failedPersonas,
    approvingPersonas,
    requestingChangesPersonas,
    activeFindings,
    filteredNits,
    resolvedFindingsCount: resolvedFindings.length,
    tokensUsed,
  });

  return {
    summary: `Quorum review finished with decision: ${decision} (${activeFindings.length} active findings, ${filteredNits.length} nits)`,
    decision,
    findings: deduplicatedFindings,
    activeFindings,
    filteredNits,
    resolvedFindings,
    suppressedFindingHashes,
    ticketValidation,
    constitutionCompliance,
    formattedMarkdown,
    inlineComments,
    stats: {
      totalFindingsRaw: rawFindings.length,
      totalFindingsDeduplicated: deduplicatedFindings.length,
      activeFindingsCount: activeFindings.length,
      filteredNitsCount: filteredNits.length,
      resolvedFindingsCount: resolvedFindings.length,
      suppressedFindingsCount: suppressedFindingHashes.length,
      personasExecuted: executedPersonas,
      approvingPersonas,
      requestingChangesPersonas,
      tokensUsed,
    },
  };
}
