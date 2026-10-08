import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../review/reviewCore';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION } from '../review/groundedEvidenceV2';
import { NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT, NORMAL_ENGINE_QUALIFICATION_STORE_ROOT,
  WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE } from './normalEngineQualification';
import type {
  PrLifecycleHistoryEvent,
  PrLifecycleHistoryFinding,
  PrLifecycleHistoryLoad,
  PrLifecycleHistorySource,
  AuthenticatedDisputesProjection,
} from '../review/prLifecycleHistoryHttp';
import type { NormalEngineQualificationHistorySource } from '../cli/publishingReview';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const uuid = z.string().uuid();
const runId = z.string().regex(/^nq_[a-f0-9]{32}$/u);
const name = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);

const eventSchema = z.object({
  eventId: uuid,
  eventType: z.string().min(1).max(120),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u).optional(),
  executionAttempt: z.number().int().positive().safe().optional(),
  evidenceSemanticsVersion: z.literal(GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION).optional(),
  headSha: sha.optional(),
  baseSha: sha.optional(),
  policyDigest: digest.optional(),
  configDigest: digest.optional(),
  contextDigest: digest.optional(),
  evidenceDigest: digest.optional(),
  verificationStatus: z.enum(['confirmed', 'contradicted', 'insufficient']),
  verification: z.object({
    findingEventId: uuid.optional(), fingerprint: z.string().max(500).optional(),
    status: z.enum(['confirmed', 'contradicted', 'insufficient']).optional(),
    currentAffectedContextDigest: digest.optional(), sourceAffectedContextDigest: digest.optional(),
  }).strict().optional(),
}).strict();

const findingSchema = z.object({
  findingEventId: uuid,
  fingerprint: z.string().min(1).max(500),
  path: z.string().min(1).max(4096),
  regionStart: z.number().int().positive().optional(),
  regionEnd: z.number().int().positive().optional(),
  firstSeenHead: sha,
  lastSeenHead: sha,
  affectedContextDigest: digest,
  sourceSeverity: z.string().max(16),
  effectiveSeverity: z.string().max(16),
  disposition: z.string().max(32),
  blocking: z.boolean(),
  verificationStatus: z.enum(['confirmed', 'contradicted', 'insufficient']),
  evidenceDigest: digest,
}).strict();

const historyLoadSchema = z.object({
  status: z.enum(['complete', 'partial', 'unavailable']),
  snapshotId: uuid.optional(),
  contextDigest: digest.optional(),
  events: z.array(eventSchema).max(5000),
  findings: z.array(findingSchema).max(5000),
  eventCount: z.number().int().nonnegative().safe(),
  findingCount: z.number().int().nonnegative().safe(),
  loadedEventCount: z.number().int().nonnegative().safe(),
  loadedFindingCount: z.number().int().nonnegative().safe(),
  eventOmittedCount: z.number().int().nonnegative().safe(),
  findingOmittedCount: z.number().int().nonnegative().safe(),
  legacyOmittedCount: z.number().int().nonnegative().safe(),
  eventsDigest: digest.optional(),
  findingsDigest: digest.optional(),
  omissions: z.array(z.string().min(1).max(500)).max(500),
}).strict().superRefine((load, context) => {
  if (load.status === 'complete' && (!load.snapshotId || !load.contextDigest || !load.eventsDigest || !load.findingsDigest)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['snapshotId'], message: 'complete qualification history requires bound digests' });
  }
  if (load.loadedEventCount !== load.events.length || load.loadedFindingCount !== load.findings.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['loadedEventCount'], message: 'loaded history counts must match rows' });
  }
  if (load.status === 'complete' && (load.eventOmittedCount > 0 || load.findingOmittedCount > 0
    || load.legacyOmittedCount > 0 || load.omissions.length > 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['omissions'], message: 'complete history cannot contain omissions' });
  }
});

const stateSchema = z.object({
  schemaVersion: z.literal('ReviewYetiNormalQualificationHistory.v2'),
  purpose: z.literal('normal-engine-qualification-history'),
  evidenceSemanticsVersion: z.literal(GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION),
  configurationVariant: z.enum(['prepared-policy-default-v1', NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT]),
  executionAttempt: z.number().int().positive().safe(),
  disputedBlockerAdjudicator: z.object({
    state: z.enum(['available', 'unconfigured', 'inactive']),
    modelAlias: z.string().min(1).max(256).nullable(),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable(),
  }).strict().superRefine((value, context) => {
    if ((value.state === 'available') !== (value.modelAlias !== null && value.reasoningEffort !== null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['state'], message: 'qualification history adjudicator binding is inconsistent' });
    }
  }),
  adjudicatorRecheckTarget: z.object({
    path: z.string().min(1).max(4096),
    findingFingerprint: z.string().min(1).max(500),
    priorFindingEventId: uuid,
    priorEvidenceDigest: digest,
  }).strict().nullable(),
  runId,
  sequenceId: name,
  caseId: name,
  bundleSha256: digest,
  inputSha256: digest,
  repairCaseId: name,
  repairInputSha256: digest,
  repairBaseSha: sha,
  repairHeadSha: sha,
  repositoryId: z.number().int().positive().safe(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  baseSha: sha,
  headSha: sha,
  policyDigest: digest,
  configDigest: digest,
  runtime: z.object({
    sourceRevision: sha,
    workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    runtimeManifestSha256: digest,
  }).strict().optional(),
  workerCompletionSha256: digest,
  canonicalEvidenceSha256: digest,
  gateDecisionSha256: digest,
  historyLoad: historyLoadSchema,
}).strict().superRefine((state, context) => {
  if (state.configurationVariant === NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT
    && state.disputedBlockerAdjudicator.state !== 'available') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['disputedBlockerAdjudicator'],
      message: 'configured adjudicator history requires the available selector' });
  }
  if (state.sequenceId === WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.sequenceId && !state.runtime) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['runtime'],
      message: 'external v2 history requires exact runtime identity' });
  }
  if (state.historyLoad.status === 'complete' && state.historyLoad.events.some((event) =>
    event.evidenceSemanticsVersion !== state.evidenceSemanticsVersion)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['historyLoad', 'events'],
      message: 'qualification history events must use the recorded grounded semantics' });
  }
});

const verificationRecordSchema = z.object({
  schemaVersion: z.literal('ReviewYetiNormalQualificationHistoryVerification.v2'),
  purpose: z.literal('normal-engine-qualification-history'),
  runId,
  sourceRunId: runId,
  sequenceId: name,
  sourceCaseId: name,
  repairCaseId: name,
  snapshotId: uuid,
  findingEventId: uuid,
  status: z.enum(['confirmed', 'contradicted', 'insufficient']),
  currentContextDigest: digest,
  currentAffectedContextDigest: digest,
  evidenceSha256: digest,
}).strict();

const verificationSetSchema = z.object({
  schemaVersion: z.literal('ReviewYetiNormalQualificationVerificationSet.v1'),
  purpose: z.literal('normal-engine-qualification-history-verification'),
  runId,
  sourceRunId: runId.nullable(),
  sequenceId: name,
  sourceCaseId: name,
  repairCaseId: name,
  status: z.enum(['complete', 'incomplete', 'unavailable', 'empty_context']),
  sourceHistorySha256: digest.nullable(),
  snapshotIdSha256: digest.nullable(),
  contextDigest: digest.nullable(),
  expectedFindingEventIds: z.array(uuid).max(5000),
  recordedFindingEventIds: z.array(uuid).max(5000),
  missingFindingEventIds: z.array(uuid).max(5000),
  verificationRecordDigests: z.array(z.object({ findingEventId: uuid, sha256: digest }).strict()).max(5000),
}).strict().superRefine((set, context) => {
  const expected = [...new Set(set.expectedFindingEventIds)].sort();
  const recorded = [...new Set(set.recordedFindingEventIds)].sort();
  const missing = [...new Set(set.missingFindingEventIds)].sort();
  const records = [...new Set(set.verificationRecordDigests.map((item) => item.findingEventId))].sort();
  if (expected.length !== set.expectedFindingEventIds.length || recorded.length !== set.recordedFindingEventIds.length
    || missing.length !== set.missingFindingEventIds.length || records.length !== set.verificationRecordDigests.length
    || JSON.stringify(expected) !== JSON.stringify([...set.expectedFindingEventIds].sort())
    || JSON.stringify(recorded) !== JSON.stringify([...set.recordedFindingEventIds].sort())
    || JSON.stringify(missing) !== JSON.stringify([...set.missingFindingEventIds].sort())
    || JSON.stringify(records) !== JSON.stringify([...set.verificationRecordDigests.map((item) => item.findingEventId)].sort())
    || set.missingFindingEventIds.some((id) => !set.expectedFindingEventIds.includes(id))
    || set.recordedFindingEventIds.some((id) => !set.expectedFindingEventIds.includes(id))
    || JSON.stringify([...set.recordedFindingEventIds].sort()) !== JSON.stringify([...records].sort())
    || (set.status === 'complete' && (set.missingFindingEventIds.length !== 0
      || JSON.stringify([...set.expectedFindingEventIds].sort()) !== JSON.stringify([...set.recordedFindingEventIds].sort())))
    || (set.status === 'empty_context' && (set.expectedFindingEventIds.length !== 0 || set.recordedFindingEventIds.length !== 0
      || set.missingFindingEventIds.length !== 0 || set.verificationRecordDigests.length !== 0 || set.sourceRunId !== null))
    || (set.status === 'unavailable' && (set.snapshotIdSha256 !== null || set.contextDigest !== null))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['expectedFindingEventIds'], message: 'qualification verification set is inconsistent' });
  }
});

export type NormalEngineQualificationVerificationSet = z.infer<typeof verificationSetSchema>;

export type NormalEngineQualificationHistoryState = z.infer<typeof stateSchema>;

export interface NormalEngineQualificationHistoryBinding {
  /** Source A qualification run whose immutable history is read. */
  runId: string;
  /** Current B/repeat qualification run that owns verification output files. */
  repairRunId: string;
  sequenceId: string;
  sourceCaseId: string;
  repairCaseId: string;
  bundleSha256: string;
  sourceInputSha256: string;
  repairInputSha256: string;
  repositoryId: number;
  repository: string;
  currentBaseSha: string;
  currentHeadSha: string;
  policyDigest: string;
  configDigest: string;
  configurationVariant?: 'prepared-policy-default-v1' | typeof NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT;
  runtime?: { sourceRevision: string; workerImageDigest: string; runtimeManifestSha256: string };
  mode: 'repair-head' | 'same-head-recheck';
  currentInputSha256: string;
}

export interface NormalEngineQualificationVerificationSetIdentity {
  runId: string;
  sourceRunId: string | null;
  sequenceId: string;
  sourceCaseId: string;
  repairCaseId: string;
}

export type NormalEngineQualificationVerificationSetMode = 'history' | 'history-unavailable'
  | 'verifier-unavailable' | 'empty-context' | 'adjudicator-recheck';

export interface PersistedQualificationHistory {
  historyPath: string;
  sha256Path: string;
  historySha256: string;
  idempotent: boolean;
}

export interface PersistedQualificationHistoryArtifact {
  kind: 'history' | 'verification-set' | 'verification';
  runId: string;
  sourceRunId: string | null;
  sequenceId: string;
  caseId: string;
  findingEventId: string | null;
  recordPath: string;
  recordSha256: string;
  sha256Path: string;
  sha256FileSha256: string;
}

function invalidLoad(reason: string): PrLifecycleHistoryLoad {
  return {
    status: 'unavailable', events: [], findings: [], eventCount: 0, findingCount: 0,
    loadedEventCount: 0, loadedFindingCount: 0, eventOmittedCount: 0, findingOmittedCount: 0,
    legacyOmittedCount: 0, omissions: [reason],
  };
}

function stableJson(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, sort(child)]));
    }
    return entry;
  };
  return JSON.stringify(sort(value));
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('qualification history path is invalid');
  await chmod(path, 0o700);
}

async function writeImmutableJson(parentDirectory: string, recordName: string, value: unknown): Promise<{
  directory: string; path: string; sha256Path: string; sha256: string; idempotent: boolean;
}> {
  const body = `${JSON.stringify(JSON.parse(stableJson(value)), null, 2)}\n`;
  const hash = createHash('sha256').update(body, 'utf8').digest('hex');
  const recordDirectory = join(parentDirectory, recordName);
  const filePath = join(recordDirectory, 'record.json');
  const shaPath = `${filePath}.sha256`;
  const existing = async () => {
    try {
      const [existingBody, existingHash] = await Promise.all([readFile(filePath, 'utf8'), readFile(shaPath, 'utf8')]);
      const actual = createHash('sha256').update(existingBody, 'utf8').digest('hex');
      if (actual !== existingHash.trim()) throw new Error('qualification history store is corrupt');
      if (actual !== hash || existingBody !== body) throw new Error('qualification history identity conflict');
      return { directory: recordDirectory, path: filePath, sha256Path: shaPath, sha256: hash, idempotent: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const prior = await existing();
  if (prior) return prior;
  const temporaryDirectory = join(parentDirectory, `.tmp-${recordName}-${randomUUID()}`);
  await mkdir(temporaryDirectory, { mode: 0o700 });
  try {
    const data = await open(join(temporaryDirectory, 'record.json'), 'wx', 0o600);
    try { await data.writeFile(body, 'utf8'); await data.sync(); }
    finally { await data.close(); }
    const hashFile = await open(join(temporaryDirectory, 'record.json.sha256'), 'wx', 0o600);
    try { await hashFile.writeFile(`${hash}\n`, 'utf8'); await hashFile.sync(); }
    finally { await hashFile.close(); }
    try { await rename(temporaryDirectory, recordDirectory); }
    catch (error) {
      const raced = await existing();
      if (raced) return raced;
      throw error;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return { directory: recordDirectory, path: filePath, sha256Path: shaPath, sha256: hash, idempotent: false };
}

async function readPrivateRecord<T>(recordPath: string, schema: z.ZodType<T>): Promise<{
  value: T; recordSha256: string; sha256Path: string; sha256FileSha256: string;
}> {
  const checksumPath = `${recordPath}.sha256`;
  const [recordStat, checksumStat] = await Promise.all([lstat(recordPath), lstat(checksumPath)]);
  if (!recordStat.isFile() || recordStat.isSymbolicLink() || (recordStat.mode & 0o777) !== 0o600
    || !checksumStat.isFile() || checksumStat.isSymbolicLink() || (checksumStat.mode & 0o777) !== 0o600) {
    throw new Error('qualification history artifact mode/type is invalid');
  }
  const [recordBytes, checksumBytes] = await Promise.all([readFile(recordPath), readFile(checksumPath)]);
  const recordSha256 = createHash('sha256').update(recordBytes).digest('hex');
  if (checksumBytes.toString('utf8') !== `${recordSha256}\n`) throw new Error('qualification history artifact checksum is invalid');
  let raw: unknown;
  try { raw = JSON.parse(recordBytes.toString('utf8')); } catch { throw new Error('qualification history artifact JSON is invalid'); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('qualification history artifact schema is invalid');
  return { value: parsed.data, recordSha256, sha256Path: checksumPath,
    sha256FileSha256: createHash('sha256').update(checksumBytes).digest('hex') };
}

function qualificationArtifactPath(rootDirectory: string, absolutePath: string): string {
  return relative(rootDirectory, absolutePath).split(/[\\/]/u).join('/');
}

function validateVerificationIdentity(identity: NormalEngineQualificationVerificationSetIdentity): void {
  const legacySequence = identity.sequenceId === 'ws5-repair-sequence-v1' && identity.sourceCaseId === 'ws5-sequence-a-v1'
    && ['ws5-sequence-a-v1', 'ws5-sequence-b-v1'].includes(identity.repairCaseId);
  const externalV2Sequence = identity.sequenceId === WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.sequenceId
    && identity.sourceCaseId === WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.sourceCaseId
    && [WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.sourceCaseId, WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.repairCaseId]
      .includes(identity.repairCaseId as typeof WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.sourceCaseId);
  if (!runId.safeParse(identity.runId).success || (identity.sourceRunId !== null && !runId.safeParse(identity.sourceRunId).success)
    || !name.safeParse(identity.sequenceId).success || !name.safeParse(identity.sourceCaseId).success
    || !name.safeParse(identity.repairCaseId).success || (!legacySequence && !externalV2Sequence)) {
    throw new Error('qualification verification set identity is invalid');
  }
}

function validBinding(state: NormalEngineQualificationHistoryState, binding: NormalEngineQualificationHistoryBinding): boolean {
  const common = state.runId === binding.runId && state.sequenceId === binding.sequenceId && state.caseId === binding.sourceCaseId
    && state.bundleSha256 === binding.bundleSha256 && state.inputSha256 === binding.sourceInputSha256
    && state.repositoryId === binding.repositoryId && state.repository === binding.repository
    && state.policyDigest === binding.policyDigest && state.configDigest === binding.configDigest
    && state.configurationVariant === (binding.configurationVariant ?? NORMAL_ENGINE_QUALIFICATION_CONFIG_VARIANT)
    && (!binding.runtime || Boolean(state.runtime && state.runtime.sourceRevision === binding.runtime.sourceRevision
      && state.runtime.workerImageDigest === binding.runtime.workerImageDigest
      && state.runtime.runtimeManifestSha256 === binding.runtime.runtimeManifestSha256))
    && state.evidenceSemanticsVersion === GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
    && state.historyLoad.status === 'complete';
  if (!common) return false;
  if (binding.sequenceId === WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.sequenceId
    && (binding.configurationVariant !== 'prepared-policy-default-v1' || !binding.runtime
      || binding.bundleSha256 !== WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.bundleSha256
      || binding.sourceCaseId !== WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.sourceCaseId
      || binding.repairCaseId !== WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.repairCaseId
      || binding.sourceInputSha256 !== WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.sourceInputSha256
      || binding.repairInputSha256 !== WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.repairInputSha256
      || binding.currentBaseSha !== WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.repairBaseSha
      || binding.currentHeadSha !== WS5_EXTERNAL_NORMAL_V2_HISTORY_LINEAGE.repairHeadSha)) return false;
  if (binding.mode === 'same-head-recheck') {
    return binding.repairCaseId === binding.sourceCaseId && binding.currentInputSha256 === state.inputSha256
      && binding.repairInputSha256 === state.inputSha256 && binding.currentBaseSha === state.baseSha
      && binding.currentHeadSha === state.headSha && state.adjudicatorRecheckTarget !== null;
  }
  return state.repairCaseId === binding.repairCaseId && state.repairInputSha256 === binding.repairInputSha256
    && state.headSha === binding.currentBaseSha && state.repairBaseSha === binding.currentBaseSha
    && state.repairHeadSha === binding.currentHeadSha && binding.currentInputSha256 === binding.repairInputSha256;
}

function qualificationSafePath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !path.startsWith('/') && !path.includes('\\')
    && !/[\x00-\x1f\x7f]/u.test(path) && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function validAdjudicatorTarget(
  state: NormalEngineQualificationHistoryState,
  target: NonNullable<NormalEngineQualificationHistoryState['adjudicatorRecheckTarget']>,
): boolean {
  if (!qualificationSafePath(target.path)) return false;
  const findings = state.historyLoad.findings.filter((finding) => finding.findingEventId === target.priorFindingEventId
    && finding.fingerprint === target.findingFingerprint && finding.path === target.path
    && finding.sourceSeverity === 'P1' && finding.effectiveSeverity === 'P1' && finding.blocking
    && finding.disposition === 'open' && finding.verificationStatus === 'confirmed'
    && finding.evidenceDigest === target.priorEvidenceDigest
    && finding.firstSeenHead === state.headSha && finding.lastSeenHead === state.headSha);
  const events = state.historyLoad.events.filter((event) => event.verification?.findingEventId === target.priorFindingEventId
    && event.verification.fingerprint === target.findingFingerprint);
  if (findings.length !== 1 || events.length !== 1) return false;
  const event = events[0]!;
  const verification = event.verification;
  if (!verification) return false;
  return event.eventType === 'finding-observed' && event.runId === `run_${state.runId.slice(3)}`
    && event.executionAttempt === state.executionAttempt
    && event.verificationStatus === 'confirmed'
    && verification.status === 'confirmed' && event.evidenceSemanticsVersion === state.evidenceSemanticsVersion
    && event.evidenceDigest === target.priorEvidenceDigest && event.headSha === state.headSha && event.baseSha === state.baseSha
    && event.policyDigest === state.policyDigest && event.configDigest === state.configDigest
    && event.contextDigest === state.historyLoad.contextDigest
    && verification.currentAffectedContextDigest === findings[0]!.affectedContextDigest;
}

export function selectQualificationAdjudicatorRecheckTarget(input: {
  historyLoad: NormalEngineQualificationHistoryState['historyLoad'];
  qualificationRunId: string;
  workerRunId: string;
  executionAttempt: number;
  baseSha: string;
  headSha: string;
  policyDigest: string;
  configDigest: string;
}): NormalEngineQualificationHistoryState['adjudicatorRecheckTarget'] {
  if (input.historyLoad.status !== 'complete' || !input.historyLoad.snapshotId || !input.historyLoad.contextDigest
    || input.workerRunId !== `run_${input.qualificationRunId.slice(3)}`) return null;
  const candidates: NonNullable<NormalEngineQualificationHistoryState['adjudicatorRecheckTarget']>[] = [];
  for (const finding of input.historyLoad.findings) {
    if (finding.sourceSeverity !== 'P1' || finding.effectiveSeverity !== 'P1' || !finding.blocking
      || finding.disposition !== 'open' || finding.verificationStatus !== 'confirmed'
      || finding.firstSeenHead !== input.headSha || finding.lastSeenHead !== input.headSha) continue;
    const target = { path: finding.path, findingFingerprint: finding.fingerprint,
      priorFindingEventId: finding.findingEventId, priorEvidenceDigest: finding.evidenceDigest };
    const events = input.historyLoad.events.filter((event) => event.verification?.findingEventId === target.priorFindingEventId
      && event.verification.fingerprint === target.findingFingerprint);
    if (events.length !== 1) return null;
    const event = events[0]!;
    const verification = event.verification;
    if (!verification) return null;
    if (!qualificationSafePath(target.path) || event.eventType !== 'finding-observed'
      || event.runId !== input.workerRunId || event.executionAttempt !== input.executionAttempt
      || event.verificationStatus !== 'confirmed' || verification.status !== 'confirmed'
      || event.evidenceSemanticsVersion !== GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION
      || event.evidenceDigest !== target.priorEvidenceDigest || event.headSha !== input.headSha
      || event.baseSha !== input.baseSha || event.policyDigest !== input.policyDigest || event.configDigest !== input.configDigest
      || event.contextDigest !== input.historyLoad.contextDigest
      || verification.currentAffectedContextDigest !== finding.affectedContextDigest) return null;
    candidates.push(target);
  }
  if (new Set(candidates.map((target) => target.findingFingerprint)).size !== candidates.length
    || new Set(candidates.map((target) => target.priorFindingEventId)).size !== candidates.length) return null;
  return candidates.sort((left, right) => left.path.localeCompare(right.path)
    || left.findingFingerprint.localeCompare(right.findingFingerprint)
    || left.priorFindingEventId.localeCompare(right.priorFindingEventId))[0] ?? null;
}

export class NormalEngineQualificationHistoryStore {
  constructor(private readonly rootDirectory: string = NORMAL_ENGINE_QUALIFICATION_STORE_ROOT) {}

  private directory(state: Pick<NormalEngineQualificationHistoryState, 'runId' | 'sequenceId' | 'caseId'>): string {
    if (!runId.safeParse(state.runId).success || !name.safeParse(state.sequenceId).success || !name.safeParse(state.caseId).success) {
      throw new Error('qualification history identity is invalid');
    }
    return join(this.rootDirectory, state.runId, state.sequenceId, state.caseId);
  }

  async persistInitial(input: unknown): Promise<PersistedQualificationHistory> {
    const parsed = stateSchema.safeParse(input);
    if (!parsed.success) throw new Error('qualification history record contract is invalid');
    const state = parsed.data;
    const contextDigest = state.historyLoad.contextDigest;
    if (!contextDigest || state.historyLoad.eventsDigest !== createHash('sha256')
      .update(canonicalJson(state.historyLoad.events.map((event) => event.eventId))).digest('hex')
      || state.historyLoad.findingsDigest !== createHash('sha256')
        .update(canonicalJson(state.historyLoad.findings.map((finding) => finding.findingEventId))).digest('hex')) {
      throw new Error('qualification history digest contract is invalid');
    }
    for (const event of state.historyLoad.events) {
      if ((event.headSha && event.headSha !== state.headSha) || (event.baseSha && event.baseSha !== state.baseSha)
        || (event.policyDigest && event.policyDigest !== state.policyDigest)
        || (event.configDigest && event.configDigest !== state.configDigest)
        || (event.contextDigest && event.contextDigest !== contextDigest)) {
        throw new Error('qualification history row identity is invalid');
      }
    }
    for (const finding of state.historyLoad.findings) {
      if (finding.firstSeenHead !== state.headSha && finding.lastSeenHead !== state.headSha) {
        throw new Error('qualification history finding identity is invalid');
      }
    }
    const directory = this.directory(state);
    await ensurePrivateDirectory(directory);
    const result = await writeImmutableJson(directory, 'history', state);
    return { historyPath: result.path, sha256Path: result.sha256Path, historySha256: result.sha256, idempotent: result.idempotent };
  }

  /** Captures the immutable phase-A history record without any repair-run mutations. */
  async historyArtifactsFor(stateIdentity: { runId: string; sequenceId: string; caseId: string }): Promise<PersistedQualificationHistoryArtifact[]> {
    const historyRecord = join(this.directory(stateIdentity), 'history', 'record.json');
    const history = await readPrivateRecord(historyRecord, stateSchema);
    if (history.value.runId !== stateIdentity.runId || history.value.sequenceId !== stateIdentity.sequenceId
      || history.value.caseId !== stateIdentity.caseId) throw new Error('qualification history artifact identity is invalid');
    return [{ kind: 'history', runId: history.value.runId, sourceRunId: null,
      sequenceId: history.value.sequenceId, caseId: history.value.caseId, findingEventId: null,
      recordPath: qualificationArtifactPath(this.rootDirectory, historyRecord), recordSha256: history.recordSha256,
      sha256Path: qualificationArtifactPath(this.rootDirectory, history.sha256Path),
      sha256FileSha256: history.sha256FileSha256 }];
  }

  private async verificationRows(identity: NormalEngineQualificationVerificationSetIdentity): Promise<Array<{
    value: z.infer<typeof verificationRecordSchema>; recordPath: string; recordSha256: string;
    sha256Path: string; sha256FileSha256: string;
  }>> {
    validateVerificationIdentity(identity);
    const directory = join(this.directory({ runId: identity.runId, sequenceId: identity.sequenceId, caseId: identity.repairCaseId }), 'verifications');
    try {
      const directoryStat = await lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o777) !== 0o700) {
        throw new Error('qualification verification artifact directory is invalid');
      }
      const entries = await readdir(directory, { withFileTypes: true });
      const rows = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !uuid.safeParse(entry.name).success) {
          throw new Error('qualification verification artifact identity is invalid');
        }
        const recordPath = join(directory, entry.name, 'record.json');
        const verification = await readPrivateRecord(recordPath, verificationRecordSchema);
        if (verification.value.runId !== identity.runId || verification.value.sourceRunId !== identity.sourceRunId
          || verification.value.sequenceId !== identity.sequenceId || verification.value.sourceCaseId !== identity.sourceCaseId
          || verification.value.repairCaseId !== identity.repairCaseId || verification.value.findingEventId !== entry.name) {
          throw new Error('qualification verification artifact identity is invalid');
        }
        rows.push({ value: verification.value, recordPath, recordSha256: verification.recordSha256,
          sha256Path: verification.sha256Path, sha256FileSha256: verification.sha256FileSha256 });
      }
      return rows;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Writes a current-run-owned verification set; empty/unavailable/fault arms are explicit. */
  async finalizeVerificationSet(
    identity: NormalEngineQualificationVerificationSetIdentity,
    mode: NormalEngineQualificationVerificationSetMode,
    binding?: NormalEngineQualificationHistoryBinding,
  ): Promise<NormalEngineQualificationVerificationSet> {
    validateVerificationIdentity(identity);
    let status: NormalEngineQualificationVerificationSet['status'];
    let sourceHistorySha256: string | null = null;
    let snapshotIdSha256: string | null = null;
    let contextDigest: string | null = null;
    let expectedFindingEventIds: string[] = [];
    if (mode === 'history' || mode === 'verifier-unavailable' || mode === 'adjudicator-recheck') {
      if (!binding || identity.runId !== binding.repairRunId || identity.sourceRunId !== binding.runId
        || identity.sequenceId !== binding.sequenceId || identity.sourceCaseId !== binding.sourceCaseId
        || identity.repairCaseId !== binding.repairCaseId
        || (mode === 'adjudicator-recheck' ? binding.mode !== 'same-head-recheck'
          : binding.mode !== 'repair-head')) throw new Error('qualification verification source binding is invalid');
      const sourceDirectory = this.directory({ runId: binding.runId, sequenceId: binding.sequenceId, caseId: binding.sourceCaseId });
      const historyRecordPath = join(sourceDirectory, 'history', 'record.json');
      const historyRecord = await readPrivateRecord(historyRecordPath, stateSchema);
      if (!validBinding(historyRecord.value, binding)) throw new Error('qualification verification source history is incompatible');
      sourceHistorySha256 = historyRecord.recordSha256;
      snapshotIdSha256 = createHash('sha256').update(historyRecord.value.historyLoad.snapshotId!, 'utf8').digest('hex');
      contextDigest = historyRecord.value.historyLoad.contextDigest!;
      expectedFindingEventIds = mode === 'adjudicator-recheck'
        ? historyRecord.value.adjudicatorRecheckTarget ? [historyRecord.value.adjudicatorRecheckTarget.priorFindingEventId] : []
        : historyRecord.value.historyLoad.findings.map((finding) => finding.findingEventId).sort();
      if (mode === 'adjudicator-recheck' && expectedFindingEventIds.length !== 1) {
        throw new Error('qualification adjudicator recheck target is unavailable');
      }
      status = mode === 'verifier-unavailable' ? 'incomplete' : 'complete';
    } else if (mode === 'history-unavailable') {
      if (identity.sourceRunId === null) throw new Error('qualification unavailable history identity is invalid');
      status = 'unavailable';
    } else {
      if (identity.sourceRunId !== null) throw new Error('qualification empty context identity is invalid');
      status = 'empty_context';
    }
    const rows = await this.verificationRows(identity);
    const recordedFindingEventIds = rows.map((row) => row.value.findingEventId).sort();
    const expected = new Set(expectedFindingEventIds);
    if (recordedFindingEventIds.some((id) => !expected.has(id))) throw new Error('qualification verification record is unexpected');
    const recorded = new Set(recordedFindingEventIds);
    const missingFindingEventIds = expectedFindingEventIds.filter((id) => !recorded.has(id));
    if ((mode === 'history' || mode === 'adjudicator-recheck') && missingFindingEventIds.length > 0) status = 'incomplete';
    const verificationRecordDigests = rows.map((row) => ({ findingEventId: row.value.findingEventId, sha256: row.recordSha256 }))
      .sort((left, right) => left.findingEventId.localeCompare(right.findingEventId));
    const set = verificationSetSchema.parse({
      schemaVersion: 'ReviewYetiNormalQualificationVerificationSet.v1',
      purpose: 'normal-engine-qualification-history-verification',
      ...identity,
      status,
      sourceHistorySha256,
      snapshotIdSha256,
      contextDigest,
      expectedFindingEventIds,
      recordedFindingEventIds,
      missingFindingEventIds,
      verificationRecordDigests,
    });
    const currentDirectory = this.directory({ runId: identity.runId, sequenceId: identity.sequenceId, caseId: identity.repairCaseId });
    await ensurePrivateDirectory(currentDirectory);
    await writeImmutableJson(currentDirectory, 'verification-set', set);
    return set;
  }

  /** Returns a run-specific manifest and the exact verification records it attests. */
  async artifactsForRepairRun(identity: NormalEngineQualificationVerificationSetIdentity): Promise<PersistedQualificationHistoryArtifact[]> {
    validateVerificationIdentity(identity);
    const currentDirectory = this.directory({ runId: identity.runId, sequenceId: identity.sequenceId, caseId: identity.repairCaseId });
    const setPath = join(currentDirectory, 'verification-set', 'record.json');
    const set = await readPrivateRecord(setPath, verificationSetSchema);
    if (set.value.runId !== identity.runId || set.value.sourceRunId !== identity.sourceRunId
      || set.value.sequenceId !== identity.sequenceId || set.value.sourceCaseId !== identity.sourceCaseId
      || set.value.repairCaseId !== identity.repairCaseId) throw new Error('qualification verification set artifact identity is invalid');
    const rows = await this.verificationRows(identity);
    const expectedRecordDigests = set.value.verificationRecordDigests;
    const actualRecordDigests = rows.map((row) => ({ findingEventId: row.value.findingEventId, sha256: row.recordSha256 }))
      .sort((left, right) => left.findingEventId.localeCompare(right.findingEventId));
    if (JSON.stringify(expectedRecordDigests) !== JSON.stringify(actualRecordDigests)
      || JSON.stringify(set.value.recordedFindingEventIds) !== JSON.stringify(actualRecordDigests.map((row) => row.findingEventId))) {
      throw new Error('qualification verification set artifact membership is invalid');
    }
    const artifacts: PersistedQualificationHistoryArtifact[] = [{ kind: 'verification-set', runId: set.value.runId,
      sourceRunId: set.value.sourceRunId, sequenceId: set.value.sequenceId, caseId: set.value.repairCaseId,
      findingEventId: null, recordPath: qualificationArtifactPath(this.rootDirectory, setPath), recordSha256: set.recordSha256,
      sha256Path: qualificationArtifactPath(this.rootDirectory, set.sha256Path), sha256FileSha256: set.sha256FileSha256 }];
    artifacts.push(...rows.map((row) => ({ kind: 'verification' as const, runId: row.value.runId,
      sourceRunId: row.value.sourceRunId, sequenceId: row.value.sequenceId, caseId: row.value.repairCaseId,
      findingEventId: row.value.findingEventId, recordPath: qualificationArtifactPath(this.rootDirectory, row.recordPath),
      recordSha256: row.recordSha256, sha256Path: qualificationArtifactPath(this.rootDirectory, row.sha256Path),
      sha256FileSha256: row.sha256FileSha256 })));
    return artifacts;
  }

  sourceForRepair(binding: NormalEngineQualificationHistoryBinding): NormalEngineQualificationHistorySource {
    if (binding.mode !== 'repair-head') throw new Error('qualification repair history mode is invalid');
    return this.sourceForBinding(binding, false);
  }

  sourceForSameHeadAdjudicatorRecheck(binding: NormalEngineQualificationHistoryBinding): NormalEngineQualificationHistorySource {
    if (binding.mode !== 'same-head-recheck') throw new Error('qualification same-head history mode is invalid');
    return this.sourceForBinding(binding, true);
  }

  private sourceForBinding(
    binding: NormalEngineQualificationHistoryBinding,
    includeAdjudicatorProjection: boolean,
  ): NormalEngineQualificationHistorySource {
    validateVerificationIdentity({ runId: binding.repairRunId, sourceRunId: binding.runId,
      sequenceId: binding.sequenceId, sourceCaseId: binding.sourceCaseId, repairCaseId: binding.repairCaseId });
    const directory = this.directory({ runId: binding.runId, sequenceId: binding.sequenceId, caseId: binding.sourceCaseId });
    let loadedState: NormalEngineQualificationHistoryState | undefined;
    const readState = async (): Promise<NormalEngineQualificationHistoryState | undefined> => {
      try {
        const historyPath = join(directory, 'history', 'record.json');
        const bytes = await readFile(historyPath);
        const sidecar = await readFile(`${historyPath}.sha256`, 'utf8');
        if (createHash('sha256').update(bytes).digest('hex') !== sidecar.trim()) return undefined;
        const parsed = stateSchema.safeParse(JSON.parse(bytes.toString('utf8')));
        return parsed.success ? parsed.data : undefined;
      } catch { return undefined; }
    };
    const read = async (): Promise<PrLifecycleHistoryLoad> => {
      const state = await readState();
      if (!state || !validBinding(state, binding)) return invalidLoad('qualification history identity is unavailable or incompatible');
      loadedState = state;
      const result = structuredClone(state.historyLoad);
      if (!includeAdjudicatorProjection) return result;
      const target = state.adjudicatorRecheckTarget;
      if (!target || !validAdjudicatorTarget(state, target)) {
        const projection: AuthenticatedDisputesProjection = { status: 'unavailable', disputes: [], paths: [],
          reason: 'history-incomplete' };
        return { ...result, authenticatedDisputes: projection };
      }
      const projection: AuthenticatedDisputesProjection = { status: 'complete',
        disputes: [{ findingFingerprint: target.findingFingerprint,
          priorFindingEventId: target.priorFindingEventId, priorEvidenceDigest: target.priorEvidenceDigest }],
        paths: [target.path] };
      return { ...result, authenticatedDisputes: projection };
    };
    const recordVerification: PrLifecycleHistorySource['recordVerification'] = async (input) => {
      const state = loadedState ?? await readState();
      if (!state || !validBinding(state, binding) || input.snapshotId !== state.historyLoad.snapshotId
        || input.currentContextDigest !== state.historyLoad.contextDigest
        || !state.historyLoad.findings.some((finding) => finding.findingEventId === input.findingEventId)
        || !digest.safeParse(input.currentAffectedContextDigest).success) return false;
      const record = {
        schemaVersion: 'ReviewYetiNormalQualificationHistoryVerification.v2',
        purpose: 'normal-engine-qualification-history',
        runId: binding.repairRunId,
        sourceRunId: binding.runId,
        sequenceId: binding.sequenceId,
        sourceCaseId: binding.sourceCaseId,
        repairCaseId: binding.repairCaseId,
        snapshotId: input.snapshotId,
        findingEventId: input.findingEventId,
        status: input.status,
        currentContextDigest: input.currentContextDigest,
        currentAffectedContextDigest: input.currentAffectedContextDigest,
        evidenceSha256: createHash('sha256').update(canonicalJson(input.evidence)).digest('hex'),
      };
      const verificationDirectory = join(this.directory({ runId: binding.repairRunId,
        sequenceId: binding.sequenceId, caseId: binding.repairCaseId }), 'verifications');
      await ensurePrivateDirectory(verificationDirectory);
      const result = await writeImmutableJson(verificationDirectory, input.findingEventId, record);
      return result.sha256.length === 64;
    };
    return { purpose: 'normal-engine-qualification-history', read, recordVerification };
  }
}
