import { EvidenceBackedFinding } from './evidence';

export interface QualityMetricsInput {
  findings: EvidenceBackedFinding[];
  expectedFindingKeys: string[];
  snapshotSha: string;
  firstCommentLatencyMs?: number;
  endToEndLatencyMs?: number;
  tokens?: number;
  costUSD?: number;
  providerFailures?: number;
}

export interface QualityMetrics {
  precision: number;
  recall: number;
  duplicateRate: number;
  staleContextRate: number;
  timeToFirstCommentMs?: number;
  endToEndLatencyMs?: number;
  tokens?: number;
  costUSD?: number;
  providerFailures: number;
}

function findingKey(finding: EvidenceBackedFinding): string {
  return `${finding.path}:${finding.line}:${finding.title}`;
}

export function measureQuality(input: QualityMetricsInput): QualityMetrics {
  const observed = input.findings.map(findingKey);
  const unique = new Set(observed);
  const expected = new Set(input.expectedFindingKeys);
  const truePositives = [...unique].filter((key) => expected.has(key)).length;
  const stale = input.findings.filter((finding) => finding.commitSha !== undefined && finding.commitSha !== input.snapshotSha).length;
  return {
    precision: unique.size ? truePositives / unique.size : expected.size === 0 ? 1 : 0,
    recall: expected.size ? truePositives / expected.size : 1,
    duplicateRate: observed.length ? (observed.length - unique.size) / observed.length : 0,
    staleContextRate: input.findings.length ? stale / input.findings.length : 0,
    timeToFirstCommentMs: input.firstCommentLatencyMs,
    endToEndLatencyMs: input.endToEndLatencyMs,
    tokens: input.tokens,
    costUSD: input.costUSD,
    providerFailures: input.providerFailures || 0,
  };
}
