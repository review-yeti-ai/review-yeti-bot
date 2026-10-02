import { createHash } from 'node:crypto';

export interface ReviewFindingEntry {
  finding: any;
  personaId: string;
}

export interface ReviewFindingIdentityParts {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  title: string;
}

export interface ReviewFindingRecord extends ReviewFindingEntry {
  runId: string;
}

export interface ReviewFindingExtractionOptions {
  /** Preserve the broader source lookup used by tools that historically scanned both shapes. */
  includeAlternateSources?: boolean;
  /** Explain-finding historically also searched payload.result.findings. */
  includeLegacyResultFindings?: boolean;
}

export interface ReviewFindingAttemptRow {
  run_id?: unknown;
  execution_attempt?: unknown;
}

/** Keep the newest completion attempt per logical run, preserving query order. */
export function newestReviewRowsPerRun<T extends ReviewFindingAttemptRow>(rows: T[]): T[] {
  const newestByRun = new Map<string, { row: T; index: number; attempt: number }>();
  const unversionedRows: Array<{ row: T; index: number }> = [];

  rows.forEach((row, index) => {
    const hasRunId = row.run_id !== undefined && row.run_id !== null && row.run_id !== '';
    const hasAttempt = row.execution_attempt !== undefined && row.execution_attempt !== null && row.execution_attempt !== '';
    const numericAttempt = Number(row.execution_attempt);
    const attempt = Number.isSafeInteger(numericAttempt) && numericAttempt >= 0
      ? numericAttempt
      : Number.NEGATIVE_INFINITY;

    // Artifact fallbacks and older query shapes may not carry attempt metadata.
    // Keep those rows independently so deduplication cannot hide another artifact.
    if (!hasRunId || !hasAttempt || attempt === Number.NEGATIVE_INFINITY) {
      unversionedRows.push({ row, index });
      return;
    }

    const runId = String(row.run_id);
    const existing = newestByRun.get(runId);

    if (!existing || attempt > existing.attempt) {
      newestByRun.set(runId, { row, index, attempt });
    }
  });

  return [...newestByRun.values()]
    .concat(unversionedRows.map(({ row, index }) => ({ row, index, attempt: Number.NEGATIVE_INFINITY })))
    .sort((left, right) => left.index - right.index)
    .map(({ row }) => row);
}

/**
 * Extract findings using the same payload precedence and persona attribution
 * for both the public finding list and tools that address those findings.
 */
export function extractReviewFindingEntries(
  payload: any,
  options: ReviewFindingExtractionOptions = {}
): ReviewFindingEntry[] {
  const topLevelFindings = Array.isArray(payload?.findings) ? payload.findings : null;
  const resultFindings = options.includeLegacyResultFindings && Array.isArray(payload?.result?.findings)
    ? payload.result.findings
    : null;

  const flatEntries = (findings: any[] | null) =>
    (findings || []).map((finding: any) => ({
      finding,
      personaId: String(finding?.personaId || finding?.persona || 'reviewer'),
    }));

  if (!options.includeAlternateSources && !options.includeLegacyResultFindings && topLevelFindings) {
    return flatEntries(topLevelFindings);
  }

  const personas = Array.isArray(payload?.result?.personas)
    ? payload.result.personas
    : Array.isArray(payload?.personas)
      ? payload.personas
      : [];
  const personaEntries = personas.flatMap((persona: any) => {
    const personaId = String(persona?.id || 'reviewer');
    const findings = Array.isArray(persona?.findings) ? persona.findings : [];
    return findings.map((finding: any) => ({ finding, personaId }));
  });

  if (options.includeAlternateSources || options.includeLegacyResultFindings) {
    return [...flatEntries(topLevelFindings), ...flatEntries(resultFindings), ...personaEntries];
  }

  return personaEntries;
}

export function getReviewFindingIdentityParts(finding: any): ReviewFindingIdentityParts {
  const filePath = String(finding?.path || finding?.file_path || finding?.file || '');
  const lineEnd = Number(finding?.line_end || finding?.line || 1);
  const lineStart = Number(finding?.line_start || finding?.startLine || lineEnd);
  const title = String(finding?.title || '');

  return { filePath, lineStart, lineEnd, title };
}

/** Return the persisted ID, or synthesize the stable ID exposed by get_review_findings. */
export function getReviewFindingId(runId: string, personaId: string, finding: any): string {
  const explicitId = finding?.finding_id || finding?.id;
  if (explicitId) {
    return String(explicitId);
  }

  const { filePath, lineStart, lineEnd, title } = getReviewFindingIdentityParts(finding);
  return createHash('sha256')
    .update(`${runId}:${personaId}:${filePath}:${lineStart}:${lineEnd}:${title}`)
    .digest('hex')
    .slice(0, 16);
}

/** The shorter ID emitted by findingsResource before the shared identity format. */
export function getLegacyResourceFindingId(runId: string, finding: any): string {
  const { filePath, lineStart, title } = getReviewFindingIdentityParts(finding);
  return createHash('sha256')
    .update(`${runId}:${filePath}:${lineStart}:${title}`)
    .digest('hex')
    .slice(0, 16);
}

/** Resolve canonical IDs first, then accept a legacy ID only if it names one candidate. */
export function findReviewFindingRecord<T extends ReviewFindingRecord>(
  records: T[],
  requestedId: string
): T | null {
  const canonicalMatches = records.filter(
    ({ finding, personaId, runId }) => getReviewFindingId(runId, personaId, finding) === requestedId
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return null;

  const legacyMatches = records.filter(({ finding, runId }) => {
    const legacyIds = [finding?.finding_id, finding?.id]
      .filter(Boolean)
      .map((id) => String(id));
    legacyIds.push(getLegacyResourceFindingId(runId, finding));
    return legacyIds.includes(requestedId);
  });

  return legacyMatches.length === 1 ? legacyMatches[0] : null;
}
