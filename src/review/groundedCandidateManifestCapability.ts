import { GROUNDED_VERIFICATION_V2_VERSION } from './groundedEvidenceContract';

export const GROUNDED_CANDIDATE_MANIFEST_CAPABILITY = 'GroundedCandidateSeverityManifest.v1' as const;

export interface GroundedVerificationCapabilityReceipt {
  version: typeof GROUNDED_VERIFICATION_V2_VERSION;
  candidate_manifest: typeof GROUNDED_CANDIDATE_MANIFEST_CAPABILITY;
}

export type GroundedVerificationRuntimeVersion = typeof GROUNDED_VERIFICATION_V2_VERSION
  | 'GroundedIndependentVerification.v1';

/** Projects support only when the runtime's trusted producer is the grounded V2 verifier. */
export function groundedVerificationCapabilityForRuntime(
  version: GroundedVerificationRuntimeVersion,
): GroundedVerificationCapabilityReceipt | undefined {
  if (version !== GROUNDED_VERIFICATION_V2_VERSION) return undefined;
  return { version: GROUNDED_VERIFICATION_V2_VERSION, candidate_manifest: GROUNDED_CANDIDATE_MANIFEST_CAPABILITY };
}
