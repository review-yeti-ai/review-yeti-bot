import { describe, expect, it } from 'vitest';
import { deriveReviewGateExternalId } from '../../src/review/reviewCheckIdentity';
import {
  createIncompleteP2RecoveryContext,
  incompleteP2RecoveryClaimFor,
  incompleteP2RecoveryClaimMatches,
  incompleteP2RecoveryClaimSchema,
  parseIncompleteP2RecoveryContext,
} from '../../src/review/incompleteP2Recovery';
import {
  loadIncompleteP2RecoveryContext,
  requiredIncompleteP2RecoveryDigest,
} from '../../src/persistence/incompleteP2Recovery';
import { workerReviewCompletionDigest } from '../../src/review/workerReviewCompletion';
import { publishFinding } from '../../src/review/reviewCore';
import type { ReviewGenerationRecoveryEvidence } from '../../src/review/reviewGenerationRecovery';

const runId = 'run_' + 'a'.repeat(32);
const repositoryId = 3210;
const owner = 'example-owner';
const repo = 'example-repo';
const prNumber = 42;
const headSha = 'b'.repeat(40);
const baseSha = 'c'.repeat(40);
const policyDigest = 'd'.repeat(64);
const configDigest = 'e'.repeat(64);
const appId = 4567;

function contextFixture() {
  return createIncompleteP2RecoveryContext({
    version: 'IncompleteP2RecoveryContext.v1',
    runId,
    repositoryId,
    owner,
    repo,
    prNumber,
    headSha,
    baseSha,
    policyDigest,
    configDigest,
    expectedAppId: appId,
    executionAttempt: 2,
    sources: [{
      executionAttempt: 1,
      workerResultDigest: 'f'.repeat(64),
      workerCheckId: 10,
      gateCheckId: 20,
      rawFindingCount: 1,
      canonicalFindingCount: 1,
    }],
    findings: [{
      sourceExecutionAttempt: 1,
      sourceWorkerResultDigest: 'f'.repeat(64),
      sourceWorkerCheckId: 10,
      sourceGateCheckId: 20,
      personaId: 'security',
      findingIndex: 0,
      finding: { severity: 'P2', path: 'src/example.ts', line: 12,
        title: 'Keep the prior advisory', body: 'This bounded advisory remains available for the new full review.' },
    }],
  });
}

function completionFixture() {
  return {
    version: 'WorkerReviewCompletion.v1',
    runId,
    repositoryId,
    owner,
    repo,
    prNumber,
    headSha,
    baseSha,
    policyDigest,
    configDigest,
    executionAttempt: 1,
    result: {
      version: 'WorkerReviewResult.v1',
      completedAt: '2026-09-29T12:00:00.000Z',
      // This is the verified durable case: the worker claims both booleans
      // true, while the service-owned roster and Gate show only 3/7 completed.
      personas: Array.from({ length: 3 }, (_, index) => ({
        id: 'reviewer-' + (index + 1),
        decision: 'FINDINGS',
        findings: [{ severity: 'P2', path: 'src/risk-' + (index + 1) + '.ts', line: 1,
          title: 'Advisory ' + (index + 1), body: 'Distinct advisory ' + (index + 1) + ' from the completed lane.' }],
      })),
      coverageComplete: true,
      quorumSatisfied: true,
      findingCount: 3,
      blockingFindingCount: 0,
    },
  };
}

function workerSummary({ canonical = 3, raw = 3, completed = 3, expected = 7, sha = headSha } = {}) {
  const tick = String.fromCharCode(96);
  return [
    'Verdict ' + tick + 'BLOCK' + tick + ' at ' + tick + sha + tick + '.',
    '',
    'Findings: ' + canonical + ' (blocking P0/P1: 0; ' + raw + ' raw persona finding(s) before clustering).',
    '',
    'Coverage: mode=panel; expected lanes=' + expected + '; completed lanes=' + completed + '; failed lanes=0; roster valid=false; quorum satisfied=false; full panel complete=false.',
  ].join('\n');
}

function gateSummary(expected = 7, completed = 3) {
  return 'Review Yeti Gate failed: the panel expected ' + expected
    + ' review lane(s) but ' + completed + ' completed. This is an incomplete review, not a findings verdict; re-dispatch the review for this head.';
}

function gateCheckFixture(attempt: number, externalId: string, completedAt: string, conclusion = 'failure') {
  return {
    id: 19 + attempt,
    name: 'Review Yeti Gate',
    head_sha: headSha,
    app: { id: appId, slug: 'ct-review-bot' },
    status: 'completed',
    conclusion,
    external_id: externalId,
    started_at: completedAt,
    completed_at: completedAt,
    output: {
      title: conclusion === 'failure' ? 'Review Yeti Gate: Failed (incomplete panel)' : 'Review Yeti Gate: Success',
      summary: gateSummary(),
    },
  };
}

function sourceRowFixture(completion: ReturnType<typeof completionFixture>, attempt: number,
  { canonical = 3, raw = 3, expected = 7, completed = 3 } = {}) {
  const resultDigest = workerReviewCompletionDigest(completion);
  const externalId = deriveReviewGateExternalId(gateCoordinates(attempt));
  const gateEvidence = {
    verdict: 'BLOCK',
    completedAt: '2026-09-29T12:00:02Z',
    coverageComplete: true,
    quorumSatisfied: false,
    infrastructureFailure: false,
    p0Count: 0,
    p1Count: 0,
    expectedLanes: expected,
    completedLanes: completed,
  };
  return {
    run_id: runId,
    repository_id: repositoryId,
    owner,
    repo,
    pr_number: prNumber,
    head_sha: headSha,
    base_sha: baseSha,
    effective_policy_digest: policyDigest,
    effective_config_digest: configDigest,
    authoritative_gate_app_id: appId,
    source_execution_attempt: attempt,
    content_digest: resultDigest,
    payload: completion,
    payload_byte_length: Buffer.byteLength(JSON.stringify(completion), 'utf8'),
    byte_length: Buffer.byteLength(JSON.stringify(completion), 'utf8'),
    gate_check_id: 19 + attempt,
    gate_execution_attempt: attempt,
    gate_review_generation: attempt - 1,
    gate_repository_id: repositoryId,
    gate_pr_number: prNumber,
    gate_expected_app_id: appId,
    gate_external_id: externalId,
    gate_creation_state: 'bound',
    gate_desired_state: 'failure',
    gate_coordinates: gateCoordinates(attempt),
    gate_evidence: gateEvidence,
    gate_decision: { status: 'failure', eligible: false, reason: 'incomplete-review' },
    gate_worker_result_digest: resultDigest,
    _proof: {
      generation: attempt,
      checkId: 9 + attempt,
      externalId: runId + ':a' + attempt,
      conclusion: 'failure' as const,
      title: 'Review Yeti: BLOCK',
      legacyIncompleteRoster: {
        workerSummary: workerSummary({ canonical, raw, expected, completed }),
        workerCompletedAt: attempt === 1 ? '2026-09-29T12:00:01Z' : '2026-09-29T12:10:01Z',
        gateChecks: [gateCheckFixture(attempt, externalId,
          attempt === 1 ? '2026-09-29T12:00:02Z' : '2026-09-29T12:10:02Z')],
      },
    },
  };
}

function recoveryEvidence(gateExternalId: string, options: { workerSummary?: string; gateCheck?: Record<string, unknown> } = {}): ReviewGenerationRecoveryEvidence[] {
  return [{
    generation: 1,
    checkId: 10,
    externalId: runId + ':a1',
    conclusion: 'failure',
    title: 'Review Yeti: BLOCK',
    legacyIncompleteRoster: {
      workerSummary: options.workerSummary ?? workerSummary(),
      workerCompletedAt: '2026-09-29T12:00:01Z',
      gateChecks: [options.gateCheck ?? {
        id: 20,
        name: 'Review Yeti Gate',
        head_sha: headSha,
        app: { id: appId, slug: 'ct-review-bot' },
        status: 'completed',
        conclusion: 'failure',
        external_id: gateExternalId,
        started_at: '2026-09-29T12:00:01Z',
        completed_at: '2026-09-29T12:00:02Z',
        output: {
          title: 'Review Yeti Gate: Failed (incomplete panel)',
          summary: gateSummary(),
        },
      }],
    },
  }];
}

function gateCoordinates(attempt = 1) {
  return {
    owner,
    repo,
    repositoryId,
    prNumber,
    headSha,
    baseSha,
    policyDigest,
    runId,
    attemptId: runId + '-g' + (attempt - 1) + '-e' + attempt,
    executionAttempt: attempt,
  };
}

function queryableForIncompletePrior() {
  const completion = completionFixture();
  const resultDigest = workerReviewCompletionDigest(completion);
  const externalId = deriveReviewGateExternalId(gateCoordinates());
  const gateEvidence = {
    verdict: 'BLOCK',
    completedAt: '2026-09-29T12:00:02Z',
    coverageComplete: true,
    quorumSatisfied: false,
    infrastructureFailure: false,
    p0Count: 0,
    p1Count: 0,
    expectedLanes: 7,
    completedLanes: 3,
  };
  const sourceRow = {
    run_id: runId,
    repository_id: repositoryId,
    owner,
    repo,
    pr_number: prNumber,
    head_sha: headSha,
    base_sha: baseSha,
    effective_policy_digest: policyDigest,
    effective_config_digest: configDigest,
    authoritative_gate_app_id: appId,
    source_execution_attempt: 1,
    content_digest: resultDigest,
    payload: completion,
    payload_byte_length: Buffer.byteLength(JSON.stringify(completion), 'utf8'),
    byte_length: Buffer.byteLength(JSON.stringify(completion), 'utf8'),
    gate_check_id: 20,
    gate_execution_attempt: 1,
    gate_review_generation: 0,
    gate_repository_id: repositoryId,
    gate_pr_number: prNumber,
    gate_expected_app_id: appId,
    gate_external_id: externalId,
    gate_creation_state: 'bound',
    gate_desired_state: 'failure',
    gate_coordinates: gateCoordinates(),
    gate_evidence: gateEvidence,
    gate_decision: { status: 'failure', eligible: false, reason: 'incomplete-review' },
    gate_worker_result_digest: resultDigest,
  };
  const runRow = {
    run_id: runId,
    repository_id: repositoryId,
    owner,
    repo,
    pr_number: prNumber,
    head_sha: headSha,
    base_sha: baseSha,
    effective_policy_digest: policyDigest,
    effective_config_digest: configDigest,
    authoritative_gate_app_id: appId,
    publication_mode: 'app-gate',
  };
  const fixture = {
    sourceRows: [sourceRow],
    runRow,
    externalId,
    resultDigest,
  };
  return {
    ...fixture,
    query: async (sql: string) => ({ rows: sql.includes('JOIN review_worker_completions') ? fixture.sourceRows : [fixture.runRow] }),
  };
}

function loadFixture(fixture: ReturnType<typeof queryableForIncompletePrior>, overrides: Record<string, unknown> = {}) {
  return loadIncompleteP2RecoveryContext(fixture, {
    runId,
    executionAttempt: 2,
    repositoryId,
    identity: { owner, repo, prNumber, headSha, baseSha, configDigest },
    policyDigest,
    expectedAppId: appId,
    incompleteP2Recovery: true,
    recoveryEvidence: recoveryEvidence(fixture.externalId),
    ...overrides,
  } as Parameters<typeof loadIncompleteP2RecoveryContext>[1]);
}

function resealCompletion(fixture: ReturnType<typeof queryableForIncompletePrior>) {
  const row = fixture.sourceRows[0] as any;
  const digest = workerReviewCompletionDigest(row.payload);
  row.content_digest = digest;
  row.gate_worker_result_digest = digest;
  row.payload_byte_length = Buffer.byteLength(JSON.stringify(row.payload), 'utf8');
  row.byte_length = row.payload_byte_length;
  return digest;
}

function zeroFindingCompletion(attempt: number) {
  const completion = completionFixture() as any;
  completion.executionAttempt = attempt;
  completion.result.personas = Array.from({ length: 3 }, (_, index) => ({
    id: 'reviewer-' + (index + 1), decision: 'APPROVE', findings: [],
  }));
  completion.result.findingCount = 0;
  completion.result.blockingFindingCount = 0;
  return completion;
}

describe('incomplete P2 recovery context', () => {
  it('binds retained findings to all source metadata and rejects altered content', () => {
    const context = contextFixture();
    expect(parseIncompleteP2RecoveryContext(context)).toEqual(context);
    expect(incompleteP2RecoveryClaimMatches(context, incompleteP2RecoveryClaimFor(context))).toBe(true);
    expect(incompleteP2RecoveryClaimMatches(context, {
      ...incompleteP2RecoveryClaimFor(context),
      sources: [],
    })).toBe(false);

    expect(() => parseIncompleteP2RecoveryContext({ ...context,
      findings: [{ ...context.findings[0], finding: { ...context.findings[0].finding, body: 'altered' } }],
    })).toThrow();
  });

  it.each([
    ['executionAttempt', { executionAttempt: 2 }],
    ['workerResultDigest', { workerResultDigest: '0'.repeat(64) }],
    ['workerCheckId', { workerCheckId: 11 }],
    ['gateCheckId', { gateCheckId: 21 }],
  ])('rejects a schema-valid claim with the correct digest but altered %s', (_field, change) => {
    const context = contextFixture();
    const original = incompleteP2RecoveryClaimFor(context);
    const changed = {
      ...original,
      sources: original.sources.map((source, index) => index === 0 ? { ...source, ...change } : source),
    };

    expect(changed.contextDigest).toBe(context.contextDigest);
    expect(incompleteP2RecoveryClaimSchema.safeParse(changed).success).toBe(true);
    expect(incompleteP2RecoveryClaimMatches(context, changed)).toBe(false);
  });

  it('rejects a schema-valid reordered two-source claim while its context digest stays correct', () => {
    const firstDigest = '1'.repeat(64);
    const secondDigest = '2'.repeat(64);
    const context = createIncompleteP2RecoveryContext({
      version: 'IncompleteP2RecoveryContext.v1',
      runId,
      repositoryId,
      owner,
      repo,
      prNumber,
      headSha,
      baseSha,
      policyDigest,
      configDigest,
      expectedAppId: appId,
      executionAttempt: 3,
      sources: [
        { executionAttempt: 1, workerResultDigest: firstDigest, workerCheckId: 10, gateCheckId: 20,
          rawFindingCount: 1, canonicalFindingCount: 1 },
        { executionAttempt: 2, workerResultDigest: secondDigest, workerCheckId: 11, gateCheckId: 21,
          rawFindingCount: 1, canonicalFindingCount: 1 },
      ],
      findings: [
        { sourceExecutionAttempt: 1, sourceWorkerResultDigest: firstDigest, sourceWorkerCheckId: 10,
          sourceGateCheckId: 20, personaId: 'security', findingIndex: 0,
          finding: { severity: 'P2', path: 'src/first.ts', line: 1,
            title: 'First source', body: 'The first archived source stays ordered.' } },
        { sourceExecutionAttempt: 2, sourceWorkerResultDigest: secondDigest, sourceWorkerCheckId: 11,
          sourceGateCheckId: 21, personaId: 'reviewer', findingIndex: 0,
          finding: { severity: 'P2', path: 'src/second.ts', line: 1,
            title: 'Second source', body: 'The second archived source stays ordered.' } },
      ],
    });
    const original = incompleteP2RecoveryClaimFor(context);
    const reordered = { ...original, sources: [...original.sources].reverse() };

    expect(reordered.contextDigest).toBe(context.contextDigest);
    expect(incompleteP2RecoveryClaimSchema.safeParse(reordered).success).toBe(true);
    expect(incompleteP2RecoveryClaimMatches(context, reordered)).toBe(false);
  });

  it('accepts service-owned Gate evidence when the worker reports true coverage and quorum flags', async () => {
    const fixture = queryableForIncompletePrior();
    const context = await loadIncompleteP2RecoveryContext(fixture, {
      runId,
      executionAttempt: 2,
      repositoryId,
      identity: { owner, repo, prNumber, headSha, baseSha, configDigest },
      policyDigest,
      expectedAppId: appId,
      incompleteP2Recovery: true,
      recoveryEvidence: recoveryEvidence(fixture.externalId),
    });

    expect(context).not.toBeNull();
    expect(context?.findings).toHaveLength(3);
    expect(context?.sources).toEqual([{
      executionAttempt: 1,
      workerResultDigest: fixture.resultDigest,
      workerCheckId: 10,
      gateCheckId: 20,
      rawFindingCount: 3,
      canonicalFindingCount: 3,
    }]);
  });

  it('refuses a completion whose payload no longer matches its immutable digest', async () => {
    const fixture = queryableForIncompletePrior();
    const completion = (fixture.sourceRows[0] as any).payload;
    completion.result.personas[0].findings[0].body = 'changed after the digest was stored';
    await expect(loadFixture(fixture)).rejects.toThrow();
  });

  it('refuses a missing stored completion row even when the GitHub proof exists', async () => {
    const fixture = queryableForIncompletePrior();
    fixture.sourceRows.length = 0;
    await expect(loadFixture(fixture)).rejects.toThrow();
  });

  it.each([
    ['App', { expectedAppId: appId + 1 }],
    ['head', { identity: { owner, repo, prNumber, headSha: '9'.repeat(40), baseSha, configDigest } }],
    ['base', { identity: { owner, repo, prNumber, headSha, baseSha: '8'.repeat(40), configDigest } }],
    ['config', { identity: { owner, repo, prNumber, headSha, baseSha, configDigest: '7'.repeat(64) } }],
    ['policy', { policyDigest: '6'.repeat(64) }],
    ['run', { runId: 'run_' + '5'.repeat(32) }],
  ])('refuses a prior completion bound to a foreign %s', async (_binding, overrides) => {
    await expect(loadFixture(queryableForIncompletePrior(), overrides)).rejects.toThrow();
  });

  it('rejects an older Gate outside the worker lifetime and does not borrow it', async () => {
    const fixture = queryableForIncompletePrior();
    const proof = recoveryEvidence(fixture.externalId)[0];
    const oldGate = { ...(proof.legacyIncompleteRoster!.gateChecks[0] as Record<string, unknown>),
      completed_at: '2026-09-29T11:59:59Z' };
    proof.legacyIncompleteRoster!.gateChecks = [oldGate];
    await expect(loadFixture(fixture, { recoveryEvidence: [proof] })).rejects.toThrow();
  });

  it('refuses a newer successful Gate instead of falling back to the older incomplete Gate', async () => {
    const fixture = queryableForIncompletePrior();
    const proof = recoveryEvidence(fixture.externalId)[0];
    const current = proof.legacyIncompleteRoster!.gateChecks[0] as Record<string, any>;
    const newerSuccess = { ...current, id: 99, conclusion: 'success', completed_at: '2026-09-29T12:00:03Z',
      output: { title: 'Review Yeti Gate: Success', summary: 'A later Gate completed successfully.' } };
    proof.legacyIncompleteRoster!.gateChecks = [current, newerSuccess];
    await expect(loadFixture(fixture, { recoveryEvidence: [proof] })).rejects.toThrow();
  });

  it('refuses a Gate record bound to another execution attempt', async () => {
    const fixture = queryableForIncompletePrior();
    const proof = recoveryEvidence(fixture.externalId)[0];
    const gate = proof.legacyIncompleteRoster!.gateChecks[0] as Record<string, unknown>;
    gate.external_id = deriveReviewGateExternalId(gateCoordinates(2));
    await expect(loadFixture(fixture, { recoveryEvidence: [proof] })).rejects.toThrow();
  });

  it.each([
    ['P0', 'Critical raw finding'],
    ['P1', 'Documentation omission'],
  ])('rejects raw %s evidence even if canonical calibration could make it advisory', async (severity, title) => {
    const fixture = queryableForIncompletePrior();
    const completion = (fixture.sourceRows[0] as any).payload;
    completion.result.personas[0].findings[0] = { ...completion.result.personas[0].findings[0],
      severity, title, body: 'The raw source severity must remain visible to recovery admission.' };
    if (severity === 'P1') {
      expect(publishFinding(completion.result.personas[0].findings[0]).severity).toBe('P2');
    }
    resealCompletion(fixture);
    await expect(loadFixture(fixture)).rejects.toThrow();
  });

  it('rejects a failed persona lane that still carries findings', async () => {
    const fixture = queryableForIncompletePrior();
    const completion = (fixture.sourceRows[0] as any).payload;
    completion.result.personas[0].decision = 'ERROR';
    completion.result.personas[0].status = 'ERROR';
    completion.result.personas[0].errorClass = 'provider_error';
    completion.result.findingCount = 2;
    const row = fixture.sourceRows[0] as any;
    row.gate_evidence.completedLanes = 2;
    resealCompletion(fixture);
    const proof = recoveryEvidence(fixture.externalId, {
      workerSummary: workerSummary({ canonical: 2, raw: 2, completed: 2 }),
    })[0];
    const gateCheck = proof.legacyIncompleteRoster!.gateChecks[0] as Record<string, any>;
    gateCheck.output.summary = gateSummary(7, 2);
    await expect(loadFixture(fixture, { recoveryEvidence: [proof] })).rejects.toThrow();
  });

  it('supports a zero-finding incomplete middle attempt without dropping prior P2 provenance', () => {
    const firstDigest = '1'.repeat(64);
    const secondDigest = '2'.repeat(64);
    const content = {
      version: 'IncompleteP2RecoveryContext.v1' as const,
      runId,
      repositoryId,
      owner,
      repo,
      prNumber,
      headSha,
      baseSha,
      policyDigest,
      configDigest,
      expectedAppId: appId,
      executionAttempt: 3,
      sources: [
        { executionAttempt: 1, workerResultDigest: firstDigest, workerCheckId: 10, gateCheckId: 20,
          rawFindingCount: 1, canonicalFindingCount: 1 },
        { executionAttempt: 2, workerResultDigest: secondDigest, workerCheckId: 11, gateCheckId: 21,
          rawFindingCount: 0, canonicalFindingCount: 0 },
      ],
      findings: [{ sourceExecutionAttempt: 1, sourceWorkerResultDigest: firstDigest,
        sourceWorkerCheckId: 10, sourceGateCheckId: 20, personaId: 'security', findingIndex: 0,
        finding: { severity: 'P2' as const, path: 'src/example.ts', line: 12,
          title: 'Retained advisory', body: 'Still included after an intervening empty incomplete attempt.' } }],
    };
    expect(createIncompleteP2RecoveryContext(content).sources[1].rawFindingCount).toBe(0);
  });

  it('loads original P2 findings across a real P2-a1, zero-finding-a2 recovery chain', async () => {
    const first = sourceRowFixture(completionFixture(), 1);
    const second = sourceRowFixture(zeroFindingCompletion(2), 2, { canonical: 0, raw: 0 });
    const gate1 = gateCheckFixture(1, first.gate_external_id,
      '2026-09-29T12:00:02Z') as Record<string, any>;
    const gate2 = gateCheckFixture(2, second.gate_external_id,
      '2026-09-29T12:10:02Z') as Record<string, any>;
    const proof1 = first._proof as ReviewGenerationRecoveryEvidence;
    const proof2 = second._proof as ReviewGenerationRecoveryEvidence;
    proof1.legacyIncompleteRoster!.nextWorkerStartedAt = '2026-09-29T12:05:00Z';
    proof1.legacyIncompleteRoster!.gateChecks = [gate1, gate2];
    proof2.legacyIncompleteRoster!.gateChecks = [gate1, gate2];
    const ledgerRows = [proof1, proof2].map((proof) => ({
      recovered_generation: proof.generation,
      worker_check_id: proof.checkId,
      external_id: proof.externalId,
      conclusion: proof.conclusion,
      title: proof.title,
      evidence: proof,
    }));
    const fixture = queryableForIncompletePrior();
    const mixed = {
      ...fixture,
      sourceRows: [first, second],
      query: async (sql: string) => ({ rows: sql.includes('review_generation_recoveries') ? ledgerRows
        : sql.includes('JOIN review_worker_completions') ? [first, second] : [fixture.runRow] }),
    };

    const context = await loadIncompleteP2RecoveryContext(mixed, {
      runId,
      executionAttempt: 3,
      repositoryId,
      identity: { owner, repo, prNumber, headSha, baseSha, configDigest },
      policyDigest,
      expectedAppId: appId,
      incompleteP2Recovery: true,
    });

    expect(context?.sources.map((source) => [source.executionAttempt, source.rawFindingCount])).toEqual([[1, 3], [2, 0]]);
    expect(context?.findings).toHaveLength(3);
    expect(context?.findings.every((finding) => finding.sourceExecutionAttempt === 1)).toBe(true);
  });

  it('rejects rather than truncating a context that exceeds the UTF-8 byte cap', () => {
    const digest = '4'.repeat(64);
    const oversized = {
      version: 'IncompleteP2RecoveryContext.v1' as const,
      runId,
      repositoryId,
      owner,
      repo,
      prNumber,
      headSha,
      baseSha,
      policyDigest,
      configDigest,
      expectedAppId: appId,
      executionAttempt: 2,
      sources: [{ executionAttempt: 1, workerResultDigest: digest, workerCheckId: 10, gateCheckId: 20,
        rawFindingCount: 5, canonicalFindingCount: 5 }],
      findings: Array.from({ length: 5 }, (_, index) => ({
        sourceExecutionAttempt: 1,
        sourceWorkerResultDigest: digest,
        sourceWorkerCheckId: 10,
        sourceGateCheckId: 20,
        personaId: 'reviewer-' + (index + 1),
        findingIndex: 0,
        finding: { severity: 'P2' as const, path: 'src/risk-' + (index + 1) + '.ts', line: 1,
          title: 'Large advisory ' + (index + 1), body: 'x'.repeat(16_000) },
      })),
    };
    expect(() => createIncompleteP2RecoveryContext(oversized)).toThrow();
    expect(oversized.findings[0].finding.body).toHaveLength(16_000);
  });

  it('allows an unrelated later technical attempt with no P2 marker or history', async () => {
    const runRow = {
      repository_id: repositoryId,
      owner,
      repo,
      pr_number: prNumber,
      head_sha: headSha,
      base_sha: baseSha,
      effective_policy_digest: policyDigest,
      effective_config_digest: configDigest,
      authoritative_gate_app_id: appId,
    };
    const queryable = { query: async (sql: string) => ({ rows:
      sql.includes('review_generation_recoveries') || sql.includes('incomplete P2 recovery loss guard')
        ? [] : [runRow] }) };
    await expect(requiredIncompleteP2RecoveryDigest(queryable, runId, 4, {})).resolves.toBeNull();
  });

  it('fails closed above the P2 retry window when a prior P2-only incomplete proof exists', async () => {
    const runRow = {
      repository_id: repositoryId,
      owner,
      repo,
      pr_number: prNumber,
      head_sha: headSha,
      base_sha: baseSha,
      effective_policy_digest: policyDigest,
      effective_config_digest: configDigest,
      authoritative_gate_app_id: appId,
    };
    const proof = recoveryEvidence('review-yeti-gate:v1:' + 'a'.repeat(64))[0];
    const recovered = {
      recovered_generation: 1,
      worker_check_id: proof.checkId,
      external_id: proof.externalId,
      conclusion: proof.conclusion,
      title: proof.title,
      evidence: proof,
    };
    const queryable = { query: async (sql: string) => ({ rows:
      sql.includes('review_generation_recoveries') ? [recovered]
        : sql.includes('incomplete P2 recovery loss guard') ? [] : [runRow] }) };
    await expect(requiredIncompleteP2RecoveryDigest(queryable, runId, 4, {})).rejects.toThrow();
  });

  it('reconstructs a context from the durable ledger and requires its exact admission marker', async () => {
    const fixture = queryableForIncompletePrior();
    const context = await loadFixture(fixture);
    if (!context) throw new Error('expected retained context fixture');
    const proof = recoveryEvidence(fixture.externalId)[0];
    const ledgerRow = {
      recovered_generation: 1,
      worker_check_id: proof.checkId,
      external_id: proof.externalId,
      conclusion: proof.conclusion,
      title: proof.title,
      evidence: proof,
    };
    const queryable = {
      query: async (sql: string) => ({ rows: sql.includes('review_generation_recoveries')
        ? [ledgerRow]
        : sql.includes('incomplete P2 recovery loss guard') ? fixture.sourceRows
          : sql.includes('JOIN review_worker_completions') ? fixture.sourceRows : [fixture.runRow] }),
    };
    await expect(requiredIncompleteP2RecoveryDigest(queryable, runId, 2,
      { incomplete_p2_recovery_digest: context.contextDigest })).resolves.toBe(context.contextDigest);
    await expect(requiredIncompleteP2RecoveryDigest(queryable, runId, 2,
      { incomplete_p2_recovery_digest: '0'.repeat(64) })).rejects.toThrow();
  });

  it('does not silently lose persisted P2 findings if both the marker and generation ledger disappear', async () => {
    const fixture = queryableForIncompletePrior();
    let priorCompletionAndGateRead = false;
    const queryable = {
      query: async (sql: string) => {
        if (sql.includes('review_generation_recoveries')) return { rows: [] };
        if (sql.includes('incomplete P2 recovery loss guard')) {
          priorCompletionAndGateRead = true;
          return { rows: fixture.sourceRows };
        }
        return { rows: [fixture.runRow] };
      },
    };
    await expect(requiredIncompleteP2RecoveryDigest(queryable, runId, 2, {})).rejects.toThrow();
    expect(priorCompletionAndGateRead).toBe(true);
  });

  it('fails closed when a linked incomplete-Gate payload is tampered to remove its findings', async () => {
    const fixture = queryableForIncompletePrior();
    const completion = (fixture.sourceRows[0] as any).payload;
    for (const persona of completion.result.personas) persona.findings = [];
    completion.result.findingCount = 0;
    completion.result.blockingFindingCount = 0;

    const queryable = {
      query: async (sql: string) => ({ rows: sql.includes('review_generation_recoveries') ? []
        : sql.includes('incomplete P2 recovery loss guard') ? fixture.sourceRows : [fixture.runRow] }),
    };
    await expect(requiredIncompleteP2RecoveryDigest(queryable, runId, 2, {})).rejects.toThrow();
  });

  it('fails closed when an incomplete Gate has lost its linked completion row', async () => {
    const fixture = queryableForIncompletePrior();
    const gateWithoutCompletion = {
      ...(fixture.sourceRows[0] as any),
      source_execution_attempt: null,
      content_digest: null,
      payload: null,
      payload_byte_length: null,
      byte_length: null,
    };
    const queryable = {
      query: async (sql: string) => ({ rows: sql.includes('review_generation_recoveries') ? []
        : sql.includes('incomplete P2 recovery loss guard') ? [gateWithoutCompletion] : [fixture.runRow] }),
    };
    await expect(requiredIncompleteP2RecoveryDigest(queryable, runId, 2, {})).rejects.toThrow();
  });

  it('does not hide raw findings carried by a failed persona lane', async () => {
    const fixture = queryableForIncompletePrior();
    const completion = (fixture.sourceRows[0] as any).payload;
    completion.result.personas[0].decision = 'ERROR';
    completion.result.personas[0].status = 'ERROR';
    completion.result.personas[0].errorClass = 'provider_error';
    (fixture.sourceRows[0] as any).gate_evidence.infrastructureFailure = true;
    resealCompletion(fixture);

    const queryable = {
      query: async (sql: string) => ({ rows: sql.includes('review_generation_recoveries') ? []
        : sql.includes('incomplete P2 recovery loss guard') ? fixture.sourceRows : [fixture.runRow] }),
    };
    await expect(requiredIncompleteP2RecoveryDigest(queryable, runId, 2, {})).rejects.toThrow();
  });

  it('does not treat shadow-only payload findings as published Gate findings', async () => {
    const fixture = queryableForIncompletePrior();
    const completion = (fixture.sourceRows[0] as any).payload;
    for (const persona of completion.result.personas) {
      persona.decision = 'APPROVE';
      persona.findings = [];
    }
    completion.result.personas.push({
      id: 'shadow-reviewer',
      decision: 'FINDINGS',
      evidenceSource: 'shadow',
      findings: [{ severity: 'P2', path: 'src/shadow.ts', line: 1,
        title: 'Shadow-only advisory', body: 'This lane never contributed to the published Gate.' }],
    });
    completion.result.findingCount = 0;
    completion.result.blockingFindingCount = 0;
    const digest = resealCompletion(fixture);
    (fixture.sourceRows[0] as any).payload_byte_length = Buffer.byteLength(JSON.stringify(completion), 'utf8');
    (fixture.sourceRows[0] as any).byte_length = Buffer.byteLength(JSON.stringify(completion), 'utf8');
    (fixture.sourceRows[0] as any).gate_worker_result_digest = digest;

    const queryable = {
      query: async (sql: string) => ({ rows: sql.includes('review_generation_recoveries') ? []
        : sql.includes('incomplete P2 recovery loss guard') ? fixture.sourceRows : [fixture.runRow] }),
    };
    await expect(requiredIncompleteP2RecoveryDigest(queryable, runId, 2, {})).resolves.toBeNull();
  });
});
