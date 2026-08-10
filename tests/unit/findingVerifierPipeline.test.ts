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

  it('keeps report-only lanes intact but removes rejected enforce findings before arbitration and blocks verifier uncertainty', () => {
    const files = [{ path: 'src/app.js', patch: '@@ -1 +1 @@\n-old\n+new' }];
    const lanes = [{
      personaId: 'security', decision: 'FINDINGS',
      findings: [{ severity: 'P1', path: 'src/app.js', line: 1, title: 'Legacy', body: 'Existing sanitized result.' }],
      rawFindings: [{ severity: 'P1', path: 'missing.js', line: 1, title: 'Unanchored', body: 'Not in this PR.' }],
    }];
    const basePolicy = { enabled: true, configDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64) };
    const report = pipeline.applyFindingVerifier(lanes, files, { ...basePolicy, mode: 'report_only' }, identity);
    const enforce = pipeline.applyFindingVerifier(lanes, files, { ...basePolicy, mode: 'enforce' }, identity);

    expect(report.personaResults[0].findings).toHaveLength(1);
    expect(report.verification.summary).toMatchObject({ rejected: 1, incomplete: false });
    expect(enforce.personaResults[0].findings).toEqual([]);
    expect(enforce.verification.summary).toMatchObject({ rejected: 1, incomplete: false });

    const blocked = pipeline.applyFindingVerifierGate({ verdict: 'SHIP', status: 'SHIP', rationale: 'Clean.', mergeEligible: true }, {
      summary: { needsReview: 1, incomplete: true },
    }, { enabled: true, mode: 'enforce' });
    expect(blocked).toMatchObject({ verdict: 'BLOCK', status: 'INCOMPLETE_REVIEW', gateDecision: 'BLOCKED', mergeEligible: false });
  });
});
