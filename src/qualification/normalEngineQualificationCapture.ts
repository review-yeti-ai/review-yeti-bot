import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../review/reviewCore';
import {
  NORMAL_ENGINE_QUALIFICATION_PLAN_ID,
  NORMAL_ENGINE_QUALIFICATION_RECEIPT_PATH,
  NORMAL_ENGINE_QUALIFICATION_STORE_ROOT,
  assertNormalEngineQualificationPlanReceipt,
  type NormalEngineQualificationPlanReceipt,
} from './normalEngineQualification';

export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_READY_PATH = '/workspace/.review-yeti/normal-engine-qualification-capture.ready.json';
export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_ACK_PATH = '/workspace/.review-yeti/qualification-capture.complete';
export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_TERMINATION_MESSAGE_PATH =
  '/workspace/.review-yeti/normal-engine-qualification-capture.termination.json';
export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_READY_VERSION = 'NormalEngineQualificationCaptureReady.v1' as const;
export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_ACK_VERSION = 'NormalEngineQualificationCaptureAck.v1' as const;
export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_OUTCOME_VERSION = 'NormalEngineQualificationCaptureOutcome.v1' as const;
export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_TERMINATION_MESSAGE_VERSION =
  'NormalEngineQualificationCaptureTerminationMessage.v1' as const;
export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_PURPOSE = 'normal-engine-qualification-artifact-capture' as const;
export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_ACK_PURPOSE = 'normal-engine-qualification-capture-ack' as const;
export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_OUTCOME_PURPOSE = 'normal-engine-qualification-capture' as const;
export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_TERMINATION_MESSAGE_PURPOSE =
  'normal-engine-qualification-capture-termination' as const;
export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_TIMEOUT_MS = 15 * 60 * 1_000;
export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_MAX_ARTIFACTS = 20_514;
export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_MAX_ACK_BYTES = 4_000_000;
export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const NORMAL_ENGINE_QUALIFICATION_CAPTURE_TERMINATION_MESSAGE_MAX_BYTES = 4_096;
const DEFAULT_REVIEW_YETI_ROOT = dirname(NORMAL_ENGINE_QUALIFICATION_RECEIPT_PATH);
const runIdSchema = z.string().regex(/^nq_[a-f0-9]{32}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const caseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/u);
const phaseSchema = z.enum(['single', 'repair-introduction', 'repair-head', 'same-head-recheck']);
const safeRelativePath = (value: string): boolean => value.length <= 2048 && !value.startsWith('/')
  && !value.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');

export type NormalEngineQualificationCaptureArtifactKind =
  | 'plan-index' | 'plan-checksum'
  | 'case-receipt' | 'case-receipt-checksum'
  | 'provider-identifiers' | 'provider-identifiers-checksum'
  | 'provider-capture' | 'provider-capture-checksum'
  | 'composed-resources' | 'composed-resources-checksum'
  | 'history-record' | 'history-checksum';

export interface NormalEngineQualificationCaptureArtifact {
  kind: NormalEngineQualificationCaptureArtifactKind;
  /** Relative to `/workspace/.review-yeti`; never an absolute filesystem path. */
  path: string;
  sha256: string;
  byteCount: number;
}

const artifactSchema = z.object({
  kind: z.enum(['plan-index', 'plan-checksum', 'case-receipt', 'case-receipt-checksum',
    'provider-identifiers', 'provider-identifiers-checksum', 'provider-capture', 'provider-capture-checksum',
    'composed-resources', 'composed-resources-checksum', 'history-record', 'history-checksum']),
  path: z.string().min(1).max(2048).refine(safeRelativePath),
  sha256: digestSchema,
  byteCount: z.number().int().nonnegative().safe(),
}).strict();

const readyCoreSchema = z.object({
  schemaVersion: z.literal(NORMAL_ENGINE_QUALIFICATION_CAPTURE_READY_VERSION),
  purpose: z.literal(NORMAL_ENGINE_QUALIFICATION_CAPTURE_PURPOSE),
  planId: z.literal(NORMAL_ENGINE_QUALIFICATION_PLAN_ID),
  runId: runIdSchema,
  planSha256: digestSchema,
  artifacts: z.array(artifactSchema).min(2).max(NORMAL_ENGINE_QUALIFICATION_CAPTURE_MAX_ARTIFACTS),
  artifactCount: z.number().int().positive().max(NORMAL_ENGINE_QUALIFICATION_CAPTURE_MAX_ARTIFACTS),
  artifactSetSha256: digestSchema,
}).strict();

export const normalEngineQualificationCaptureReadyV1Schema = readyCoreSchema.superRefine((ready, context) => {
  if (ready.artifactCount !== ready.artifacts.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifactCount'], message: 'capture inventory count does not match rows' });
  }
  const paths = ready.artifacts.map((row) => row.path);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1]! >= path)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifacts'], message: 'capture inventory paths must be unique and sorted' });
  }
  if (sha256(canonicalJson(ready.artifacts)) !== ready.artifactSetSha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifactSetSha256'], message: 'capture inventory digest does not match rows' });
  }
  if (!ready.artifacts.some((row) => row.kind === 'plan-index' && row.path === 'normal-engine-qualification.json'
    && row.sha256 === ready.planSha256)
    || !ready.artifacts.some((row) => row.kind === 'plan-checksum' && row.path === 'normal-engine-qualification.json.sha256')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifacts'], message: 'capture inventory is missing its bound plan index' });
  }
});

export const normalEngineQualificationCaptureAckV1Schema = z.object({
  schemaVersion: z.literal(NORMAL_ENGINE_QUALIFICATION_CAPTURE_ACK_VERSION),
  purpose: z.literal(NORMAL_ENGINE_QUALIFICATION_CAPTURE_ACK_PURPOSE),
  planId: z.literal(NORMAL_ENGINE_QUALIFICATION_PLAN_ID),
  runId: runIdSchema,
  planSha256: digestSchema,
  readySha256: digestSchema,
  artifactSetSha256: digestSchema,
  artifactCount: z.number().int().positive().max(NORMAL_ENGINE_QUALIFICATION_CAPTURE_MAX_ARTIFACTS),
  copiedArtifacts: z.array(artifactSchema).min(2).max(NORMAL_ENGINE_QUALIFICATION_CAPTURE_MAX_ARTIFACTS),
  copiedArtifactSetSha256: digestSchema,
}).strict().superRefine((ack, context) => {
  if (ack.artifactCount !== ack.copiedArtifacts.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifactCount'], message: 'copied inventory count does not match rows' });
  }
  const paths = ack.copiedArtifacts.map((row) => row.path);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1]! >= path)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['copiedArtifacts'], message: 'copied inventory paths must be unique and sorted' });
  }
  if (sha256(canonicalJson(ack.copiedArtifacts)) !== ack.copiedArtifactSetSha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['copiedArtifactSetSha256'], message: 'copied inventory digest does not match rows' });
  }
});

export type NormalEngineQualificationCaptureStatus = 'not_requested' | 'acknowledged' | 'timed_out' | 'invalid_ack';
export type NormalEngineQualificationCaptureReason = 'hold-disabled' | 'ack-timeout' | 'ack-invalid' | 'ready-manifest-invalid' | null;

export interface NormalEngineQualificationCaptureWaitResult {
  requested: boolean;
  status: NormalEngineQualificationCaptureStatus;
  readySha256: string | null;
  ackSha256: string | null;
  artifactSetSha256: string | null;
  artifactCount: number;
  reason: NormalEngineQualificationCaptureReason;
}

export interface NormalEngineQualificationCaptureReadyV1 extends z.infer<typeof readyCoreSchema> {}

export interface PersistedNormalEngineQualificationCaptureReady {
  path: string;
  sha256Path: string;
  sha256: string;
  artifactSetSha256: string;
  artifactCount: number;
  manifest: NormalEngineQualificationCaptureReadyV1;
  idempotent: boolean;
}

export interface NormalEngineQualificationCaptureArtifactSource {
  planId: typeof NORMAL_ENGINE_QUALIFICATION_PLAN_ID;
  runId: string;
  cases: Array<{
    runId: string;
    phase: z.infer<typeof phaseSchema>;
    caseId: string;
    receiptPath: string;
    receiptSha256: string;
    providerIdentifiersPath: string | null;
    providerIdentifiersSha256: string | null;
    providerCaptureStatus: 'captured' | 'unavailable';
    providerCapturePath: string | null;
    providerCaptureSha256: string | null;
    composedResourcesStatus: 'captured' | 'unavailable';
    composedResourcesPath: string | null;
    composedResourcesSha256: string | null;
  }>;
  historyArtifacts: Array<{
    kind: 'history' | 'verification-set' | 'verification';
    runId: string;
    sequenceId: string;
    caseId: string;
    findingEventId: string | null;
    recordPath: string;
    recordSha256: string;
    sha256Path: string;
    sha256FileSha256: string;
  }>;
}

const artifactSourceSchema = z.object({
  planId: z.literal(NORMAL_ENGINE_QUALIFICATION_PLAN_ID),
  runId: runIdSchema,
  cases: z.array(z.object({
    runId: runIdSchema,
    phase: phaseSchema,
    caseId: caseIdSchema,
    receiptPath: z.string().min(1).max(2048),
    receiptSha256: digestSchema,
    providerIdentifiersPath: z.string().min(1).max(2048).nullable(),
    providerIdentifiersSha256: digestSchema.nullable(),
    providerCaptureStatus: z.enum(['captured', 'unavailable']),
    providerCapturePath: z.string().min(1).max(2048).nullable(),
    providerCaptureSha256: digestSchema.nullable(),
    composedResourcesStatus: z.enum(['captured', 'unavailable']),
    composedResourcesPath: z.string().min(1).max(2048).nullable(),
    composedResourcesSha256: digestSchema.nullable(),
  }).strict()).min(1).max(64),
  historyArtifacts: z.array(z.object({
    kind: z.enum(['history', 'verification-set', 'verification']),
    runId: runIdSchema,
    sequenceId: z.literal('ws5-repair-sequence-v1'),
    caseId: z.enum(['ws5-sequence-a-v1', 'ws5-sequence-b-v1']),
    findingEventId: z.string().uuid().nullable(),
    recordPath: z.string().min(1).max(2048),
    recordSha256: digestSchema,
    sha256Path: z.string().min(1).max(2048),
    sha256FileSha256: digestSchema,
  }).strict()).max(10_000),
}).strict();

export function normalEngineQualificationCaptureArtifactSource(
  index: NormalEngineQualificationPlanReceipt,
): NormalEngineQualificationCaptureArtifactSource {
  return {
    planId: index.planId,
    runId: index.runId,
    cases: index.cases.map((row) => ({
      runId: row.runId, phase: row.phase, caseId: row.caseId,
      receiptPath: row.receiptPath, receiptSha256: row.receiptSha256,
      providerIdentifiersPath: row.providerIdentifiersPath, providerIdentifiersSha256: row.providerIdentifiersSha256,
      providerCaptureStatus: row.providerCaptureStatus, providerCapturePath: row.providerCapturePath,
      providerCaptureSha256: row.providerCaptureSha256,
      composedResourcesStatus: row.composedResourcesStatus, composedResourcesPath: row.composedResourcesPath,
      composedResourcesSha256: row.composedResourcesSha256,
    })),
    historyArtifacts: index.historyArtifacts.map((row) => ({
      kind: row.kind, runId: row.runId, sequenceId: row.sequenceId, caseId: row.caseId,
      findingEventId: row.findingEventId, recordPath: row.recordPath, recordSha256: row.recordSha256,
      sha256Path: row.sha256Path, sha256FileSha256: row.sha256FileSha256,
    })),
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function expectedArtifactRows(plan: NormalEngineQualificationPlanReceipt, planSha256: string):
  Array<{ kind: NormalEngineQualificationCaptureArtifactKind; path: string; sha256: string }> {
  const source = artifactSourceSchema.parse(normalEngineQualificationCaptureArtifactSource(plan));
  const rows: Array<{ kind: NormalEngineQualificationCaptureArtifactKind; path: string; sha256: string }> = [];
  const seen = new Set<string>();
  const add = (kind: NormalEngineQualificationCaptureArtifactKind, path: string, digest: string): void => {
    const planPath = path === 'normal-engine-qualification.json' || path === 'normal-engine-qualification.json.sha256';
    if (!safeRelativePath(path) || (!planPath && !path.startsWith('normal-engine-qualification-store/'))) {
      throw new Error('normal_engine_qualification_capture_artifact_path_invalid');
    }
    if (seen.has(path)) throw new Error('normal_engine_qualification_capture_artifact_inventory_duplicate');
    seen.add(path);
    rows.push({ kind, path, sha256: digest });
  };
  add('plan-index', 'normal-engine-qualification.json', planSha256);
  add('plan-checksum', 'normal-engine-qualification.json.sha256', sha256(`${planSha256}\n`));
  for (const row of source.cases) {
    const prefix = `normal-engine-qualification-store/${row.runId}/${row.phase}/${row.caseId}`;
    const expectedReceipt = `${prefix}/receipt.json`;
    if (row.receiptPath !== expectedReceipt) throw new Error('normal_engine_qualification_capture_receipt_path_invalid');
    add('case-receipt', row.receiptPath, row.receiptSha256);
    add('case-receipt-checksum', row.receiptPath.replace(/receipt\.json$/u, 'receipt.sha256'), sha256(`${row.receiptSha256}\n`));

    const identifiersPath = `${prefix}/provider-identifiers.record/provider-identifiers.json`;
    if ((row.providerIdentifiersPath === null) !== (row.providerIdentifiersSha256 === null)
      || (row.providerIdentifiersPath !== null && row.providerIdentifiersPath !== identifiersPath)) {
      throw new Error('normal_engine_qualification_capture_identifiers_path_invalid');
    }
    if (row.providerIdentifiersPath && row.providerIdentifiersSha256) {
      add('provider-identifiers', row.providerIdentifiersPath, row.providerIdentifiersSha256);
      add('provider-identifiers-checksum', row.providerIdentifiersPath.replace(/provider-identifiers\.json$/u, 'provider-identifiers.sha256'),
        sha256(`${row.providerIdentifiersSha256}\n`));
    }

    const capturePath = `${prefix}/provider-capture.record/provider-capture.json`;
    if ((row.providerCaptureStatus === 'captured' && (row.providerCapturePath !== capturePath || row.providerCaptureSha256 === null))
      || (row.providerCaptureStatus === 'unavailable' && (row.providerCapturePath !== null || row.providerCaptureSha256 !== null))) {
      throw new Error('normal_engine_qualification_capture_provider_path_invalid');
    }
    if (row.providerCapturePath && row.providerCaptureSha256) {
      add('provider-capture', row.providerCapturePath, row.providerCaptureSha256);
      add('provider-capture-checksum', row.providerCapturePath.replace(/provider-capture\.json$/u, 'provider-capture.sha256'),
        sha256(`${row.providerCaptureSha256}\n`));
    }

    const resourcesPath = `${prefix}/composed-resources.record/composed-runtime-resources.json`;
    if ((row.composedResourcesStatus === 'captured' && (row.composedResourcesPath !== resourcesPath || row.composedResourcesSha256 === null))
      || (row.composedResourcesStatus === 'unavailable' && (row.composedResourcesPath !== null || row.composedResourcesSha256 !== null))) {
      throw new Error('normal_engine_qualification_capture_resources_path_invalid');
    }
    if (row.composedResourcesPath && row.composedResourcesSha256) {
      add('composed-resources', row.composedResourcesPath, row.composedResourcesSha256);
      add('composed-resources-checksum', row.composedResourcesPath.replace(/composed-runtime-resources\.json$/u,
        'composed-runtime-resources.sha256'), sha256(`${row.composedResourcesSha256}\n`));
    }
  }
  for (const row of source.historyArtifacts) {
    const prefix = `normal-engine-qualification-store/${row.runId}/${row.sequenceId}/${row.caseId}`;
    const expectedRecord = row.kind === 'history' ? `${prefix}/history/record.json`
      : row.kind === 'verification-set' ? `${prefix}/verification-set/record.json`
        : row.findingEventId ? `${prefix}/verifications/${row.findingEventId}/record.json` : '';
    if (!expectedRecord || row.recordPath !== expectedRecord || row.sha256Path !== `${expectedRecord}.sha256`
      || (row.kind === 'history' && row.findingEventId !== null)
      || (row.kind === 'verification-set' && row.findingEventId !== null)
      || (row.kind === 'verification' && row.findingEventId === null)) {
      throw new Error('normal_engine_qualification_capture_history_path_invalid');
    }
    add('history-record', row.recordPath, row.recordSha256);
    add('history-checksum', row.sha256Path, row.sha256FileSha256);
  }
  return rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function readPrivateRegularFile(root: string, relativePath: string,
  maxBytes = NORMAL_ENGINE_QUALIFICATION_CAPTURE_MAX_ARTIFACT_BYTES): Promise<Buffer> {
  if (!safeRelativePath(relativePath)) throw new Error('normal_engine_qualification_capture_artifact_path_invalid');
  const rootPath = resolve(root);
  await assertPrivateDirectoryTree(rootPath);
  const parts = relativePath.split('/');
  let parent = rootPath;
  for (const segment of parts.slice(0, -1)) {
    parent = join(parent, segment);
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error('normal_engine_qualification_capture_parent_invalid');
    }
  }
  const absolutePath = join(rootPath, ...parts);
  if (!absolutePath.startsWith(`${rootPath}${sep}`)) throw new Error('normal_engine_qualification_capture_artifact_path_invalid');
  const beforeOpen = await lstat(absolutePath);
  if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink() || (beforeOpen.mode & 0o777) !== 0o600
    || beforeOpen.size > maxBytes) {
    throw new Error('normal_engine_qualification_capture_artifact_not_private_regular_file');
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(absolutePath, flags);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || (fileStat.mode & 0o777) !== 0o600) {
      throw new Error('normal_engine_qualification_capture_artifact_not_private_regular_file');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readExpectedArtifact(root: string, row: { kind: NormalEngineQualificationCaptureArtifactKind; path: string; sha256: string }):
  Promise<NormalEngineQualificationCaptureArtifact> {
  const bytes = await readPrivateRegularFile(root, row.path);
  const actualSha = sha256(bytes);
  if (actualSha !== row.sha256) throw new Error('normal_engine_qualification_capture_artifact_digest_mismatch');
  if (row.kind.endsWith('-checksum')) {
    if (!/^[a-f0-9]{64}\n$/u.test(bytes.toString('utf8'))) {
      throw new Error('normal_engine_qualification_capture_checksum_content_invalid');
    }
  }
  return { ...row, byteCount: bytes.byteLength };
}

async function assertPrivateDirectoryTree(directory: string): Promise<void> {
  const absolute = resolve(directory);
  const root = absolute.startsWith(sep) ? sep : '';
  let current = root;
  for (const segment of absolute.split(sep).filter(Boolean)) {
    current = current ? join(current, segment) : segment;
    const directoryStat = await lstat(current);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('normal_engine_qualification_capture_directory_invalid');
    }
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertPrivateDirectoryTree(directory);
  await chmod(directory, 0o700);
}

async function persistPrivatePair(path: string, sha256Path: string, body: string, digest: string): Promise<boolean> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  try {
    const [existingBody, existingChecksum] = await Promise.all([
      readPrivateRegularFile(directory, basename(path)), readPrivateRegularFile(directory, basename(sha256Path)),
    ]);
    if (sha256(existingBody) !== existingChecksum.toString('utf8').trim()) {
      throw new Error('normal_engine_qualification_capture_record_corrupt');
    }
    if (existingBody.toString('utf8') !== body || existingChecksum.toString('utf8') !== `${digest}\n`) {
      throw new Error('normal_engine_qualification_capture_record_conflict');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const bodyTemp = `${path}.tmp-${randomUUID()}`;
  const checksumTemp = `${sha256Path}.tmp-${randomUUID()}`;
  try {
    const bodyFile = await open(bodyTemp, 'wx', 0o600);
    try { await bodyFile.writeFile(body, 'utf8'); await bodyFile.sync(); }
    finally { await bodyFile.close(); }
    const checksumFile = await open(checksumTemp, 'wx', 0o600);
    try { await checksumFile.writeFile(`${digest}\n`, 'utf8'); await checksumFile.sync(); }
    finally { await checksumFile.close(); }
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    await rename(checksumTemp, sha256Path);
    await rename(bodyTemp, path);
    const finalDirectory = await open(directory, 'r');
    try { await finalDirectory.sync(); } finally { await finalDirectory.close(); }
  } finally {
    await rm(bodyTemp, { force: true });
    await rm(checksumTemp, { force: true });
  }
  return false;
}

export async function writeNormalEngineQualificationCaptureReady(
  sourceInput: NormalEngineQualificationCaptureArtifactSource,
  planReceipt: { planPath: string; planSha256: string },
  artifactRootDirectory: string = DEFAULT_REVIEW_YETI_ROOT,
): Promise<PersistedNormalEngineQualificationCaptureReady> {
  const source = artifactSourceSchema.parse(sourceInput);
  const root = resolve(artifactRootDirectory);
  const expectedPlanPath = join(root, 'normal-engine-qualification.json');
  if (resolve(planReceipt.planPath) !== expectedPlanPath || !digestSchema.safeParse(planReceipt.planSha256).success) {
    throw new Error('normal_engine_qualification_capture_plan_binding_invalid');
  }
  const planBytes = await readPrivateRegularFile(root, 'normal-engine-qualification.json');
  if (sha256(planBytes) !== planReceipt.planSha256) throw new Error('normal_engine_qualification_capture_plan_digest_mismatch');
  let parsedPlan: unknown;
  try { parsedPlan = JSON.parse(planBytes.toString('utf8')); }
  catch { throw new Error('normal_engine_qualification_capture_plan_json_invalid'); }
  let plan: NormalEngineQualificationPlanReceipt;
  try { plan = assertNormalEngineQualificationPlanReceipt(parsedPlan); }
  catch { throw new Error('normal_engine_qualification_capture_plan_contract_invalid'); }
  if (plan.planId !== source.planId || plan.runId !== source.runId) {
    throw new Error('normal_engine_qualification_capture_plan_identity_mismatch');
  }
  const planSource = artifactSourceSchema.parse(normalEngineQualificationCaptureArtifactSource(plan));
  if (canonicalJson(source) !== canonicalJson(planSource)) {
    throw new Error('normal_engine_qualification_capture_source_plan_mismatch');
  }
  const expectedRows = expectedArtifactRows(plan, planReceipt.planSha256);
  const artifacts: NormalEngineQualificationCaptureArtifact[] = [];
  for (const row of expectedRows) artifacts.push(await readExpectedArtifact(root, row));
  const manifest = normalEngineQualificationCaptureReadyV1Schema.parse({
    schemaVersion: NORMAL_ENGINE_QUALIFICATION_CAPTURE_READY_VERSION,
    purpose: NORMAL_ENGINE_QUALIFICATION_CAPTURE_PURPOSE,
    planId: source.planId,
    runId: source.runId,
    planSha256: planReceipt.planSha256,
    artifacts,
    artifactCount: artifacts.length,
    artifactSetSha256: sha256(canonicalJson(artifacts)),
  });
  const path = join(root, basename(NORMAL_ENGINE_QUALIFICATION_CAPTURE_READY_PATH));
  const sha256Path = `${path}.sha256`;
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  const readySha256 = sha256(body);
  const idempotent = await persistPrivatePair(path, sha256Path, body, readySha256);
  return { path, sha256Path, sha256: readySha256, artifactSetSha256: manifest.artifactSetSha256,
    artifactCount: manifest.artifactCount, manifest, idempotent };
}

export interface NormalEngineQualificationCaptureWaitDependencies {
  /** Test seam only; production uses the one constant sentinel path. */
  markerPath?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function noCapture(): NormalEngineQualificationCaptureWaitResult {
  return { requested: false, status: 'not_requested', readySha256: null, ackSha256: null,
    artifactSetSha256: null, artifactCount: 0, reason: 'hold-disabled' };
}

function invalidCapture(reason: 'ack-invalid' | 'ready-manifest-invalid', ready?: PersistedNormalEngineQualificationCaptureReady,
  ackSha256: string | null = null): NormalEngineQualificationCaptureWaitResult {
  return { requested: true, status: 'invalid_ack', readySha256: ready?.sha256 ?? null, ackSha256,
    artifactSetSha256: ready?.artifactSetSha256 ?? null, artifactCount: ready?.artifactCount ?? 0, reason };
}

export async function waitForNormalEngineQualificationCapture(
  env: NodeJS.ProcessEnv,
  ready: PersistedNormalEngineQualificationCaptureReady | null,
  dependencies: NormalEngineQualificationCaptureWaitDependencies = {},
): Promise<NormalEngineQualificationCaptureWaitResult> {
  const hold = String(env.REVIEW_NORMAL_ENGINE_QUALIFICATION_CAPTURE_HOLD || '').trim();
  if (hold === '') return noCapture();
  if (hold !== 'true' || env.REVIEW_NORMAL_ENGINE_QUALIFICATION_PLAN !== NORMAL_ENGINE_QUALIFICATION_PLAN_ID) {
    return invalidCapture('ack-invalid', ready ?? undefined);
  }
  if (!ready) return invalidCapture('ready-manifest-invalid');
  const timeoutMs = dependencies.timeoutMs ?? NORMAL_ENGINE_QUALIFICATION_CAPTURE_TIMEOUT_MS;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 250;
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || ((milliseconds: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > NORMAL_ENGINE_QUALIFICATION_CAPTURE_TIMEOUT_MS
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) return invalidCapture('ack-invalid', ready);
  let readyBytes: Buffer;
  try {
    const reviewYetiRoot = dirname(ready.path);
    const expectedPath = join(reviewYetiRoot, basename(NORMAL_ENGINE_QUALIFICATION_CAPTURE_READY_PATH));
    if (resolve(ready.path) !== expectedPath || resolve(ready.sha256Path) !== `${expectedPath}.sha256`) {
      return invalidCapture('ready-manifest-invalid', ready);
    }
    readyBytes = await readPrivateRegularFile(reviewYetiRoot, basename(expectedPath), NORMAL_ENGINE_QUALIFICATION_CAPTURE_MAX_ACK_BYTES);
    const readyChecksumBytes = await readPrivateRegularFile(reviewYetiRoot, `${basename(expectedPath)}.sha256`);
    const actualReadySha = sha256(readyBytes);
    if (actualReadySha !== ready.sha256 || readyChecksumBytes.toString('utf8') !== `${ready.sha256}\n`) {
      return invalidCapture('ready-manifest-invalid', ready);
    }
    const diskManifest = normalEngineQualificationCaptureReadyV1Schema.parse(JSON.parse(readyBytes.toString('utf8')));
    if (canonicalJson(diskManifest) !== canonicalJson(ready.manifest)
      || diskManifest.artifactSetSha256 !== ready.artifactSetSha256 || diskManifest.artifactCount !== ready.artifactCount) {
      return invalidCapture('ready-manifest-invalid', ready);
    }
  } catch {
    return invalidCapture('ready-manifest-invalid', ready);
  }
  const readySha256 = sha256(readyBytes);
  const markerPath = dependencies.markerPath || NORMAL_ENGINE_QUALIFICATION_CAPTURE_ACK_PATH;
  const startedAt = now();
  if (!Number.isFinite(startedAt)) return invalidCapture('ack-invalid', ready);
  for (;;) {
    try {
      const marker = await lstat(markerPath);
      if (!marker.isFile() || marker.isSymbolicLink() || marker.size > NORMAL_ENGINE_QUALIFICATION_CAPTURE_MAX_ACK_BYTES
        || (marker.mode & 0o777) !== 0o600) {
        if (marker.isFile() || marker.isSymbolicLink()) await unlink(markerPath).catch(() => undefined);
        return invalidCapture('ack-invalid', ready);
      }
      const ackBytes = await readPrivateRegularFile(dirname(markerPath), basename(markerPath), NORMAL_ENGINE_QUALIFICATION_CAPTURE_MAX_ACK_BYTES);
      const ackSha256 = sha256(ackBytes);
      let parsedAck: z.infer<typeof normalEngineQualificationCaptureAckV1Schema>;
      try { parsedAck = normalEngineQualificationCaptureAckV1Schema.parse(JSON.parse(ackBytes.toString('utf8'))); }
      catch {
        await unlink(markerPath).catch(() => undefined);
        return invalidCapture('ack-invalid', ready, ackSha256);
      }
      const expectedAck = {
        planId: ready.manifest.planId,
        runId: ready.manifest.runId,
        planSha256: ready.manifest.planSha256,
        readySha256,
        artifactSetSha256: ready.manifest.artifactSetSha256,
        artifactCount: ready.manifest.artifactCount,
        copiedArtifacts: ready.manifest.artifacts,
        copiedArtifactSetSha256: ready.manifest.artifactSetSha256,
      };
      if (Object.entries(expectedAck).some(([key, value]) => canonicalJson((parsedAck as unknown as Record<string, unknown>)[key]) !== canonicalJson(value))) {
        await unlink(markerPath).catch(() => undefined);
        return invalidCapture('ack-invalid', ready, ackSha256);
      }
      await unlink(markerPath);
      return { requested: true, status: 'acknowledged', readySha256, ackSha256,
        artifactSetSha256: ready.manifest.artifactSetSha256, artifactCount: ready.manifest.artifactCount, reason: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return invalidCapture('ack-invalid', ready);
    }
    const elapsed = now() - startedAt;
    const remaining = timeoutMs - elapsed;
    if (!Number.isFinite(elapsed) || remaining <= 0) {
      return { requested: true, status: 'timed_out', readySha256, ackSha256: null,
        artifactSetSha256: ready.manifest.artifactSetSha256, artifactCount: ready.manifest.artifactCount, reason: 'ack-timeout' };
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

export interface NormalEngineQualificationCaptureOutcomeV1 {
  schemaVersion: typeof NORMAL_ENGINE_QUALIFICATION_CAPTURE_OUTCOME_VERSION;
  purpose: typeof NORMAL_ENGINE_QUALIFICATION_CAPTURE_OUTCOME_PURPOSE;
  planId: typeof NORMAL_ENGINE_QUALIFICATION_PLAN_ID;
  runId: string;
  planSha256: string;
  planTerminalStatus: 'completed' | 'failed';
  captureRequested: boolean;
  captureStatus: NormalEngineQualificationCaptureStatus;
  readySha256: string | null;
  ackSha256: string | null;
  artifactSetSha256: string | null;
  artifactCount: number;
  captureReason: NormalEngineQualificationCaptureReason;
  completedAt: string;
}

export const normalEngineQualificationCaptureOutcomeV1Schema = z.object({
  schemaVersion: z.literal(NORMAL_ENGINE_QUALIFICATION_CAPTURE_OUTCOME_VERSION),
  purpose: z.literal(NORMAL_ENGINE_QUALIFICATION_CAPTURE_OUTCOME_PURPOSE),
  planId: z.literal(NORMAL_ENGINE_QUALIFICATION_PLAN_ID),
  runId: runIdSchema,
  planSha256: digestSchema,
  planTerminalStatus: z.enum(['completed', 'failed']),
  captureRequested: z.boolean(),
  captureStatus: z.enum(['not_requested', 'acknowledged', 'timed_out', 'invalid_ack']),
  readySha256: digestSchema.nullable(),
  ackSha256: digestSchema.nullable(),
  artifactSetSha256: digestSchema.nullable(),
  artifactCount: z.number().int().nonnegative().max(NORMAL_ENGINE_QUALIFICATION_CAPTURE_MAX_ARTIFACTS),
  captureReason: z.enum(['hold-disabled', 'ack-timeout', 'ack-invalid', 'ready-manifest-invalid']).nullable(),
  completedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((outcome, context) => {
  if (outcome.captureStatus === 'not_requested'
    && (outcome.captureRequested || outcome.readySha256 !== null || outcome.ackSha256 !== null
      || outcome.artifactSetSha256 !== null || outcome.artifactCount !== 0 || outcome.captureReason !== 'hold-disabled')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['captureStatus'], message: 'disabled capture outcome has inconsistent evidence' });
  }
  if (outcome.captureStatus === 'acknowledged'
    && (!outcome.captureRequested || outcome.readySha256 === null || outcome.ackSha256 === null
      || outcome.artifactSetSha256 === null || outcome.artifactCount < 2 || outcome.captureReason !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['captureStatus'], message: 'acknowledged capture outcome is incomplete' });
  }
  if (outcome.captureStatus === 'timed_out'
    && (!outcome.captureRequested || outcome.readySha256 === null || outcome.ackSha256 !== null
      || outcome.artifactSetSha256 === null || outcome.artifactCount < 2 || outcome.captureReason !== 'ack-timeout')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['captureStatus'], message: 'timed-out capture outcome is inconsistent' });
  }
  if (outcome.captureStatus === 'invalid_ack'
    && (!outcome.captureRequested || !['ack-invalid', 'ready-manifest-invalid'].includes(outcome.captureReason || '')
      || (outcome.readySha256 === null) !== (outcome.artifactSetSha256 === null)
      || (outcome.readySha256 === null && (outcome.ackSha256 !== null || outcome.artifactCount !== 0))
      || (outcome.readySha256 !== null && outcome.artifactCount < 2))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['captureStatus'], message: 'invalid capture outcome is inconsistent' });
  }
});

export interface NormalEngineQualificationCaptureTerminationMessageV1 {
  schemaVersion: typeof NORMAL_ENGINE_QUALIFICATION_CAPTURE_TERMINATION_MESSAGE_VERSION;
  purpose: typeof NORMAL_ENGINE_QUALIFICATION_CAPTURE_TERMINATION_MESSAGE_PURPOSE;
  outcomeSchemaVersion: typeof NORMAL_ENGINE_QUALIFICATION_CAPTURE_OUTCOME_VERSION;
  outcomeByteCount: number;
  outcomeSha256: string;
  outcomeBase64: string;
}

function canonicalCaptureOutcomeBytes(outcome: NormalEngineQualificationCaptureOutcomeV1): Buffer {
  return Buffer.from(`${canonicalJson(outcome)}\n`, 'utf8');
}

const captureTerminationMessageCoreSchema = z.object({
  schemaVersion: z.literal(NORMAL_ENGINE_QUALIFICATION_CAPTURE_TERMINATION_MESSAGE_VERSION),
  purpose: z.literal(NORMAL_ENGINE_QUALIFICATION_CAPTURE_TERMINATION_MESSAGE_PURPOSE),
  outcomeSchemaVersion: z.literal(NORMAL_ENGINE_QUALIFICATION_CAPTURE_OUTCOME_VERSION),
  outcomeByteCount: z.number().int().positive().safe(),
  outcomeSha256: digestSchema,
  outcomeBase64: z.string().min(1).max(NORMAL_ENGINE_QUALIFICATION_CAPTURE_TERMINATION_MESSAGE_MAX_BYTES * 2),
}).strict();

/** Strict envelope that carries only the canonical, schema-bounded qualification outcome. */
export const normalEngineQualificationCaptureTerminationMessageV1Schema = captureTerminationMessageCoreSchema
  .superRefine((message, context) => {
    const envelopeBytes = Buffer.from(`${canonicalJson(message)}\n`, 'utf8');
    if (envelopeBytes.byteLength >= NORMAL_ENGINE_QUALIFICATION_CAPTURE_TERMINATION_MESSAGE_MAX_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['outcomeBase64'],
        message: 'capture termination message exceeds the Kubernetes message bound' });
    }

    const outcomeBytes = Buffer.from(message.outcomeBase64, 'base64');
    if (outcomeBytes.toString('base64') !== message.outcomeBase64
      || outcomeBytes.byteLength !== message.outcomeByteCount
      || sha256(outcomeBytes) !== message.outcomeSha256) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['outcomeSha256'],
        message: 'capture termination outcome byte count or digest is invalid' });
      return;
    }

    let rawOutcome: unknown;
    try { rawOutcome = JSON.parse(outcomeBytes.toString('utf8')); }
    catch {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['outcomeBase64'],
        message: 'capture termination outcome JSON is invalid' });
      return;
    }
    const outcome = normalEngineQualificationCaptureOutcomeV1Schema.safeParse(rawOutcome);
    if (!outcome.success || outcome.data.schemaVersion !== message.outcomeSchemaVersion
      || !canonicalCaptureOutcomeBytes(outcome.data).equals(outcomeBytes)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['outcomeBase64'],
        message: 'capture termination outcome is not canonical Outcome.v1 JSON' });
    }
  });

/** Decodes the exact Kubernetes termination message and returns its validated private outcome. */
export function parseNormalEngineQualificationCaptureTerminationMessage(
  input: string | Uint8Array,
): { envelope: NormalEngineQualificationCaptureTerminationMessageV1; outcome: NormalEngineQualificationCaptureOutcomeV1 } {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (bytes.byteLength >= NORMAL_ENGINE_QUALIFICATION_CAPTURE_TERMINATION_MESSAGE_MAX_BYTES) {
    throw new Error('normal_engine_qualification_capture_termination_message_too_large');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error('normal_engine_qualification_capture_termination_message_utf8_invalid');
  }
  let rawEnvelope: unknown;
  try { rawEnvelope = JSON.parse(text); }
  catch { throw new Error('normal_engine_qualification_capture_termination_message_json_invalid'); }
  const envelope = normalEngineQualificationCaptureTerminationMessageV1Schema.parse(rawEnvelope);
  if (!Buffer.from(`${canonicalJson(envelope)}\n`, 'utf8').equals(bytes)) {
    throw new Error('normal_engine_qualification_capture_termination_message_not_canonical');
  }
  const outcomeBytes = Buffer.from(envelope.outcomeBase64, 'base64');
  const outcome = normalEngineQualificationCaptureOutcomeV1Schema.parse(JSON.parse(outcomeBytes.toString('utf8')));
  return { envelope, outcome };
}

export interface PersistedNormalEngineQualificationCaptureOutcome {
  path: string;
  sha256Path: string;
  sha256: string;
  idempotent: boolean;
}

export async function persistNormalEngineQualificationCaptureOutcome(
  input: unknown,
  artifactRootDirectory: string = DEFAULT_REVIEW_YETI_ROOT,
): Promise<PersistedNormalEngineQualificationCaptureOutcome> {
  const outcome = normalEngineQualificationCaptureOutcomeV1Schema.parse(input);
  const root = resolve(artifactRootDirectory);
  const storeRootName = basename(NORMAL_ENGINE_QUALIFICATION_STORE_ROOT);
  const relativePath = `${storeRootName}/${outcome.runId}/capture-handoff.record/capture-outcome.json`;
  const path = join(root, relativePath);
  const sha256Path = `${path.slice(0, -'.json'.length)}.sha256`;
  const body = `${canonicalJson(outcome)}\n`;
  const digest = sha256(body);

  const outcomeBytes = Buffer.from(body, 'utf8');
  const rawEnvelope = {
    schemaVersion: NORMAL_ENGINE_QUALIFICATION_CAPTURE_TERMINATION_MESSAGE_VERSION,
    purpose: NORMAL_ENGINE_QUALIFICATION_CAPTURE_TERMINATION_MESSAGE_PURPOSE,
    outcomeSchemaVersion: NORMAL_ENGINE_QUALIFICATION_CAPTURE_OUTCOME_VERSION,
    outcomeByteCount: outcomeBytes.byteLength,
    outcomeSha256: digest,
    outcomeBase64: outcomeBytes.toString('base64'),
  };
  const terminationMessageBody = `${canonicalJson(rawEnvelope)}\n`;
  if (Buffer.byteLength(terminationMessageBody, 'utf8') >= NORMAL_ENGINE_QUALIFICATION_CAPTURE_TERMINATION_MESSAGE_MAX_BYTES) {
    throw new Error('normal_engine_qualification_capture_termination_message_too_large');
  }
  const envelope = normalEngineQualificationCaptureTerminationMessageV1Schema.parse(rawEnvelope);
  const validatedTerminationMessageBody = `${canonicalJson(envelope)}\n`;
  if (validatedTerminationMessageBody !== terminationMessageBody) {
    throw new Error('normal_engine_qualification_capture_termination_message_not_canonical');
  }
  const terminationMessagePath = join(root, basename(NORMAL_ENGINE_QUALIFICATION_CAPTURE_TERMINATION_MESSAGE_PATH));
  const terminationMessageSha256Path = `${terminationMessagePath}.sha256`;
  const terminationMessageSha256 = sha256(terminationMessageBody);

  const idempotent = await persistPrivatePair(path, sha256Path, body, digest);
  await persistPrivatePair(terminationMessagePath, terminationMessageSha256Path,
    terminationMessageBody, terminationMessageSha256);
  return { path, sha256Path, sha256: digest, idempotent };
}
