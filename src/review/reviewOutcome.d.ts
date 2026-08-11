export interface ReceiptOutcomeInput {
  arbitration?: Record<string, unknown>;
  unitManifest?: { coverage?: { complete?: boolean } } | null;
  laneReceipts?: unknown[];
  findingVerification?: { summary?: { incomplete?: boolean } } | null;
  headCurrent?: boolean;
  evidenceEnabled?: boolean;
}

export function deriveReceiptOutcome(input?: ReceiptOutcomeInput): Record<string, unknown>;
