import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(__dirname, '../..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));
const identity = {
  repo: 'owner/repository', prNumber: 42,
  baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
};

describe('finding verifier pipeline policy and publication fence', () => {
  it('hashes GitHub API blobs at exact refs instead of the mutable local patch', async () => {
    const bytes = Buffer.from('immutable head bytes\n', 'utf8');
    const calls: string[] = [];
    const commandRunner = (_command: string, args: string[]) => {
      calls.push(args.join(' '));
      return { status: 0, stdout: JSON.stringify({ encoding: 'base64', content: bytes.toString('base64') }) };
    };
    const files = [{ path: 'src/app.js', patch: '@@ -1 +1 @@\n-old\n+local mutation' }];
    const findings = [{ path: 'src/app.js', side: 'RIGHT', line: 1 }];
    const verifierIdentity = { repository: identity.repo, prNumber: 42, baseSha: identity.baseSha, headSha: identity.headSha, configDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64) };

    const first = await pipeline.fetchExactFindingBlobSnapshot(verifierIdentity, files, findings, { commandRunner });
    files[0].patch = '@@ -1 +1 @@\n-old\n+different local mutation';
    const second = await pipeline.fetchExactFindingBlobSnapshot(verifierIdentity, files, findings, { commandRunner });

    expect(first.files[0].contentHash).toBe(require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
    expect(second.files[0].contentHash).toBe(first.files[0].contentHash);
    expect(calls.every((call) => call.includes(`ref=${identity.headSha}`))).toBe(true);
    expect(calls.every((call) => call.includes('repos/owner/repository/contents/src/app.js'))).toBe(true);
  });

  it('uses the base SHA and previous path for a deleted or renamed LEFT finding', async () => {
    const calls: string[] = [];
    const verifierIdentity = { repository: identity.repo, prNumber: 42, baseSha: identity.baseSha, headSha: identity.headSha, configDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64) };
    await pipeline.fetchExactFindingBlobSnapshot(verifierIdentity, [{
      path: 'src/new-name.js', previousPath: 'src/old-name.js', status: 'renamed', patch: '@@ -1 +1 @@\n-old\n+new',
    }], [{ path: 'src/new-name.js', side: 'LEFT', line: 1 }], {
      commandRunner: (_command: string, args: string[]) => {
        calls.push(args.join(' '));
        return { status: 0, stdout: JSON.stringify({ encoding: 'base64', content: Buffer.from('old\n').toString('base64') }) };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('contents/src/old-name.js');
    expect(calls[0]).toContain(`ref=${identity.baseSha}`);
  });

  it('retains a raw model candidate through pass aggregation and produces a bounded enforce receipt before sanitization', async () => {
    const aggregated = pipeline.aggregatePersonaRuns({ id: 'security', name: 'Security' }, [{
      personaId: 'security', decision: 'APPROVE', findings: [],
      rawFindings: [{ severity: 'P1', path: 'missing.js', line: 1, title: 'Raw only', body: 'This must be verified before sanitization.' }],
    }], 'test-model');
    const verifierIdentity = { repo: identity.repo, prNumber: 42, baseSha: identity.baseSha, headSha: identity.headSha };
    const result = await pipeline.applyFindingVerifier([aggregated], [{ path: 'src/app.js', patch: '@@ -1 +1 @@\n-old\n+new' }], {
      enabled: true, mode: 'enforce', configDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64),
    }, verifierIdentity, {
      commandRunner: () => ({ status: 0, stdout: JSON.stringify({ encoding: 'base64', content: Buffer.from('new\n').toString('base64') }) }),
    });

    expect(aggregated.rawFindings).toHaveLength(1);
    expect(result.personaResults[0].findings).toEqual([]);
    expect(result.verification.summary).toMatchObject({ rejected: 1 });
    expect(JSON.stringify(result.verification)).not.toContain('Raw only');
  });

  it('turns an unavailable exact blob into enforce uncertainty rather than a SHIP-capable result', async () => {
    const verifierIdentity = { repo: identity.repo, prNumber: 42, baseSha: identity.baseSha, headSha: identity.headSha };
    const result = await pipeline.applyFindingVerifier([{
      personaId: 'security', decision: 'FINDINGS', findings: [],
      rawFindings: [{ severity: 'P1', path: 'src/app.js', side: 'RIGHT', line: 1, title: 'Needs blob', body: 'GitHub must provide the immutable bytes.' }],
    }], [{ path: 'src/app.js', patch: '@@ -1 +1 @@\n-old\n+new' }], {
      enabled: true, mode: 'enforce', configDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64),
    }, verifierIdentity, { commandRunner: () => ({ status: 1, stderr: 'unavailable' }) });

    expect(result.verification.summary).toMatchObject({ needsReview: 1, incomplete: true });
  });

  it('accepts immutable GitHub submodule metadata for an enforce file-level finding but cannot validate a content hash', async () => {
    const verifierIdentity = { repo: identity.repo, prNumber: 42, baseSha: identity.baseSha, headSha: identity.headSha };
    const changed = [{ path: 'modules/core', mode: '160000', isSubmodule: true, patch: '@@ -1 +1 @@\n-aaaaaaaa\n+bbbbbbbb' }];
    const runner = () => ({ status: 0, stdout: JSON.stringify({ type: 'submodule', sha: 'e'.repeat(40) }) });
    const accepted = await pipeline.applyFindingVerifier([{
      personaId: 'security', decision: 'FINDINGS', findings: [],
      rawFindings: [{ severity: 'P1', path: 'modules/core', line: 1, title: 'Pinned module', body: 'The immutable submodule commit is unsafe.' }],
    }], changed, { enabled: true, mode: 'enforce', configDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64) }, verifierIdentity, { commandRunner: runner });
    const hashUnavailable = await pipeline.applyFindingVerifier([{
      personaId: 'security', decision: 'FINDINGS', findings: [],
      rawFindings: [{ severity: 'P1', path: 'modules/core', line: 1, contentHash: 'f'.repeat(64), title: 'Pinned module', body: 'The immutable submodule commit is unsafe.' }],
    }], changed, { enabled: true, mode: 'enforce', configDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64) }, verifierIdentity, { commandRunner: runner });

    expect(accepted.verification.verifications[0]).toMatchObject({ status: 'accepted', subjectType: 'file' });
    expect(hashUnavailable.verification.verifications[0]).toMatchObject({ status: 'needs_review', reasonCode: 'content_hash_unavailable' });
  });

  it('uses trusted review.finding_verifier configuration and defaults its configured mode to report_only', () => {
    const configRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'finding-verifier-config-'));
    const verifyHead = () => ({ status: 0, stdout: JSON.stringify({ headRefOid: identity.headSha, baseRefOid: identity.baseSha }) });
    const env = {
      REVIEW_YETI_CONFIG_DIR: configRoot,
      REVIEW_YETI_TRUSTED_CONFIG_DIR: configRoot,
      REVIEW_YETI_TRUSTED_CONFIG_BASE_SHA: identity.baseSha,
    };

    expect(pipeline.resolveTrustedFindingVerifierPolicy({ localConfig: { parsed: {} }, prContext: identity, env, commandRunner: verifyHead }))
      .toMatchObject({ enabled: false, mode: 'report_only', status: 'disabled_not_configured' });
    expect(pipeline.resolveTrustedFindingVerifierPolicy({
      localConfig: { raw: 'review:\n  finding_verifier: {}\n', parsed: { review: { finding_verifier: {} } } },
      prContext: identity, env, commandRunner: verifyHead,
    })).toMatchObject({ enabled: true, mode: 'report_only', status: 'trusted' });
    expect(pipeline.resolveTrustedFindingVerifierPolicy({
      localConfig: { raw: 'review:\n  finding_verifier:\n    mode: enforce\n', parsed: { review: { finding_verifier: { mode: 'enforce' } } } },
      prContext: identity, env, commandRunner: verifyHead,
    })).toMatchObject({ enabled: true, mode: 'enforce', status: 'trusted' });
  });

  it('aborts publication before any write when a fresh exact-head check detects a race', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = pipeline.postOrOutputComment('summary', identity, { lineComments: [], fileComments: [] }, {
      commandRunner(command: string, args: string[]) {
        calls.push({ command, args });
        if (args[0] === 'pr' && args[1] === 'view') {
          return { status: 0, stdout: JSON.stringify({ headRefOid: 'c'.repeat(40), baseRefOid: identity.baseSha }) };
        }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
    });

    expect(result).toMatchObject({ success: false, postedViaGh: false });
    expect(result.error).toMatch(/head changed during review/i);
    expect(calls.some(({ args }) => args.includes('--method') || args.includes('reviews') || args.includes('comments'))).toBe(false);
  });

  it('fences the started-marker publication path before its read or write', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = pipeline.postStartedComment(identity, {}, {
      commandRunner(command: string, args: string[]) {
        calls.push({ command, args });
        if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ headRefOid: 'c'.repeat(40), baseRefOid: identity.baseSha }) };
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
    });

    expect(result).toMatchObject({ success: false, postedViaGh: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 2)).toEqual(['pr', 'view']);
  });

  it('rechecks the head after listing before PATCHing a started marker', () => {
    const calls: string[][] = [];
    let headChecks = 0;
    const result = pipeline.postStartedComment(identity, {}, {
      commandRunner(_command: string, args: string[]) {
        calls.push(args);
        if (args[0] === 'pr' && args[1] === 'view') {
          headChecks += 1;
          return { status: 0, stdout: JSON.stringify({ headRefOid: headChecks === 1 ? identity.headSha : 'c'.repeat(40), baseRefOid: identity.baseSha }) };
        }
        if (args[0] === 'api' && args[1]?.includes('/issues/42/comments')) {
          return { status: 0, stdout: JSON.stringify({ id: 7, body: '<!-- review-yeti-bot:v1:owner/repository#42:started -->' }) };
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
    });

    expect(result).toMatchObject({ success: false, postedViaGh: false });
    expect(calls.some((args) => args.includes('PATCH'))).toBe(false);
  });

  it('rechecks the head after listing before falling back to gh pr comment', () => {
    const calls: string[][] = [];
    let headChecks = 0;
    const result = pipeline.postStartedComment(identity, {}, {
      commandRunner(_command: string, args: string[]) {
        calls.push(args);
        if (args[0] === 'pr' && args[1] === 'view') {
          headChecks += 1;
          return { status: 0, stdout: JSON.stringify({ headRefOid: headChecks === 1 ? identity.headSha : 'c'.repeat(40), baseRefOid: identity.baseSha }) };
        }
        if (args[0] === 'api' && args[1]?.includes('/issues/42/comments')) return { status: 0, stdout: '' };
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
    });

    expect(result).toMatchObject({ success: false, postedViaGh: false });
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'comment')).toBe(false);
  });

  it('keeps report-only lanes intact but removes rejected enforce findings before arbitration and blocks verifier uncertainty', async () => {
    const files = [{ path: 'src/app.js', patch: '@@ -1 +1 @@\n-old\n+new' }];
    const lanes = [{
      personaId: 'security', decision: 'FINDINGS',
      findings: [{ severity: 'P1', path: 'src/app.js', line: 1, title: 'Legacy', body: 'Existing sanitized result.' }],
      rawFindings: [{ severity: 'P1', path: 'missing.js', line: 1, title: 'Unanchored', body: 'Not in this PR.' }],
    }];
    const basePolicy = { enabled: true, configDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64) };
    const blobOptions = { commandRunner: () => ({ status: 0, stdout: JSON.stringify({ encoding: 'base64', content: Buffer.from('new\n').toString('base64') }) }) };
    const report = await pipeline.applyFindingVerifier(lanes, files, { ...basePolicy, mode: 'report_only' }, identity, blobOptions);
    const enforce = await pipeline.applyFindingVerifier(lanes, files, { ...basePolicy, mode: 'enforce' }, identity, blobOptions);

    expect(report.personaResults[0].findings).toHaveLength(1);
    expect(report.verification.summary).toMatchObject({ rejected: 1, incomplete: false });
    expect(enforce.personaResults[0].findings).toEqual([]);
    expect(enforce.verification.summary).toMatchObject({ rejected: 1, incomplete: false });

    const blocked = pipeline.applyFindingVerifierGate({ verdict: 'SHIP', status: 'SHIP', rationale: 'Clean.', mergeEligible: true }, {
      summary: { needsReview: 1, incomplete: true },
    }, { enabled: true, mode: 'enforce' });
    expect(blocked).toMatchObject({ verdict: 'BLOCK', status: 'INCOMPLETE_REVIEW', gateDecision: 'BLOCKED', mergeEligible: false });
  });

  // Regression coverage for the cisco-cdr false-BLOCK incident (2026-08-11). This gate runs
  // BEFORE deriveReceiptOutcome and independently rewrites arbitration.verdict to 'BLOCK'
  // whenever verification.summary.incomplete is true -- fed by the same navigation-truncation
  // signal that a monorepo (>5,000 files, the bounded-navigation-snapshot cap) sets on every
  // review. Without this fix, deriveReceiptOutcome never even sees a 'SHIP' verdict to degrade
  // gracefully: this gate already overwrote it to 'BLOCK' first.
  describe('evidence-tooling-unavailable degradation', () => {
    it('CORE REGRESSION: does not force BLOCK on a clean SHIP when evidence tooling was unavailable for the whole review', () => {
      const result = pipeline.applyFindingVerifierGate(
        { verdict: 'SHIP', status: 'SHIP', rationale: 'Clean.', mergeEligible: true },
        { summary: { needsReview: 0, incomplete: true } },
        { enabled: true, mode: 'enforce' },
        { evidenceEnabled: false },
      );
      expect(result).toMatchObject({ verdict: 'SHIP', mergeEligible: true });
    });

    it('OVER-CORRECTION GUARD: still forces BLOCK when evidence tooling was enabled (default, unchanged behavior)', () => {
      const result = pipeline.applyFindingVerifierGate(
        { verdict: 'SHIP', status: 'SHIP', rationale: 'Clean.', mergeEligible: true },
        { summary: { needsReview: 1, incomplete: true } },
        { enabled: true, mode: 'enforce' },
        { evidenceEnabled: true },
      );
      expect(result).toMatchObject({ verdict: 'BLOCK', gateDecision: 'BLOCKED', mergeEligible: false });
    });
  });
});
