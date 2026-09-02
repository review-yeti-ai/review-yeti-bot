import { describe, expect, it } from 'vitest';
import { FINDING_FINGERPRINT_VERSION } from '../../src/qualification/findingFingerprint';
import { compareQualificationReceipts } from '../../src/qualification/receiptComparison';

const lanes = [
  ['persona', 'security'],
  ['persona', 'performance'],
  ['persona', 'architecture'],
  ['persona', 'testing'],
  ['persona', 'dependencies'],
  ['persona', 'licensing'],
  ['moderator', 'moderator'],
  ['arbiter', 'arbiter'],
].map(([role, lane]) => ({
  role,
  lane,
  providerId: 'openrouter',
  requestedModel: 'deepseek/deepseek-v4-flash-0731',
  resolvedModel: 'deepseek/deepseek-v4-flash-0731',
  callCount: 1,
  retryCount: 0,
}));

const fingerprint = (anchor: string, content: string, severity = 'P1') => ({
  severity,
  anchorDigest: anchor.repeat(64),
  contentDigest: content.repeat(64),
});

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 'ReviewYetiPanelQualification.v1',
    profile: 'same-head',
    status: 'succeeded',
    repo: 'calltelemetry/ct-pr-operator-sandbox',
    prNumber: 5,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    diffDigest: 'c'.repeat(64),
    engineRevision: 'd'.repeat(64),
    policyDigest: 'e'.repeat(64),
    configDigest: 'f'.repeat(64),
    providerTopologyDigest: '1'.repeat(64),
    laneAttribution: lanes,
    verdict: 'FIX_FIRST',
    findingsCount: 1,
    severityCounts: { P0: 0, P1: 1, P2: 0 },
    findingFingerprintVersion: FINDING_FINGERPRINT_VERSION,
    findingFingerprints: [fingerprint('2', '3')],
    ...overrides,
  };
}

describe('qualification receipt comparison', () => {
  it('fails closed without verdicts when either receipt is not a successful same-head receipt', () => {
    const result = compareQualificationReceipts(receipt(), receipt({ status: 'failed' }));

    expect(result).toEqual({
      comparable: false,
      failureClass: 'qualification_receipt_invalid',
      invalidReceipts: ['right'],
    });
    expect(result).not.toHaveProperty('leftVerdict');
    expect(result).not.toHaveProperty('rightVerdict');
  });

  it.each([
    ['engineRevision', { engineRevision: '9'.repeat(64) }],
    ['providerTopologyDigest', { providerTopologyDigest: '8'.repeat(64) }],
    ['laneAttribution', { laneAttribution: lanes.map((lane, index) => index === 0 ? { ...lane, resolvedModel: 'z-ai/glm-5.3-flash' } : lane) }],
  ])('fails closed without verdicts when %s differs', (field, overrides) => {
    const result = compareQualificationReceipts(receipt(), receipt(overrides));

    expect(result).toEqual({
      comparable: false,
      failureClass: 'qualification_identity_mismatch',
      mismatchFields: [field],
    });
    expect(result).not.toHaveProperty('leftVerdict');
    expect(result).not.toHaveProperty('rightVerdict');
  });

  it('returns bounded quality deltas only for identical execution identities', () => {
    const result = compareQualificationReceipts(
      receipt(),
      receipt({
        verdict: 'BLOCK',
        findingsCount: 3,
        severityCounts: { P0: 0, P1: 2, P2: 1 },
        findingFingerprints: [fingerprint('2', '3'), fingerprint('4', '5'), fingerprint('6', '7', 'P2')],
      }),
    );

    expect(result).toEqual({
      comparable: true,
      leftVerdict: 'FIX_FIRST',
      rightVerdict: 'BLOCK',
      findingsDelta: 2,
      severityDelta: { P0: 0, P1: 1, P2: 1 },
      findingOverlap: {
        anchor: { matched: 1, leftOnly: 0, rightOnly: 2 },
        exact: { matched: 1, leftOnly: 0, rightOnly: 2 },
      },
    });
  });

  it('uses multiset overlap to expose duplicates without revealing finding content', () => {
    const result = compareQualificationReceipts(
      receipt({
        findingsCount: 3,
        severityCounts: { P0: 0, P1: 3, P2: 0 },
        findingFingerprints: [fingerprint('2', '3'), fingerprint('2', '3'), fingerprint('4', '5')],
      }),
      receipt({
        findingsCount: 3,
        severityCounts: { P0: 0, P1: 3, P2: 0 },
        findingFingerprints: [fingerprint('2', '3'), fingerprint('2', '6'), fingerprint('7', '8')],
      }),
    );

    expect(result).toMatchObject({
      comparable: true,
      findingOverlap: {
        anchor: { matched: 2, leftOnly: 1, rightOnly: 1 },
        exact: { matched: 1, leftOnly: 2, rightOnly: 2 },
      },
    });
    expect(JSON.stringify(result)).not.toContain('title');
    expect(JSON.stringify(result)).not.toContain('body');
    expect(JSON.stringify(result)).not.toContain('path');
  });

  it('matches the same anchor while exposing severity or content drift', () => {
    const result = compareQualificationReceipts(
      receipt(),
      receipt({
        verdict: 'SHIP',
        severityCounts: { P0: 0, P1: 0, P2: 1 },
        findingFingerprints: [fingerprint('2', '4', 'P2')],
      }),
    );

    expect(result).toMatchObject({
      comparable: true,
      findingOverlap: {
        anchor: { matched: 1, leftOnly: 0, rightOnly: 0 },
        exact: { matched: 0, leftOnly: 1, rightOnly: 1 },
      },
    });
  });

  it.each([
    { findingFingerprintVersion: 'ReviewYetiFindingFingerprint.v2' },
    { findingFingerprints: undefined },
    { findingFingerprints: [fingerprint('x', '3')] },
    { findingFingerprints: [fingerprint('2', '3')], findingsCount: 2 },
    { findingFingerprints: [{ ...fingerprint('2', '3'), severity: 'P3' }] },
  ])('fails closed on malformed finding fingerprint telemetry: %o', (overrides) => {
    expect(compareQualificationReceipts(receipt(), receipt(overrides))).toEqual({
      comparable: false,
      failureClass: 'qualification_receipt_invalid',
      invalidReceipts: ['right'],
    });
  });

  it('accepts an explicit tilde-pinned model identity without treating it as auto-routing', () => {
    const explicitAliasLanes = lanes.map((lane) => ({
      ...lane,
      requestedModel: '~deepseek/deepseek-v4-flash-latest',
      resolvedModel: 'deepseek/deepseek-v4-flash-0731',
    }));

    expect(compareQualificationReceipts(
      receipt({ laneAttribution: explicitAliasLanes }),
      receipt({ laneAttribution: explicitAliasLanes }),
    )).toMatchObject({ comparable: true });
  });
});
