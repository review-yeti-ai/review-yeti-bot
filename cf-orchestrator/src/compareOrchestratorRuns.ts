/**
 * compareOrchestratorRuns.ts
 *
 * Compares two review runs (DOKS production vs. Cloudflare parallel canary)
 * for the same repository and commit SHA to verify exact functional parity.
 */

import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunnerCostDetails } from './runners/runnerCost.js';

export interface ReviewRunReceipt {
  orchestrator: 'doks' | 'cloudflare';
  runId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  verdict: 'neutral' | 'success' | 'action_required' | 'cancelled';
  findingFingerprints: string[];
  durationMs: number;
  tokensUsed?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  zoektIndexShards?: number;
  runnerCost?: RunnerCostDetails;
  completedAt: string;
}

export interface Finding {
  ruleId: string;
  file: string;
  line?: number;
  severity?: string;
  message?: string;
}

export interface ParityComparisonResult {
  match: boolean;
  repo: string;
  headSha: string;
  verdictMatch: boolean;
  findingFingerprintsMatch: boolean;
  findingCountDiff: number;
  latencyDeltaMs: number;
  latencyRatio: number;
  tokenDelta?: number;
  tokenWarning: boolean;
  doksOnly: string[];
  cfOnly: string[];
  notes: string[];
}

/**
 * Computes a standardized finding fingerprint from either a Finding object
 * or an existing fingerprint string.
 */
export function computeFingerprint(finding: Finding | string): string {
  if (!finding) return '';
  if (typeof finding === 'string') {
    return finding.trim();
  }
  const rawFile = finding.file || '';
  const file = rawFile.replace(/\\/g, '/').replace(/^\.\//, '');
  const line = Math.max(1, Math.floor(Number(finding.line) || 1));
  const ruleId = finding.ruleId || '';
  const severity = String(finding?.severity ?? 'warning').toLowerCase();
  return `${file}:${line}:${ruleId}:${severity}`;
}

/**
 * Sanitizes text for safe inclusion in Markdown table cells.
 * Replaces newlines with spaces, escapes pipes, and escapes backticks.
 */
export function sanitizeMarkdownCell(text: string): string {
  if (!text) return '';
  return text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').replace(/`/g, '\\`');
}

/**
 * Evaluates parity between a DOKS production review receipt and a Cloudflare canary receipt.
 */
export function compareRuns(doks: ReviewRunReceipt, cf: ReviewRunReceipt): ParityComparisonResult {
  const notes: string[] = [];

  // 1. Verdict Parity
  const verdictMatch = doks.verdict === cf.verdict;
  if (!verdictMatch) {
    notes.push(`Verdict mismatch: DOKS=${doks.verdict} vs Cloudflare=${cf.verdict}`);
  }

  // 2. Finding Fingerprint Set Comparison (Symmetric Difference)
  const doksFp = Array.isArray(doks.findingFingerprints) ? doks.findingFingerprints : [];
  const cfFp = Array.isArray(cf.findingFingerprints) ? cf.findingFingerprints : [];

  const doksSet = new Set(doksFp);
  const cfSet = new Set(cfFp);

  const doksOnly = doksFp.filter((fp) => !cfSet.has(fp));
  const cfOnly = cfFp.filter((fp) => !doksSet.has(fp));

  const findingFingerprintsMatch = doksOnly.length === 0 && cfOnly.length === 0;
  if (!findingFingerprintsMatch) {
    notes.push(
      `Finding fingerprint divergence: ${doksOnly.length} missing in CF, ${cfOnly.length} unexpected in CF`
    );
  }

  // 3. Performance & Latency Metrics
  const doksDuration = Number.isNaN(doks.durationMs) ? 0 : Math.max(0, doks.durationMs ?? 0);
  const cfDuration = Number.isNaN(cf.durationMs) ? 0 : Math.max(0, cf.durationMs ?? 0);
  const latencyDeltaMs = cfDuration - doksDuration;
  const rawRatio = doksDuration > 0 ? cfDuration / doksDuration : 1.0;
  const latencyRatio = Number.isNaN(rawRatio) ? 1.0 : Math.round(rawRatio * 100) / 100;

  // 4. Token Usage & Warning Threshold (> 500 tokens)
  let tokenDelta: number | undefined;
  let tokenWarning = false;
  if (doks.tokensUsed && cf.tokensUsed) {
    tokenDelta = cf.tokensUsed.totalTokens - doks.tokensUsed.totalTokens;
    tokenWarning = Math.abs(tokenDelta) > 500;
    if (tokenWarning) {
      notes.push(`Noticeable token difference: DOKS=${doks.tokensUsed.totalTokens} vs CF=${cf.tokensUsed.totalTokens}`);
    }
  } else {
    tokenWarning = false;
  }

  const match = verdictMatch && findingFingerprintsMatch;

  return {
    match,
    repo: doks.repo,
    headSha: doks.headSha,
    verdictMatch,
    findingFingerprintsMatch,
    findingCountDiff: cfFp.length - doksFp.length,
    latencyDeltaMs,
    latencyRatio,
    tokenDelta,
    tokenWarning,
    doksOnly,
    cfOnly,
    notes,
  };
}

/**
 * Formats a terminal-friendly ASCII summary report.
 * Backwards compatible with existing assertions.
 */
export function formatComparisonReport(result: ParityComparisonResult): string {
  const statusEmoji = result.match ? '✅ MATCH' : '❌ MISMATCH';

  return `
============================================================
 ORCHESTRATOR PARITY REPORT: ${result.repo} @ ${result.headSha.slice(0, 7)}
 Status: ${statusEmoji}
============================================================
• Verdict Agreement:         ${result.verdictMatch ? 'YES' : 'NO'}
• Finding Fingerprint Match: ${result.findingFingerprintsMatch ? 'YES' : 'NO'} (diff: ${result.findingCountDiff > 0 ? '+' : ''}${result.findingCountDiff})
• Latency Delta:             ${result.latencyDeltaMs > 0 ? '+' : ''}${result.latencyDeltaMs}ms (${result.latencyRatio}x)
${result.tokenDelta !== undefined ? `• Token Usage Delta:         ${result.tokenDelta > 0 ? '+' : ''}${result.tokenDelta}` : ''}
${result.notes.length > 0 ? `\nNotes:\n- ${result.notes.join('\n- ')}` : ''}
============================================================
`;
}

/**
 * Formats a GitHub-Flavored Markdown (GFM) ledger for CI step summaries and PR comments.
 */
export function formatMarkdownLedger(
  result: ParityComparisonResult,
  doks?: ReviewRunReceipt,
  cf?: ReviewRunReceipt
): string {
  const statusBadge = result.match ? '✅ MATCH' : '❌ MISMATCH';
  const prNum = doks?.prNumber ?? cf?.prNumber;
  const prDisplay = prNum !== undefined ? `#${prNum}` : 'N/A';
  const commitShort = result.headSha ? result.headSha.slice(0, 7) : 'N/A';

  const doksVerdict = doks?.verdict ?? 'N/A';
  const cfVerdict = cf?.verdict ?? 'N/A';
  const verdictAgreement = result.verdictMatch ? '✅ YES' : '❌ NO';

  const doksDuration = doks ? `${doks.durationMs.toLocaleString()} ms` : 'N/A';
  const cfDuration = cf ? `${cf.durationMs.toLocaleString()} ms` : 'N/A';
  const latencyDeltaStr = `${result.latencyDeltaMs > 0 ? '+' : ''}${result.latencyDeltaMs.toLocaleString()} ms`;
  const latencyStatus = result.latencyDeltaMs < 0 ? '⚡ Faster' : result.latencyDeltaMs > 0 ? 'Slower' : 'Equal';

  const doksPrompt =
    typeof doks?.tokensUsed?.promptTokens === 'number'
      ? doks.tokensUsed.promptTokens.toLocaleString()
      : 'N/A';
  const cfPrompt =
    typeof cf?.tokensUsed?.promptTokens === 'number'
      ? cf.tokensUsed.promptTokens.toLocaleString()
      : 'N/A';
  const promptDelta =
    typeof doks?.tokensUsed?.promptTokens === 'number' &&
    typeof cf?.tokensUsed?.promptTokens === 'number'
      ? `${cf.tokensUsed.promptTokens - doks.tokensUsed.promptTokens > 0 ? '+' : ''}${(cf.tokensUsed.promptTokens - doks.tokensUsed.promptTokens).toLocaleString()}`
      : 'N/A';

  const doksComp =
    typeof doks?.tokensUsed?.completionTokens === 'number'
      ? doks.tokensUsed.completionTokens.toLocaleString()
      : 'N/A';
  const cfComp =
    typeof cf?.tokensUsed?.completionTokens === 'number'
      ? cf.tokensUsed.completionTokens.toLocaleString()
      : 'N/A';
  const compDelta =
    typeof doks?.tokensUsed?.completionTokens === 'number' &&
    typeof cf?.tokensUsed?.completionTokens === 'number'
      ? `${cf.tokensUsed.completionTokens - doks.tokensUsed.completionTokens > 0 ? '+' : ''}${(cf.tokensUsed.completionTokens - doks.tokensUsed.completionTokens).toLocaleString()}`
      : 'N/A';

  const doksTotal =
    typeof doks?.tokensUsed?.totalTokens === 'number'
      ? doks.tokensUsed.totalTokens.toLocaleString()
      : 'N/A';
  const cfTotal =
    typeof cf?.tokensUsed?.totalTokens === 'number'
      ? cf.tokensUsed.totalTokens.toLocaleString()
      : 'N/A';
  const totalDelta =
    result.tokenDelta !== undefined
      ? `${result.tokenDelta > 0 ? '+' : ''}${result.tokenDelta.toLocaleString()}`
      : 'N/A';
  const tokenStatus = result.tokenWarning ? '⚠️ Divergent (>500 tokens)' : 'Nominal';

  const doksCostStr = doks?.runnerCost?.formattedCost ?? 'N/A';
  const cfCostStr = cf?.runnerCost?.formattedCost ?? 'N/A';
  let runnerCostRow = '';
  if (doks?.runnerCost || cf?.runnerCost) {
    const costDelta = (cf?.runnerCost && doks?.runnerCost)
      ? `${cf.runnerCost.costUsd < doks.runnerCost.costUsd ? '⚡ ' : ''}${(cf.runnerCost.costUsd - doks.runnerCost.costUsd).toFixed(6)} USD`
      : '—';
    const costStatus = (cf?.runnerCost && doks?.runnerCost && doks.runnerCost.costUsd > 0)
      ? `${Math.round((cf.runnerCost.costUsd / doks.runnerCost.costUsd) * 100)}% of DOKS`
      : (cf?.runnerCost ? cf.runnerCost.runnerName : '—');
    runnerCostRow = `\n| **Runner Cost** | ${doksCostStr} | ${cfCostStr} | ${costDelta} | ${costStatus} |`;
  }

  let findingSection: string;
  if (result.findingFingerprintsMatch) {
    const count = doks?.findingFingerprints?.length ?? cf?.findingFingerprints?.length ?? 0;
    findingSection = `### 3. Finding Fingerprint Divergence\n✅ **100% Finding Parity**: All ${count} findings matched identically between DOKS and Cloudflare.`;
  } else {
    const totalDiscrepancies = result.doksOnly.length + result.cfOnly.length;
    const rows: string[] = [];
    for (const fp of result.doksOnly) {
      rows.push(`| ⚠️ **DOKS Only** | \`${sanitizeMarkdownCell(fp)}\` | Missing in Cloudflare Canary |`);
    }
    for (const fp of result.cfOnly) {
      rows.push(`| ⚠️ **CF Only** | \`${sanitizeMarkdownCell(fp)}\` | Unexpected in Cloudflare |`);
    }
    findingSection = `### 3. Finding Fingerprint Divergence\n❌ **${totalDiscrepancies} Finding Discrepanc${totalDiscrepancies === 1 ? 'y' : 'ies'} Detected**\n\n| Origin | Fingerprint | Description / Status |\n|---|---|---|\n${rows.join('\n')}`;
  }

  let notesSection = '';
  if (result.notes.length > 0) {
    notesSection = `\n\n---\n\n### 4. Diagnostic Notes & Warnings\n${result.notes.map((n) => `- ${n}`).join('\n')}`;
  }

  return `# ⚖️ Review Yeti Orchestrator Parity Ledger

### Status: ${statusBadge}
> **Repository:** \`${result.repo}\` | **Commit:** \`${commitShort}\` | **PR:** \`${prDisplay}\`

---

### 1. Review Verdict Parity
| Dimension | DOKS Production | Cloudflare Canary | Agreement |
|---|---|---|---|
| **Verdict** | \`${doksVerdict}\` | \`${cfVerdict}\` | ${verdictAgreement} |
| **Run ID** | \`${doks?.runId ?? 'N/A'}\` | \`${cf?.runId ?? 'N/A'}\` | — |
| **Completed At** | \`${doks?.completedAt ?? 'N/A'}\` | \`${cf?.completedAt ?? 'N/A'}\` | — |

---

### 2. Execution & Cost Metrics
| Metric | DOKS Production | Cloudflare Canary | Delta (CF - DOKS) | Ratio / Status |
|---|---|---|---|---|
| **Wall Latency** | ${doksDuration} | ${cfDuration} | ${latencyDeltaStr} | **${result.latencyRatio}x** (${latencyStatus}) |
| **Prompt Tokens** | ${doksPrompt} | ${cfPrompt} | ${promptDelta} | — |
| **Completion Tokens** | ${doksComp} | ${cfComp} | ${compDelta} | — |
| **Total Tokens** | ${doksTotal} | ${cfTotal} | ${totalDelta} | ${tokenStatus} |${runnerCostRow}

---

${findingSection}${notesSection}
`;
}

/**
 * Validates untrusted JSON data against the ReviewRunReceipt contract.
 * Throws a descriptive Error if validation fails.
 */
export function validateReceipt(data: unknown, label: string): ReviewRunReceipt {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Invalid ${label} receipt: root must be a non-null object`);
  }
  const obj = data as Record<string, unknown>;

  if (obj.orchestrator !== 'doks' && obj.orchestrator !== 'cloudflare') {
    throw new Error(
      `Invalid ${label} receipt: orchestrator must be 'doks' or 'cloudflare', got ${JSON.stringify(obj.orchestrator)}`
    );
  }
  if (typeof obj.runId !== 'string' || obj.runId.trim() === '') {
    throw new Error(`Invalid ${label} receipt: runId must be a non-empty string`);
  }
  if (typeof obj.repo !== 'string' || obj.repo.trim() === '') {
    throw new Error(`Invalid ${label} receipt: repo must be a non-empty string`);
  }
  if (typeof obj.prNumber !== 'number' || !Number.isInteger(obj.prNumber) || obj.prNumber <= 0) {
    throw new Error(`Invalid ${label} receipt: prNumber must be a positive integer`);
  }
  if (typeof obj.headSha !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(obj.headSha.trim())) {
    throw new Error(`Invalid ${label} receipt: headSha must be a valid commit SHA string`);
  }
  const validVerdicts = ['neutral', 'success', 'action_required', 'cancelled'];
  if (typeof obj.verdict !== 'string' || !validVerdicts.includes(obj.verdict)) {
    throw new Error(`Invalid ${label} receipt: verdict must be one of ${validVerdicts.join(', ')}`);
  }
  if (!Array.isArray(obj.findingFingerprints) || !obj.findingFingerprints.every((f) => typeof f === 'string')) {
    throw new Error(`Invalid ${label} receipt: findingFingerprints must be an array of strings`);
  }
  if (typeof obj.durationMs !== 'number' || !Number.isFinite(obj.durationMs) || obj.durationMs < 0) {
    throw new Error(`Invalid ${label} receipt: durationMs must be a non-negative number`);
  }

  if (obj.tokensUsed !== undefined) {
    if (typeof obj.tokensUsed !== 'object' || obj.tokensUsed === null || Array.isArray(obj.tokensUsed)) {
      throw new Error(`Invalid ${label} receipt: tokensUsed must be an object`);
    }
    const t = obj.tokensUsed as Record<string, unknown>;
    for (const key of ['promptTokens', 'completionTokens', 'totalTokens']) {
      if (typeof t[key] !== 'number' || !Number.isFinite(t[key]) || (t[key] as number) < 0) {
        throw new Error(`Invalid ${label} receipt: tokensUsed.${key} must be a non-negative number`);
      }
    }
  }

  return {
    orchestrator: obj.orchestrator,
    runId: obj.runId,
    repo: obj.repo,
    prNumber: obj.prNumber,
    headSha: obj.headSha,
    verdict: obj.verdict as ReviewRunReceipt['verdict'],
    findingFingerprints: obj.findingFingerprints,
    durationMs: obj.durationMs,
    tokensUsed: obj.tokensUsed as ReviewRunReceipt['tokensUsed'],
    zoektIndexShards: obj.zoektIndexShards as number | undefined,
    runnerCost: obj.runnerCost as ReviewRunReceipt['runnerCost'],
    completedAt: (obj.completedAt as string) || new Date().toISOString(),
  };
}

export interface CliOptions {
  doks?: string;
  cf?: string;
  output?: string;
  summary?: boolean;
  'fail-on-mismatch'?: boolean;
  'github-step-summary'?: boolean;
  help?: boolean;
}

/**
 * Executes the comparison CLI logic.
 * Returns an exit code:
 *   0: Parity verified (or mismatch without fail-on-mismatch, or help)
 *   1: Parity mismatch with fail-on-mismatch enabled
 *   2: Argument errors, I/O errors, JSON syntax errors, or schema validation errors
 */
export function runCli(
  argv: string[],
  env: Record<string, string | undefined> = process.env
): number {
  let values: CliOptions;

  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        doks: { type: 'string' },
        cf: { type: 'string' },
        output: { type: 'string' },
        summary: { type: 'boolean' },
        'fail-on-mismatch': { type: 'boolean', default: false },
        'github-step-summary': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    });
    values = parsed.values as CliOptions;
  } catch (err: any) {
    console.error(`CLI argument error: ${err.message}`);
    return 2;
  }

  if (values.help) {
    console.log(`
Usage: compare-orchestrator-runs --doks <file> --cf <file> [options]

Options:
  --doks <path>            Path to DOKS ReviewRunReceipt JSON (required)
  --cf <path>              Path to Cloudflare ReviewRunReceipt JSON (required)
  --output <path>          Path to save Markdown parity ledger
  --summary                Display brief summary
  --fail-on-mismatch       Exit with code 1 if parity comparison fails (default: false)
  --github-step-summary    Append Markdown ledger to $GITHUB_STEP_SUMMARY (default: false)
  -h, --help               Show help message
`);
    return 0;
  }

  if (!values.doks || !values.cf) {
    console.error('Error: Both --doks and --cf arguments are required.');
    return 2;
  }

  const doksPath = String(values.doks);
  const cfPath = String(values.cf);

  let doksReceipt: ReviewRunReceipt;
  try {
    const raw = fs.readFileSync(doksPath, 'utf8') as string;
    const data = JSON.parse(raw);
    doksReceipt = validateReceipt(data, 'DOKS');
  } catch (err: any) {
    console.error(`Error reading DOKS receipt (${doksPath}): ${err.message}`);
    return 2;
  }

  let cfReceipt: ReviewRunReceipt;
  try {
    const raw = fs.readFileSync(cfPath, 'utf8') as string;
    const data = JSON.parse(raw);
    cfReceipt = validateReceipt(data, 'Cloudflare');
  } catch (err: any) {
    console.error(`Error reading Cloudflare receipt (${cfPath}): ${err.message}`);
    return 2;
  }

  // Cross-receipt target consistency check
  if (doksReceipt.repo !== cfReceipt.repo || doksReceipt.headSha !== cfReceipt.headSha) {
    console.error(
      `Error: Cross-receipt target mismatch: DOKS (${doksReceipt.repo}@${doksReceipt.headSha.slice(0, 7)}) vs Cloudflare (${cfReceipt.repo}@${cfReceipt.headSha.slice(0, 7)})`
    );
    return 2;
  }

  const result = compareRuns(doksReceipt, cfReceipt);
  console.log(formatComparisonReport(result));

  if (values.output) {
    try {
      const outputPath = String(values.output);
      const outDir = path.dirname(outputPath);
      if (outDir && outDir !== '.') {
        fs.mkdirSync(outDir, { recursive: true });
      }
      const markdown = formatMarkdownLedger(result, doksReceipt, cfReceipt);
      fs.writeFileSync(outputPath, markdown, 'utf8');
    } catch (err: any) {
      console.error(`Error writing output file (${values.output}): ${err.message}`);
      return 2;
    }
  }

  if (values['github-step-summary']) {
    const stepSummaryPath = env.GITHUB_STEP_SUMMARY;
    if (stepSummaryPath) {
      try {
        const markdown = formatMarkdownLedger(result, doksReceipt, cfReceipt);
        fs.appendFileSync(stepSummaryPath, markdown + '\n', 'utf8');
      } catch (err: any) {
        console.error(`Error appending to GITHUB_STEP_SUMMARY (${stepSummaryPath}): ${err.message}`);
        return 2;
      }
    } else {
      console.warn('Warning: --github-step-summary specified but GITHUB_STEP_SUMMARY environment variable is not set');
    }
  }

  if (!result.match && values['fail-on-mismatch']) {
    return 1;
  }

  return 0;
}
