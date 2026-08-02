import { sha256 } from './reviewCore';

export type EvidenceGateStatus = 'PASS' | 'FAIL' | 'INCOMPLETE';

export interface EvidenceReceipt {
  tool: string;
  version: string;
  operation: string;
  snapshotSha: string;
  exitStatus: number | 'timeout' | 'error';
  durationMs: number;
  outputDigest: string;
  interpretation: string;
  output?: string;
}

export interface EvidenceBackedFinding {
  severity: 'P0' | 'P1' | 'P2';
  path: string;
  line: number;
  title: string;
  confidence?: number;
  evidenceRefs?: string[];
  validationStatus?: 'validated' | 'unvalidated' | 'rejected';
  commitSha?: string;
}

export interface EvidenceGateInput {
  receipts: EvidenceReceipt[];
  findings: EvidenceBackedFinding[];
  requiredLaneIds?: string[];
  completedLaneIds?: string[];
  snapshotSha: string;
}

export interface EvidenceGateResult {
  status: EvidenceGateStatus;
  reasons: string[];
}

export function receiptId(receipt: EvidenceReceipt): string {
  return sha256({ version: 'evidence-receipt-v1', tool: receipt.tool, operation: receipt.operation, snapshotSha: receipt.snapshotSha, outputDigest: receipt.outputDigest });
}

export function createEvidenceReceipt(input: Omit<EvidenceReceipt, 'outputDigest'> & { output?: string }): EvidenceReceipt {
  return { ...input, outputDigest: sha256(input.output || '') };
}

export class EvidenceGate {
  evaluate(input: EvidenceGateInput): EvidenceGateResult {
    const reasons: string[] = [];
    const required = new Set(input.requiredLaneIds || []);
    const completed = new Set(input.completedLaneIds || []);
    if ([...required].some((lane) => !completed.has(lane))) reasons.push('required review lane is incomplete');
    if (input.receipts.length === 0) reasons.push('no deterministic evidence receipt was produced');
    if (input.receipts.some((receipt) => receipt.snapshotSha !== input.snapshotSha)) reasons.push('evidence receipt is bound to a different snapshot');
    if (input.receipts.some((receipt) => receipt.exitStatus !== 0)) reasons.push('deterministic evidence command failed');
    const knownReceiptIds = new Set(input.receipts.map(receiptId));

    for (const finding of input.findings) {
      if (finding.severity === 'P0' || finding.severity === 'P1') {
        if (!finding.evidenceRefs?.length) reasons.push(`${finding.path}:${finding.line} has no evidence reference`);
        else if (finding.evidenceRefs.some((reference) => !knownReceiptIds.has(reference))) reasons.push(`${finding.path}:${finding.line} cites an unknown evidence receipt`);
        if (!finding.commitSha || finding.commitSha !== input.snapshotSha) reasons.push(`${finding.path}:${finding.line} is not bound to the review snapshot`);
        if (finding.validationStatus !== 'validated') reasons.push(`${finding.path}:${finding.line} is not validated`);
      }
    }
    const hasFailure = input.receipts.some((receipt) => receipt.exitStatus !== 0);
    return { status: hasFailure ? 'FAIL' : reasons.length ? 'INCOMPLETE' : 'PASS', reasons };
  }
}
