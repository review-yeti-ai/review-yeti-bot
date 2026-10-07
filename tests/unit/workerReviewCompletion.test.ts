import { describe, expect, it, vi } from 'vitest';
import { findingClaimType, findingFingerprint, findingFingerprintForClaimType } from '../../src/review/findingConvergence';
import { createReviewDecisionV2, REVIEW_SEVERITY_POLICY_V2 } from '../../src/review/reviewDecision';
import { applyGroundedVerificationToPersonas, buildDeterministicCoverageManifest, groundedAffectedContextDigest, GROUNDED_VERIFICATION_LEGACY_VERSION,
  GROUNDED_DEFAULT_BUDGET, GROUNDED_VERIFICATION_VERSION, runIndependentGroundedVerification } from '../../src/review/groundedReviewEngine';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION, GROUNDED_REVIEW_RECEIPT_V2_VERSION,
  GROUNDED_VERIFICATION_V2_VERSION, isValidGroundedCitationV2, sha256Bytes } from '../../src/review/groundedEvidenceV2';
import { canonicalJson, computeArbitration, sha256, type ReviewChangedFile } from '../../src/review/reviewCore';
import { createPublishingProgress } from '../../src/telemetry/publishingProgress';
import { MAX_CHANGED_FILE_PATCH_BYTES } from '../../src/review/reviewEvidenceLimits';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { groundedRelativeImportCandidates } from '../../src/review/groundedContractResolver';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { completeComposedRuntimeResources, ComposedRuntimeResourceObserver } from '../../src/panel/composedResourceReceipt';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import type { RepoFileProvider } from '../../src/panel/panelEngine';
import {
  MAX_COMPLETION_BYTES,
  MAX_TURN_USAGES,
  deriveCanonicalWorkerReviewEvidence,
  deriveStoredCompletionVerdict,
  groundedFindingContinuityDigest,
  storedCompletionShipCompleteReason,
  parseWorkerReviewCompletion,
  type TrustedReviewCoverageContract,
  type WorkerReviewCompletion,
} from '../../src/review/workerReviewCompletion';

const changedFiles = [{
  path: 'src/example.ts',
  patch: '@@ -1,0 +1,2 @@\n+const first = 1;\n+const second = 2;\n',
}];

const expectedCoordinates = {
  runId: `run_${'a'.repeat(32)}`,
  repositoryId: 3210,
  owner: 'exampleorg',
  repo: 'review-yeti-bot',
  prNumber: 42,
  headSha: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
  policyDigest: 'd'.repeat(64),
  configDigest: 'e'.repeat(64),
  executionAttempt: 2,
} as const;

const contract: TrustedReviewCoverageContract = {
  expectedCoordinates,
  expectedPersonaIds: ['security', 'architecture'],
  changedFiles,
  coverageComplete: true,
  quorumSatisfied: true,
};

const lane = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  decision: 'APPROVE',
  findings: [],
  ...overrides,
});

function completion(overrides: Record<string, unknown> = {}): WorkerReviewCompletion {
  return {
    version: 'WorkerReviewCompletion.v1',
    ...expectedCoordinates,
    result: {
      version: 'WorkerReviewResult.v1',
      completedAt: '2026-09-09T12:00:00.000Z',
      personas: [lane('security'), lane('architecture')],
      coverageComplete: true,
      quorumSatisfied: true,
      verdict: 'SHIP',
      findingCount: 0,
      blockingFindingCount: 0,
    },
    ...overrides,
  } as WorkerReviewCompletion;
}

function derive(input: WorkerReviewCompletion = completion(), trusted = contract) {
  return deriveCanonicalWorkerReviewEvidence(input, trusted);
}

function expectInvalid(result: ReturnType<typeof derive>, message: RegExp): void {
  expect(result.valid).toBe(false);
  if (result.valid) throw new Error('expected invalid worker review evidence');
  expect(result.reason).toBe('invalid-evidence');
  expect(result.message).toMatch(message);
}

function thrownComposedFailure(): WorkerReviewCompletion {
  return completion({ result: {
    version: 'WorkerReviewResult.v1', completedAt: completion().result.completedAt,
    personas: contract.expectedPersonaIds.map((id) => lane(id, {
      decision: 'ERROR', status: 'ERROR', errorClass: 'rate_limit',
    })),
    coverageComplete: true, quorumSatisfied: false,
    failureDiagnostics: { reason: 'lane_infrastructure_incomplete', recoverableIncompletePanel: true,
      logTail: 'lane panel failed: 429' },
  } });
}

const composedContract: TrustedReviewCoverageContract = {
  ...contract, reviewEngine: 'composed', composedChangedPaths: ['src/example.ts'], composedMaxTasks: 8,
};
const v2Contract: TrustedReviewCoverageContract = { ...contract, reviewDecisionPolicy: REVIEW_SEVERITY_POLICY_V2,
  groundedVerifierRouting: { primaryModel: 'test-model' } };

function withDecision(input: WorkerReviewCompletion, overrides: Record<string, unknown> = {},
  trustedChangedFiles: readonly ReviewChangedFile[] = changedFiles): WorkerReviewCompletion {
  const findings = input.result.personas.flatMap((persona) => persona.findings);
  const candidatesByFingerprint = new Map<string, typeof findings[number]>();
  const severityRank: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, NIT: 4 };
  for (const finding of findings) {
    const fingerprint = findingFingerprint(finding);
    const previous = candidatesByFingerprint.get(fingerprint);
    if (!previous || (severityRank[finding.severity] ?? 5) < (severityRank[previous.severity] ?? 5)
      || ((severityRank[finding.severity] ?? 5) === (severityRank[previous.severity] ?? 5)
        && (finding.line ?? Number.MAX_SAFE_INTEGER) < (previous.line ?? Number.MAX_SAFE_INTEGER))) {
      candidatesByFingerprint.set(fingerprint, finding);
    }
  }
  const counts = { p0Count: 0, p1Count: 0, p2Count: 0, p3Count: 0, nitCount: 0 };
  for (const finding of findings) {
    if (finding.severity === 'P0') counts.p0Count++;
    else if (finding.severity === 'P1') counts.p1Count++;
    else if (finding.severity === 'P2') counts.p2Count++;
    else if (finding.severity === 'P3') counts.p3Count++;
    else if (finding.severity === 'NIT') counts.nitCount++;
  }
  const reviewDecision = createReviewDecisionV2({
    schemaVersion: 'review-yeti-decision.v2', policyVersion: REVIEW_SEVERITY_POLICY_V2,
    policyDigest: expectedCoordinates.policyDigest,
    coverageComplete: input.result.coverageComplete,
    quorumSatisfied: input.result.quorumSatisfied,
    infrastructureFailure: input.result.personas.some((persona) => persona.decision === 'ERROR'),
    expectedLanes: 2,
    completedLanes: input.result.personas.filter((persona) => persona.decision !== 'ERROR').length,
    counts, ...overrides,
  });
  const coverage = buildDeterministicCoverageManifest(trustedChangedFiles);
  const outcomes = [...candidatesByFingerprint.values()].map((finding) => {
    const claimType = findingClaimType({ path: finding.path, title: finding.title });
    const fingerprint = findingFingerprintForClaimType({ path: finding.path, title: finding.title }, claimType);
    const path = finding.path!;
    const currentAffectedContextDigest = groundedAffectedContextDigest(finding, trustedChangedFiles, [path]);
    const sourcePresence = trustedChangedFiles.find((file) => file.path === path)?.sourcePresence;
    const evidence = {
      violatedInvariant: 'The changed source violates the stated contract.',
      failurePath: 'The changed path reaches the contract without a guard.',
      benignCheck: 'The source contains no relevant guard.',
      changeConnection: 'The admitted patch exposes the behavior.',
      citations: [
        { id: `head:${path}`, path, side: 'head', sha: expectedCoordinates.headSha,
          ...(sourcePresence?.absentSide === 'head' ? { presence: 'absent' as const } : {}) },
        { id: `base:${path}`, path, side: 'base', sha: expectedCoordinates.baseSha,
          ...(sourcePresence?.absentSide === 'base' ? { presence: 'absent' as const } : {}) },
        { id: `diff:${path}`, path, side: 'diff', sha: null },
      ],
      causalDiffPaths: [path],
    };
    return { fingerprint, path, line: finding.line!, title: finding.title!, claimType,
      severity: finding.severity as 'P0' | 'P1' | 'P2' | 'P3' | 'NIT', status: 'confirmed' as const,
      affectedContextDigest: currentAffectedContextDigest, relatedDiffPaths: [path],
      evidenceDigest: sha256(canonicalJson({ fingerprint, currentAffectedContextDigest, evidence })), evidence };
  });
  const groundedReview = {
    version: 'GroundedReviewReceipt.v1' as const,
    coverage: { digest: coverage.digest, regionCount: coverage.regions.length, assignmentCount: coverage.assignments.length,
      coveredRegionCount: coverage.coveredRegionIds.length, complete: coverage.complete, omissions: coverage.omissions },
    history: { status: 'unavailable' as const, eventCount: 0, findingCount: 0, loadedEventCount: 0, loadedFindingCount: 0,
      eventOmittedCount: 0, findingOmittedCount: 0, legacyOmittedCount: 0, omissions: ['unit fixture has no history'],
      memorySources: { honcho: 'unavailable' as const, mcp: 'unavailable' as const },
      verificationWrites: { attempted: 0, recorded: 0, failed: 0 } },
    verification: { version: GROUNDED_VERIFICATION_LEGACY_VERSION, candidates: outcomes.length, confirmed: outcomes.length,
      contradicted: 0, insufficient: 0, unverifiedBlockerCount: 0, coverageComplete: coverage.complete, calls: 0,
      budget: GROUNDED_DEFAULT_BUDGET, outcomes },
  };
  return { ...input, result: { ...input.result, reviewDecision, groundedReview } } as WorkerReviewCompletion;
}

describe('composed infrastructure failure without a returned task plan', () => {
  it.each(['rate_limit', 'transport', 'provider_error', 'timeout'] as const)(
    'accepts only failing %s evidence and cannot reuse it as a stored successful review', (errorClass) => {
      const input = thrownComposedFailure();
      for (const persona of input.result.personas) persona.errorClass = errorClass;
      expect(derive(input, composedContract)).toMatchObject({ valid: true, evidence: {
        verdict: 'BLOCK', infrastructureFailure: true, completedLanes: 0, quorumSatisfied: false,
        p0Count: 0, p1Count: 0, p2Count: 0,
      } });
      expect(deriveStoredCompletionVerdict(input.result, {
        expectedLanes: 2, coverageComplete: true, reviewEngine: 'composed',
      })).toBeNull();
    },
  );

  it.each([
    ['missing lane', (input: WorkerReviewCompletion) => { input.result.personas.pop(); }],
    ['duplicate lane', (input: WorkerReviewCompletion) => { input.result.personas[1].id = 'security'; }],
    ['unknown lane', (input: WorkerReviewCompletion) => { input.result.personas[1].id = 'unknown'; }],
    ['approval', (input: WorkerReviewCompletion) => { input.result.personas[0].decision = 'APPROVE'; }],
    ['missing error status', (input: WorkerReviewCompletion) => { input.result.personas[0].status = undefined; }],
    ['shadow lane', (input: WorkerReviewCompletion) => { input.result.personas[0].evidenceSource = 'shadow'; }],
    ['finding', (input: WorkerReviewCompletion) => { input.result.personas[0].findings.push({
      severity: 'P1', path: 'src/example.ts', line: 1, title: 'Defect', body: 'Must remain blocking.',
    }); }],
    ['missing diagnostics', (input: WorkerReviewCompletion) => { input.result.failureDiagnostics = undefined; }],
    ['non-recoverable diagnostics', (input: WorkerReviewCompletion) => {
      input.result.failureDiagnostics!.recoverableIncompletePanel = false;
    }],
    ['unreadable coverage', (input: WorkerReviewCompletion) => { input.result.coverageComplete = false; }],
    ['claimed quorum', (input: WorkerReviewCompletion) => { input.result.quorumSatisfied = true; }],
    ['claimed SHIP', (input: WorkerReviewCompletion) => { input.result.verdict = 'SHIP'; }],
    ['wrong identity', (input: WorkerReviewCompletion) => { input.headSha = 'f'.repeat(40); }],
    ['invalid supplied plan', (input: WorkerReviewCompletion) => { input.result.taskPlan = [{
      id: 'task-a', dimension: 'architecture', paths: ['unrelated.ts'], question: 'Question?', rationale: 'Reason.',
    }]; }],
  ] as const)('refuses %s rather than treating it as a planless infrastructure failure', (_label, mutate) => {
    const input = thrownComposedFailure();
    mutate(input);
    expectInvalid(derive(input, composedContract), /./u);
  });

  it.each(['auth', 'contract', 'internal_error', 'malformed_output', 'budget_exhausted'] as const)(
    'refuses non-infrastructure class %s', (errorClass) => {
      const input = thrownComposedFailure();
      input.result.personas[0].errorClass = errorClass;
      expectInvalid(derive(input, composedContract), /missing its trusted task plan/u);
    },
  );

  it('retains trusted coverage and effective-path requirements', () => {
    expectInvalid(derive(thrownComposedFailure(), { ...composedContract, coverageComplete: false }), /missing/u);
    expectInvalid(derive(thrownComposedFailure(), { ...composedContract, composedChangedPaths: [] }), /missing/u);
  });
});

describe('WorkerReviewCompletion.v1', () => {
  it('accepts optional classification accounting without treating it as coverage or verdict authority', () => {
    const input = completion();
    input.result.deletionClassification = { version: 'deletion-classification.v1', digest: 'f'.repeat(64),
      status: 'partial', totalFiles: 64, classifiedFiles: 40, unresolvedFiles: 24, totalGroups: 8 };
    const parsed = parseWorkerReviewCompletion(input);
    expect(derive(parsed)).toEqual(derive(completion()));
    const incomplete = completion({ result: { ...input.result, coverageComplete: false, verdict: undefined } });
    expect(derive(incomplete)).toMatchObject({ valid: true, evidence: { coverageComplete: false } });
    expect(() => parseWorkerReviewCompletion({ ...input, result: { ...input.result, deletionClassification: {
      ...input.result.deletionClassification, unresolvedFiles: 0,
    } } })).toThrow();
    expect(() => parseWorkerReviewCompletion({ ...input, result: { ...input.result, deletionClassification: {
      ...input.result.deletionClassification, totalGroups: 65,
    } } })).toThrow();
  });

  it('validates composed task coverage and IDs from the trusted diff', () => {
    const taskPlan = [{ id: 'task-a', dimension: 'architecture' as const, paths: ['src/example.ts'],
      question: 'Could this change regress behavior?', rationale: 'The source changed.' }];
    const composed = completion({ result: { ...completion().result,
      personas: [lane('task-a')], taskPlan,
    } });
    const trusted = { ...contract, reviewEngine: 'composed' as const,
      composedChangedPaths: ['src/example.ts'], composedMaxTasks: 8 };
    const derived = derive(composed, trusted);
    expect(derived).toMatchObject({ valid: true,
      evidence: { reviewEngine: 'composed', expectedLanes: 1, completedLanes: 1, verdict: 'SHIP' } });
    if (!derived.valid) throw new Error('expected valid composed evidence');
    const digest = 'a'.repeat(64);
    const gate = { worker_result_digest: digest, evidence: derived.evidence,
      decision: { status: 'success', eligible: true, reason: 'clean-review' } };
    expect(storedCompletionShipCompleteReason(composed.result, gate, digest)).toBeNull();
    expect(storedCompletionShipCompleteReason(composed.result, {
      ...gate, evidence: { ...derived.evidence, reviewEngine: undefined },
    }, digest)).toBe('rederived-invalid');
    expectInvalid(derive(composed, contract), /panel completion cannot claim/u);
    expectInvalid(derive({ ...composed, result: { ...composed.result, taskPlan: undefined } }, trusted),
      /missing its trusted task plan/u);
    expectInvalid(derive({ ...composed, result: { ...composed.result,
      taskPlan: [{ ...taskPlan[0], paths: ['docs/unrelated.md'] }],
    } }, trusted), /does not cover the trusted changed files/u);
    expectInvalid(derive({ ...composed, result: { ...composed.result,
      taskPlan: Array.from({ length: 5 }, (_, index) => ({ ...taskPlan[0], id: `task-${index}` })),
    } }, { ...trusted, composedMaxTasks: 4 }), /too_many_tasks/u);
    expectInvalid(derive({ ...composed, result: { ...composed.result,
      personas: [{ id: 'not-in-plan', decision: 'APPROVE', findings: [] }],
    } }, trusted), /unknown persona lane/u);
  });

  it('requires and rebinds current composed resource receipt to prepared config and delivered paths', () => {
    const task = { id: 'task-a', dimension: 'architecture' as const, paths: ['src/example.ts'],
      question: 'Could this change regress behavior?', rationale: 'The source changed.' };
    const patchText = changedFiles[0]!.patch!;
    const sourceDelivery = { version: 'TaskSourceDelivery.v1' as const, taskId: task.id,
      headSha: expectedCoordinates.headSha, baseSha: expectedCoordinates.baseSha,
      contextDigests: [sha256('task-context')], complete: true,
      files: [{ path: 'src/example.ts', patchDigest: sha256(patchText), totalChars: patchText.length,
        ranges: [[0, patchText.length] as [number, number]], inline: true }] };
    const prepared = resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({
      review_engine: 'composed', severity_policy: REVIEW_SEVERITY_POLICY_V2, personas: ['security'],
    }) }, { baseUrl: 'https://gateway.example.invalid', apiKey: 'test', model: 'test-model' });
    const configuration = prepared.review_configuration_receipt;
    if (!configuration) throw new Error('test effective configuration receipt was not produced');
    const observer = new ComposedRuntimeResourceObserver({ configDigest: expectedCoordinates.configDigest, configuration });
    observer.configureBudget({ configuredTotalTurns: 100, investigationTurns: 88, verificationReserveTurns: 12 });
    observer.setPlan([task]);
    observer.markTaskStarted(task.id);
    observer.markTaskOutcome(task.id, 'completed', sourceDelivery);
    const observation = observer.snapshot('terminal');
    if (!observation) throw new Error('test composed resource observation was not produced');
    const resources = completeComposedRuntimeResources({ observation, configDigest: expectedCoordinates.configDigest, verifierCalls: 0 });
    if (!resources) throw new Error('test worker resource receipt was not produced');

    const input = completion({ result: { ...completion().result, personas: [lane(task.id, { sourceDelivery })], taskPlan: [task] } });
    const v2 = withDecision(input, { expectedLanes: 1, completedLanes: 1 });
    const legacyReceipt = v2.result.groundedReview!;
    v2.result.groundedReview = {
      version: GROUNDED_REVIEW_RECEIPT_V2_VERSION,
      semanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
      coverage: legacyReceipt.coverage,
      history: legacyReceipt.history,
      verification: { version: GROUNDED_VERIFICATION_V2_VERSION,
        semanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
        candidates: 0, confirmed: 0, contradicted: 0, insufficient: 0, unverifiedBlockerCount: 0,
        coverageComplete: legacyReceipt.coverage.complete, calls: 0, budget: GROUNDED_DEFAULT_BUDGET, outcomes: [] },
    } as any;
    v2.result.composedResources = resources;
    const trusted: TrustedReviewCoverageContract = { ...v2Contract, reviewEngine: 'composed',
      composedChangedPaths: ['src/example.ts'], composedMaxTasks: 8, composedEffectiveConfiguration: configuration };
    expect(derive(v2, trusted)).toMatchObject({ valid: true, evidence: { reviewEngine: 'composed',
      coverageComplete: true, verdict: 'SHIP' } });

    const missing = structuredClone(v2);
    delete missing.result.composedResources;
    expectInvalid(derive(missing, trusted), /missing its worker-stage runtime resource receipt/u);
    const unbound = structuredClone(v2);
    unbound.result.composedResources!.configDigest = { value: null,
      unavailableReason: 'prepared digest was not available' } as any;
    expectInvalid(derive(unbound, trusted), /not bound to the service-prepared effective configuration/u);
    const forgedCoverage = structuredClone(v2);
    forgedCoverage.result.composedResources!.coverage.investigatedPaths.sha256 = 'f'.repeat(64);
    expectInvalid(derive(forgedCoverage, trusted), /path coverage disagrees with the trusted plan/u);
  });

  it('treats a composed task list as one reviewer for blocking thresholds', () => {
    const tasks = Array.from({ length: 7 }, (_, index) => ({ id: `task-${index + 1}`,
      dimension: 'architecture' as const, paths: ['src/example.ts'],
      question: 'Could this change regress behavior?', rationale: 'The source changed.' }));
    const personas = tasks.map((task, index) => ({ id: task.id,
      decision: index < 3 ? 'FINDINGS' as const : 'APPROVE' as const,
      findings: index < 3 ? [{ severity: 'P1' as const, path: 'src/example.ts',
        line: index + 1, title: `Defect ${index + 1}`, body: `Distinct defect ${index + 1}.` }] : [],
    }));
    const review = completion({ result: { ...completion().result, personas, taskPlan: tasks,
      verdict: undefined, findingCount: undefined, blockingFindingCount: undefined } });
    const derived = derive(review, { ...contract, reviewEngine: 'composed',
      composedChangedPaths: ['src/example.ts'], composedMaxTasks: 8,
      changedFiles: [{ path: 'src/example.ts', patch: '@@ -1,0 +1,3 @@\n+a\n+b\n+c\n' }],
    });
    expect(derived).toMatchObject({ valid: true, evidence: { verdict: 'BLOCK', expectedLanes: 7 } });
    expect(deriveStoredCompletionVerdict(review.result, {
      expectedLanes: 7, coverageComplete: true, reviewEngine: 'composed',
    })?.verdict).toBe('BLOCK');
    expect(deriveStoredCompletionVerdict(review.result, {
      expectedLanes: 7, coverageComplete: true,
    })).toBeNull();
    expect(deriveStoredCompletionVerdict({ ...review.result, taskPlan: undefined }, {
      expectedLanes: 7, coverageComplete: true,
    })?.verdict).toBe('FIX_FIRST');
    expect(deriveStoredCompletionVerdict(review.result, {
      expectedLanes: 6, coverageComplete: true, reviewEngine: 'composed',
    })).toBeNull();
  });
  it('derives clean evidence from complete persona findings without trusting the worker verdict', () => {
    const result = derive();

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.canonical.verdict).toBe('SHIP');
    expect(result.canonical.quorumSatisfied).toBe(true);
    expect(result.evidence).toMatchObject({
      verdict: 'SHIP',
      coverageComplete: true,
      quorumSatisfied: true,
      infrastructureFailure: false,
      expectedLanes: 2,
      completedLanes: 2,
      p0Count: 0,
      p1Count: 0,
    });
  });

  it('derives canonical blocking evidence for findings', () => {
    const result = derive(completion({
      result: {
        ...completion().result,
        personas: [
          lane('security', {
            decision: 'FINDINGS',
            findings: [{ severity: 'P1', path: 'src/example.ts', line: 1, title: 'Unsafe change', body: 'This needs review.' }],
          }),
          lane('architecture'),
        ],
        verdict: 'FIX_FIRST',
        findingCount: 1,
        blockingFindingCount: 1,
      },
    }));

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.canonical.verdict).toBe('FIX_FIRST');
    expect(result.evidence.p1Count).toBe(1);
    expect(result.evidence.quorumSatisfied).toBe(true);
  });

  it('does not let a worker SHIP or count override canonical findings', () => {
    const result = derive(completion({
      result: {
        ...completion().result,
        personas: [
          lane('security', {
            decision: 'FINDINGS',
            findings: [{ severity: 'P1', path: 'src/example.ts', line: 1, title: 'Unsafe change', body: 'This needs review.' }],
          }),
          lane('architecture'),
        ],
        verdict: 'SHIP',
        findingCount: 0,
        blockingFindingCount: 0,
      },
    }));

    expectInvalid(result, /disagrees with canonical/u);
  });

  it('rejects missing, duplicate, and unknown persona lanes safely', () => {
    const missing = derive(completion({ result: { ...completion().result, personas: [lane('security')], verdict: 'BLOCK' } }));
    expect(missing.valid).toBe(true);
    if (missing.valid) {
      expect(missing.canonical.status).toBe('INCOMPLETE_REVIEW');
      expect(missing.evidence.quorumSatisfied).toBe(false);
      expect(missing.evidence.completedLanes).toBe(1);
    }

    const duplicate = derive(completion({ result: { ...completion().result, personas: [lane('security'), lane('security')] } }));
    expectInvalid(duplicate, /duplicate/u);

    const unknown = derive(completion({ result: { ...completion().result, personas: [lane('security'), lane('testing')] } }));
    expectInvalid(unknown, /unknown/u);
  });

  it('marks lane errors as infrastructure failure and never as success', () => {
    const result = derive(completion({
      result: {
        ...completion().result,
        personas: [lane('security', { decision: 'ERROR', status: 'ERROR', errorClass: 'timeout' }), lane('architecture')],
        verdict: 'BLOCK',
        findingCount: 0,
        blockingFindingCount: 0,
      },
    }));

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.canonical.verdict).toBe('BLOCK');
    expect(result.evidence.infrastructureFailure).toBe(true);
    expect(result.evidence.quorumSatisfied).toBe(false);
  });

  it('rejects raw error transcripts and retains only the bounded error class', () => {
    const transcript = 'provider response included secret=do-not-retain';
    const rawError = completion({
      result: {
        ...completion().result,
        personas: [lane('security', { decision: 'ERROR', status: 'ERROR', error: transcript }), lane('architecture')],
      },
    });

    let thrown: unknown;
    try {
      parseWorkerReviewCompletion(rawError);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(transcript);
    expect(() => parseWorkerReviewCompletion(rawError)).toThrow(/invalid WorkerReviewCompletion.*'error'/u);

    const safe = parseWorkerReviewCompletion(completion({
      result: {
        ...completion().result,
        personas: [lane('security', { decision: 'ERROR', status: 'ERROR', errorClass: 'timeout' }), lane('architecture')],
        verdict: 'BLOCK',
      },
    }));
    expect(safe.result.personas[0]).toMatchObject({ errorClass: 'timeout' });
    expect(safe.result.personas[0]).not.toHaveProperty('error');
  });

  it('accepts only bounded failure diagnostics on the typed completion envelope', () => {
    const diagnostic = { reason: 'provider_rate_limited', providerStatus: 429, logTail: 'HTTP 429 [REDACTED]' };
    const parsed = parseWorkerReviewCompletion(completion({
      result: {
        ...completion().result,
        personas: [lane('security', { decision: 'ERROR', status: 'ERROR', errorClass: 'rate_limit' }), lane('architecture')],
        coverageComplete: false, quorumSatisfied: false, failureDiagnostics: diagnostic,
      },
    }));
    expect(parsed.result.failureDiagnostics).toEqual(diagnostic);
    expect(() => parseWorkerReviewCompletion(completion({
      result: { ...completion().result, failureDiagnostics: { ...diagnostic, providerStatus: 99 } },
    }))).toThrow(/providerStatus/u);
  });

  it('preserves incomplete coverage and quorum failure as non-success evidence', () => {
    const coverage = derive(completion({ result: { ...completion().result, coverageComplete: false, verdict: 'BLOCK' } }));
    expect(coverage.valid).toBe(true);
    if (coverage.valid) {
      expect(coverage.evidence.coverageComplete).toBe(false);
      expect(coverage.canonical.status).toBe('INCOMPLETE_REVIEW');
    }

    const quorum = derive(completion({ result: { ...completion().result, quorumSatisfied: false, verdict: 'SHIP' } }));
    expect(quorum.valid).toBe(true);
    if (quorum.valid) expect(quorum.evidence.quorumSatisfied).toBe(false);

    const trustedFailure = derive(completion(), { ...contract, coverageComplete: false });
    expect(trustedFailure.valid).toBe(false);
    expect(trustedFailure.evidence?.coverageComplete).toBe(false);
  });

  it('rejects invalid or unanchored finding evidence', () => {
    const invalid = derive(completion({
      result: {
        ...completion().result,
        personas: [
          lane('security', {
            decision: 'FINDINGS',
            findings: [{ severity: 'P1', path: '../secret.ts', line: 1, title: 'Bad path', body: 'Not in the review.' }],
          }),
          lane('architecture'),
        ],
      },
    }));

    expectInvalid(invalid, /invalid findings/u);
  });

  it('rejects schema, coordinate, and authoritative-field violations', () => {
    expect(() => parseWorkerReviewCompletion({ ...completion(), headSha: 'not-a-sha' })).toThrow(/invalid WorkerReviewCompletion/u);
    expect(() => parseWorkerReviewCompletion({ ...completion(), repositoryId: 0 })).toThrow(/invalid WorkerReviewCompletion/u);
    expect(() => parseWorkerReviewCompletion({ ...completion(), checkId: 123 })).toThrow(/invalid WorkerReviewCompletion/u);
    expect(() => parseWorkerReviewCompletion({ ...completion(), result: { ...completion().result, conclusion: 'success' } })).toThrow(/invalid WorkerReviewCompletion/u);
    expect(() => parseWorkerReviewCompletion({ ...completion(), result: { ...completion().result, url: 'https://example.test' } })).toThrow(/invalid WorkerReviewCompletion/u);
    expect(() => parseWorkerReviewCompletion({ ...completion(), override: { verdict: 'SHIP' } })).toThrow(/invalid WorkerReviewCompletion/u);
    expect(() => parseWorkerReviewCompletion({
      ...completion(),
      result: { ...completion().result, version: 'ReviewYetiPublishingReview.v1' },
    })).toThrow(/invalid WorkerReviewCompletion/u);
    for (const [field, value] of [['required', false], ['providerId', 'provider'], ['model', 'model']] as const) {
      expect(() => parseWorkerReviewCompletion({
        ...completion(),
        result: { ...completion().result, personas: [lane('security', { [field]: value }), lane('architecture')] },
      })).toThrow(/invalid WorkerReviewCompletion/u);
    }

    const mismatchedCoordinates = derive(completion({ headSha: 'f'.repeat(40) }));
    expectInvalid(mismatchedCoordinates, /coordinates do not match/u);
  });

  it.each([
    ['runId', `run_${'f'.repeat(32)}`],
    ['repositoryId', 3211],
    ['owner', 'other-owner'],
    ['repo', 'other-repo'],
    ['prNumber', 43],
    ['headSha', 'f'.repeat(40)],
    ['baseSha', 'f'.repeat(40)],
    ['policyDigest', 'f'.repeat(64)],
    ['configDigest', 'f'.repeat(64)],
    ['executionAttempt', 3],
  ] as const)('rejects a trusted coordinate mismatch for %s', (field, value) => {
    expectInvalid(derive(completion({ [field]: value })), /coordinates do not match/u);
  });

  it('does not accept the current metrics-only publishing receipt as review evidence', () => {
    const metricsOnly = completion({
      result: {
        ...completion().result,
        personas: [{ id: 'security', decision: 'APPROVE', findingsCount: 0 }],
      },
    });
    expect(() => parseWorkerReviewCompletion(metricsOnly)).toThrow(/findings/u);
  });

  it('rejects oversized payloads before schema processing', () => {
    const oversized = { ...completion(), extra: 'x'.repeat(MAX_COMPLETION_BYTES) };
    expect(() => parseWorkerReviewCompletion(oversized)).toThrow(/exceeds/u);
  });

  it('enforces per-field text bounds independently from the total UTF-8 byte bound', () => {
    const tooLong = completion({
      result: {
        ...completion().result,
        personas: [lane('security', {
          decision: 'FINDINGS',
          findings: [{ severity: 'P2', path: 'src/example.ts', line: 1, title: 'Bounded', body: 'x'.repeat(16_001) }],
        }), lane('architecture')],
      },
    });
    expect(() => parseWorkerReviewCompletion(tooLong)).toThrow(/invalid WorkerReviewCompletion/u);

    const boundedMultibyte = 'é'.repeat(16_000);
    const parsed = parseWorkerReviewCompletion(completion({
      result: {
        ...completion().result,
        personas: [lane('security', {
          decision: 'FINDINGS',
          findings: [{ severity: 'P2', path: 'src/example.ts', line: 1, title: 'Bounded', body: boundedMultibyte }],
        }), lane('architecture')],
      },
    }));
    expect(parsed.result.personas[0]?.findings[0]?.body).toHaveLength(16_000);
  });

  it('rejects an under-specified trusted contract rather than assuming review coverage', () => {
    expect(() => derive(completion(), { ...contract, expectedPersonaIds: [] })).toThrow(/expected persona IDs/u);
    expect(() => derive(completion(), { ...contract, expectedPersonaIds: ['security', 'security'] })).toThrow(/unique/u);
    expect(() => derive(completion(), { ...contract, changedFiles: [] })).toThrow(/one or more/u);
    expectInvalid(
      derive(completion(), { ...contract, expectedCoordinates: { ...expectedCoordinates, configDigest: 'f'.repeat(64) } }),
      /coordinates do not match/u,
    );
  });

  it('accepts the shared per-file patch limit and rejects the next UTF-8 byte', () => {
    const atLimit = { ...contract, changedFiles: [{ path: 'src/limit.ts', patch: 'x'.repeat(MAX_CHANGED_FILE_PATCH_BYTES) }] };
    expect(derive(completion(), atLimit).valid).toBe(true);
    expect(() => derive(completion(), { ...atLimit, changedFiles: [{ ...atLimit.changedFiles[0],
      patch: `${atLimit.changedFiles[0].patch}x` }] })).toThrow(/patch exceeds its bound/u);
  });

  describe('optional per-persona telemetry (Stage 0: turn-accumulated usage)', () => {
    // Additive-only: `personaSchema` is `.strict()`, so this whole block exists to prove the new
    // field is genuinely optional (no version bump / dispatcher change needed) rather than merely
    // undocumented-but-accepted.
    const turnUsage = (overrides: Record<string, unknown> = {}) => ({
      turn: 1, kind: 'final', promptTokens: 100, completionTokens: 20, totalTokens: 120,
      cachedTokens: 30, costUSD: 0.001, model: 'claude-5-sonnet', durationMs: 250,
      ...overrides,
    });

    it('parses a persona that carries full per-turn telemetry', () => {
      const parsed = parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [
            lane('security', {
              telemetry: {
                model: 'claude-5-sonnet',
                turnsCount: 3,
                toolTurns: 1,
                correctionTurns: 1,
                promptTokens: 450,
                completionTokens: 75,
                totalTokens: 525,
                cachedTokens: 80,
                costUSD: 0.0042,
                durationMs: 900,
                turnUsages: [
                  turnUsage({ turn: 1, kind: 'tool' }),
                  turnUsage({ turn: 2, kind: 'correction', cachedTokens: 0 }),
                  turnUsage({ turn: 3, kind: 'final' }),
                ],
              },
            }),
            lane('architecture'),
          ],
        },
      }));
      expect(parsed.result.personas[0]?.telemetry).toMatchObject({
        turnsCount: 3, toolTurns: 1, correctionTurns: 1, totalTokens: 525, cachedTokens: 80,
      });
      expect(parsed.result.personas[0]?.telemetry?.turnUsages).toHaveLength(3);
      expect(parsed.result.personas[0]?.telemetry?.turnUsages?.map((t) => t.kind)).toEqual(['tool', 'correction', 'final']);
    });

    it('parses telemetry.toolCalls -- the count crossing the completion boundary (#862 gap)', () => {
      // Before this change `toolCalls` was tracked inside the panel engine (the array declared
      // in `panelEngine.ts`) but had no field on `personaTelemetrySchema`, so it never reached the
      // completion payload -- nothing downstream could read it.
      const parsed = parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', { telemetry: { toolCalls: 7 } }), lane('architecture')],
        },
      }));
      expect(parsed.result.personas[0]?.telemetry).toEqual({ toolCalls: 7 });
    });

    it('rejects a negative toolCalls count', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', { telemetry: { toolCalls: -1 } }), lane('architecture')],
        },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });

    it('still parses a persona with no telemetry field at all -- backward compatible, no version bump', () => {
      // This is the pre-Stage-0 shape every existing caller (and every OTHER test in this file)
      // sends. `telemetry` must be optional, not merely tolerated when present.
      const parsed = parseWorkerReviewCompletion(completion());
      expect(parsed.result.personas[0]).not.toHaveProperty('telemetry');
      expect(parsed.version).toBe('WorkerReviewCompletion.v1');
    });

    it('parses telemetry with only a subset of its fields populated', () => {
      const parsed = parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', { telemetry: { model: 'claude-5-sonnet', turnsCount: 1 } }), lane('architecture')],
        },
      }));
      expect(parsed.result.personas[0]?.telemetry).toEqual({ model: 'claude-5-sonnet', turnsCount: 1 });
    });

    it('rejects an unrecognized key on the telemetry object (still .strict())', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', { telemetry: { turnsCount: 1, notARealField: true } }), lane('architecture')],
        },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });

    it('rejects an unrecognized key on a turnUsages entry', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', {
            telemetry: { turnUsages: [{ ...turnUsage(), providerRawResponse: 'do-not-leak-this' }] },
          }), lane('architecture')],
        },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });

    it('rejects a turnUsages entry with an invalid kind', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', {
            telemetry: { turnUsages: [turnUsage({ kind: 'not-a-real-kind' })] },
          }), lane('architecture')],
        },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });

    it('rejects a negative token count inside telemetry', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', { telemetry: { promptTokens: -1 } }), lane('architecture')],
        },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });

    it('accepts exactly MAX_TURN_USAGES entries and rejects one more (dead-guard check)', () => {
      // `MAX_TURN_USAGES`'s doc comment says it exists to reject an unbounded `turnUsages` array
      // across the worker boundary. Every other fixture in this file carries at most 3 entries, so
      // without this pair, dropping `.max(MAX_TURN_USAGES)` entirely (or raising it to `Infinity`)
      // would leave the whole suite green -- a guard no test can distinguish from its own absence.
      const atLimit = Array.from({ length: MAX_TURN_USAGES }, (_, index) => turnUsage({ turn: index + 1 }));
      const parsed = parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', { telemetry: { turnUsages: atLimit } }), lane('architecture')],
        },
      }));
      expect(parsed.result.personas[0]?.telemetry?.turnUsages).toHaveLength(MAX_TURN_USAGES);

      const overLimit = Array.from({ length: MAX_TURN_USAGES + 1 }, (_, index) => turnUsage({ turn: index + 1 }));
      expect(() => parseWorkerReviewCompletion(completion({
        result: {
          ...completion().result,
          personas: [lane('security', { telemetry: { turnUsages: overLimit } }), lane('architecture')],
        },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });
  });

  describe('optional panel wall clock (Stage 0: closes the #862 measurement gap)', () => {
    // #862 added `panelWallClockMs` to `PanelResult`, but `resultSchema` had no field for it, so
    // it never reached the completion payload. This block proves the additive fix: the field
    // parses when present, is genuinely optional (no version bump), and stays bounded.
    it('parses a result that carries panelWallClockMs', () => {
      const parsed = parseWorkerReviewCompletion(completion({
        result: { ...completion().result, panelWallClockMs: 4_200 },
      }));
      expect(parsed.result.panelWallClockMs).toBe(4_200);
    });

    it('still parses a result with no panelWallClockMs -- backward compatible, no version bump', () => {
      const parsed = parseWorkerReviewCompletion(completion());
      expect(parsed.result).not.toHaveProperty('panelWallClockMs');
    });

    it('rejects a negative panelWallClockMs', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: { ...completion().result, panelWallClockMs: -1 },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });

    it('rejects a non-integer panelWallClockMs', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: { ...completion().result, panelWallClockMs: 4_200.5 },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });
  });

  describe('optional per-persona evidenceSource (shadow-mode review engine comparison)', () => {
    // Additive-only, same contract as the telemetry block above: `personaSchema` is `.strict()`,
    // so this proves `evidenceSource` is genuinely optional (no version bump / dispatcher change
    // needed) rather than merely undocumented-but-accepted.
    it('parses a persona tagged evidenceSource: panel', () => {
      const parsed = parseWorkerReviewCompletion(completion({
        result: { ...completion().result, personas: [lane('security', { evidenceSource: 'panel' }), lane('architecture')] },
      }));
      expect(parsed.result.personas[0]?.evidenceSource).toBe('panel');
    });

    it('parses a persona tagged evidenceSource: shadow', () => {
      const parsed = parseWorkerReviewCompletion(completion({
        result: { ...completion().result, personas: [lane('security', { evidenceSource: 'shadow' }), lane('architecture')] },
      }));
      expect(parsed.result.personas[0]?.evidenceSource).toBe('shadow');
    });

    it('still parses a persona with no evidenceSource field at all -- backward compatible, no version bump', () => {
      // This is the shape every pre-shadow-mode caller (and every OTHER test in this file) sends.
      // `evidenceSource` must be optional, not merely tolerated when present.
      const parsed = parseWorkerReviewCompletion(completion());
      expect(parsed.result.personas[0]).not.toHaveProperty('evidenceSource');
      expect(parsed.version).toBe('WorkerReviewCompletion.v1');
    });

    it('rejects an evidenceSource value outside the panel/shadow enum', () => {
      expect(() => parseWorkerReviewCompletion(completion({
        result: { ...completion().result, personas: [lane('security', { evidenceSource: 'composed' }), lane('architecture')] },
      }))).toThrow(/invalid WorkerReviewCompletion/u);
    });
  });
});

it('native completion parsing forwards optional observations without approving prepared ERROR personas',()=>{
  const operationalTelemetry=createPublishingProgress({runId:'run-native',executionAttempt:2},{sink:()=>{}}).snapshot!()!;
  const body=completion({result:{version:'WorkerReviewResult.v1',completedAt:'2026-09-09T12:00:00.000Z',
    personas:[{id:'security',decision:'ERROR',status:'ERROR',errorClass:'timeout',findings:[]}],coverageComplete:false,quorumSatisfied:false,
    failureDiagnostics:{reason:'worker_terminal_deadline_exceeded',logTail:'timeout',operationalTelemetry}}});
  const parsed=parseWorkerReviewCompletion(body);
  expect(parsed.result.failureDiagnostics?.operationalTelemetry).toEqual(operationalTelemetry);
  expect(parsed.result.coverageComplete).toBe(false); expect(parsed.result.quorumSatisfied).toBe(false);
  expect(parsed.result.failureDiagnostics).not.toHaveProperty('recoverableIncompletePanel');
  expect(parsed.result.failureDiagnostics?.operationalTelemetry?.providerCalls.started).toBe(0);
  const derived=derive(parsed);expect(derived.valid).toBe(true);
  if(derived.valid){expect(derived.evidence.verdict).not.toBe('SHIP');expect(derived.evidence.quorumSatisfied).toBe(false);}
  expect(()=>parseWorkerReviewCompletion({...body,result:{...body.result,failureDiagnostics:{...body.result.failureDiagnostics,operationalTelemetry:{...operationalTelemetry,prompt:'SECRET'}}}})).toThrow();
});

describe('ADR 0002: the Gate derives required P2s with the same convergence as the raw check', () => {
  const p2 = { severity: 'P2', path: 'src/example.ts', line: 1, title: 'Constant name hides its unit', body: 'Name the unit in the identifier.' };
  const withP2 = () => completion({ result: { ...completion().result, findingCount: 1,
    personas: [lane('security', { decision: 'FINDINGS', findings: [p2] }), lane('architecture')] } });
  const thread = (overrides: Record<string, unknown> = {}) => ({
    fingerprint: findingFingerprint(p2), severity: 'P2' as const, path: p2.path, line: 1, title: p2.title,
    resolved: false, outdated: false, ...overrides,
  });

  it('counts an in-diff P2 as required when no thread satisfies it', () => {
    const result = derive(withP2());
    expect(result.valid).toBe(true);
    expect(result.evidence).toMatchObject({ verdict: 'SHIP', p0Count: 0, p1Count: 0, p2Count: 1 });
  });

  it('does not count a P2 whose thread was resolved with a stated reason', () => {
    const result = derive(withP2(), { ...contract, findingThreads: [thread({ resolved: true,
      resolution: { author: 'author1', reason: 'The unit is fixed by the protocol and documented above.' } })] });
    expect(result.evidence).toMatchObject({ p2Count: 0 });
  });

  it('still counts it when the thread is only resolved, without a reason', () => {
    expect(derive(withP2(), { ...contract, findingThreads: [thread({ resolved: true })] }).evidence).toMatchObject({ p2Count: 1 });
  });
});

describe('versioned v2 worker/Gate decision agreement', () => {
  it('accepts truthful side-less insufficient P2 outcomes after the verifier budget is exhausted', async () => {
    const path = 'src/budget.ts';
    const lineSources = Array.from({ length: 25 }, (_, index) => `export const advisory${index + 1} = ${index + 1};`);
    const baseLineSources = Array.from({ length: 25 }, (_, index) => `export const previous${index + 1} = ${index + 1};`);
    const headSource = `${lineSources.join('\n')}\n`;
    const baseSource = `${baseLineSources.join('\n')}\n`;
    const patch = `@@ -1,25 +1,25 @@\n${baseLineSources.map((line) => `-${line}`).join('\n')}\n${lineSources.map((line) => `+${line}`).join('\n')}\n`;
    const admittedFiles = [{ path, patch }];
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_requestedPath, side) => ({ content: side === 'head' ? headSource : baseSource,
        sha: side === 'head' ? expectedCoordinates.headSha : expectedCoordinates.baseSha, presence: 'present',
        source: { repository: `${expectedCoordinates.owner}/${expectedCoordinates.repo}`, path, side } }),
      readDiff: () => ({ patch, identity: { repository: `${expectedCoordinates.owner}/${expectedCoordinates.repo}`,
        headSha: expectedCoordinates.headSha, baseSha: expectedCoordinates.baseSha } }),
    };
    const findings = lineSources.map((_, index) => ({ severity: 'P2' as const, path, line: index + 1,
      title: `Budget advisory ${index + 1}`, body: `Advisory claim ${index + 1} is not fully verified.` }));
    const verifier = vi.fn(async () => ({ model: 'test-verifier',
      content: JSON.stringify({ status: 'insufficient', reason: 'The source does not establish this advisory.' }),
      usage: null, costUSD: null }));
    const verification = await runIndependentGroundedVerification({ findings, changedFiles: admittedFiles, provider,
      repository: `${expectedCoordinates.owner}/${expectedCoordinates.repo}`, headSha: expectedCoordinates.headSha,
      baseSha: expectedCoordinates.baseSha, model: 'test-model', verificationVersion: GROUNDED_VERIFICATION_VERSION,
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
      budget: { totalCalls: 12, callsPerTask: 12, concurrency: 1 },
      client: { complete: verifier } as unknown as ReviewModelClient });

    expect(verifier).toHaveBeenCalledTimes(12);
    expect(verification).toMatchObject({ candidates: 25, calls: 12, insufficient: 25, coverageComplete: true });
    expect(verification.outcomes.filter((row) => row.reason?.includes('budget was exhausted'))).toHaveLength(13);
    expect(verification.outcomes.filter((row) => row.candidateSide === undefined)).toHaveLength(13);

    const applied = applyGroundedVerificationToPersonas([{ id: 'security', findings }], verification,
      admittedFiles, REVIEW_SEVERITY_POLICY_V2);
    expect(applied).toMatchObject({ coverageComplete: true, unverifiedBlockerCount: 0, unverifiedAdvisoryCount: 25,
      personas: [{ findings: [] }] });
    const input = completion({ result: { ...completion().result, personas: [lane('security', { findings: applied.personas[0]!.findings }),
      lane('architecture')], coverageComplete: applied.coverageComplete } });
    const legacy = withDecision(input, {}, admittedFiles);
    const manifest = buildDeterministicCoverageManifest(admittedFiles);
    legacy.result.verdict = 'SHIP';
    legacy.result.findingCount = 0;
    legacy.result.blockingFindingCount = 0;
    legacy.result.groundedReview = {
      version: GROUNDED_REVIEW_RECEIPT_V2_VERSION,
      semanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
      coverage: { digest: manifest.digest, regionCount: manifest.regions.length,
        assignmentCount: manifest.assignments.length, coveredRegionCount: manifest.coveredRegionIds.length,
        complete: manifest.complete, omissions: manifest.omissions },
      history: legacy.result.groundedReview!.history,
      verification: { ...verification, outcomes: verification.outcomes.map(({ reason: _reason, scopeDecision: _scope,
        ...outcome }) => outcome) },
    } as any;
    const result = derive(legacy, { ...v2Contract, changedFiles: admittedFiles });
    expect(result, JSON.stringify(result)).toMatchObject({ valid: true,
      evidence: { verdict: 'SHIP', p2Count: 0, coverageComplete: true } });

    const p1Finding = { ...findings[0]!, severity: 'P1' as const, title: 'Unverified blocking candidate',
      blockerEvidence: { trigger: 'The changed line is reached by a request.', impact: 'The request may expose protected data.',
        violatedContract: 'Protected data requires an authenticated owner.' } };
    const mixedVerification = await runIndependentGroundedVerification({ findings: [p1Finding, ...findings.slice(1)],
      changedFiles: admittedFiles, provider, repository: `${expectedCoordinates.owner}/${expectedCoordinates.repo}`,
      headSha: expectedCoordinates.headSha, baseSha: expectedCoordinates.baseSha, model: 'test-model',
      verificationVersion: GROUNDED_VERIFICATION_VERSION, severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
      budget: { totalCalls: 12, callsPerTask: 12, concurrency: 1 },
      client: { complete: verifier } as unknown as ReviewModelClient });
    expect(mixedVerification).toMatchObject({ candidates: 25, calls: 12, insufficient: 25,
      unverifiedBlockerCount: 1, coverageComplete: false });
    const mixedApplied = applyGroundedVerificationToPersonas([{ id: 'security', findings: [p1Finding, ...findings.slice(1)] }],
      mixedVerification, admittedFiles, REVIEW_SEVERITY_POLICY_V2);
    expect(mixedApplied).toMatchObject({ coverageComplete: false, unverifiedBlockerCount: 1, personas: [{ findings: [] }] });
    const mixedInput = completion({ result: { ...completion().result,
      personas: [lane('security', { findings: mixedApplied.personas[0]!.findings }), lane('architecture')],
      coverageComplete: mixedApplied.coverageComplete, quorumSatisfied: false } });
    const mixedLegacy = withDecision(mixedInput, {}, admittedFiles);
    const mixedReceipt = structuredClone(mixedLegacy.result.groundedReview!);
    mixedLegacy.result.verdict = undefined;
    mixedLegacy.result.findingCount = undefined;
    mixedLegacy.result.blockingFindingCount = undefined;
    mixedLegacy.result.groundedReview = {
      version: GROUNDED_REVIEW_RECEIPT_V2_VERSION,
      semanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
      coverage: mixedReceipt.coverage,
      history: mixedReceipt.history,
      verification: { ...mixedVerification, outcomes: mixedVerification.outcomes.map(({ reason: _reason, scopeDecision: _scope,
        ...outcome }) => outcome) },
    } as any;
    const genuineIncompleteP1 = derive(mixedLegacy, { ...v2Contract, changedFiles: admittedFiles });
    expect(genuineIncompleteP1, JSON.stringify(genuineIncompleteP1)).toMatchObject({ valid: true,
      evidence: { coverageComplete: false, verdict: 'BLOCK', reviewDecision: { eligible: false } } });

    const downgradedInsufficientP1 = structuredClone(mixedLegacy);
    const downgradedReceipt = downgradedInsufficientP1.result.groundedReview!;
    const p1Outcome = downgradedReceipt.version === GROUNDED_REVIEW_RECEIPT_V2_VERSION
      ? downgradedReceipt.verification.outcomes.find((outcome) => outcome.fingerprint === findingFingerprint(p1Finding)) as any
      : undefined;
    if (!p1Outcome) throw new Error('expected the v2 P1 candidate outcome');
    p1Outcome.severity = 'P2';
    downgradedReceipt.version === GROUNDED_REVIEW_RECEIPT_V2_VERSION && (downgradedReceipt.verification.unverifiedBlockerCount = 0);
    downgradedReceipt.version === GROUNDED_REVIEW_RECEIPT_V2_VERSION && (downgradedReceipt.verification.coverageComplete = true);
    downgradedInsufficientP1.result.coverageComplete = true;
    downgradedInsufficientP1.result.quorumSatisfied = true;
    const cleanP2Decision = withDecision(downgradedInsufficientP1, {}, admittedFiles).result.reviewDecision;
    downgradedInsufficientP1.result.reviewDecision = cleanP2Decision;
    downgradedInsufficientP1.result.groundedReview = downgradedReceipt;
    expectInvalid(derive(downgradedInsufficientP1, { ...v2Contract, changedFiles: admittedFiles }),
      /outcome severity disagrees with its original engine candidate/u);

    const missingCandidateManifest = structuredClone(legacy);
    delete (missingCandidateManifest.result.groundedReview as any).verification.candidateManifest;
    expectInvalid(derive(missingCandidateManifest, { ...v2Contract, changedFiles: admittedFiles }),
      /lacks the original pre-filter candidate severity manifest/u);
    const partialCandidateManifest = structuredClone(legacy);
    (partialCandidateManifest.result.groundedReview as any).verification.candidateManifest.pop();
    expect(() => derive(partialCandidateManifest, { ...v2Contract, changedFiles: admittedFiles }))
      .toThrow(/pre-filter candidate severity manifest must be complete/u);
    const wrongCandidateCount = structuredClone(legacy);
    (wrongCandidateCount.result.groundedReview as any).verification.candidates -= 1;
    expect(() => derive(wrongCandidateCount, { ...v2Contract, changedFiles: admittedFiles }))
      .toThrow(/candidate severity manifest must be complete|counts must account for every outcome/u);
  });

  it('revalidates deleted-contract evidence with an unchanged head caller at the Gate boundary', async () => {
    const path = 'src/security.ts';
    const callerPath = 'src/handler.ts';
    const diff = `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-export function authorize(request: Request) {\n-  return request.session !== null;\n-}\n`;
    const admittedFiles = parseChangedFiles(diff, { repository: `${expectedCoordinates.owner}/${expectedCoordinates.repo}`,
      headSha: expectedCoordinates.headSha, baseSha: expectedCoordinates.baseSha }).files;
    const oldDefinition = 'export function authorize(request: Request) {\n  return request.session !== null;\n}\n';
    const caller = "import { authorize } from './security';\nexport function handle(request: Request) { return authorize(request); }\n";
    const resolutionCandidates = groundedRelativeImportCandidates(callerPath, './security');
    const finding = { severity: 'P1' as const, path, line: 1,
      title: 'Deleted authorization export remains reachable from the handler', body: 'The handler still imports the removed export.',
      blockerEvidence: { trigger: 'The handler imports and calls authorize.', impact: 'Authorization checks cannot resolve.',
        violatedContract: 'The authorization helper export remains available to current callers.' } };
    const input = completion({ result: { ...completion().result, personas: [
      lane('security', { decision: 'FINDINGS', findings: [finding] }), lane('architecture')], verdict: 'FIX_FIRST',
      findingCount: 1, blockingFindingCount: 1 } });
    const built = withDecision(input, {}, admittedFiles);
    const primary = vi.fn(async (request: any) => {
      const body = request.messages[1].content;
      const files = JSON.parse(body.match(/<retrieved_repository_evidence>(.*?)<\/retrieved_repository_evidence>/su)[1]);
      const target = files.find((file: any) => file.path === path);
      const callerEvidence = files.find((file: any) => file.path === callerPath);
      const candidateId = target.base.windows.find((window: any) => window.role === 'candidate').id;
      const contractId = target.base.windows.find((window: any) => window.role === 'dependency-contract').id;
      const absenceId = target.head.absence.id;
      const diffId = target.diffs[0].id;
      const baseCallerId = callerEvidence.base.windows.find((window: any) => window.role === 'dependency-caller').id;
      const headCallerId = callerEvidence.head.windows.find((window: any) => window.role === 'dependency-caller').id;
      const citations = [candidateId, contractId, absenceId, baseCallerId, headCallerId, diffId];
      return { model: 'test-model', content: JSON.stringify({ status: 'confirmed',
        violatedInvariant: 'Every public authorization contract must remain resolvable by active callers.',
        failurePath: 'The unchanged handler imports the removed export and calls it for every request.',
        benignCheck: 'The deleted definition was the only exact named export satisfying this import.',
        changeConnection: 'The admitted deletion removes the export while the current handler still imports it.',
        rootCause: { componentId: 'security.authorize', behaviorId: 'preserve-auth-export',
          contractId: 'named-import-resolves', failureModeId: 'reachable-missing-export' },
        causeAnchor: { componentPath: path, side: 'base', startLine: 1, endLine: 3, citationIds: [candidateId] },
        causalPath: { relation: 'same-component', candidatePath: path, componentPath: path,
          citationIds: [candidateId, contractId, absenceId, baseCallerId, headCallerId, diffId] },
        baseState: { trigger: 'present', contract: 'not-violated', citationIds: [candidateId, contractId, baseCallerId] },
        headState: { trigger: 'present', contract: 'violated', citationIds: [absenceId, headCallerId] },
        causalDelta: { kind: 'introduced', materiality: 'reachability', citationIds: [diffId] }, citations }),
        usage: null, costUSD: null };
    });
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      findReferences: async (symbol, sourcePath, side) => ({ version: 'PinnedSourceReferenceSearch.v1',
        repository: `${expectedCoordinates.owner}/${expectedCoordinates.repo}`, sourcePath, symbol, side,
        revisionSha: side === 'head' ? expectedCoordinates.headSha : expectedCoordinates.baseSha,
        candidatePaths: [callerPath], searchComplete: false, scannedFileCount: 12, scannedBytes: 20_000, reason: 'scan_file_limit' }),
      readFileAt: async (requestedPath, side) => {
        const absent = requestedPath === path && side === 'head';
        const content = requestedPath === path ? (side === 'head' ? null : oldDefinition)
          : requestedPath === callerPath ? caller : null;
        if (requestedPath === path || requestedPath === callerPath) return {
          content, sha: side === 'head' ? expectedCoordinates.headSha : expectedCoordinates.baseSha,
          presence: absent ? 'absent' as const : 'present' as const,
          source: { repository: `${expectedCoordinates.owner}/${expectedCoordinates.repo}`, path: requestedPath, side },
        };
        if (resolutionCandidates.includes(requestedPath)) return { content: null,
          sha: side === 'head' ? expectedCoordinates.headSha : expectedCoordinates.baseSha,
          presence: 'absent' as const,
          source: { repository: `${expectedCoordinates.owner}/${expectedCoordinates.repo}`, path: requestedPath, side } };
        return { content: null, sha: side === 'head' ? expectedCoordinates.headSha : expectedCoordinates.baseSha,
          presence: 'unavailable' as const,
          source: { repository: `${expectedCoordinates.owner}/${expectedCoordinates.repo}`, path: requestedPath, side } };
      },
      readDiff: (requestedPath) => requestedPath === path ? { patch: admittedFiles[0]!.patch!,
        identity: { repository: `${expectedCoordinates.owner}/${expectedCoordinates.repo}`,
          headSha: expectedCoordinates.headSha, baseSha: expectedCoordinates.baseSha } } : null,
    };
    const verification = await runIndependentGroundedVerification({ findings: [finding], changedFiles: admittedFiles,
      provider, repository: `${expectedCoordinates.owner}/${expectedCoordinates.repo}`, headSha: expectedCoordinates.headSha,
      baseSha: expectedCoordinates.baseSha, model: 'test-model', verificationVersion: GROUNDED_VERIFICATION_VERSION,
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2, client: { complete: primary } as unknown as ReviewModelClient });
    expect(verification.outcomes[0], JSON.stringify(verification.outcomes[0])).toMatchObject({ status: 'confirmed',
      candidateSide: 'base', scopeDecision: { causalScope: 'introduced' } });
    const manifest = buildDeterministicCoverageManifest(admittedFiles);
    const receipt = { version: GROUNDED_REVIEW_RECEIPT_V2_VERSION,
      semanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
      coverage: { digest: manifest.digest, regionCount: manifest.regions.length, assignmentCount: manifest.assignments.length,
        coveredRegionCount: manifest.coveredRegionIds.length, complete: manifest.complete, omissions: manifest.omissions },
      history: { status: 'unavailable' as const, eventCount: 0, findingCount: 0, loadedEventCount: 0, loadedFindingCount: 0,
        eventOmittedCount: 0, findingOmittedCount: 0, legacyOmittedCount: 0, omissions: ['history unavailable in this test'],
        memorySources: { honcho: 'unavailable' as const, mcp: 'unavailable' as const },
        verificationWrites: { attempted: 0, recorded: 0, failed: 0 } },
      verification: { ...verification, outcomes: verification.outcomes.map(({ reason: _reason, scopeDecision: _scope,
        ...outcome }) => outcome) } };
    built.result.groundedReview = receipt as any;
    const expectedImportResolutionSources = verification.sourceResolutionProbeManifest.map(({ resolutionRefs: _refs, ...source }) => source);
    const trusted = { ...v2Contract, changedFiles: admittedFiles, expectedImportResolutionSources };
    const result = derive(built, trusted);
    expect(result, JSON.stringify(result)).toMatchObject({ valid: true, evidence: { p1Count: 1, verdict: 'FIX_FIRST' } });

    const fallbackPath = resolutionCandidates.find((candidate) => candidate.endsWith('/index.ts'))!;
    const fallbackContent = 'export function authorize(request: Request) { return true; }\n';
    const forgedWorkerAbsenceContext = expectedImportResolutionSources.map((source) => source.path === fallbackPath
      && source.revisionSha === expectedCoordinates.headSha
      ? { ...source, presence: 'present' as const, sourceDigest: sha256Bytes(Buffer.from(fallbackContent, 'utf8')) }
      : source);
    expectInvalid(derive(built, { ...trusted, expectedImportResolutionSources: forgedWorkerAbsenceContext }),
      /does not prove absence of every current import target/u);
  });

  it('revalidates a v2 large-source scope proof at the trusted completion boundary', async () => {
    const admittedFiles: ReviewChangedFile[] = [{ path: 'src/example.ts',
      patch: '@@ -1 +1 @@\n-oldOperation();\n+newOperation();\n' }];
    const finding = { severity: 'P1' as const, path: 'src/example.ts', line: 1,
      title: 'Unsafe changed operation', body: 'The new operation bypasses the contract.', blockerEvidence: {
        trigger: 'A caller reaches the changed operation.', impact: 'The operation runs without its required guard.',
        violatedContract: 'The operation must be guarded before execution.',
      } };
    const baseSource = 'oldOperation();\n';
    const headSource = 'newOperation();\n';
    const patch = admittedFiles[0].patch!;
    const repository = `${expectedCoordinates.owner}/${expectedCoordinates.repo}`;
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (path, side) => ({ content: side === 'head' ? headSource : baseSource,
        sha: side === 'head' ? expectedCoordinates.headSha : expectedCoordinates.baseSha,
        presence: 'present', source: { repository, path, side } }),
      readDiff: () => ({ patch, identity: { repository, headSha: expectedCoordinates.headSha, baseSha: expectedCoordinates.baseSha } }),
    };
    const completeVerifier = vi.fn(async (request: any) => {
      const body = request.messages[1].content;
      const files = JSON.parse(body.match(/<retrieved_repository_evidence>(.*?)<\/retrieved_repository_evidence>/su)[1]);
      const row = files[0];
      const headId = row.head.windows[0].id;
      const baseId = row.base.windows[0].id;
      const diffId = row.diffs[0].id;
      return { model: 'test-verifier', content: JSON.stringify({ status: 'confirmed',
        violatedInvariant: 'The changed operation must be guarded.', failurePath: 'The caller reaches it unguarded.',
        benignCheck: 'No guard exists in the new implementation.', changeConnection: 'The patch replaces the guarded call.',
        rootCause: { componentId: 'example-operation', behaviorId: 'unguarded-call',
          contractId: 'guard-required', failureModeId: 'guard-skipped' },
        causeAnchor: { componentPath: 'src/example.ts', side: 'head', startLine: 1, endLine: 1, citationIds: [headId] },
        causalPath: { relation: 'same-component', candidatePath: 'src/example.ts', componentPath: 'src/example.ts',
          citationIds: [headId, baseId, diffId] },
        baseState: { trigger: 'absent', contract: 'not-violated', citationIds: [baseId] },
        headState: { trigger: 'present', contract: 'violated', citationIds: [headId] },
        causalDelta: { kind: 'introduced', materiality: 'reachability', citationIds: [diffId] },
        citations: [headId, baseId, diffId] }), usage: null, costUSD: null };
    });
    const verification = await runIndependentGroundedVerification({ findings: [finding], changedFiles: admittedFiles,
      provider, repository, headSha: expectedCoordinates.headSha, baseSha: expectedCoordinates.baseSha,
      model: 'test-model', verificationVersion: GROUNDED_VERIFICATION_VERSION, severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
      client: { complete: completeVerifier } as unknown as ReviewModelClient });
    expect(verification.outcomes[0]?.scopeDecision, JSON.stringify(verification.outcomes[0])).toMatchObject({ causalScope: 'introduced' });
    expect((verification.outcomes[0]?.evidence as any).citations.every(isValidGroundedCitationV2),
      JSON.stringify((verification.outcomes[0]?.evidence as any).citations)).toBe(true);

    const prior = completion({ result: { ...completion().result,
      personas: [lane('security', { decision: 'FINDINGS', findings: [finding] }), lane('architecture')] } });
    const v1Built = withDecision(prior, {}, admittedFiles);
    const manifest = buildDeterministicCoverageManifest(admittedFiles);
    const receipt = {
      version: GROUNDED_REVIEW_RECEIPT_V2_VERSION,
      semanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
      coverage: { digest: manifest.digest, regionCount: manifest.regions.length, assignmentCount: manifest.assignments.length,
        coveredRegionCount: manifest.coveredRegionIds.length, complete: manifest.complete, omissions: manifest.omissions },
      history: { status: 'unavailable' as const, eventCount: 0, findingCount: 0, loadedEventCount: 0, loadedFindingCount: 0,
        eventOmittedCount: 0, findingOmittedCount: 0, legacyOmittedCount: 0, omissions: ['history unavailable in this test'],
        memorySources: { honcho: 'unavailable' as const, mcp: 'unavailable' as const },
        verificationWrites: { attempted: 0, recorded: 0, failed: 0 } },
      verification: { ...verification,
        outcomes: verification.outcomes.map(({ reason: _reason, scopeDecision: _scopeDecision, ...outcome }) => outcome) },
    };
    const v2Completion = structuredClone(v1Built);
    v2Completion.result.groundedReview = receipt as any;
    v2Completion.result.verdict = 'FIX_FIRST';
    v2Completion.result.findingCount = 1;
    v2Completion.result.blockingFindingCount = 1;
    const trusted = { ...v2Contract, changedFiles: admittedFiles };
    const accepted = derive(v2Completion, trusted);
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ valid: true, evidence: { p1Count: 1, verdict: 'FIX_FIRST' } });

    const p2LaneWithP1Proof = structuredClone(v2Completion);
    p2LaneWithP1Proof.result.personas[0]!.findings[0]!.severity = 'P2';
    const p2LaneReceipt = withDecision(p2LaneWithP1Proof, {}, admittedFiles);
    p2LaneWithP1Proof.result.reviewDecision = p2LaneReceipt.result.reviewDecision;
    p2LaneWithP1Proof.result.groundedReview = structuredClone(v2Completion.result.groundedReview);
    p2LaneWithP1Proof.result.verdict = undefined;
    p2LaneWithP1Proof.result.findingCount = undefined;
    p2LaneWithP1Proof.result.blockingFindingCount = undefined;
    expectInvalid(derive(p2LaneWithP1Proof, trusted), /severity does not match its normalized current lane finding/u);

    const missingMaterialOutcome = structuredClone(v2Completion);
    const missingVerification = missingMaterialOutcome.result.groundedReview!.verification;
    missingVerification.outcomes = [];
    missingVerification.candidates = 0;
    missingVerification.confirmed = 0;
    missingVerification.contradicted = 0;
    missingVerification.insufficient = 0;
    missingVerification.unverifiedBlockerCount = 0;
    (missingVerification as any).candidateManifest = [];
    expectInvalid(derive(missingMaterialOutcome, trusted), /current blocking finding lacks an exact normalized v2 verification outcome/u);

    const duplicateOutcomes = structuredClone(v2Completion);
    const duplicateVerification = duplicateOutcomes.result.groundedReview!.verification;
    const duplicateRows = duplicateVerification.outcomes as any[];
    duplicateRows.push(structuredClone(duplicateRows[0]!));
    duplicateVerification.candidates = 2;
    duplicateVerification.confirmed = 2;
    expect(() => derive(duplicateOutcomes, trusted)).toThrow(/uniquely bind one normalized finding identity|candidate severity manifest/u);

    const trustedDispute = { ...trusted, groundedVerifierRouting: { primaryModel: 'test-model',
      disputedBlockerAdjudicatorModel: 'adjudicator-alias' }, authenticatedDisputePaths: ['src/example.ts'],
      authenticatedDisputes: [{ findingFingerprint: v2Completion.result.groundedReview!.verification.outcomes[0]!.fingerprint,
        priorFindingEventId: 'event-disputed-p1', priorEvidenceDigest: '8'.repeat(64) }] };
    const adjudicated = structuredClone(v2Completion);
    (adjudicated.result.groundedReview!.verification.outcomes[0]! as any).verifierRoute = {
      version: 'GroundedVerifierRoute.v1', purpose: 'disputed-blocker-recheck',
      requestedRole: 'disputed-blocker-adjudicator', appliedRole: 'disputed-blocker-adjudicator',
      configuredAlternateModel: 'adjudicator-alias', selectedModel: 'adjudicator-alias',
      responseReportedModel: 'reported-model', responseModelUnavailableReason: null,
      upstreamIdentity: { providerId: null, model: null, unavailableReason: 'No signed provider attestation.' },
    };
    expect(derive(adjudicated, trustedDispute)).toMatchObject({ valid: true, evidence: { p1Count: 1 } });
    const forgedRoute = structuredClone(adjudicated);
    (forgedRoute.result.groundedReview!.verification.outcomes[0]! as any).verifierRoute.appliedRole = 'primary';
    (forgedRoute.result.groundedReview!.verification.outcomes[0]! as any).verifierRoute.selectedModel = 'test-model';
    expectInvalid(derive(forgedRoute, trustedDispute), /did not use the selected adjudicator route/u);
    expectInvalid(derive(adjudicated, { ...trusted, groundedVerifierRouting: trustedDispute.groundedVerifierRouting,
      authenticatedDisputePaths: [], authenticatedDisputes: [] }), /lacks an exact authenticated disputed P0\/P1 context/u);

    const snapshotId = '11111111-1111-4111-8111-111111111111';
    const contextDigest = '2'.repeat(64);
    const priorRunId = `run_${'3'.repeat(32)}`;
    const ancestry = { version: 'ReviewHeadAncestry.v1', result: 'ancestor', priorRunId,
      priorHeadSha: '4'.repeat(40), currentHeadSha: expectedCoordinates.headSha, comparisonDigest: '5'.repeat(64) };
    const continuityCompletion = structuredClone(v2Completion);
    const continuityOutcome: any = continuityCompletion.result.groundedReview!.verification.outcomes[0]!;
    const continuityEvidence = continuityOutcome.evidence as any;
    const continuityMaterial = {
      version: 'GroundedFindingContinuity.v1', status: 'continuous', durableFindingId: 'finding-123',
      historySnapshotId: snapshotId, historyContextDigest: contextDigest, sourceEventIds: ['event-a'],
      currentFingerprint: continuityOutcome.fingerprint, candidateSide: continuityOutcome.candidateSide,
      rootCause: continuityEvidence.rootCause, causeAnchor: continuityEvidence.causeAnchor,
      sourceWindowManifestDigest: continuityEvidence.sourceWindowManifestDigest,
      currentOutcomeEvidenceDigest: continuityOutcome.evidenceDigest,
    };
    const continuity = { ...continuityMaterial,
      evidenceDigest: groundedFindingContinuityDigest(continuityMaterial as any) };
    continuityOutcome.verifiedContinuity = continuity;
    continuityCompletion.result.groundedReview!.history = {
      status: 'complete', snapshotId, contextDigest, eventCount: 1, findingCount: 1, loadedEventCount: 1,
      loadedFindingCount: 1, eventOmittedCount: 0, findingOmittedCount: 0, legacyOmittedCount: 0,
      eventsDigest: '6'.repeat(64), findingsDigest: '7'.repeat(64), omissions: [],
      memorySources: { honcho: 'unavailable', mcp: 'unavailable' },
      verificationWrites: { attempted: 0, recorded: 0, failed: 0 }, verifiedAncestry: ancestry,
    } as any;
    const trustedHistory = { snapshotId, contextDigest, eventIds: ['event-a'], currentRunId: expectedCoordinates.runId,
      currentHeadSha: expectedCoordinates.headSha, expectedContinuityByFingerprint: { [continuity.currentFingerprint]: continuity },
      verifiedAncestry: ancestry } as any;
    const continuityAccepted = derive(continuityCompletion, { ...trusted, groundedHistory: trustedHistory });
    expect(continuityAccepted, JSON.stringify(continuityAccepted)).toMatchObject({ valid: true,
      groundedContinuity: [continuity] });

    const forgedContinuity = structuredClone(continuityCompletion);
    (forgedContinuity.result.groundedReview!.verification.outcomes[0]! as any).verifiedContinuity.durableFindingId = 'forged-finding-id';
    const forgedContinuityResult = derive(forgedContinuity, { ...trusted, groundedHistory: trustedHistory });
    expect(forgedContinuityResult, JSON.stringify(forgedContinuityResult)).toMatchObject({ valid: true,
      evidence: { verdict: 'FIX_FIRST' } });
    if (forgedContinuityResult.valid) expect(forgedContinuityResult.groundedContinuity).toBeUndefined();

    const staleOutcomeBinding = structuredClone(continuityCompletion);
    const staleHint = (staleOutcomeBinding.result.groundedReview!.verification.outcomes[0]! as any).verifiedContinuity;
    staleHint.currentOutcomeEvidenceDigest = '9'.repeat(64);
    const { evidenceDigest: _staleDigest, ...staleMaterial } = staleHint;
    staleHint.evidenceDigest = groundedFindingContinuityDigest(staleMaterial);
    const staleOutcomeBindingResult = derive(staleOutcomeBinding, { ...trusted, groundedHistory: trustedHistory });
    expect(staleOutcomeBindingResult, JSON.stringify(staleOutcomeBindingResult)).toMatchObject({ valid: true,
      evidence: { verdict: 'FIX_FIRST' } });
    if (staleOutcomeBindingResult.valid) expect(staleOutcomeBindingResult.groundedContinuity).toBeUndefined();

    const historicalContinuityShape = structuredClone(continuityCompletion);
    const historicalHint = (historicalContinuityShape.result.groundedReview!.verification.outcomes[0]! as any).verifiedContinuity;
    delete historicalHint.currentOutcomeEvidenceDigest;
    historicalHint.evidenceDigest = historicalContinuityShape.result.groundedReview!.verification.outcomes[0]!.evidenceDigest;
    const historicalContinuityResult = derive(historicalContinuityShape, { ...trusted, groundedHistory: trustedHistory });
    expect(historicalContinuityResult, JSON.stringify(historicalContinuityResult)).toMatchObject({ valid: true,
      evidence: { verdict: 'FIX_FIRST' } });
    if (historicalContinuityResult.valid) expect(historicalContinuityResult.groundedContinuity).toBeUndefined();

    const fixedCompletion = structuredClone(continuityCompletion);
    const fixedOutcome: any = fixedCompletion.result.groundedReview!.verification.outcomes[0]!;
    const confirmedEvidence = fixedOutcome.evidence;
    const baseCitation = confirmedEvidence.citations.find((citation: any) => citation.side === 'base');
    const fixedAnchor = { componentPath: 'src/example.ts', side: 'base', startLine: 1, endLine: 1,
      citationIds: [baseCitation.id], contentDigest: sha256('oldOperation();\n') };
    const contradictedEvidence = { semanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
      citations: confirmedEvidence.citations, usedCitationIds: confirmedEvidence.usedCitationIds,
      sourceWindowManifestDigest: confirmedEvidence.sourceWindowManifestDigest,
      causalDiffPaths: confirmedEvidence.causalDiffPaths, explanation: 'The new implementation removes the prior unsafe call.' };
    fixedOutcome.status = 'contradicted';
    fixedOutcome.evidence = contradictedEvidence;
    fixedOutcome.verifiedContinuity.causeAnchor = fixedAnchor;
    fixedOutcome.evidenceDigest = sha256(canonicalJson({ fingerprint: fixedOutcome.fingerprint,
      currentAffectedContextDigest: fixedOutcome.affectedContextDigest, evidence: contradictedEvidence }));
    fixedOutcome.verifiedContinuity.currentOutcomeEvidenceDigest = fixedOutcome.evidenceDigest;
    const { evidenceDigest: _oldContinuityDigest, ...fixedContinuityMaterial } = fixedOutcome.verifiedContinuity;
    fixedOutcome.verifiedContinuity.evidenceDigest = groundedFindingContinuityDigest(fixedContinuityMaterial);
    fixedCompletion.result.groundedReview!.verification.confirmed = 0;
    fixedCompletion.result.groundedReview!.verification.contradicted = 1;
    fixedCompletion.result.groundedReview!.verification.outcomes[0] = fixedOutcome;
    fixedCompletion.result.personas = [lane('security'), lane('architecture')] as any;
    const cleanDecision = withDecision(completion({ result: { ...completion().result,
      personas: [lane('security'), lane('architecture')] } })).result.reviewDecision;
    fixedCompletion.result.reviewDecision = cleanDecision;
    fixedCompletion.result.verdict = 'SHIP';
    fixedCompletion.result.findingCount = 0;
    fixedCompletion.result.blockingFindingCount = 0;
    const fixedTransitionMaterial = {
      version: 'GroundedLifecycleTransition.v1', kind: 'fixed', durableFindingId: 'finding-123',
      priorFindingEventId: 'event-a', changedContextDigest: fixedOutcome.affectedContextDigest,
      historySnapshotId: snapshotId, historyContextDigest: contextDigest,
      currentFingerprint: fixedOutcome.fingerprint, candidateSide: fixedOutcome.candidateSide,
      outcomeStatus: 'contradicted', baseSha: expectedCoordinates.baseSha, headSha: expectedCoordinates.headSha,
      sourceWindowManifestDigest: contradictedEvidence.sourceWindowManifestDigest,
      currentOutcomeEvidenceDigest: fixedOutcome.evidenceDigest,
    };
    const fixedTransition = { ...fixedTransitionMaterial, evidenceDigest: sha256(canonicalJson(fixedTransitionMaterial)) };
    const fixedTrustedHistory = { ...trustedHistory,
      expectedContinuityByFingerprint: { [fixedOutcome.fingerprint]: fixedOutcome.verifiedContinuity },
      expectedTransitionsByFingerprint: { [fixedOutcome.fingerprint]: fixedTransition } };
    const fixedResult = derive(fixedCompletion, { ...trusted, groundedHistory: fixedTrustedHistory });
    expect(fixedResult, JSON.stringify(fixedResult)).toMatchObject({ valid: true, evidence: { verdict: 'SHIP' },
      groundedTransitions: [{ transition: 'fixed', durableFindingId: 'finding-123', outcomeStatus: 'contradicted',
        sourceCitationIds: expect.arrayContaining([baseCitation.id]) }] });

    const staleTransition = structuredClone(fixedTransition);
    staleTransition.changedContextDigest = '9'.repeat(64);
    const { evidenceDigest: _oldTransitionDigest, ...staleTransitionMaterial } = staleTransition;
    staleTransition.evidenceDigest = sha256(canonicalJson(staleTransitionMaterial));
    const staleTransitionResult = derive(fixedCompletion, { ...trusted,
      groundedHistory: { ...fixedTrustedHistory,
        expectedTransitionsByFingerprint: { [fixedOutcome.fingerprint]: staleTransition } } });
    expect(staleTransitionResult, JSON.stringify(staleTransitionResult)).toMatchObject({ valid: true,
      evidence: { verdict: 'SHIP' } });
    if (staleTransitionResult.valid) expect(staleTransitionResult.groundedTransitions).toBeUndefined();

    const forgedLabel = structuredClone(v2Completion);
    const forgedOutcome = forgedLabel.result.groundedReview!.verification.outcomes[0]!;
    const forgedEvidence = forgedOutcome.evidence as any;
    forgedEvidence.scopeDecision.causalScope = 'preexisting';
    forgedOutcome.evidenceDigest = sha256(canonicalJson({ fingerprint: forgedOutcome.fingerprint,
      currentAffectedContextDigest: forgedOutcome.affectedContextDigest, evidence: forgedEvidence }));
    expectInvalid(derive(forgedLabel, trusted), /causal-scope decision failed trusted proof re-reduction/u);

    const staleWindow = structuredClone(v2Completion);
    const staleOutcome = staleWindow.result.groundedReview!.verification.outcomes[0]!;
    const staleCitation = (staleOutcome.evidence as any).citations.find((citation: any) => citation.window);
    staleCitation.window.windowSha256 = 'f'.repeat(64);
    expect(() => parseWorkerReviewCompletion(staleWindow)).toThrow(/source window ID|citation ID is not bound/u);
  });

  it.each([
    { kind: 'added', path: 'src/new.ts', line: 1,
      diff: 'diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export const value = unsafe();\n',
      absentSide: 'base' as const },
    { kind: 'deleted', path: 'src/old.ts', line: 1,
      diff: 'diff --git a/src/old.ts b/src/old.ts\ndeleted file mode 100644\n--- a/src/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const value = unsafe();\n',
      absentSide: 'head' as const },
  ])('accepts a bound $kind-side citation and rejects a receipt that omits its absence label', ({ path, line, diff, absentSide }) => {
    const admittedFiles = parseChangedFiles(diff, { repository: `${expectedCoordinates.owner}/${expectedCoordinates.repo}`,
      headSha: expectedCoordinates.headSha, baseSha: expectedCoordinates.baseSha }).files;
    const finding = { severity: 'P1' as const, path, line, title: 'Unsafe exported behavior',
      body: 'A caller reaches the unsafe operation.', blockerEvidence: {
        trigger: 'A caller invokes the exported function.', impact: 'The function performs an unsafe operation.',
        violatedContract: 'The export must validate input before the operation.',
      } };
    const input = completion({ result: { ...completion().result, verdict: 'FIX_FIRST', findingCount: 1,
      blockingFindingCount: 1, personas: [lane('security', { decision: 'FINDINGS', findings: [finding] }), lane('architecture')] } });
    const withReceipt = withDecision(input, {}, admittedFiles);
    const trusted = { ...v2Contract, changedFiles: admittedFiles };
    const accepted = derive(withReceipt, trusted);
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ valid: true, evidence: { verdict: 'FIX_FIRST', p1Count: 1 } });
    const receipt = withReceipt.result.groundedReview!;
    const citation = receipt.verification.outcomes[0]!.evidence!.citations.find((row) => row.side === absentSide)!;
    expect(citation).toMatchObject({ presence: 'absent' });

    const forged = structuredClone(withReceipt);
    const outcome = forged.result.groundedReview!.verification.outcomes[0]!;
    const forgedCitation = outcome.evidence!.citations.find((row) => row.side === absentSide)!;
    delete forgedCitation.presence;
    outcome.evidenceDigest = sha256(canonicalJson({ fingerprint: outcome.fingerprint,
      currentAffectedContextDigest: outcome.affectedContextDigest, evidence: outcome.evidence }));
    expectInvalid(derive(forged, trusted), /citation presence does not match trusted source-side evidence/u);
  });

  it('accepts a complete advisory-only review and retains P2/P3/NIT receipt counts', () => {
    const input = completion({ result: { ...completion().result, findingCount: 3,
      personas: [lane('security', { decision: 'FINDINGS', findings: [
        { severity: 'P2', path: 'src/example.ts', line: 1, title: 'Lower impact input edge case', body: 'One caller receives a less useful error.' },
        { severity: 'P3', path: 'src/example.ts', line: 2, title: 'Clarify local name', body: 'A clearer name would help maintenance.' },
        { severity: 'NIT', path: 'src/example.ts', line: 1, title: 'Optional formatting polish', body: 'Whitespace could match neighboring style.' },
      ] }), lane('architecture')] } });
    const result = derive(withDecision(input), v2Contract);
    expect(result).toMatchObject({ valid: true, evidence: { verdict: 'SHIP', p2Count: 0,
      reviewDecision: { classification: 'SHIP', eligible: true, counts: { p2Count: 1, p3Count: 1, nitCount: 1 } } } });
  });

  it('keeps a P2-first, proof-backed P1 cluster aligned across decision and blocker receipts', () => {
    const blockerEvidence = {
      trigger: 'A request without a valid session reaches the profile lookup.',
      impact: 'The handler returns another account holder private profile data.',
      violatedContract: 'Profile data is readable only by its authenticated owner.',
    };
    const lower = { severity: 'P2' as const, path: 'src/example.ts', line: 1,
      title: 'Profile lookup lacks a session guard', body: 'Requests without a session reach the profile lookup.' };
    const verified = { ...lower, severity: 'P1' as const, line: 2,
      body: 'An unauthenticated request reaches the profile lookup and returns private account data.', blockerEvidence };
    const personas = [
      lane('security', { decision: 'FINDINGS', findings: [lower] }),
      lane('architecture', { decision: 'FINDINGS', findings: [verified] }),
    ];
    const canonical = computeArbitration(personas, 2, {
      changedFiles, coverageComplete: true, severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
    });
    const input = completion({ result: {
      ...completion().result, verdict: canonical.verdict, findingCount: canonical.metrics.totalFindings,
      blockingFindingCount: canonical.metrics.p0Count + canonical.metrics.p1Count, personas,
      reviewDecision: createReviewDecisionV2({
        schemaVersion: 'review-yeti-decision.v2', policyVersion: REVIEW_SEVERITY_POLICY_V2,
        policyDigest: expectedCoordinates.policyDigest, coverageComplete: true, quorumSatisfied: true,
        infrastructureFailure: false, expectedLanes: 2, completedLanes: canonical.completedPersonas,
        counts: {
          p0Count: canonical.metrics.p0Count, p1Count: canonical.metrics.p1Count,
          p2Count: canonical.metrics.p2Count, p3Count: canonical.metrics.p3Count, nitCount: canonical.metrics.nitCount,
        },
      }),
    } });

    const groundedReview = withDecision(input).result.groundedReview;
    const result = derive({ ...input, result: { ...input.result, groundedReview } }, v2Contract);
    const fingerprint = findingFingerprint(verified);
    expect(result).toMatchObject({ valid: true, evidence: {
      verdict: 'FIX_FIRST', p1Count: 1, p2Count: 0, blockingFingerprints: [fingerprint],
      blockingFindings: [{ fingerprint, severity: 'P1', line: 2, title: verified.title,
        body: verified.body, blockerEvidence }],
      reviewDecision: { blocking: true, eligible: false, counts: { p1Count: 1, p2Count: 0 } },
    } });
  });

  it('blocks one evidence-backed P1 and fails closed on a forged eligible receipt or count', () => {
    const finding = { severity: 'P1', path: 'src/example.ts', line: 1, title: 'Missing authorization check',
      body: 'An anonymous caller can read another user record. Add a regression test for this authorization path.', blockerEvidence: {
        trigger: 'A request with no authenticated session reaches this handler.',
        impact: 'It returns another account holder private data to the caller.',
        violatedContract: 'Account data is readable only to its authenticated owner.',
      } };
    const input = withDecision(completion({ result: { ...completion().result, verdict: 'FIX_FIRST', findingCount: 1,
      blockingFindingCount: 1, personas: [lane('security', { decision: 'FINDINGS', findings: [finding] }), lane('architecture')] } }));
    expect(derive(input, v2Contract)).toMatchObject({ valid: true, evidence: {
      verdict: 'FIX_FIRST', p1Count: 1, reviewDecision: { blocking: true, eligible: false },
      blockingFingerprints: [findingFingerprint(finding)],
      blockingFindings: [{ fingerprint: findingFingerprint(finding), severity: 'P1', path: finding.path,
        line: finding.line, title: finding.title, body: finding.body, blockerEvidence: finding.blockerEvidence }],
    } });

    const p2LaneWithP1Receipt = structuredClone(input);
    p2LaneWithP1Receipt.result.personas[0]!.findings[0]!.severity = 'P2';
    const p2LaneRebuilt = withDecision(p2LaneWithP1Receipt);
    const legacyReceipt = p2LaneRebuilt.result.groundedReview;
    if (!legacyReceipt || legacyReceipt.version !== 'GroundedReviewReceipt.v1') {
      throw new Error('expected a historical grounded v1 receipt fixture');
    }
    legacyReceipt.verification.outcomes[0]!.severity = 'P1';
    p2LaneRebuilt.result.verdict = undefined;
    p2LaneRebuilt.result.findingCount = undefined;
    p2LaneRebuilt.result.blockingFindingCount = undefined;
    expectInvalid(derive(p2LaneRebuilt, v2Contract), /severity does not match its normalized current lane finding/u);

    const receipt = input.result.reviewDecision!;
    const forged = { ...input, result: { ...input.result,
      reviewDecision: { ...receipt, eligible: true },
    } } as WorkerReviewCompletion;
    expectInvalid(derive(forged, v2Contract), /decision receipt disagrees/u);
    const changedCounts = { ...input, result: { ...input.result,
      reviewDecision: { ...receipt, counts: { ...receipt.counts, p2Count: 1 } },
    } } as WorkerReviewCompletion;
    expectInvalid(derive(changedCounts, v2Contract), /decision receipt disagrees/u);
  });

  it('rejects a forged standalone test-coverage P1 even with a confirmed grounded receipt', () => {
    const finding = { severity: 'P1', path: 'src/example.ts', line: 1,
      title: 'Missing unit tests for the retry timeout branch',
      body: 'No unit tests cover the timeout retry path.', blockerEvidence: {
        trigger: 'The changed retry branch is called with a timeout.',
        impact: 'The timeout can be missed by a future regression.',
        violatedContract: 'The retry timeout branch must behave correctly.',
      } };
    const input = withDecision(completion({ result: { ...completion().result, verdict: 'FIX_FIRST', findingCount: 1,
      blockingFindingCount: 1, personas: [lane('security', { decision: 'FINDINGS', findings: [finding] }), lane('architecture')] } }));
    input.result.groundedReview!.verification.outcomes[0].claimType = 'generic';

    expectInvalid(derive(input, v2Contract), /test-coverage-only claim cannot be blocking/u);
  });

  it('requires the explicit trusted policy and a receipt; malformed activation fails closed', () => {
    expectInvalid(derive(withDecision(completion())), /not enabled by trusted policy/u);
    expectInvalid(derive(completion(), v2Contract), /grounded-review receipt/u);
    expect(() => derive(completion(), { ...contract,
      reviewDecisionPolicy: 'review-yeti-severity.v3' as typeof REVIEW_SEVERITY_POLICY_V2,
    })).toThrow(/policy is unsupported/u);
  });

  it('allows only optional legacy mismatches that explicitly remain incomplete', () => {
    const workerCoverage = buildDeterministicCoverageManifest([{ path: 'src/example.ts' }]);
    const incomplete = withDecision(completion({ result: { ...completion().result,
      coverageComplete: false, quorumSatisfied: false, verdict: 'BLOCK' } }));
    const receipt = incomplete.result.groundedReview!;
    receipt.coverage = { digest: workerCoverage.digest, regionCount: workerCoverage.regions.length,
      assignmentCount: workerCoverage.assignments.length, coveredRegionCount: workerCoverage.coveredRegionIds.length,
      complete: workerCoverage.complete, omissions: workerCoverage.omissions };
    receipt.verification.coverageComplete = false;

    const legacy = structuredClone(incomplete);
    delete legacy.result.reviewDecision;
    expect(derive(legacy, { ...contract, changedFiles })).toMatchObject({
      valid: true, evidence: { verdict: 'BLOCK', coverageComplete: false },
    });

    const completeLegacy = structuredClone(legacy);
    completeLegacy.result.coverageComplete = true;
    expectInvalid(derive(completeLegacy, { ...contract, changedFiles }), /coverage receipt does not match/u);

    const forgedCompleteReceipt = structuredClone(legacy);
    forgedCompleteReceipt.result.groundedReview!.coverage.complete = true;
    forgedCompleteReceipt.result.groundedReview!.verification.coverageComplete = true;
    expectInvalid(derive(forgedCompleteReceipt, { ...contract, changedFiles }), /coverage receipt does not match/u);

    const finding = { severity: 'P1', path: 'src/example.ts', line: 1,
      title: 'Changed handler skips the access check', body: 'The changed handler returns a private record without authorization.' };
    const partialBlock = withDecision(completion({ result: { ...completion().result,
      coverageComplete: false, quorumSatisfied: false, verdict: 'BLOCK', findingCount: 1, blockingFindingCount: 1,
      personas: [lane('security', { decision: 'FINDINGS', findings: [finding] }), lane('architecture')],
    } }));
    partialBlock.result.groundedReview!.coverage = { digest: workerCoverage.digest,
      regionCount: workerCoverage.regions.length, assignmentCount: workerCoverage.assignments.length,
      coveredRegionCount: workerCoverage.coveredRegionIds.length, complete: workerCoverage.complete,
      omissions: workerCoverage.omissions };
    partialBlock.result.groundedReview!.verification.coverageComplete = false;
    const partialBlockLegacy = structuredClone(partialBlock);
    delete partialBlockLegacy.result.reviewDecision;
    expect(derive(partialBlockLegacy, { ...contract, changedFiles })).toMatchObject({
      valid: true, evidence: { verdict: 'BLOCK', p1Count: 1, coverageComplete: false },
    });

    const staleOutcomeContext = structuredClone(partialBlockLegacy);
    staleOutcomeContext.result.groundedReview!.verification.outcomes[0]!.affectedContextDigest = 'f'.repeat(64);
    expectInvalid(derive(staleOutcomeContext, { ...contract, changedFiles }), /outcome context does not match/u);

    expectInvalid(derive(incomplete, { ...v2Contract, changedFiles }), /coverage receipt does not match/u);
  });

  it('keeps a zero-finding review with incomplete coverage ineligible', () => {
    const input = completion({ result: { ...completion().result, coverageComplete: false, quorumSatisfied: false,
      verdict: undefined, findingCount: undefined, blockingFindingCount: undefined } });
    const result = derive(withDecision(input), v2Contract);
    expect(result).toMatchObject({ valid: true, evidence: { verdict: 'BLOCK', coverageComplete: false,
      quorumSatisfied: false, p0Count: 0, p1Count: 0,
      reviewDecision: { classification: 'INCOMPLETE_REVIEW', eligible: false, reason: 'incomplete-review' } } });
  });
});
