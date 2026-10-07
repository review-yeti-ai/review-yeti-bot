import { describe, expect, it } from 'vitest';
import { groundedFixtureHeadSnapshot, groundedFixtureProvider, groundedFixtureReceipt,
  type GroundedFixtureSourceSnapshot } from '../support/groundedReviewFixture';
import { GROUNDED_VERIFICATION_VERSION } from '../../src/review/groundedReviewEngine';
import { groundedCandidateHunkProof, groundedSourceTextLineRangeDigest }
  from '../../src/review/groundedSourceWindows';
import { groundedCitationManifestDigest, sha256Bytes } from '../../src/review/groundedEvidenceV2';
import { REVIEW_SEVERITY_POLICY_V2 } from '../../src/review/reviewDecision';

const owner = 'fixture-owner';
const repo = 'fixture-repo';
const repository = `${owner}/${repo}`;
const path = 'src/policy.ts';
const baseSha = '1'.repeat(40);
const middleSha = '2'.repeat(40);
const headSha = '3'.repeat(40);
const baseContent = "export const timeoutMs = 1_000;\nexport const cacheEnabled = false;\n";
const middleContent = "export const timeoutMs = 2_000;\nexport const cacheEnabled = false;\n";
const headContent = "export const timeoutMs = 2_000;\nexport const cacheEnabled = true;\n";
const firstPatch = [
  'diff --git a/src/policy.ts b/src/policy.ts',
  'index 1111111..2222222 100644',
  '--- a/src/policy.ts',
  '+++ b/src/policy.ts',
  '@@ -1,2 +1,2 @@',
  '-export const timeoutMs = 1_000;',
  '+export const timeoutMs = 2_000;',
  ' export const cacheEnabled = false;',
].join('\n');
const secondPatch = [
  'diff --git a/src/policy.ts b/src/policy.ts',
  'index 2222222..3333333 100644',
  '--- a/src/policy.ts',
  '+++ b/src/policy.ts',
  '@@ -1,2 +1,2 @@',
  ' export const timeoutMs = 2_000;',
  '-export const cacheEnabled = false;',
  '+export const cacheEnabled = true;',
].join('\n');

function snapshot(revisionSha: string, content: string): GroundedFixtureSourceSnapshot {
  return { path, revisionSha, content };
}

function finding(line: number) {
  return { severity: 'P1', path, line, title: 'Changed policy behavior requires review' };
}

describe('grounded review fixture source snapshots', () => {
  it('binds sequential V2 source windows and carries the exact admitted head into the next base', async () => {
    const initial = snapshot(baseSha, baseContent);
    const firstHead = snapshot(middleSha, middleContent);
    const first = await groundedFixtureReceipt({ owner, repo, headSha: middleSha, baseSha,
      changedFiles: [{ path, patch: firstPatch }], findings: [finding(1)], sourceSnapshots: [initial, firstHead],
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2 });
    const firstOutcome = first.verification.outcomes[0] as any;
    expect(firstOutcome).toMatchObject({ status: 'confirmed', candidateSide: 'head' });
    const firstEvidence = firstOutcome.evidence;
    const firstHeadCitation = firstEvidence.citations.find((citation: any) => citation.side === 'head');
    expect(firstEvidence.sourceWindowManifestDigest).toBe(groundedCitationManifestDigest(firstEvidence.citations));
    expect(firstHeadCitation.window.fullContentSha256).toBe(sha256Bytes(Buffer.from(middleContent, 'utf8')));
    expect(firstHeadCitation.window.regionDigest).toBe(groundedCandidateHunkProof({ patch: firstPatch,
      candidateLine: 1, candidateSide: 'head' })?.regionDigest);
    expect(firstHeadCitation.window.mapping).toEqual(groundedCandidateHunkProof({ patch: firstPatch,
      candidateLine: 1, candidateSide: 'head' })?.mapping);
    expect(firstEvidence.causeAnchor.contentDigest).toBe(groundedSourceTextLineRangeDigest(middleContent, 1, 1));

    const admittedHead = groundedFixtureHeadSnapshot({ path, headSha: middleSha, sourceSnapshots: [initial, firstHead] });
    expect(admittedHead).toEqual(firstHead);
    expect(admittedHead).not.toBe(firstHead);
    expect(Object.isFrozen(admittedHead)).toBe(true);

    const secondHead = snapshot(headSha, headContent);
    const second = await groundedFixtureReceipt({ owner, repo, headSha, baseSha: admittedHead!.revisionSha,
      changedFiles: [{ path, patch: secondPatch }], findings: [finding(2)],
      sourceSnapshots: [admittedHead!, secondHead], severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2 });
    const secondOutcome = second.verification.outcomes[0] as any;
    expect(secondOutcome).toMatchObject({ status: 'confirmed', candidateSide: 'head' });
    const secondEvidence = secondOutcome.evidence;
    const secondBaseCitation = secondEvidence.citations.find((citation: any) => citation.side === 'base');
    const secondHeadCitation = secondEvidence.citations.find((citation: any) => citation.side === 'head');
    expect(secondEvidence.sourceWindowManifestDigest).toBe(groundedCitationManifestDigest(secondEvidence.citations));
    expect(secondBaseCitation.window.revisionSha).toBe(middleSha);
    expect(secondBaseCitation.window.fullContentSha256).toBe(sha256Bytes(Buffer.from(middleContent, 'utf8')));
    expect(secondBaseCitation.window.startLine).toBeLessThanOrEqual(firstEvidence.causeAnchor.startLine);
    expect(secondBaseCitation.window.endLine).toBeGreaterThanOrEqual(firstEvidence.causeAnchor.endLine);
    expect(groundedSourceTextLineRangeDigest(middleContent, firstEvidence.causeAnchor.startLine,
      firstEvidence.causeAnchor.endLine)).toBe(firstEvidence.causeAnchor.contentDigest);
    expect(secondHeadCitation.window.fullContentSha256).toBe(sha256Bytes(Buffer.from(headContent, 'utf8')));
    expect(secondHeadCitation.window.regionDigest).toBe(groundedCandidateHunkProof({ patch: secondPatch,
      candidateLine: 2, candidateSide: 'head' })?.regionDigest);
    expect(secondHeadCitation.window.mapping).toEqual(groundedCandidateHunkProof({ patch: secondPatch,
      candidateLine: 2, candidateSide: 'head' })?.mapping);
  });

  it('reports source and patch disagreement through the V2 verifier instead of rewriting either side', async () => {
    const inconsistentHead = snapshot(headSha, middleContent);
    const provider = groundedFixtureProvider({ owner, repo, headSha, baseSha: middleSha,
      changedFiles: [{ path, patch: secondPatch }], candidateFindings: [finding(2)],
      sourceSnapshots: [snapshot(middleSha, middleContent), inconsistentHead] });
    const source = await provider.readFileAt!(path, 'head');
    expect(source).toMatchObject({ content: middleContent, sha: headSha,
      contentSha256: sha256Bytes(Buffer.from(middleContent, 'utf8')) });

    const result = await groundedFixtureReceipt({ owner, repo, headSha, baseSha: middleSha,
      changedFiles: [{ path, patch: secondPatch }], findings: [finding(2)],
      sourceSnapshots: [snapshot(middleSha, middleContent), inconsistentHead],
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2 });
    expect(result.verification.version).toBe(GROUNDED_VERIFICATION_VERSION);
    expect(result.verification.outcomes[0]).toMatchObject({ status: 'insufficient' });
    expect(result.verification.calls).toBe(0);
  });

  it('preserves legacy synthetic source bytes when no snapshots are supplied', async () => {
    const legacyPatch = '@@ -1,1 +1,1 @@\n-old line\n+new line';
    const provider = groundedFixtureProvider({ owner, repo, headSha, baseSha,
      changedFiles: [{ path, patch: legacyPatch }] });
    const base = await provider.readFileAt!(path, 'base');
    const head = await provider.readFileAt!(path, 'head');
    expect(base.content?.split('\n').slice(0, 2)).toEqual(['old line', 'const fixtureBase2 = 2;']);
    expect(head.content?.split('\n').slice(0, 2)).toEqual(['new line', 'const fixtureHead2 = 2;']);
  });

  it('fails closed for duplicate bindings and missing exact revision snapshots', async () => {
    expect(() => groundedFixtureProvider({ owner, repo, headSha: middleSha, baseSha,
      changedFiles: [{ path, patch: firstPatch }], sourceSnapshots: [snapshot(middleSha, middleContent),
        snapshot(middleSha, headContent)] })).toThrow(/duplicate source snapshot binding/u);

    const provider = groundedFixtureProvider({ owner, repo, headSha: middleSha, baseSha,
      changedFiles: [{ path, patch: firstPatch }], sourceSnapshots: [snapshot(middleSha, middleContent)] });
    await expect(provider.readFileAt!(path, 'base')).resolves.toMatchObject({ content: null, sha: baseSha,
      presence: 'unavailable', source: { repository, path, side: 'base' } });
    expect(groundedFixtureHeadSnapshot({ path, headSha: baseSha, sourceSnapshots: [snapshot(middleSha, middleContent)] }))
      .toBeUndefined();
  });
});
