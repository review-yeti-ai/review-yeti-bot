export const FINDING_FINGERPRINT_VERSION = 'ReviewYetiFindingFingerprint.v1' as const;
export const MAX_FINDING_FINGERPRINTS = 256;

export interface QualificationFindingFingerprint {
  severity: 'P0' | 'P1' | 'P2';
  anchorDigest: string;
  contentDigest: string;
}

export function findingFingerprintSortKey(fingerprint: QualificationFindingFingerprint): string {
  return `${fingerprint.severity}:${fingerprint.anchorDigest}:${fingerprint.contentDigest}`;
}

export function compareFindingFingerprints(
  left: QualificationFindingFingerprint,
  right: QualificationFindingFingerprint,
): number {
  const leftKey = findingFingerprintSortKey(left);
  const rightKey = findingFingerprintSortKey(right);
  return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
}
