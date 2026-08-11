import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(__dirname, '../..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));
const { runPersonaInvestigation } = require(path.join(root, 'src/review/reviewInvestigation.js'));
const { deriveReceiptOutcome } = require(path.join(root, 'src/review/reviewOutcome.js'));
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

  // Regression coverage for the cisco-cdr false-BLOCK incident (2026-08-11) and its false-SHIP
  // near-miss.
  //
  // An earlier version of this fix threaded an `evidenceEnabled` flag straight into
  // applyFindingVerifierGate and skipped it wholesale whenever bounded evidence/navigation
  // tooling was off. That was wrong and was caught before merging: `verification.summary.
  // incomplete` can be true for reasons that have nothing to do with bounded-navigation
  // availability (the finding verifier's own exact-blob check -- findingVerifier.js -- is an
  // independent mechanism that can fail on its own, e.g. a real finding it could not confirm).
  // Blanket-skipping this gate on that basis would have let an unverifiable real finding through
  // as SHIP -- the exact false-SHIP class this repo's gate exists to prevent. Also, with evidence
  // tooling off, reviewInvestigation.js's candidateFindings no longer silently discards a
  // findings-bearing persona result (see reviewInvestigation.test.ts): a real P1 finding still
  // reaches `arbitration.verdict`, so this gate never needed a bypass to let a genuinely clean
  // SHIP through in the first place.
  //
  // The actual fix lives further upstream, in review-pipeline.js's navigationCompletenessMatters:
  // a truncated/unavailable bounded-navigation snapshot only feeds into
  // `findingVerification.summary.incomplete` when a persona produced a finding actually grounded
  // in that snapshot's evidence tools. This gate itself is unchanged from before PR #37 and stays
  // that way -- it always blocks a genuinely incomplete verification.
  describe('applyFindingVerifierGate never bypasses genuine incompleteness', () => {
    it('DANGER GUARD: still forces BLOCK on a real needsReview>0 verification gap, with no evidence-availability escape hatch', () => {
      const result = pipeline.applyFindingVerifierGate(
        { verdict: 'SHIP', status: 'SHIP', rationale: 'Clean.', mergeEligible: true },
        { summary: { needsReview: 1, incomplete: true } },
        { enabled: true, mode: 'enforce' },
      );
      expect(result).toMatchObject({ verdict: 'BLOCK', gateDecision: 'BLOCKED', mergeEligible: false });
    });

    it('has no fourth-argument bypass at all (signature reverted to its pre-incident shape)', () => {
      // Calling with a would-be bypass options object as a 4th arg must be a no-op: the function
      // only takes 3 params. This pins the signature so a future edit cannot silently reintroduce
      // the blanket bypass.
      const result = pipeline.applyFindingVerifierGate(
        { verdict: 'SHIP', status: 'SHIP', rationale: 'Clean.', mergeEligible: true },
        { summary: { needsReview: 1, incomplete: true } },
        { enabled: true, mode: 'enforce' },
        { evidenceEnabled: false },
      );
      expect(result).toMatchObject({ verdict: 'BLOCK', gateDecision: 'BLOCKED', mergeEligible: false });
    });
  });

  describe('navigationCompletenessMatters (the actual source-level fix)', () => {
    it('CORE REGRESSION: a truncated snapshot does not matter when zero personas produced a navigation-grounded finding', () => {
      const matters = pipeline.navigationCompletenessMatters({
        personaResults: [
          { personaId: 'security', findings: [] },
          { personaId: 'testing', findings: [] },
        ],
        navigationSnapshot: { complete: false, truncated: true },
        options: {},
      });
      expect(matters).toBe(false);
    });

    it('still matters when a finding is grounded in the (truncated) navigation snapshot', () => {
      const matters = pipeline.navigationCompletenessMatters({
        personaResults: [
          { personaId: 'security', findings: [{ severity: 'P1', evidence_receipt_ids: ['er_1'] }] },
        ],
        navigationSnapshot: { complete: false, truncated: true },
        options: {},
      });
      expect(matters).toBe(true);
    });

    it('DANGER GUARD: does not matter for a finding reviewInvestigation.js marked unverified (evidence tooling was globally off, not navigation-dependent)', () => {
      const matters = pipeline.navigationCompletenessMatters({
        personaResults: [
          { personaId: 'security', findings: [{ severity: 'P1', unverified: true }] },
        ],
        navigationSnapshot: { complete: false, truncated: true },
        options: {},
      });
      expect(matters).toBe(false);
    });

    it('does not matter once the snapshot is complete, regardless of findings', () => {
      const matters = pipeline.navigationCompletenessMatters({
        personaResults: [
          { personaId: 'security', findings: [{ severity: 'P1', evidence_receipt_ids: ['er_1'] }] },
        ],
        navigationSnapshot: { complete: true, truncated: false },
        options: {},
      });
      expect(matters).toBe(false);
    });

    it('never matters for a synthetic modelClient test/CLI harness that never fetches real navigation', () => {
      const matters = pipeline.navigationCompletenessMatters({
        personaResults: [{ personaId: 'security', findings: [{ severity: 'P1', evidence_receipt_ids: ['er_1'] }] }],
        navigationSnapshot: null,
        options: { modelClient: async () => ({}) },
      });
      expect(matters).toBe(false);
    });
  });

  // The acceptance criterion the coordinator required before this PR could merge: a persona that
  // reports a real P1 finding, with bounded evidence tooling unavailable for the whole review,
  // must not resolve to SHIP end-to-end. This composes the real fixed functions across all three
  // files this incident touched (reviewInvestigation.js, review-pipeline.js, reviewOutcome.js) --
  // it is not just each gate tested in isolation.
  describe('end-to-end acceptance: a P1 finding with evidence tooling unavailable must not resolve to SHIP', () => {
    it('ACCEPTANCE', async () => {
      const reviewIdentity = { provider: 'github', repository: identity.repo, prNumber: identity.prNumber, baseSha: identity.baseSha, headSha: identity.headSha };
      const disabledRegistry = { capabilities: { enabled: false, readOnly: true, tools: [] }, call: async () => ({ status: 'unavailable', reason: 'disabled' }) };
      const changedFiles = [{ path: 'lib/repo.ex', patch: '@@ -1 +1 @@\n-old\n+new' }];

      // The flagging persona actually runs the real investigation state machine end to end, with
      // evidence tooling disabled, and reports a real defect it can establish from the diff alone.
      const flaggingRun = await runPersonaInvestigation({
        identity: reviewIdentity,
        persona: { id: 'security', name: 'Security', charter: 'Flag correctness defects.' },
        manifest: 'ru_1 lib/repo.ex',
        diffText: changedFiles[0].patch,
        evidenceRegistry: disabledRegistry,
        clock: () => 100,
        modelTurn: async () => ({
          ok: true,
          content: JSON.stringify({
            review_status: 'COMPLETE',
            risk_plan: [{ id: 'risk-1', unit_ids: ['ru_1'], statement: 'insert_all may skip the usec cast', evidence_needed: [], allowed_tools: [] }],
            evidence_requests: [],
            risk_dispositions: [{ risk_id: 'risk-1', status: 'confirmed', reason: 'visible directly in the diff' }],
            findings: [{ severity: 'P1', path: 'lib/repo.ex', line: 1, side: 'RIGHT', title: 'insert_all skips usec cast', body: 'insert_all bypasses the changeset cast on a :utc_datetime_usec column.', risk_id: 'risk-1' }],
          }),
          model: 'test/model', provider: 'test', usage: { promptTokens: 10, completionTokens: 5 },
        }),
      });
      // Sanity check on the retention fix (reviewInvestigation.test.ts covers this directly too):
      // the finding must have survived candidateFindings, not been silently dropped.
      expect(flaggingRun.personaResult.decision).toBe('FINDINGS');

      const cleanPersonaResult = (personaId: string) => ({
        personaId, decision: 'APPROVE', findings: [], partial: 0,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUSD: 0 }, routes: [],
      });
      const personaResults = [
        pipeline.aggregatePersonaRuns({ id: 'security', name: 'Security' }, [flaggingRun.personaResult], 'test/model'),
        ...['testing', 'style', 'architecture', 'performance'].map((id) => (
          pipeline.aggregatePersonaRuns({ id, name: id }, [cleanPersonaResult(id)], 'test/model')
        )),
      ];

      const arbitration0 = pipeline.computeArbitrationQuorum(personaResults, 5, { changedFiles, coverageComplete: true });
      // The P1 finding alone must be enough to keep arbitration off SHIP -- this is the
      // fundamental property: arbitration actually saw the finding because it was never dropped.
      expect(arbitration0.verdict).not.toBe('SHIP');

      // Nothing in this run is navigation-grounded (the retained finding is `unverified: true`),
      // so a truncated/unavailable bounded-navigation snapshot correctly adds no extra
      // incompleteness on top -- this is the actual source-level fix, verified in the
      // navigationCompletenessMatters suite above.
      const findingVerification = {
        summary: { incomplete: pipeline.navigationCompletenessMatters({ personaResults, navigationSnapshot: { complete: false, truncated: true }, options: {} }) },
      };
      expect(findingVerification.summary.incomplete).toBe(false);

      const arbitration1 = pipeline.applyFindingVerifierGate(arbitration0, findingVerification, { enabled: true, mode: 'enforce' });
      const finalOutcome = deriveReceiptOutcome({
        arbitration: arbitration1,
        unitManifest: { coverage: { complete: true } },
        laneReceipts: [flaggingRun.executionReceipt],
        findingVerification,
        headCurrent: true,
        evidenceEnabled: false,
      });

      expect(finalOutcome.verdict).not.toBe('SHIP');
      expect(finalOutcome.mergeEligible).not.toBe(true);
    });
  });
});
