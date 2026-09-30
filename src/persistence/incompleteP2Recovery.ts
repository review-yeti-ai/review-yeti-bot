import { constantTimeDigestEqual } from '../utils/constantTimeDigest';
import { deriveReviewGateExternalId, REVIEW_GATE_CHECK_NAME } from '../review/reviewCheckIdentity';
import {
  MAX_INCOMPLETE_P2_RECOVERY_BYTES,
  MAX_INCOMPLETE_P2_RECOVERY_FINDINGS,
  IncompleteP2RecoveryContextError,
  createIncompleteP2RecoveryContext,
  parseIncompleteP2RecoveryContext,
  type IncompleteP2RecoveryContext,
  type IncompleteP2RecoveryFinding,
  type IncompleteP2RecoveryIdentity,
  type IncompleteP2RecoverySource,
} from '../review/incompleteP2Recovery';
import {
  MAX_INCOMPLETE_P2_RECOVERY_EXECUTION_ATTEMPT,
} from '../review/incompleteP2RecoveryLimits';
import { parseIncompleteRosterSummary } from '../review/incompleteRosterSummary';
import {
  REVIEW_WORKER_APP_SLUG,
  validateReviewGenerationRecoveryEvidence,
  type ReviewGenerationRecoveryEvidence,
  type ReviewGenerationRecoveryRequest,
} from '../review/reviewGenerationRecovery';
import { selectIncompleteRecoveryGate } from '../review/reviewGenerationRecovery';
import {
  MAX_COMPLETION_BYTES,
  deriveStoredCompletionVerdict,
  parseWorkerReviewCompletion,
  workerReviewCompletionDigest,
} from '../review/workerReviewCompletion';

export interface IncompleteP2RecoveryQueryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface IncompleteP2RecoveryLookupInput {
  runId: string;
  executionAttempt: number;
  repositoryId: number;
  identity: Pick<IncompleteP2RecoveryIdentity,
    'owner' | 'repo' | 'prNumber' | 'headSha' | 'baseSha' | 'configDigest'>;
  policyDigest: string;
  expectedAppId: number;
  /** Present before admission persists the verified GitHub ledger. Afterward
   * the same receipt is loaded from review_generation_recoveries. */
  recoveryEvidence?: ReviewGenerationRecoveryEvidence[];
  /** Distinguishes an explicit candidate from ordinary fail-closed probing. */
  incompleteP2Recovery?: true;
}

const RUN_ID = /^run_[a-f0-9]{32}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const MAX_INCOMPLETE_GATE_LOSS_GUARD_ROWS = 16;

function refuse(): never {
  throw new IncompleteP2RecoveryContextError();
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

function recoveryRequest(input: IncompleteP2RecoveryLookupInput, candidate: boolean): ReviewGenerationRecoveryRequest {
  return {
    owner: input.identity.owner,
    repo: input.identity.repo,
    headSha: input.identity.headSha,
    runId: input.runId,
    expectedGeneration: input.executionAttempt,
    expectedAppId: input.expectedAppId,
    ...(candidate ? { incompleteP2Recovery: true } : {}),
  };
}

interface WorkerSummaryCounts { canonical: number; raw: number; expected: number; completed: number }

function workerSummaryCounts(summary: unknown, headSha: string): WorkerSummaryCounts | null {
  const counts = parseIncompleteRosterSummary(summary, headSha);
  if (!counts) return null;
  const { canonicalFindingCount: canonical, rawFindingCount: raw,
    expectedLanes: expected, completedLanes: completed } = counts;
  if (![canonical, raw].every(Number.isSafeInteger)
    || canonical < 0 || raw < canonical || raw > MAX_INCOMPLETE_P2_RECOVERY_FINDINGS) return null;
  return { canonical, raw, expected, completed };
}

function isZeroFindingIncompleteSummary(summary: unknown, headSha: string): boolean {
  const counts = workerSummaryCounts(summary, headSha);
  return counts !== null && counts.canonical === 0 && counts.raw === 0;
}

function proofHasP2(proof: ReviewGenerationRecoveryEvidence['legacyIncompleteRoster'] | undefined,
  headSha: string): boolean {
  const counts = workerSummaryCounts(proof?.workerSummary, headSha);
  return counts !== null && counts.canonical > 0 && counts.raw > 0;
}

async function readPersistedRecoveryEvidence(
  queryable: IncompleteP2RecoveryQueryable,
  input: IncompleteP2RecoveryLookupInput,
): Promise<ReviewGenerationRecoveryEvidence[] | null> {
  const result = await queryable.query(`
    SELECT recovered_generation, worker_check_id, external_id, conclusion, title, evidence
      FROM review_generation_recoveries
     WHERE run_id = $1 AND recovered_generation < $2
     ORDER BY recovered_generation ASC`, [input.runId, input.executionAttempt]);
  if (result.rows.length === 0) return null;
  if (result.rows.length !== input.executionAttempt - 1) refuse();
  const evidence: ReviewGenerationRecoveryEvidence[] = [];
  for (const row of result.rows) {
    const stored = jsonValue(row.evidence);
    if (!isRecord(stored)
      || Number(row.recovered_generation) !== stored.generation
      || Number(row.worker_check_id) !== stored.checkId
      || row.external_id !== stored.externalId
      || row.conclusion !== stored.conclusion || row.title !== stored.title) refuse();
    evidence.push(stored as ReviewGenerationRecoveryEvidence);
  }
  return evidence;
}

/** Attempts above the bounded P2 retry window remain valid for ordinary
 * technical retries. They cannot carry P2 recovery, however, so inspect the
 * small immutable generation ledger and reject a missing marker if an earlier
 * generation had a P2-only incomplete roster. */
async function hasPersistedP2RecoveryCandidate(
  queryable: IncompleteP2RecoveryQueryable,
  runId: string,
  headSha: string,
): Promise<boolean> {
  const result = await queryable.query(`
    SELECT recovered_generation, worker_check_id, external_id, conclusion, title, evidence
      FROM review_generation_recoveries
     WHERE run_id = $1 AND recovered_generation <= ${MAX_INCOMPLETE_P2_RECOVERY_EXECUTION_ATTEMPT}
     ORDER BY recovered_generation ASC`, [runId]);
  if (result.rows.length > MAX_INCOMPLETE_P2_RECOVERY_EXECUTION_ATTEMPT) refuse();
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows[index];
    const stored = jsonValue(row.evidence);
    if (!isRecord(stored)
      || Number(row.recovered_generation) !== index + 1
      || Number(row.recovered_generation) !== stored.generation
      || Number(row.worker_check_id) !== stored.checkId
      || row.external_id !== stored.externalId
      || row.conclusion !== stored.conclusion || row.title !== stored.title) refuse();
    if (row.title === 'Review Yeti: BLOCK'
      && proofHasP2(stored.legacyIncompleteRoster, headSha)) return true;
  }
  return false;
}

/** A lost admission marker and lost generation ledger must not erase findings
 * that are still durably linked to the service's incomplete Gate. This query
 * is deliberately detection-only: recovery still requires the complete
 * generation ledger and exact context digest. Shadow lanes do not gate the
 * published result, so they cannot trigger this guard by themselves. */
async function hasPersistedIncompleteGateFindings(
  queryable: IncompleteP2RecoveryQueryable,
  runId: string,
  executionAttempt: number,
): Promise<boolean> {
  const result = await queryable.query(`
    /* incomplete P2 recovery loss guard */
    SELECT runs.run_id, runs.repository_id, runs.owner, runs.repo, runs.pr_number,
           runs.head_sha, runs.base_sha, runs.effective_policy_digest, runs.effective_config_digest,
           runs.authoritative_gate_app_id,
           gate.execution_attempt AS gate_execution_attempt, gate.review_generation AS gate_review_generation,
           gate.repository_id AS gate_repository_id, gate.pr_number AS gate_pr_number,
           gate.expected_app_id AS gate_expected_app_id, gate.check_id AS gate_check_id,
           gate.external_id AS gate_external_id, gate.creation_state AS gate_creation_state,
           gate.desired_state AS gate_desired_state, gate.coordinates AS gate_coordinates,
           gate.evidence AS gate_evidence, gate.decision AS gate_decision,
           gate.worker_result_digest AS gate_worker_result_digest,
           completions.execution_attempt AS source_execution_attempt,
           completions.content_digest,
           CASE WHEN octet_length(completions.payload::text) <= ${MAX_COMPLETION_BYTES}
                THEN completions.payload ELSE NULL END AS payload,
           octet_length(completions.payload::text) AS payload_byte_length,
           completions.byte_length
      FROM review_gate_attempts gate
      JOIN review_runs runs ON runs.run_id = gate.run_id
      LEFT JOIN review_worker_completions completions
        ON completions.run_id = gate.run_id
       AND completions.execution_attempt = gate.execution_attempt
     WHERE gate.run_id = $1
       AND gate.execution_attempt < $2
       AND gate.creation_state = 'bound'
       AND gate.check_id IS NOT NULL
       AND gate.desired_state = 'failure'
       AND gate.decision->>'reason' = 'incomplete-review'
     ORDER BY gate.execution_attempt ASC
     LIMIT ${MAX_INCOMPLETE_GATE_LOSS_GUARD_ROWS + 1}`, [runId, executionAttempt]);
  if (result.rows.length > MAX_INCOMPLETE_GATE_LOSS_GUARD_ROWS) refuse();
  for (const row of result.rows) {
    const gateEvidence = jsonValue(row.gate_evidence);
    const decision = jsonValue(row.gate_decision);
    const coordinates = jsonValue(row.gate_coordinates);
    if (!isRecord(gateEvidence) || !isRecord(decision) || !isRecord(coordinates)
      || decision.status !== 'failure' || decision.reason !== 'incomplete-review'
      || row.gate_creation_state !== 'bound' || row.gate_desired_state !== 'failure'
      || Number(row.gate_execution_attempt) <= 0
      || Number(row.gate_execution_attempt) >= executionAttempt
      || Number(row.gate_repository_id) !== Number(row.repository_id)
      || Number(row.gate_pr_number) !== Number(row.pr_number)
      || Number(row.gate_expected_app_id) !== Number(row.authoritative_gate_app_id)
      || typeof gateEvidence.coverageComplete !== 'boolean'
      || typeof gateEvidence.infrastructureFailure !== 'boolean'
      || typeof gateEvidence.quorumSatisfied !== 'boolean'
      || gateEvidence.quorumSatisfied !== false || gateEvidence.verdict !== 'BLOCK'
      || !Number.isSafeInteger(Number(gateEvidence.expectedLanes))
      || !Number.isSafeInteger(Number(gateEvidence.completedLanes))
      || Number(gateEvidence.expectedLanes) <= 0
      || Number(gateEvidence.completedLanes) < 0
      || Number(gateEvidence.completedLanes) >= Number(gateEvidence.expectedLanes)
      || !Number.isSafeInteger(Number(gateEvidence.p0Count)) || Number(gateEvidence.p0Count) !== 0
      || !Number.isSafeInteger(Number(gateEvidence.p1Count)) || Number(gateEvidence.p1Count) !== 0) refuse();
    const sourceAttempt = Number(row.source_execution_attempt);
    const contentDigest = String(row.content_digest || '');
    const gateDigest = String(row.gate_worker_result_digest || '');
    const storedByteLength = Number(row.byte_length);
    const payloadByteLength = Number(row.payload_byte_length);
    if (!Number.isSafeInteger(sourceAttempt) || sourceAttempt !== Number(row.gate_execution_attempt)
      || !DIGEST.test(contentDigest) || !DIGEST.test(gateDigest)
      || !constantTimeDigestEqual(contentDigest, gateDigest)
      || row.payload == null || !Number.isSafeInteger(storedByteLength) || storedByteLength <= 0
      || storedByteLength > MAX_COMPLETION_BYTES || !Number.isSafeInteger(payloadByteLength)
      || payloadByteLength <= 0 || payloadByteLength > MAX_COMPLETION_BYTES) refuse();

    const completion = parseWorkerReviewCompletion(jsonValue(row.payload));
    const completionDigest = workerReviewCompletionDigest(completion);
    if (!constantTimeDigestEqual(completionDigest, contentDigest)
      || completion.runId !== row.run_id || completion.executionAttempt !== sourceAttempt
      || completion.repositoryId !== Number(row.repository_id)
      || completion.owner !== row.owner || completion.repo !== row.repo
      || completion.prNumber !== Number(row.pr_number)
      || completion.headSha !== row.head_sha || completion.baseSha !== row.base_sha
      || completion.policyDigest !== row.effective_policy_digest
      || completion.configDigest !== row.effective_config_digest) refuse();

    const expectedCoordinates = {
      owner: row.owner,
      repo: row.repo,
      repositoryId: Number(row.repository_id),
      prNumber: Number(row.pr_number),
      headSha: row.head_sha,
      baseSha: row.base_sha,
      policyDigest: row.effective_policy_digest,
      runId: row.run_id,
      attemptId: `${row.run_id}-g${Number(row.gate_review_generation)}-e${sourceAttempt}`,
      executionAttempt: sourceAttempt,
    };
    if (Number(row.gate_check_id) <= 0
      || Object.entries(expectedCoordinates).some(([key, value]) => coordinates[key] !== value)
      || row.gate_external_id !== deriveReviewGateExternalId(expectedCoordinates)) refuse();

    // A failed persona carrying findings is malformed but still cannot be
    // discarded as evidence. Only explicitly shadow-only findings are
    // outside the published Gate's result. Once the payload and Gate digest
    // are bound, either kind of gating finding requires fail-closed handling.
    const hasGatingFindings = completion.result.personas.some((persona) =>
      persona.evidenceSource !== 'shadow' && persona.findings.length > 0);
    if (hasGatingFindings) return true;

    const canonical = deriveStoredCompletionVerdict(completion.result, {
      expectedLanes: Number(gateEvidence.expectedLanes),
      coverageComplete: gateEvidence.coverageComplete,
      ...(gateEvidence.reviewEngine === 'composed' ? { reviewEngine: 'composed' as const } : {}),
    });
    if (!canonical || canonical.verdict !== gateEvidence.verdict
      || canonical.quorumSatisfied !== gateEvidence.quorumSatisfied
      || gateEvidence.infrastructureFailure !== false
      || canonical.completedPersonas !== Number(gateEvidence.completedLanes)
      || canonical.metrics.p0Count !== Number(gateEvidence.p0Count)
      || canonical.metrics.p1Count !== Number(gateEvidence.p1Count)
      || (completion.result.findingCount !== undefined
        && completion.result.findingCount !== canonical.metrics.totalFindings)
      || (completion.result.blockingFindingCount !== undefined
        && completion.result.blockingFindingCount !== canonical.metrics.p0Count + canonical.metrics.p1Count)) refuse();
  }
  return false;
}

function selectedGateCheck(
  input: IncompleteP2RecoveryLookupInput,
  proof: ReviewGenerationRecoveryEvidence,
): Record<string, any> {
  const source = proof.legacyIncompleteRoster;
  if (!source) refuse();
  const request = recoveryRequest(input, true);
  const selected = selectIncompleteRecoveryGate(request, source);
  if (!isRecord(selected)) refuse();
  return selected;
}

function validateRunIdentity(row: Record<string, any>, input: IncompleteP2RecoveryLookupInput): IncompleteP2RecoveryIdentity {
  if (!RUN_ID.test(input.runId) || !Number.isSafeInteger(input.executionAttempt)
    || input.executionAttempt < 2 || input.executionAttempt > MAX_INCOMPLETE_P2_RECOVERY_EXECUTION_ATTEMPT
    || !Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0
    || !Number.isSafeInteger(input.expectedAppId) || input.expectedAppId <= 0
    || !DIGEST.test(input.policyDigest) || !DIGEST.test(input.identity.configDigest)
    || !SHA.test(input.identity.headSha) || !SHA.test(input.identity.baseSha)) refuse();
  if (row.run_id !== input.runId || Number(row.repository_id) !== input.repositoryId
    || row.owner !== input.identity.owner || row.repo !== input.identity.repo
    || Number(row.pr_number) !== input.identity.prNumber
    || row.head_sha !== input.identity.headSha || row.base_sha !== input.identity.baseSha
    || row.effective_policy_digest !== input.policyDigest
    || row.effective_config_digest !== input.identity.configDigest
    || Number(row.authoritative_gate_app_id) !== input.expectedAppId
    || row.publication_mode !== 'app-gate') refuse();
  return {
    runId: input.runId,
    repositoryId: input.repositoryId,
    owner: input.identity.owner,
    repo: input.identity.repo,
    prNumber: input.identity.prNumber,
    headSha: input.identity.headSha,
    baseSha: input.identity.baseSha,
    policyDigest: input.policyDigest,
    configDigest: input.identity.configDigest,
    expectedAppId: input.expectedAppId,
    executionAttempt: input.executionAttempt,
  };
}

function gateRecordForSource(
  row: Record<string, any>,
  input: IncompleteP2RecoveryLookupInput,
  proof: ReviewGenerationRecoveryEvidence,
  counts: WorkerSummaryCounts,
): { checkId: number; evidence: Record<string, any> } {
  const gateEvidence = jsonValue(row.gate_evidence);
  const decision = jsonValue(row.gate_decision);
  const coordinates = jsonValue(row.gate_coordinates);
  const sourceAttempt = proof.generation;
  const gateCheck = selectedGateCheck(input, proof);
  const checkId = Number(row.gate_check_id);
  if (!Number.isSafeInteger(checkId) || checkId <= 0 || Number(gateCheck.id) !== checkId
    || gateCheck.name !== REVIEW_GATE_CHECK_NAME || gateCheck.head_sha !== input.identity.headSha
    || gateCheck.app?.id !== input.expectedAppId || gateCheck.app?.slug !== REVIEW_WORKER_APP_SLUG
    || gateCheck.status !== 'completed' || gateCheck.conclusion !== 'failure'
    || gateCheck.external_id !== row.gate_external_id
    || gateCheck.output?.title !== 'Review Yeti Gate: Failed (incomplete panel)') refuse();
  if (!isRecord(gateEvidence) || !isRecord(decision) || !isRecord(coordinates)
    || decision.status !== 'failure' || decision.reason !== 'incomplete-review'
    || row.gate_desired_state !== 'failure' || row.gate_creation_state !== 'bound'
    || Number(row.gate_review_generation) !== sourceAttempt - 1
    || Number(row.gate_execution_attempt) !== sourceAttempt
    || Number(row.gate_repository_id) !== input.repositoryId
    || Number(row.gate_pr_number) !== input.identity.prNumber
    || Number(row.gate_expected_app_id) !== input.expectedAppId
    || !DIGEST.test(String(row.gate_worker_result_digest || ''))
    || !constantTimeDigestEqual(String(row.gate_worker_result_digest), String(row.content_digest))) refuse();
  const expectedCoordinates = {
    owner: input.identity.owner,
    repo: input.identity.repo,
    repositoryId: input.repositoryId,
    prNumber: input.identity.prNumber,
    headSha: input.identity.headSha,
    baseSha: input.identity.baseSha,
    policyDigest: input.policyDigest,
    runId: input.runId,
    attemptId: `${input.runId}-g${sourceAttempt - 1}-e${sourceAttempt}`,
    executionAttempt: sourceAttempt,
  };
  if (Object.entries(expectedCoordinates).some(([key, value]) => coordinates[key] !== value)
    || row.gate_external_id !== deriveReviewGateExternalId(expectedCoordinates)
    || typeof gateEvidence.coverageComplete !== 'boolean' || gateEvidence.quorumSatisfied !== false
    || gateEvidence.infrastructureFailure !== false || gateEvidence.verdict !== 'BLOCK'
    || gateEvidence.exemption != null
    || Number(gateEvidence.expectedLanes) !== counts.expected
    || Number(gateEvidence.completedLanes) !== counts.completed
    || Number(gateEvidence.p0Count) !== 0 || Number(gateEvidence.p1Count) !== 0
    || Number(gateEvidence.expectedLanes) <= Number(gateEvidence.completedLanes)) refuse();
  const gateSummary = `Review Yeti Gate failed: the panel expected ${counts.expected} review lane(s) but ${counts.completed} completed. This is an incomplete review, not a findings verdict; re-dispatch the review for this head.`;
  if (gateCheck.output?.summary !== gateSummary) refuse();
  return { checkId, evidence: gateEvidence };
}

function preservedFindingsForSource(
  completion: ReturnType<typeof parseWorkerReviewCompletion>,
  canonical: NonNullable<ReturnType<typeof deriveStoredCompletionVerdict>>,
  source: IncompleteP2RecoverySource,
): IncompleteP2RecoveryFinding[] {
  const findings: IncompleteP2RecoveryFinding[] = [];
  for (const persona of completion.result.personas) {
    if (persona.evidenceSource === 'shadow') continue;
    const failed = persona.decision === 'ERROR' || persona.status === 'ERROR' || persona.errorClass !== undefined;
    if (failed) {
      if (persona.findings.length > 0) refuse();
      continue;
    }
    persona.findings.forEach((finding, findingIndex) => {
      // P2-only means raw gating findings were P2 too; a P1 that calibration
      // happened to downgrade is not admitted into this recovery class.
      if (finding.severity !== 'P2') refuse();
      findings.push({
        sourceExecutionAttempt: source.executionAttempt,
        sourceWorkerResultDigest: source.workerResultDigest,
        sourceWorkerCheckId: source.workerCheckId,
        sourceGateCheckId: source.gateCheckId,
        personaId: persona.id,
        findingIndex,
        finding: { ...finding, severity: 'P2' },
      });
    });
  }
  if (findings.length !== source.rawFindingCount
    || canonical.metrics.rawFindingCount !== source.rawFindingCount
    || canonical.metrics.totalFindings !== source.canonicalFindingCount
    || canonical.metrics.p0Count !== 0 || canonical.metrics.p1Count !== 0
    || canonical.metrics.p2Count !== source.canonicalFindingCount
    || canonical.findings.some((finding) => finding.severity !== 'P2')) refuse();
  return findings;
}

/** Load all earlier, same-run completion evidence for a P2-only incomplete
 * retry. Returns null for an ordinary attempt with no P2 recovery proof;
 * malformed or incomplete provenance always throws. */
export async function loadIncompleteP2RecoveryContext(
  queryable: IncompleteP2RecoveryQueryable,
  input: IncompleteP2RecoveryLookupInput,
): Promise<IncompleteP2RecoveryContext | null> {
  if (input.executionAttempt === 1) return null;
  if (!Number.isSafeInteger(input.executionAttempt) || input.executionAttempt < 2
    || input.executionAttempt > MAX_INCOMPLETE_P2_RECOVERY_EXECUTION_ATTEMPT) refuse();
  const runResult = await queryable.query(`
    SELECT run_id, repository_id, owner, repo, pr_number, head_sha, base_sha,
           effective_policy_digest, effective_config_digest, authoritative_gate_app_id,
           publication_mode
      FROM review_runs
     WHERE run_id = $1`, [input.runId]);
  const run = runResult.rows[0];
  if (!run) refuse();
  const identity = validateRunIdentity(run, input);

  const recoveryEvidence = input.recoveryEvidence
    ? input.recoveryEvidence
    : await readPersistedRecoveryEvidence(queryable, input);
  if (!recoveryEvidence) {
    if (input.incompleteP2Recovery === true) refuse();
    return null;
  }
  if (!Array.isArray(recoveryEvidence) || recoveryEvidence.length !== input.executionAttempt - 1) refuse();
  const p2ProofFlags = recoveryEvidence.map((proof) => proofHasP2(proof.legacyIncompleteRoster, identity.headSha));
  if (!p2ProofFlags.some(Boolean)) {
    if (input.incompleteP2Recovery === true) refuse();
    // Ordinary no-findings incomplete retries remain on the existing path.
    if (recoveryEvidence.some((proof) => proof.title === 'Review Yeti: BLOCK'
      && !isZeroFindingIncompleteSummary(proof.legacyIncompleteRoster?.workerSummary, identity.headSha))) refuse();
    try {
      validateReviewGenerationRecoveryEvidence(recoveryRequest(input, false), recoveryEvidence);
    } catch { refuse(); }
    return null;
  }
  // A P2 recovery chain may carry a zero-finding incomplete generation, but
  // every generation must be a validated incomplete-panel BLOCK so no other
  // failure class is accidentally folded into this context.
  if (recoveryEvidence.some((proof, index) => !p2ProofFlags[index]
    && (proof.title !== 'Review Yeti: BLOCK'
      || !isZeroFindingIncompleteSummary(proof.legacyIncompleteRoster?.workerSummary, identity.headSha)))) refuse();
  try { validateReviewGenerationRecoveryEvidence(recoveryRequest(input, true), recoveryEvidence); } catch { refuse(); }

  const sourceRows = await queryable.query(`
    SELECT runs.run_id, runs.repository_id, runs.owner, runs.repo, runs.pr_number,
           runs.head_sha, runs.base_sha, runs.effective_policy_digest, runs.effective_config_digest,
           completions.execution_attempt AS source_execution_attempt,
           completions.content_digest, completions.payload, completions.byte_length,
           gate.check_id AS gate_check_id, gate.execution_attempt AS gate_execution_attempt,
           gate.review_generation AS gate_review_generation, gate.repository_id AS gate_repository_id,
           gate.pr_number AS gate_pr_number, gate.expected_app_id AS gate_expected_app_id,
           gate.external_id AS gate_external_id, gate.creation_state AS gate_creation_state,
           gate.desired_state AS gate_desired_state, gate.coordinates AS gate_coordinates,
           gate.evidence AS gate_evidence, gate.decision AS gate_decision,
           gate.worker_result_digest AS gate_worker_result_digest
      FROM review_runs runs
      JOIN review_worker_completions completions ON completions.run_id = runs.run_id
      LEFT JOIN LATERAL (
        SELECT attempts.*
          FROM review_gate_attempts attempts
         WHERE attempts.run_id = completions.run_id
           AND attempts.execution_attempt = completions.execution_attempt
           AND attempts.worker_result_digest = completions.content_digest
         ORDER BY attempts.review_generation DESC
         LIMIT 1
      ) gate ON true
     WHERE runs.run_id = $1 AND completions.execution_attempt < $2
     ORDER BY completions.execution_attempt ASC`, [input.runId, input.executionAttempt]);
  if (sourceRows.rows.length !== input.executionAttempt - 1) refuse();

  const sources: IncompleteP2RecoverySource[] = [];
  const findings: IncompleteP2RecoveryFinding[] = [];
  for (let index = 0; index < sourceRows.rows.length; index += 1) {
    const row = sourceRows.rows[index];
    const sourceAttempt = index + 1;
    const proof = recoveryEvidence[index];
    if (Number(row.source_execution_attempt) !== sourceAttempt
      || proof.generation !== sourceAttempt || proof.title !== 'Review Yeti: BLOCK'
      || proof.conclusion !== 'failure' || proof.externalId !== `${input.runId}:a${sourceAttempt}`) refuse();
    const completion = parseWorkerReviewCompletion(jsonValue(row.payload));
    const completionDigest = workerReviewCompletionDigest(completion);
    if (completion.runId !== input.runId || completion.executionAttempt !== sourceAttempt
      || completion.repositoryId !== input.repositoryId || completion.owner !== input.identity.owner
      || completion.repo !== input.identity.repo || completion.prNumber !== input.identity.prNumber
      || completion.headSha !== identity.headSha || completion.baseSha !== identity.baseSha
      || completion.policyDigest !== identity.policyDigest || completion.configDigest !== identity.configDigest
      || !DIGEST.test(String(row.content_digest || ''))
      || !constantTimeDigestEqual(completionDigest, String(row.content_digest))) refuse();

    const counts = workerSummaryCounts(proof.legacyIncompleteRoster?.workerSummary, identity.headSha);
    if (!counts) refuse();
    const gate = gateRecordForSource(row, input, proof, counts);
    if (completion.result.coverageComplete !== gate.evidence.coverageComplete) refuse();
    const canonical = deriveStoredCompletionVerdict(completion.result, {
      expectedLanes: counts.expected,
      coverageComplete: gate.evidence.coverageComplete,
      ...(gate.evidence.reviewEngine === 'composed' ? { reviewEngine: 'composed' as const } : {}),
    });
    if (!canonical || canonical.quorumSatisfied !== false
      || canonical.verdict !== 'BLOCK'
      || canonical.completedPersonas !== counts.completed
      || canonical.metrics.totalFindings !== counts.canonical
      || canonical.metrics.rawFindingCount !== counts.raw
      || (completion.result.findingCount !== undefined && completion.result.findingCount !== counts.canonical)
      || (completion.result.blockingFindingCount !== undefined && completion.result.blockingFindingCount !== 0)) refuse();
    const source: IncompleteP2RecoverySource = {
      executionAttempt: sourceAttempt,
      workerResultDigest: completionDigest,
      workerCheckId: proof.checkId,
      gateCheckId: gate.checkId,
      rawFindingCount: counts.raw,
      canonicalFindingCount: counts.canonical,
    };
    sources.push(source);
    findings.push(...preservedFindingsForSource(completion, canonical, source));
    if (findings.length > MAX_INCOMPLETE_P2_RECOVERY_FINDINGS) refuse();
  }
  if (findings.length === 0) refuse();

  try {
    const context = createIncompleteP2RecoveryContext({
      version: 'IncompleteP2RecoveryContext.v1',
      ...identity,
      sources,
      findings,
    });
    if (Buffer.byteLength(JSON.stringify(context), 'utf8') > MAX_INCOMPLETE_P2_RECOVERY_BYTES) refuse();
    return parseIncompleteP2RecoveryContext(context);
  } catch { refuse(); }
}

/** Require the stored admission digest whenever the persisted generation
 * ledger indicates that a prior attempt carried P2 findings. Missing or
 * mismatched context markers fail closed. */
export async function requiredIncompleteP2RecoveryDigest(
  queryable: IncompleteP2RecoveryQueryable,
  runId: string,
  executionAttempt: number,
  artifacts: unknown,
): Promise<string | null> {
  if (executionAttempt === 1) return null;
  if (!Number.isSafeInteger(executionAttempt) || executionAttempt < 1) refuse();
  const value = jsonValue(artifacts);
  const marker = isRecord(value) ? value.incomplete_p2_recovery_digest : undefined;
  const row = (await queryable.query(`
    SELECT repository_id, owner, repo, pr_number, head_sha, base_sha,
           effective_policy_digest, effective_config_digest, authoritative_gate_app_id
      FROM review_runs WHERE run_id = $1`, [runId])).rows[0];
  if (!row) refuse();
  if (executionAttempt > MAX_INCOMPLETE_P2_RECOVERY_EXECUTION_ATTEMPT) {
    if (marker !== undefined || await hasPersistedIncompleteGateFindings(queryable, runId, executionAttempt)
      || await hasPersistedP2RecoveryCandidate(queryable, runId, row.head_sha)) refuse();
    return null;
  }
  const context = await loadIncompleteP2RecoveryContext(queryable, {
    runId,
    executionAttempt,
    repositoryId: Number(row.repository_id),
    identity: {
      owner: row.owner,
      repo: row.repo,
      prNumber: Number(row.pr_number),
      headSha: row.head_sha,
      baseSha: row.base_sha,
      configDigest: row.effective_config_digest,
    },
    policyDigest: row.effective_policy_digest,
    expectedAppId: Number(row.authoritative_gate_app_id),
  });
  if (!context) {
    if (marker !== undefined) refuse();
    if (await hasPersistedIncompleteGateFindings(queryable, runId, executionAttempt)) refuse();
    return null;
  }
  if (typeof marker !== 'string' || !DIGEST.test(marker)
    || !constantTimeDigestEqual(marker, context.contextDigest)) refuse();
  return marker;
}
