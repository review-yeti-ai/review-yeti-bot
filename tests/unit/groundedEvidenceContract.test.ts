import { describe, expect, it } from 'vitest';
import {
  GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
  GROUNDED_REVIEW_RECEIPT_V2_VERSION,
  GROUNDED_SOURCE_WINDOW_MANIFEST_VERSION,
  GROUNDED_SOURCE_WINDOW_VERSION,
  GROUNDED_VERIFICATION_V2_VERSION,
} from '../../src/review/groundedEvidenceContract';
import {
  GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION as serverSemanticsVersion,
  GROUNDED_REVIEW_RECEIPT_V2_VERSION as serverReceiptVersion,
  GROUNDED_SOURCE_WINDOW_MANIFEST_VERSION as serverManifestVersion,
  GROUNDED_SOURCE_WINDOW_VERSION as serverWindowVersion,
  GROUNDED_VERIFICATION_V2_VERSION as serverVerificationVersion,
} from '../../src/review/groundedEvidenceV2';
import { GROUNDED_CANDIDATE_MANIFEST_CAPABILITY,
  groundedVerificationCapabilityForRuntime } from '../../src/review/groundedCandidateManifestCapability';

describe('grounded evidence static contract versions', () => {
  it('uses one browser-safe version contract across runtime hashing and candidate capability', () => {
    expect([
      serverWindowVersion,
      serverManifestVersion,
      serverVerificationVersion,
      serverReceiptVersion,
      serverSemanticsVersion,
    ]).toEqual([
      GROUNDED_SOURCE_WINDOW_VERSION,
      GROUNDED_SOURCE_WINDOW_MANIFEST_VERSION,
      GROUNDED_VERIFICATION_V2_VERSION,
      GROUNDED_REVIEW_RECEIPT_V2_VERSION,
      GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
    ]);
    expect(groundedVerificationCapabilityForRuntime(GROUNDED_VERIFICATION_V2_VERSION)).toEqual({
      version: GROUNDED_VERIFICATION_V2_VERSION,
      candidate_manifest: GROUNDED_CANDIDATE_MANIFEST_CAPABILITY,
    });
  });
});
