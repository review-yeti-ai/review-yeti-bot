type QualificationVerdict = 'SHIP' | 'FIX_FIRST' | 'BLOCK';

interface QualificationLaneAttribution {
  role: 'persona' | 'moderator' | 'arbiter';
  lane: string;
  providerId: string;
  requestedModel: string;
  resolvedModel: string;
  callCount: number;
  retryCount: number;
}

interface ComparableQualificationReceipt {
  version: 'ReviewYetiPanelQualification.v1';
  profile: 'same-head';
  status: 'succeeded';
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  diffDigest: string;
  engineRevision: string;
  policyDigest: string;
  configDigest: string;
  providerTopologyDigest: string;
  laneAttribution: QualificationLaneAttribution[];
  verdict: QualificationVerdict;
  findingsCount: number;
  severityCounts: { P0: number; P1: number; P2: number };
}

export type QualificationReceiptComparison =
  | {
      comparable: false;
      failureClass: 'qualification_receipt_invalid';
      invalidReceipts: Array<'left' | 'right'>;
    }
  | {
      comparable: false;
      failureClass: 'qualification_identity_mismatch';
      mismatchFields: string[];
    }
  | {
      comparable: true;
      leftVerdict: QualificationVerdict;
      rightVerdict: QualificationVerdict;
      findingsDelta: number;
      severityDelta: { P0: number; P1: number; P2: number };
    };

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/u;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._~:/-]{0,255}$/u;

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isLane(value: unknown): value is QualificationLaneAttribution {
  if (!value || typeof value !== 'object') return false;
  const lane = value as Record<string, unknown>;
  return ['persona', 'moderator', 'arbiter'].includes(String(lane.role))
    && BOUNDED_ID.test(String(lane.lane || ''))
    && BOUNDED_ID.test(String(lane.providerId || ''))
    && MODEL_ID.test(String(lane.requestedModel || ''))
    && MODEL_ID.test(String(lane.resolvedModel || ''))
    && isCount(lane.callCount)
    && Number(lane.callCount) >= 1
    && isCount(lane.retryCount)
    && Number(lane.retryCount) <= Number(lane.callCount) - 1;
}

function asComparableReceipt(value: unknown): ComparableQualificationReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const receipt = value as Record<string, any>;
  if (receipt.version !== 'ReviewYetiPanelQualification.v1'
      || receipt.profile !== 'same-head'
      || receipt.status !== 'succeeded'
      || !REPO.test(String(receipt.repo || ''))
      || !Number.isSafeInteger(receipt.prNumber) || receipt.prNumber < 1
      || !SHA.test(String(receipt.baseSha || ''))
      || !SHA.test(String(receipt.headSha || ''))
      || !DIGEST.test(String(receipt.diffDigest || ''))
      || !DIGEST.test(String(receipt.engineRevision || ''))
      || !DIGEST.test(String(receipt.policyDigest || ''))
      || !DIGEST.test(String(receipt.configDigest || ''))
      || !DIGEST.test(String(receipt.providerTopologyDigest || ''))
      || !Array.isArray(receipt.laneAttribution)
      || receipt.laneAttribution.length !== 8
      || !receipt.laneAttribution.every(isLane)
      || !['SHIP', 'FIX_FIRST', 'BLOCK'].includes(receipt.verdict)
      || !isCount(receipt.findingsCount)
      || !receipt.severityCounts || typeof receipt.severityCounts !== 'object'
      || !isCount(receipt.severityCounts.P0)
      || !isCount(receipt.severityCounts.P1)
      || !isCount(receipt.severityCounts.P2)) {
    return null;
  }
  return receipt as unknown as ComparableQualificationReceipt;
}

function laneIdentity(receipt: ComparableQualificationReceipt): string {
  return JSON.stringify(receipt.laneAttribution.map((lane) => ({
    role: lane.role,
    lane: lane.lane,
    providerId: lane.providerId,
    requestedModel: lane.requestedModel,
    resolvedModel: lane.resolvedModel,
  })));
}

/**
 * Compare quality only after both receipts prove the same source, engine,
 * policy, configured topology, and resolved lane topology. A failed identity
 * check deliberately returns no verdict fields, preventing accidental quality
 * claims across unlike review engines or providers.
 */
export function compareQualificationReceipts(
  leftValue: unknown,
  rightValue: unknown,
): QualificationReceiptComparison {
  const left = asComparableReceipt(leftValue);
  const right = asComparableReceipt(rightValue);
  if (!left || !right) {
    return {
      comparable: false,
      failureClass: 'qualification_receipt_invalid',
      invalidReceipts: [
        ...(!left ? ['left' as const] : []),
        ...(!right ? ['right' as const] : []),
      ],
    };
  }

  const exactIdentity: Array<keyof ComparableQualificationReceipt> = [
    'repo', 'prNumber', 'baseSha', 'headSha', 'diffDigest', 'engineRevision',
    'policyDigest', 'configDigest', 'providerTopologyDigest',
  ];
  const mismatchFields = exactIdentity
    .filter((field) => left[field] !== right[field])
    .map(String);
  if (laneIdentity(left) !== laneIdentity(right)) mismatchFields.push('laneAttribution');
  if (mismatchFields.length > 0) {
    return {
      comparable: false,
      failureClass: 'qualification_identity_mismatch',
      mismatchFields,
    };
  }

  return {
    comparable: true,
    leftVerdict: left.verdict,
    rightVerdict: right.verdict,
    findingsDelta: right.findingsCount - left.findingsCount,
    severityDelta: {
      P0: right.severityCounts.P0 - left.severityCounts.P0,
      P1: right.severityCounts.P1 - left.severityCounts.P1,
      P2: right.severityCounts.P2 - left.severityCounts.P2,
    },
  };
}
