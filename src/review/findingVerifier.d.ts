export type FindingVerificationMode = 'report_only' | 'enforce';
export type FindingVerificationStatus = 'accepted' | 'rejected' | 'needs_review';

export interface FindingVerifierIdentity {
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  configDigest: string;
  policyDigest: string;
}

export interface FindingVerificationReceipt {
  schemaVersion: 'finding-verification-v1';
  verifierVersion: 'finding-verification-v1';
  status: FindingVerificationStatus;
  reasonCode: string;
  identityDigest?: string;
  path?: string;
  side?: 'RIGHT' | 'LEFT';
  line?: number;
  subjectType?: 'line' | 'file';
  claimFingerprint?: string;
  findingKey?: string;
}

export interface ExactBlobSnapshot {
  identity: FindingVerifierIdentity;
  files: Array<{ path: string; content?: string; contentHash?: string; content_hash?: string; sha256?: string; hash?: string; patch?: string }>;
}

export interface VerifyFindingInput {
  finding: Record<string, unknown>;
  changedFiles: Array<Record<string, unknown>>;
  exactBlobSnapshot: ExactBlobSnapshot;
  identity: FindingVerifierIdentity;
  mode?: FindingVerificationMode;
  seenClaims?: Map<string, string> | Set<string>;
}

export function verifyFinding(input: VerifyFindingInput): FindingVerificationReceipt;
export function verifyFindings(input: Omit<VerifyFindingInput, 'finding'> & { findings: Array<Record<string, unknown>> }): {
  schemaVersion: 'finding-verification-v1';
  verifierVersion: 'finding-verification-v1';
  mode: FindingVerificationMode;
  findings: Array<Record<string, unknown>>;
  acceptedFindings: Array<Record<string, unknown>>;
  verifications: ReadonlyArray<FindingVerificationReceipt>;
  summary: { accepted: number; rejected: number; needsReview: number; incomplete: boolean };
};
