import { describe, expect, it } from 'vitest';

const {
  verifyFinding,
  verifyFindings,
} = require('../../src/review/findingVerifier');

const sha = (value: string) => require('node:crypto').createHash('sha256').update(value).digest('hex');
const identity = {
  repository: 'owner/repository',
  prNumber: 42,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  configDigest: 'c'.repeat(64),
  policyDigest: 'd'.repeat(64),
};
const patch = '@@ -4,3 +4,3 @@\n context\n-removed()\n+added()\n context';
const files = [{ path: 'src/app.js', patch }];
const finding = {
  severity: 'P1', path: 'src/app.js', side: 'RIGHT', line: 5,
  title: 'Unchecked input', body: 'The new branch trusts unvalidated input.',
};

function snapshot(extra: Record<string, unknown> = {}) {
  return {
    identity,
    files: [{ path: 'src/app.js', patch, content: 'context\nadded()\ncontext' }],
    ...extra,
  };
}

describe('finding verifier', () => {
  it('accepts an exact changed RIGHT anchor and emits only a redacted stable receipt', () => {
    const result = verifyFinding({ finding, changedFiles: files, exactBlobSnapshot: snapshot(), identity, mode: 'enforce' });

    expect(result).toMatchObject({ schemaVersion: 'finding-verification-v1', status: 'accepted', reasonCode: 'ok' });
    expect(result.findingKey).toMatch(/^fv_[a-f0-9]{64}$/);
    expect(result.claimFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(finding.title);
    expect(JSON.stringify(result)).not.toContain(finding.body);
  });

  it('accepts deleted LEFT lines but rejects invalid paths and ambiguous omitted sides', () => {
    expect(verifyFinding({
      finding: { ...finding, side: 'LEFT', line: 5 }, changedFiles: files, exactBlobSnapshot: snapshot(), identity,
    })).toMatchObject({ status: 'accepted' });
    expect(verifyFinding({
      finding: { ...finding, path: '../secret.js' }, changedFiles: files, exactBlobSnapshot: snapshot(), identity,
    })).toMatchObject({ status: 'rejected', reasonCode: 'invalid_path' });
    expect(verifyFinding({
      finding: { ...finding, line: 5, side: undefined }, changedFiles: [{ path: 'src/app.js', patch: '@@ -5,1 +5,1 @@\n-old\n+new' }],
      exactBlobSnapshot: snapshot({ files: [{ path: 'src/app.js', patch: '@@ -5,1 +5,1 @@\n-old\n+new' }] }), identity,
    })).toMatchObject({ status: 'needs_review', reasonCode: 'ambiguous_side' });
  });

  it('permits file-level eligibility only for binary, gitlink, and patchless files', () => {
    for (const changed of [
      { path: 'assets/logo.png', patch: 'Binary files differ' },
      { path: 'vendor/core', mode: '160000', patch: '@@ -1 +1 @@\n-old\n+new' },
      { path: 'generated/report.json' },
    ]) {
      expect(verifyFinding({ finding: { ...finding, path: changed.path, line: 99 }, changedFiles: [changed], exactBlobSnapshot: { identity, files: [changed] }, identity }))
        .toMatchObject({ status: 'accepted', subjectType: 'file' });
    }
    expect(verifyFinding({
      finding: { ...finding, line: 7 }, changedFiles: [{ path: 'src/app.js', patch: '+not-a-hunk' }],
      exactBlobSnapshot: snapshot({ files: [{ path: 'src/app.js', patch: '+not-a-hunk' }] }), identity,
    })).toMatchObject({ status: 'needs_review', reasonCode: 'unusable_patch' });
  });

  it('checks an optional exact snapshot content hash and exact review identity', () => {
    expect(verifyFinding({
      finding: { ...finding, contentHash: sha('wrong') }, changedFiles: files, exactBlobSnapshot: snapshot(), identity,
    })).toMatchObject({ status: 'rejected', reasonCode: 'content_hash_mismatch' });
    expect(verifyFinding({
      finding, changedFiles: files, exactBlobSnapshot: snapshot({ identity: { ...identity, headSha: 'e'.repeat(40) } }), identity,
    })).toMatchObject({ status: 'needs_review', reasonCode: 'identity_mismatch' });
    expect(verifyFinding({
      finding, changedFiles: files, exactBlobSnapshot: snapshot({ files: [{ path: 'src/app.js', patch: '@@ -1 +1 @@\n-old\n+new' }] }), identity,
    })).toMatchObject({ status: 'needs_review', reasonCode: 'snapshot_mismatch' });
  });

  it('detects deterministic duplicate and anchor-conflict claims without retaining claim prose', () => {
    const seenClaims = new Map();
    const first = verifyFinding({ finding, changedFiles: files, exactBlobSnapshot: snapshot(), identity, seenClaims });
    const duplicate = verifyFinding({ finding, changedFiles: files, exactBlobSnapshot: snapshot(), identity, seenClaims });
    const conflict = verifyFinding({
      finding: { ...finding, title: 'Different defect', body: 'Distinct concern at the same anchor.' },
      changedFiles: files, exactBlobSnapshot: snapshot(), identity, seenClaims,
    });

    expect(first.status).toBe('accepted');
    expect(duplicate).toMatchObject({ status: 'rejected', reasonCode: 'duplicate_claim' });
    expect(conflict).toMatchObject({ status: 'needs_review', reasonCode: 'anchor_conflict' });
    expect(JSON.stringify(conflict)).not.toContain('Different defect');
  });

  it('preserves report-only findings but removes rejected findings and blocks uncertainty in enforce mode', () => {
    const batch = [finding, { ...finding, path: 'missing.js' }];
    const report = verifyFindings({ findings: batch, changedFiles: files, exactBlobSnapshot: snapshot(), identity, mode: 'report_only' });
    const enforce = verifyFindings({ findings: batch, changedFiles: files, exactBlobSnapshot: snapshot(), identity, mode: 'enforce' });

    expect(report.findings).toHaveLength(2);
    expect(report.acceptedFindings).toHaveLength(2);
    expect(report.summary).toMatchObject({ rejected: 1, incomplete: false });
    expect(enforce.findings).toHaveLength(1);
    expect(enforce.acceptedFindings).toHaveLength(1);
    expect(enforce.summary).toMatchObject({ rejected: 1, incomplete: false });

    const uncertain = verifyFindings({
      findings: [{ ...finding, side: undefined, line: 5 }],
      changedFiles: [{ path: 'src/app.js', patch: '@@ -5,1 +5,1 @@\n-old\n+new' }],
      exactBlobSnapshot: snapshot(), identity, mode: 'enforce',
    });
    expect(uncertain.summary).toMatchObject({ needsReview: 1, incomplete: true });
  });
});
