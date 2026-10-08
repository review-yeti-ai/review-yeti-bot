import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { RepoFileProvider } from '../panel/panelEngine';
import { canonicalJson, sha256 } from './reviewCore';

const SHA = z.string().regex(/^[a-f0-9]{40}$/u);
const DIGEST = z.string().regex(/^[a-f0-9]{64}$/u);
const FINGERPRINT = z.string().regex(/^fp1_[a-f0-9]{24}$/u);
const REVIEW_ID = z.string().regex(/^run_[a-f0-9]{32}$/u);
const repoPath = z.string().min(1).max(4_096).refine((value) => value.replaceAll('\\', '/') === value
  && !path.posix.isAbsolute(value) && !/^[a-z]:/iu.test(value)
  && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'),
'path must be canonical and repository-relative');

export type ReproductionJsonValue = null | boolean | number | string
  | ReproductionJsonValue[] | { [key: string]: ReproductionJsonValue };

const jsonValue: z.ZodType<ReproductionJsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string().max(512),
  z.array(jsonValue).max(16),
  z.record(z.string().min(1).max(128), jsonValue).superRefine((value, context) => {
    if (Object.keys(value).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'prototype keys are not allowed' });
    }
  }),
]));

export const GROUNDED_REPRODUCTION_RECIPE_VERSION = 'GroundedReproductionRecipe.v1' as const;
export const GROUNDED_REPRODUCTION_RECEIPT_VERSION = 'GroundedSandboxReproduction.v1' as const;

/** A recipe is service-owned allowlist data. No command, script, or runtime comes from a review claim. */
export const groundedReproductionRecipeSchema = z.object({
  version: z.literal(GROUNDED_REPRODUCTION_RECIPE_VERSION),
  id: z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/u),
  repository: z.string().min(3).max(500),
  candidatePath: repoPath,
  exportName: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u),
  args: z.array(jsonValue).max(8),
  expectedBase: jsonValue,
  expectedHead: jsonValue,
}).strict();
export type GroundedReproductionRecipeV1 = z.infer<typeof groundedReproductionRecipeSchema>;

const reproductionIdentitySchema = z.object({
  reviewId: REVIEW_ID, repository: z.string().min(3).max(500), baseSha: SHA, headSha: SHA,
  candidateFingerprint: FINGERPRINT, path: repoPath, affectedContextDigest: DIGEST,
  sourceWindowManifestDigest: DIGEST,
}).strict();

const reproductionReceiptMaterialSchema = z.object({
  version: z.literal(GROUNDED_REPRODUCTION_RECEIPT_VERSION),
  status: z.enum(['observed', 'not_observed', 'unavailable', 'rejected']),
  reason: z.string().min(1).max(240).optional(),
  identity: reproductionIdentitySchema,
  limits: z.object({ executionBudgetMs: z.number().int().positive().max(15_000), executionTimeoutMs: z.number().int().positive().max(5_000),
    maxOutputBytes: z.number().int().positive().max(8_192), sourceReadTimeoutMs: z.number().int().positive().max(4_000),
    controlPlaneTimeoutMs: z.number().int().positive().max(12_000), cleanupTimeoutMs: z.literal(8_000) }).strict(),
  recipe: z.object({ id: z.string().min(1).max(128), digest: DIGEST,
    expectedBaseDigest: DIGEST.optional(), expectedHeadDigest: DIGEST.optional() }).strict().optional(),
  sourceManifest: z.object({ digest: DIGEST, files: z.array(z.object({ path: repoPath,
    baseRevisionSha: SHA, headRevisionSha: SHA, baseContentSha256: DIGEST, headContentSha256: DIGEST }).strict()).max(8) }).strict().optional(),
  sandbox: z.object({ runtimeImageDigest: z.string().regex(/^[^@\s]+@sha256:[a-f0-9]{64}$/u),
    runtimeImageId: DIGEST, dockerServerVersion: z.string().min(1).max(100),
    containerConfigDigests: z.array(DIGEST).min(1).max(2), networkMode: z.literal('none'),
    readOnlyRootfs: z.literal(true), capDropAll: z.literal(true), noNewPrivileges: z.literal(true),
    hostSocketMounted: z.literal(false), user: z.literal('1000:1000'), pidsLimit: z.literal(16),
    memoryBytes: z.literal(268_435_456), nanoCpus: z.literal(250_000_000), tmpfsBytes: z.literal(8_388_608),
    shmBytes: z.literal(8_388_608), maxContainerLogBytes: z.literal(65_536) }).strict().optional(),
  executions: z.array(z.object({ side: z.enum(['base', 'head']),
    exitStatus: z.union([z.number().int().min(0).max(255), z.enum(['timeout', 'error'])]),
    durationActualMs: z.number().int().nonnegative().max(15_000), outputDigest: DIGEST.optional() }).strict()).max(2).optional(),
  observations: z.object({ baseMatchesExpected: z.boolean(), headMatchesExpected: z.boolean(),
    baseResultDigest: DIGEST, headResultDigest: DIGEST }).strict().optional(),
}).strict();
export const groundedReproductionReceiptSchema = reproductionReceiptMaterialSchema.extend({ receiptDigest: DIGEST }).strict();
export type GroundedReproductionReceiptV1 = z.infer<typeof groundedReproductionReceiptSchema>;

export interface GroundedReproductionCandidateV1 {
  fingerprint: string;
  path: string;
  line: number;
  severity: 'P0' | 'P1' | 'P2' | 'P3' | 'NIT';
  title: string;
}

export interface GroundedReproductionRequestV1 {
  reviewId: string;
  repository: string;
  baseSha: string;
  headSha: string;
  candidate: GroundedReproductionCandidateV1;
  affectedContextDigest: string;
  sourceWindowManifestDigest: string;
  provider: RepoFileProvider;
  signal?: AbortSignal;
}

export interface GroundedReproductionAdapter {
  reproduce(input: GroundedReproductionRequestV1): Promise<GroundedReproductionReceiptV1>;
}

export interface DockerQualifiedReproductionAdapterOptions {
  /** The Docker endpoint and binary are provided by trusted service code, never review input. */
  dockerHost: string;
  dockerBinaryPath: string;
  /** One adapter instance is bound to exactly one trusted review and its admitted revisions. */
  reviewContext: { reviewId: string; repository: string; baseSha: string; headSha: string };
  /** Immutable service-selected runtime, such as `node@sha256:<digest>`. It is never pulled. */
  runtimeImageDigest: string;
  recipes: readonly GroundedReproductionRecipeV1[];
  tempRoot?: string;
  executionBudgetMs?: number;
  executionTimeoutMs?: number;
  maxOutputBytes?: number;
  sourceReadTimeoutMs?: number;
  controlPlaneTimeoutMs?: number;
}

interface DockerCommandResult {
  exitStatus: number | 'timeout' | 'error';
  stdout: string;
  stderr: string;
  truncated: boolean;
}
type DockerCliChild = ChildProcessByStdio<null, Readable, Readable>;

interface DockerInspection {
  Id?: string;
  Image?: string;
  Config?: { Image?: string; User?: string; Env?: string[]; Entrypoint?: string[]; Cmd?: string[]; Tty?: boolean };
  HostConfig?: { NetworkMode?: string; ReadonlyRootfs?: boolean; CapDrop?: string[]; CapAdd?: string[] | null;
    SecurityOpt?: string[]; PidsLimit?: number; Memory?: number; MemorySwap?: number; NanoCpus?: number;
    Tmpfs?: Record<string, string>; ShmSize?: number; Privileged?: boolean; PortBindings?: Record<string, unknown> | null;
    Binds?: string[] | null; VolumesFrom?: string[] | null; LogConfig?: { Type?: string; Config?: Record<string, string> } };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>;
}

interface DockerImageInspection { Id?: string; RepoDigests?: string[] }

const MAX_SOURCE_BYTES = 32_768;
const MAX_OUTPUT_BYTES = 8_192;
const DEFAULT_EXECUTION_TIMEOUT_MS = 2_500;
const DEFAULT_EXECUTION_BUDGET_MS = 15_000;
const MAX_REPRODUCTIONS_PER_REVIEW = 1;
const MAX_EXECUTION_BUDGET_MS = 15_000;
const MAX_EXECUTION_TIMEOUT_MS = 5_000;
const DEFAULT_SOURCE_READ_TIMEOUT_MS = 4_000;
const MAX_SOURCE_READ_TIMEOUT_MS = 4_000;
const DEFAULT_CONTROL_PLANE_TIMEOUT_MS = 12_000;
const MAX_CONTROL_PLANE_TIMEOUT_MS = 12_000;
const CLEANUP_TIMEOUT_MS = 8_000;
const MEMORY_BYTES = 268_435_456;
const NANO_CPUS = 250_000_000;
const PIDS_LIMIT = 16;
const TMPFS_BYTES = 8_388_608;
const SHM_BYTES = 8_388_608;
const CONTAINER_LOG_BYTES = 65_536;
const REQUIRED_CONTAINER_ENV = Object.freeze(['HOME=/tmp', 'TMPDIR=/tmp', 'CI=1', 'CT_REVIEW_SANDBOX=1',
  'NODE_ENV=production', 'PATH=/usr/local/bin:/usr/bin:/bin']);

function boundedServiceOption(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a positive bounded integer`);
  return Math.min(value, maximum);
}

function reproductionLimits(options: DockerQualifiedReproductionAdapterOptions): GroundedReproductionReceiptV1['limits'] {
  return {
    executionBudgetMs: boundedServiceOption(options.executionBudgetMs, DEFAULT_EXECUTION_BUDGET_MS, 1,
      MAX_EXECUTION_BUDGET_MS, 'executionBudgetMs'),
    executionTimeoutMs: boundedServiceOption(options.executionTimeoutMs, DEFAULT_EXECUTION_TIMEOUT_MS, 100,
      MAX_EXECUTION_TIMEOUT_MS, 'executionTimeoutMs'),
    maxOutputBytes: boundedServiceOption(options.maxOutputBytes, MAX_OUTPUT_BYTES, 512, MAX_OUTPUT_BYTES, 'maxOutputBytes'),
    sourceReadTimeoutMs: boundedServiceOption(options.sourceReadTimeoutMs, DEFAULT_SOURCE_READ_TIMEOUT_MS, 1,
      MAX_SOURCE_READ_TIMEOUT_MS, 'sourceReadTimeoutMs'),
    controlPlaneTimeoutMs: boundedServiceOption(options.controlPlaneTimeoutMs, DEFAULT_CONTROL_PLANE_TIMEOUT_MS, 100,
      MAX_CONTROL_PLANE_TIMEOUT_MS, 'controlPlaneTimeoutMs'),
    cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
  };
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makeReceipt(material: Omit<GroundedReproductionReceiptV1, 'receiptDigest'>): GroundedReproductionReceiptV1 {
  const parsed = reproductionReceiptMaterialSchema.parse(material);
  return groundedReproductionReceiptSchema.parse({ ...parsed, receiptDigest: sha256(canonicalJson(parsed)) });
}

function expectedIdentity(input: GroundedReproductionRequestV1) {
  return { reviewId: input.reviewId, repository: input.repository, baseSha: input.baseSha, headSha: input.headSha,
    candidateFingerprint: input.candidate.fingerprint, path: input.candidate.path,
    affectedContextDigest: input.affectedContextDigest, sourceWindowManifestDigest: input.sourceWindowManifestDigest };
}

function createUnavailableReceipt(input: GroundedReproductionRequestV1, limits: GroundedReproductionReceiptV1['limits'],
  status: 'unavailable' | 'rejected', reason: string,
  extra: Partial<Omit<GroundedReproductionReceiptV1, 'version' | 'status' | 'reason' | 'identity' | 'receiptDigest'>> = {}) {
  return makeReceipt({ version: GROUNDED_REPRODUCTION_RECEIPT_VERSION, status, reason,
    identity: expectedIdentity(input), limits, ...extra });
}

function recipeDigest(recipe: GroundedReproductionRecipeV1): string {
  return sha256(canonicalJson(recipe));
}

function sourceManifestDigest(input: { repository: string; baseSha: string; headSha: string; files: unknown[] }): string {
  return sha256(canonicalJson({ version: 'GroundedReproductionSourceManifest.v1', ...input }));
}

/** Rechecks receipt integrity and all review coordinates before an engine may attach it. */
export function validateGroundedReproductionReceipt(value: unknown, expected: {
  reviewId: string; repository: string; baseSha: string; headSha: string; candidateFingerprint: string; path: string;
  affectedContextDigest: string; sourceWindowManifestDigest: string;
}): GroundedReproductionReceiptV1 | null {
  const parsed = groundedReproductionReceiptSchema.safeParse(value);
  if (!parsed.success) return null;
  const { receiptDigest, ...material } = parsed.data;
  if (sha256(canonicalJson(material)) !== receiptDigest
    || canonicalJson(parsed.data.identity) !== canonicalJson(expected)) return null;
  const receipt = parsed.data;
  if (receipt.sourceManifest && (receipt.sourceManifest.files.length !== 1
    || receipt.sourceManifest.files[0]?.path !== expected.path
    || receipt.sourceManifest.files[0]?.baseRevisionSha !== expected.baseSha
    || receipt.sourceManifest.files[0]?.headRevisionSha !== expected.headSha
    || sourceManifestDigest({ repository: expected.repository, baseSha: expected.baseSha, headSha: expected.headSha,
      files: receipt.sourceManifest.files }) !== receipt.sourceManifest.digest)) return null;
  if (receipt.status === 'observed' || receipt.status === 'not_observed') {
    const recipe = receipt.recipe, source = receipt.sourceManifest, sandbox = receipt.sandbox;
    const executions = receipt.executions, observations = receipt.observations;
    if (!recipe?.expectedBaseDigest || !recipe.expectedHeadDigest || recipe.expectedBaseDigest === recipe.expectedHeadDigest
      || !source || !sandbox || !executions || executions.length !== 2 || !observations
      || executions[0]?.side !== 'base' || executions[1]?.side !== 'head'
      || executions.some((execution) => execution.exitStatus !== 0 || !execution.outputDigest
        || execution.durationActualMs > receipt.limits.executionTimeoutMs)
      || executions.reduce((total, execution) => total + execution.durationActualMs, 0) > receipt.limits.executionBudgetMs
      || sandbox.containerConfigDigests.length !== 2
      || observations.baseMatchesExpected !== (observations.baseResultDigest === recipe.expectedBaseDigest)
      || observations.headMatchesExpected !== (observations.headResultDigest === recipe.expectedHeadDigest)
      || (receipt.status === 'observed') !== (observations.baseMatchesExpected && observations.headMatchesExpected)) return null;
  }
  return receipt;
}

function safeRepoPath(value: string): boolean {
  return repoPath.safeParse(value).success;
}

function canonicalSourceFile(pathValue: string, content: string, side: 'base' | 'head', result: {
  sha: string; presence?: 'present' | 'absent' | 'unavailable'; source?: { repository: string; path: string; side: string };
  contentSha256?: string;
}, expected: { repository: string; revisionSha: string }): {
  path: string; content: string; revisionSha: string; contentSha256: string;
} | null {
  if (!safeRepoPath(pathValue) || result.sha !== expected.revisionSha || result.presence !== 'present'
    || result.source?.repository !== expected.repository || result.source.path !== pathValue || result.source.side !== side) return null;
  const contentSha256 = hashText(content);
  if (!content || Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES
    || result.contentSha256 !== undefined && result.contentSha256 !== contentSha256) return null;
  return { path: pathValue, content, revisionSha: result.sha, contentSha256 };
}

function harnessText(): string {
  return `import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const recipe = JSON.parse(await fs.readFile('/harness/recipe.json', 'utf8'));
const side = process.argv[2];
if (side !== 'base' && side !== 'head') process.exit(31);
const root = '/workspace';
const entry = path.resolve(root, recipe.sourcePath);
if (!entry.startsWith(root + path.sep)) process.exit(32);
const moduleUrl = pathToFileURL(entry).href + '?review-yeti-reproduction=' + side;
const loaded = await import(moduleUrl);
const fn = loaded[recipe.exportName];
if (typeof fn !== 'function') process.exit(33);
const result = await fn(...recipe.args);
const output = JSON.stringify(result);
if (output === undefined || Buffer.byteLength(output, 'utf8') > 4096) process.exit(34);
process.stdout.write(JSON.stringify({ version: 'QualifiedReproductionHarness.v1', side, result }));
`;
}

function cleanJson(value: unknown, depth = 0, nodes = { value: 0 }): ReproductionJsonValue {
  nodes.value += 1;
  if (nodes.value > 128 || depth > 4) throw new Error('result_bounds_exceeded');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 512) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 16) return value.map((item) => cleanJson(item, depth + 1, nodes));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 16 || entries.some(([key]) => ['__proto__', 'constructor', 'prototype'].includes(key))) {
      throw new Error('result_bounds_exceeded');
    }
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, cleanJson(item, depth + 1, nodes)]));
  }
  throw new Error('result_not_json');
}

function decodeOutput(value: string, side: 'base' | 'head') {
  const parsed = JSON.parse(value.trim()) as Record<string, unknown>;
  if (parsed.version !== 'QualifiedReproductionHarness.v1' || parsed.side !== side) throw new Error('harness_output_mismatch');
  const result = cleanJson(parsed.result);
  return { result, resultDigest: sha256(canonicalJson(result)) };
}

function terminateProcessGroup(child: DockerCliChild, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
    try { process.kill(-child.pid, signal); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; }
  }
  try { child.kill(signal); } catch { /* process may already have exited */ }
}

async function runDockerCli(input: { binaryPath: string; host: string; configDir: string; args: string[];
  timeoutMs: number; maxBytes: number; signal?: AbortSignal }): Promise<DockerCommandResult> {
  if (input.signal?.aborted) return { exitStatus: 'error', stdout: '', stderr: '', truncated: false };
  return new Promise((resolve) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0), stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0), truncated = false;
    let timedOut = false, aborted = false, settled = false, timer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let child: DockerCliChild;
    const finish = (exitStatus: DockerCommandResult['exitStatus']) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener('abort', abort);
      resolve({ exitStatus, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), truncated });
    };
    const kill = () => {
      terminateProcessGroup(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), 250);
    };
    const abort = () => { aborted = true; kill(); };
    try {
      child = spawn(input.binaryPath, ['--host', input.host, ...input.args], {
        shell: false, detached: process.platform !== 'win32', cwd: input.configDir,
        env: { PATH: `${path.dirname(input.binaryPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: input.configDir,
          DOCKER_CONFIG: input.configDir, CI: '1', CT_REVIEW_SANDBOX: '1', NODE_ENV: 'production' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as DockerCliChild;
    } catch {
      return finish('error');
    }
    const append = (target: Buffer<ArrayBufferLike>, other: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      const remaining = input.maxBytes - target.length - other.length;
      if (remaining <= 0) { truncated = true; return target; }
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([target, chunk.subarray(0, remaining)]);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, stderr, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, stdout, chunk); });
    child.on('close', (code: number | null) => finish(timedOut ? 'timeout' : aborted ? 'error' : (code ?? 1)));
    child.on('error', () => finish('error'));
    input.signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { timedOut = true; kill(); }, input.timeoutMs);
  });
}

async function makePrivateDirectory(parent: string, prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(parent, prefix));
  await fs.chmod(directory, 0o700);
  return directory;
}

async function makeTreeReadOnly(root: string): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await makeTreeReadOnly(target);
    else await fs.chmod(target, 0o444);
  }
  await fs.chmod(root, 0o555);
}

async function makeTreeWritable(root: string): Promise<void> {
  await fs.chmod(root, 0o700).catch(() => undefined);
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await makeTreeWritable(target);
    else await fs.chmod(target, 0o600).catch(() => undefined);
  }
}

async function writeSourceFile(root: string, sourcePath: string, content: string): Promise<void> {
  if (!safeRepoPath(sourcePath)) throw new Error('source_path_invalid');
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...sourcePath.split('/'));
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('source_path_invalid');
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, content, { encoding: 'utf8', mode: 0o400, flag: 'wx' });
}

function safeLocalDockerEndpoint(value: string): boolean {
  return /^unix:\/\/\/[^\0\r\n]+$/u.test(value);
}

function emptyObject(value: unknown): boolean {
  return value == null || (typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length === 0);
}

function safeContainerEnv(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  const allowed = new Set(['PATH', 'NODE_VERSION', 'YARN_VERSION', 'HOME', 'TMPDIR', 'CI', 'CT_REVIEW_SANDBOX', 'NODE_ENV']);
  const seen = new Map<string, string>();
  for (const entry of value) {
    if (typeof entry !== 'string') return false;
    const index = entry.indexOf('=');
    if (index < 1) return false;
    const key = entry.slice(0, index), item = entry.slice(index + 1);
    if (!allowed.has(key) || seen.has(key) || /(?:TOKEN|SECRET|CREDENTIAL|API_KEY|PASSWORD)/iu.test(key)) return false;
    seen.set(key, item);
  }
  return REQUIRED_CONTAINER_ENV.every((entry) => {
    const index = entry.indexOf('=');
    return seen.get(entry.slice(0, index)) === entry.slice(index + 1);
  });
}

function containerConfigDigest(inspect: DockerInspection, expected: { imageRef: string; imageId: string;
  sourceRoot: string; harnessRoot: string; command: string[] }): string | null {
  const config = inspect.Config, host = inspect.HostConfig, mounts = inspect.Mounts;
  if (!config || !host || !Array.isArray(mounts) || inspect.Image !== expected.imageId || config.Image !== expected.imageRef
    || config.User !== '1000:1000' || config.Tty !== false || !safeContainerEnv(config.Env)
    || canonicalJson(config.Entrypoint) !== canonicalJson(['/usr/local/bin/node'])
    || canonicalJson(config.Cmd) !== canonicalJson(expected.command)
    || host.NetworkMode !== 'none' || host.ReadonlyRootfs !== true || host.Privileged !== false
    || canonicalJson(host.CapDrop) !== canonicalJson(['ALL']) || (host.CapAdd?.length ?? 0) !== 0
    || !host.SecurityOpt?.includes('no-new-privileges:true') || host.PidsLimit !== PIDS_LIMIT
    || host.Memory !== MEMORY_BYTES || host.MemorySwap !== MEMORY_BYTES || host.NanoCpus !== NANO_CPUS
    || host.Tmpfs?.['/tmp'] !== `rw,noexec,nosuid,nodev,size=${TMPFS_BYTES},uid=1000,gid=1000`
    || host.ShmSize !== SHM_BYTES || host.LogConfig?.Type !== 'local'
    || host.LogConfig.Config?.['max-size'] !== '64k' || host.LogConfig.Config?.['max-file'] !== '1'
    || host.LogConfig.Config?.compress !== 'false'
    || !emptyObject(host.PortBindings) || (host.Binds?.length ?? 0) > 0 || (host.VolumesFrom?.length ?? 0) > 0
    || mounts.length !== 2) return null;
  const byDestination = new Map(mounts.map((mount) => [mount.Destination, mount]));
  const source = byDestination.get('/workspace'), harness = byDestination.get('/harness');
  if (!source || !harness || source.Type !== 'bind' || harness.Type !== 'bind'
    || source.Source !== expected.sourceRoot || harness.Source !== expected.harnessRoot
    || source.RW !== false || harness.RW !== false
    || mounts.some((mount) => `${mount.Source} ${mount.Destination}`.includes('docker.sock'))) return null;
  return sha256(canonicalJson({ imageId: inspect.Image, imageRef: config.Image, user: config.User,
    env: config.Env, entrypoint: config.Entrypoint, command: config.Cmd,
    host: { networkMode: host.NetworkMode, readOnlyRootfs: host.ReadonlyRootfs, privileged: host.Privileged,
      capDrop: host.CapDrop, capAdd: host.CapAdd ?? [], securityOpt: host.SecurityOpt, pidsLimit: host.PidsLimit,
      memory: host.Memory, memorySwap: host.MemorySwap, nanoCpus: host.NanoCpus, tmpfs: host.Tmpfs,
      shmSize: host.ShmSize, logConfig: host.LogConfig },
    mounts: mounts.map((mount) => ({ type: mount.Type, destination: mount.Destination, readOnly: mount.RW === false })) }));
}

export function createDockerQualifiedReproductionAdapter(options: DockerQualifiedReproductionAdapterOptions): GroundedReproductionAdapter {
  if (!path.isAbsolute(options.dockerBinaryPath) || !safeLocalDockerEndpoint(options.dockerHost)
    || !/^[^@\s]+@sha256:[a-f0-9]{64}$/u.test(options.runtimeImageDigest)) {
    throw new Error('qualified reproduction requires a service-owned Docker binary, local Unix socket, and immutable runtime image');
  }
  const reviewContext = z.object({ reviewId: REVIEW_ID, repository: z.string().min(3).max(500),
    baseSha: SHA, headSha: SHA }).strict().parse(options.reviewContext);
  const dockerBinaryPath = options.dockerBinaryPath;
  const limits = reproductionLimits(options);
  const recipes = options.recipes.map((recipe) => groundedReproductionRecipeSchema.parse(recipe));
  if (!recipes.length || recipes.length > 64 || new Set(recipes.map((recipe) => `${recipe.repository}:${recipe.id}`)).size !== recipes.length) {
    throw new Error('qualified reproduction recipes must be non-empty and uniquely identified');
  }
  const tempRoot = path.resolve(options.tempRoot ?? os.tmpdir());
  let reproductionAttempts = 0;

  return {
    async reproduce(input): Promise<GroundedReproductionReceiptV1> {
      const identity = expectedIdentity(input);
      const unavailable = (status: 'unavailable' | 'rejected', reason: string,
        extra: Partial<Omit<GroundedReproductionReceiptV1, 'version' | 'status' | 'reason' | 'identity' | 'receiptDigest'>> = {}) =>
        createUnavailableReceipt(input, limits, status, reason, extra);
      if (!REVIEW_ID.safeParse(input.reviewId).success || !SHA.safeParse(input.baseSha).success
        || !SHA.safeParse(input.headSha).success || !FINGERPRINT.safeParse(input.candidate.fingerprint).success
        || !DIGEST.safeParse(input.affectedContextDigest).success || !DIGEST.safeParse(input.sourceWindowManifestDigest).success
        || !safeRepoPath(input.candidate.path)) throw new Error('reproduction_request_identity_invalid');
      if (input.reviewId !== reviewContext.reviewId || input.repository !== reviewContext.repository
        || input.baseSha !== reviewContext.baseSha || input.headSha !== reviewContext.headSha) {
        return unavailable('rejected', 'review_context_mismatch');
      }
      if (input.candidate.severity !== 'P0' && input.candidate.severity !== 'P1') {
        return unavailable('unavailable', 'reproduction_is_blocker_only');
      }
      if (input.signal?.aborted) return unavailable('unavailable', 'review_aborted');
      if (reproductionAttempts >= MAX_REPRODUCTIONS_PER_REVIEW) return unavailable('unavailable', 'per_review_limit');
      const recipe = recipes.find((entry) => entry.repository === input.repository && entry.candidatePath === input.candidate.path);
      if (!recipe) return unavailable('unavailable', 'no_qualified_recipe');
      reproductionAttempts += 1;

      const containerNames: string[] = [];
      const executionRows: NonNullable<GroundedReproductionReceiptV1['executions']> = [];
      let tempDirectory: string | undefined;
      let dockerConfigDirectory: string | undefined;
      let cleanupFailed = false;
      let sourceReadTimedOut = false;
      const partial = (status: 'unavailable' | 'rejected', reason: string,
        fields: Partial<Omit<GroundedReproductionReceiptV1, 'version' | 'status' | 'reason' | 'identity' | 'receiptDigest'>> = {}) =>
        unavailable(status, reason, { recipe: { id: recipe.id, digest: recipeDigest(recipe) }, ...fields });

      try {
        if (typeof input.provider.readFileAt !== 'function') return partial('unavailable', 'pinned_source_reader_unavailable');
        const sourceAbortController = new AbortController();
        let sourceReadTimer: NodeJS.Timeout | undefined;
        let reviewAbortHandler: (() => void) | undefined;
        let sourceReadSucceeded = false;
        let baseRead: Awaited<ReturnType<NonNullable<RepoFileProvider['readFileAt']>>>;
        let headRead: Awaited<ReturnType<NonNullable<RepoFileProvider['readFileAt']>>>;
        try {
          const reads = Promise.all([
            input.provider.readFileAt(recipe.candidatePath, 'base', { signal: sourceAbortController.signal }),
            input.provider.readFileAt(recipe.candidatePath, 'head', { signal: sourceAbortController.signal }),
          ]);
          const reviewAbort = new Promise<never>((_resolve, reject) => {
            if (!input.signal) return;
            reviewAbortHandler = () => {
              sourceAbortController.abort();
              reject(new Error('review_aborted'));
            };
            input.signal.addEventListener('abort', reviewAbortHandler, { once: true });
          });
          const sourceTimeout = new Promise<never>((_resolve, reject) => {
            sourceReadTimer = setTimeout(() => {
              sourceReadTimedOut = true;
              sourceAbortController.abort();
              reject(new Error('source_read_timeout'));
            }, limits.sourceReadTimeoutMs);
          });
          [baseRead, headRead] = await Promise.race([reads, reviewAbort, sourceTimeout]);
          sourceReadSucceeded = true;
        } catch (error) {
          if (sourceReadTimedOut) return partial('unavailable', 'source_read_timeout');
          if (input.signal?.aborted) return partial('unavailable', 'review_aborted');
          return partial('unavailable', 'pinned_source_read_failed');
        } finally {
          if (!sourceReadSucceeded) sourceAbortController.abort();
          if (sourceReadTimer) clearTimeout(sourceReadTimer);
          if (reviewAbortHandler) input.signal?.removeEventListener('abort', reviewAbortHandler);
        }
        if (!baseRead || !headRead || baseRead.content === null || headRead.content === null) {
          return partial('unavailable', 'pinned_source_read_unavailable');
        }
        const baseFile = canonicalSourceFile(recipe.candidatePath, baseRead.content, 'base', baseRead,
          { repository: input.repository, revisionSha: input.baseSha });
        const headFile = canonicalSourceFile(recipe.candidatePath, headRead.content, 'head', headRead,
          { repository: input.repository, revisionSha: input.headSha });
        if (!baseFile || !headFile) return partial('rejected', 'source_revision_mismatch');
        if (Buffer.byteLength(baseFile.content, 'utf8') + Buffer.byteLength(headFile.content, 'utf8') > MAX_SOURCE_BYTES) {
          return partial('unavailable', 'source_size_limit');
        }
        const sourceManifestFiles = [{ path: recipe.candidatePath, baseRevisionSha: baseFile.revisionSha,
          headRevisionSha: headFile.revisionSha, baseContentSha256: baseFile.contentSha256,
          headContentSha256: headFile.contentSha256 }];
        const sourceManifest = { digest: sourceManifestDigest({ repository: input.repository, baseSha: input.baseSha,
          headSha: input.headSha, files: sourceManifestFiles }), files: sourceManifestFiles };

        tempDirectory = await makePrivateDirectory(tempRoot, 'review-yeti-reproduction-');
        dockerConfigDirectory = path.join(tempDirectory, 'docker-config');
        await fs.mkdir(dockerConfigDirectory, { mode: 0o700 });
        await fs.writeFile(path.join(dockerConfigDirectory, 'config.json'), '{}', { mode: 0o400, flag: 'wx' });
        const baseRoot = path.join(tempDirectory, 'base');
        const headRoot = path.join(tempDirectory, 'head');
        const harnessRoot = path.join(tempDirectory, 'harness');
        await fs.mkdir(baseRoot, { mode: 0o700 });
        await fs.mkdir(headRoot, { mode: 0o700 });
        await fs.mkdir(harnessRoot, { mode: 0o700 });
        await writeSourceFile(baseRoot, recipe.candidatePath, baseFile.content);
        await writeSourceFile(headRoot, recipe.candidatePath, headFile.content);
        await fs.writeFile(path.join(harnessRoot, 'recipe.json'), JSON.stringify({ sourcePath: recipe.candidatePath,
          exportName: recipe.exportName, args: recipe.args }), { mode: 0o400, flag: 'wx' });
        await fs.writeFile(path.join(harnessRoot, 'run.mjs'), harnessText(), { mode: 0o400, flag: 'wx' });
        await Promise.all([makeTreeReadOnly(baseRoot), makeTreeReadOnly(headRoot), makeTreeReadOnly(harnessRoot)]);

        const controlDeadlineAt = Date.now() + limits.controlPlaneTimeoutMs;
        const runBoundedDocker = async (args: string[], limitMs: number, deadlineAt: number,
          signal = input.signal, maxBytes = Math.max(limits.maxOutputBytes, 16_384)): Promise<DockerCommandResult> => {
          const remaining = deadlineAt - Date.now();
          if (!dockerConfigDirectory || remaining < 1) return { exitStatus: 'timeout', stdout: '', stderr: '', truncated: false };
          return runDockerCli({ binaryPath: dockerBinaryPath, host: options.dockerHost, configDir: dockerConfigDirectory,
            args, timeoutMs: Math.max(1, Math.min(limitMs, remaining)), maxBytes, signal });
        };
        const control = (args: string[], limitMs: number, signal = input.signal, maxBytes = Math.max(limits.maxOutputBytes, 16_384)) =>
          runBoundedDocker(args, limitMs, controlDeadlineAt, signal, maxBytes);

        const serverVersion = await control(['version', '--format', '{{.Server.Version}}'], 2_000);
        if (serverVersion.exitStatus !== 0 || serverVersion.truncated || !serverVersion.stdout.trim()) {
          return partial('unavailable', 'docker_engine_unavailable', { sourceManifest });
        }
        const imageResult = await control(['image', 'inspect', options.runtimeImageDigest], 2_000);
        if (imageResult.exitStatus !== 0 || imageResult.truncated) {
          return partial('unavailable', 'pinned_runtime_image_unavailable', { sourceManifest });
        }
        let imageInfo: DockerImageInspection;
        try { imageInfo = (JSON.parse(imageResult.stdout) as DockerImageInspection[])[0]!; }
        catch { return partial('unavailable', 'pinned_runtime_image_unreadable', { sourceManifest }); }
        if (!imageInfo?.Id || !imageInfo.RepoDigests?.includes(options.runtimeImageDigest)) {
          return partial('rejected', 'runtime_image_digest_mismatch', { sourceManifest });
        }

        const configDigests: string[] = [];
        const sandboxReceipt = () => ({ runtimeImageDigest: options.runtimeImageDigest,
          runtimeImageId: imageInfo.Id!.replace(/^sha256:/u, ''), dockerServerVersion: serverVersion.stdout.trim(),
          containerConfigDigests: [...configDigests], networkMode: 'none' as const, readOnlyRootfs: true as const,
          capDropAll: true as const, noNewPrivileges: true as const, hostSocketMounted: false as const,
          user: '1000:1000' as const, pidsLimit: 16 as const, memoryBytes: MEMORY_BYTES as 268_435_456,
          nanoCpus: NANO_CPUS as 250_000_000, tmpfsBytes: TMPFS_BYTES as 8_388_608, shmBytes: SHM_BYTES as 8_388_608,
          maxContainerLogBytes: CONTAINER_LOG_BYTES as 65_536 });
        const observations: Partial<{ base: { resultDigest: string; matches: boolean }; head: { resultDigest: string; matches: boolean } }> = {};
        let executionSpentMs = 0;
        for (const side of ['base', 'head'] as const) {
          const remainingExecutionMs = limits.executionBudgetMs - executionSpentMs;
          if (remainingExecutionMs < 1) return partial('unavailable', 'execution_budget_exhausted', {
            sourceManifest, executions: executionRows, ...(configDigests.length ? { sandbox: sandboxReceipt() } : {}) });
          const sourceRoot = side === 'base' ? baseRoot : headRoot;
          const containerName = `review-yeti-repro-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
          containerNames.push(containerName);
          const commandArgs = ['--experimental-strip-types', '/harness/run.mjs', side];
          const create = await control(['create', '--pull=never', '--name', containerName,
            '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
            '--user=1000:1000', `--pids-limit=${PIDS_LIMIT}`, `--memory=${MEMORY_BYTES}`,
            `--memory-swap=${MEMORY_BYTES}`, '--cpus=0.25', `--shm-size=${SHM_BYTES}`,
            `--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=${TMPFS_BYTES},uid=1000,gid=1000`,
            '--log-driver=local', '--log-opt=max-size=64k', '--log-opt=max-file=1', '--log-opt=compress=false',
            '--mount', `type=bind,source=${sourceRoot},target=/workspace,readonly`,
            '--mount', `type=bind,source=${harnessRoot},target=/harness,readonly`,
            '--workdir=/workspace', ...REQUIRED_CONTAINER_ENV.map((value) => `--env=${value}`),
            '--entrypoint=/usr/local/bin/node', options.runtimeImageDigest, ...commandArgs], 5_000);
          if (create.exitStatus !== 0 || create.truncated || !create.stdout.trim()) {
            return partial('unavailable', create.exitStatus === 'timeout' ? 'container_create_timeout'
              : create.exitStatus === 'error' ? 'docker_cli_unavailable' : 'container_create_failed',
            { sourceManifest, executions: executionRows, ...(configDigests.length ? { sandbox: sandboxReceipt() } : {}) });
          }
          const containerId = create.stdout.trim();
          const inspectResult = await control(['inspect', '--type=container', containerId], 3_000);
          if (inspectResult.exitStatus !== 0 || inspectResult.truncated) {
            return partial('rejected', 'container_config_unreadable', { sourceManifest, executions: executionRows });
          }
          let inspection: DockerInspection;
          try { inspection = (JSON.parse(inspectResult.stdout) as DockerInspection[])[0]!; }
          catch { return partial('rejected', 'container_config_unreadable', { sourceManifest, executions: executionRows }); }
          const configDigest = containerConfigDigest(inspection, { imageRef: options.runtimeImageDigest,
            imageId: imageInfo.Id, sourceRoot, harnessRoot, command: commandArgs });
          if (!configDigest) return partial('rejected', 'container_isolation_profile_mismatch', {
            sourceManifest, executions: executionRows });
          configDigests.push(configDigest);

          const sideBudgetMs = Math.min(limits.executionTimeoutMs, remainingExecutionMs);
          const executionStartedAt = Date.now();
          const executionDeadlineAt = executionStartedAt + sideBudgetMs;
          const started = await runBoundedDocker(['start', containerId], Math.min(2_000, sideBudgetMs), executionDeadlineAt);
          if (started.exitStatus !== 0) {
            const durationActualMs = Date.now() - executionStartedAt;
            executionSpentMs += durationActualMs;
            executionRows.push({ side, exitStatus: started.exitStatus === 'timeout' ? 'timeout' : 'error', durationActualMs });
            return partial('unavailable', started.exitStatus === 'timeout' ? 'container_start_timeout' : 'container_start_failed',
              { sourceManifest, executions: executionRows, sandbox: sandboxReceipt() });
          }
          const waitRemainingMs = executionDeadlineAt - Date.now();
          const waited = waitRemainingMs > 0
            ? await runBoundedDocker(['wait', containerId], waitRemainingMs, executionDeadlineAt)
            : { exitStatus: 'timeout' as const, stdout: '', stderr: '', truncated: false };
          const durationActualMs = Date.now() - executionStartedAt;
          executionSpentMs += durationActualMs;
          if (waited.exitStatus === 'timeout') {
            executionRows.push({ side, exitStatus: 'timeout', durationActualMs });
            return partial('unavailable', 'execution_timeout', { sourceManifest, executions: executionRows,
              sandbox: sandboxReceipt() });
          }
          if (waited.exitStatus !== 0) {
            executionRows.push({ side, exitStatus: 'error', durationActualMs });
            return partial('unavailable', 'container_wait_failed', { sourceManifest, executions: executionRows,
              sandbox: sandboxReceipt() });
          }
          const exitCode = Number(waited.stdout.trim());
          const logs = await control(['logs', containerId], 1_000, input.signal, limits.maxOutputBytes);
          const outputDigest = sha256(`${logs.stdout}${logs.stderr}`);
          if (logs.exitStatus !== 0 || logs.truncated || !Number.isSafeInteger(exitCode)) {
            executionRows.push({ side, exitStatus: 'error', durationActualMs, outputDigest });
            return partial('unavailable', 'container_output_unavailable', { sourceManifest, executions: executionRows,
              sandbox: sandboxReceipt() });
          }
          executionRows.push({ side, exitStatus: exitCode, durationActualMs, outputDigest });
          if (exitCode !== 0) return partial('unavailable', 'reproduction_harness_failed', { sourceManifest,
            executions: executionRows, sandbox: sandboxReceipt() });
          const parsed = decodeOutput(logs.stdout, side);
          const expected = side === 'base' ? recipe.expectedBase : recipe.expectedHead;
          observations[side] = { resultDigest: parsed.resultDigest, matches: canonicalJson(parsed.result) === canonicalJson(expected) };
        }

        const baseObservation = observations.base, headObservation = observations.head;
        if (!baseObservation || !headObservation || configDigests.length !== 2 || executionRows.length !== 2) {
          return partial('unavailable', 'reproduction_output_incomplete', { sourceManifest, executions: executionRows,
            ...(configDigests.length ? { sandbox: sandboxReceipt() } : {}) });
        }
        if (executionSpentMs > limits.executionBudgetMs) {
          return partial('unavailable', 'execution_budget_exhausted', { sourceManifest, executions: executionRows,
            sandbox: sandboxReceipt() });
        }
        const status = baseObservation.matches && headObservation.matches ? 'observed' : 'not_observed';
        return makeReceipt({ version: GROUNDED_REPRODUCTION_RECEIPT_VERSION, status, identity,
          limits, recipe: { id: recipe.id, digest: recipeDigest(recipe),
            expectedBaseDigest: sha256(canonicalJson(recipe.expectedBase)), expectedHeadDigest: sha256(canonicalJson(recipe.expectedHead)) },
          sourceManifest, executions: executionRows, sandbox: sandboxReceipt(),
          observations: { baseMatchesExpected: baseObservation.matches, headMatchesExpected: headObservation.matches,
            baseResultDigest: baseObservation.resultDigest, headResultDigest: headObservation.resultDigest } });
      } catch (error) {
        const reason = sourceReadTimedOut ? 'source_read_timeout' : input.signal?.aborted ? 'review_aborted'
          : error instanceof Error && /timeout/iu.test(error.message) ? 'execution_timeout' : 'reproduction_adapter_failed';
        return partial('unavailable', reason, { executions: executionRows });
      } finally {
        let cleanupFailed = false;
        const cleanupDeadlineAt = Date.now() + limits.cleanupTimeoutMs;
        for (const containerName of containerNames) {
          let removed = false;
          for (let attempt = 0; attempt < 2 && !removed; attempt += 1) {
            const remainingMs = cleanupDeadlineAt - Date.now();
            if (remainingMs < 1) break;
            const cleanup = await runDockerCli({ binaryPath: dockerBinaryPath, host: options.dockerHost,
              configDir: dockerConfigDirectory ?? tempRoot, args: ['rm', '--force', containerName],
              timeoutMs: Math.min(3_000, remainingMs), maxBytes: 1_024 }).catch(() => null);
            if (cleanup?.exitStatus === 0) { removed = true; break; }
            const psRemainingMs = cleanupDeadlineAt - Date.now();
            if (psRemainingMs < 1) break;
            const remaining = await runDockerCli({ binaryPath: dockerBinaryPath, host: options.dockerHost,
              configDir: dockerConfigDirectory ?? tempRoot, args: ['ps', '-aq', '--filter', `name=^/${containerName}$`],
              timeoutMs: Math.min(1_000, psRemainingMs), maxBytes: 1_024 }).catch(() => null);
            removed = remaining?.exitStatus === 0 && remaining.stdout.trim().length === 0;
          }
          if (!removed) cleanupFailed = true;
        }
        if (tempDirectory) {
          await makeTreeWritable(tempDirectory);
          await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
        if (cleanupFailed) throw new Error('qualified_reproduction_container_cleanup_failed');
      }
    },
  };
}
