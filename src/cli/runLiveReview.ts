import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { executePersonaPanel } from '../panel/panelEngine';
import { generatePRSummary } from '../review/summaryEngine';
import { generateMermaidDiagram } from '../review/mermaidEngine';
import { computeAppVerdict } from '../review/reviewAdapters';
import { CommentPublisher } from '../github/commentPublisher';
import { getGitHubAppInstallationToken } from '../github/appAuth';
import { loadSameHeadReviewSource } from '../github/qualificationReader';
import type { SameHeadReviewSource } from '../github/qualificationReader';
import { OpenRouterClient, OpenRouterResponseError, OpenRouterTimeoutError } from '../gateway/openRouterClient';
import type { ReviewModelClient, TokensUsed } from '../gateway/openRouterClient';
import { createDefaultV3Config } from '../config/configLoader';
import type { CtReviewConfigV3 } from '../config/schema';
import type { PanelFinding, PanelResult, PanelRequestPolicy } from '../panel/panelEngine';
import {
  compareFindingFingerprints,
  FINDING_FINGERPRINT_VERSION,
  MAX_FINDING_FINGERPRINTS,
  type QualificationFindingFingerprint,
} from '../qualification/findingFingerprint';
import {
  isPublishingReviewWorker,
  runPublishingReviewWorker,
} from './publishingReview';
import { GitHubInstallationClient } from '../github/installationClient';
import { logger } from '../utils/logger';
import workerSelfTestModules from './workerSelfTestModules.json';

export interface WorkerAuthConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}

const GH_EXEC_OPTIONS = {
  encoding: 'utf-8' as const,
  maxBuffer: 64 * 1024 * 1024,
  timeout: 120_000,
};

export const RECEIPT_ONLY_PATH = '/workspace/.review-yeti/receipt.json';

const WORKER_SELF_TEST_MODULES = workerSelfTestModules.map(({ id }) => id);

export interface WorkerSelfTestResult {
  ok: true;
  nodeVersion: string;
  runtimeManifestDigest: string;
  loadedModuleIds: string[];
}

export interface ReceiptOnlyWorkerReceipt {
  version: 'ReviewYetiReceiptOnly.v1';
  status: 'succeeded';
  runId: string;
  deliveryId: string;
  repositoryId: number;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  configDigest: string;
  publicationMode: 'disabled';
  providerCalls: 0;
  githubWrites: 0;
  startedAt: string;
  completedAt: string;
}

/**
 * A provider qualification receipt proves only that one explicitly selected
 * provider completed a streamed request. It intentionally contains no review
 * content, credentials, GitHub writes, or publication decision.
 */
export interface ProviderQualificationReceipt {
  version: 'ReviewYetiProviderQualification.v1';
  status: 'succeeded';
  runId: string;
  deliveryId: string;
  repositoryId: number;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  configDigest: string;
  providerId: string;
  requestedModel: string;
  resolvedModel: string;
  responseDigest: string;
  responseChars: number;
  publicationMode: 'disabled';
  providerCalls: 1;
  githubWrites: 0;
  usage: TokensUsed | null;
  costUSD: number | null;
  startedAt: string;
  completedAt: string;
}

export interface PanelQualificationReceipt {
  version: 'ReviewYetiPanelQualification.v1';
  status: 'succeeded';
  runId: string;
  deliveryId: string;
  repositoryId: number;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  configDigest: string;
  providerId: string;
  requestedModel: string;
  resolvedModel: string;
  resultDigest: string;
  publicationMode: 'disabled';
  providerCalls: number;
  githubWrites: 0;
  personaCount: number;
  findingsCount: number;
  quorumSatisfied: boolean;
  verdict: 'SHIP' | 'FIX_FIRST' | 'BLOCK';
  usage: TokensUsed | null;
  costUSD: number | null;
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

/**
 * Full-panel qualification keeps the v1 aggregate receipt shape while adding
 * an explicit profile and expected-lane count. This makes a six-persona run
 * distinguishable from the legacy single-lane panel probe without changing
 * any live-review or publication contract.
 */
export interface FullPanelQualificationReceipt extends PanelQualificationReceipt {
  profile: 'full-panel';
  expectedPersonaCount: 6;
  optionalFailureCount: 0;
  engineRevision: string;
  providerTopologyDigest: string;
  laneAttribution: QualificationLaneAttribution[];
  retryCount: number;
}

export interface SameHeadQualificationReceipt extends Omit<FullPanelQualificationReceipt, 'profile'> {
  profile: 'same-head';
  source: 'github-pull-request';
  diffDigest: string;
  githubReads: 3;
  verdictSource: 'canonical-production-policy';
  severityCounts: { P0: number; P1: number; P2: number };
  findingFingerprintVersion: 'ReviewYetiFindingFingerprint.v1';
  findingFingerprints: QualificationFindingFingerprint[];
}

export interface FullPanelQualificationAttemptReceipt {
  attempt: number;
  persona: string;
  providerId: string;
  requestedModel: string;
  resolvedModel?: string;
  outcome: 'completed' | 'failed';
  durationMs: number;
  usage?: TokensUsed | null;
  costUSD?: number | null;
  failureClass?: string;
  timeoutKind?: string;
  responseStatus?: number;
}

export interface QualificationLaneAttribution {
  role: 'persona' | 'moderator' | 'arbiter';
  lane: string;
  providerId: string;
  requestedModel: string;
  resolvedModel: string;
  callCount: number;
  retryCount: number;
}

export interface FailedFullPanelQualificationReceipt {
  version: 'ReviewYetiPanelQualification.v1';
  profile: 'full-panel';
  status: 'failed';
  runId: string;
  deliveryId: string;
  repositoryId: number;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  configDigest: string;
  engineRevision: string;
  providerTopologyDigest: string;
  providerId: string;
  requestedModel: string;
  publicationMode: 'disabled';
  providerCalls: number;
  retryCount: number;
  githubWrites: 0;
  expectedPersonaCount: 6;
  failureClass: string;
  attempts: FullPanelQualificationAttemptReceipt[];
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

export interface FailedSameHeadQualificationReceipt extends Omit<FailedFullPanelQualificationReceipt, 'profile'> {
  profile: 'same-head';
  source: 'github-pull-request';
  diffDigest?: string;
  githubReads: number;
}

const RECEIPT_RUN_ID = /^run_[a-f0-9]{32}$/u;
const RECEIPT_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/u;
const RECEIPT_SHA = /^[a-f0-9]{40}$/u;
const RECEIPT_DIGEST = /^[a-f0-9]{64}$/u;

function receiptValue(env: NodeJS.ProcessEnv, name: string): string {
  return env[name]?.trim() || '';
}

function invalidReceiptContract(): Error {
  return new Error('receipt-only worker contract is invalid');
}

export function isReceiptOnlyWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return receiptValue(env, 'REVIEW_RECEIPT_ONLY') === 'true';
}

function providerQualificationRequested(env: NodeJS.ProcessEnv): boolean {
  return receiptValue(env, 'REVIEW_PROVIDER_QUALIFICATION_ONLY') === 'true';
}

function panelQualificationRequested(env: NodeJS.ProcessEnv): boolean {
  return receiptValue(env, 'REVIEW_PANEL_QUALIFICATION_ONLY') === 'true';
}

function fullPanelQualificationRequested(env: NodeJS.ProcessEnv): boolean {
  return receiptValue(env, 'REVIEW_FULL_PANEL_QUALIFICATION_ONLY') === 'true';
}

function sameHeadQualificationRequested(env: NodeJS.ProcessEnv): boolean {
  return receiptValue(env, 'REVIEW_SAME_HEAD_QUALIFICATION_ONLY') === 'true';
}

function usesOpenRouterQualificationClient(env: NodeJS.ProcessEnv): boolean {
  const providerId = receiptValue(env, 'REVIEW_QUALIFICATION_PROVIDER_ID');
  return providerId === '' || providerId === 'openrouter';
}

/** Provider qualification is opt-in and cannot share the receipt-only/live modes. */
export function isProviderQualificationWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return providerQualificationRequested(env)
    && !sameHeadQualificationRequested(env)
    && !fullPanelQualificationRequested(env)
    && !panelQualificationRequested(env)
    && receiptValue(env, 'REVIEW_RECEIPT_ONLY') !== 'true'
    && usesOpenRouterQualificationClient(env)
    && receiptValue(env, 'REVIEW_PUBLICATION_MODE') === 'disabled';
}

/** Panel qualification is opt-in and mutually exclusive with all other worker modes. */
export function isPanelQualificationWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return panelQualificationRequested(env)
    && !sameHeadQualificationRequested(env)
    && !fullPanelQualificationRequested(env)
    && !providerQualificationRequested(env)
    && receiptValue(env, 'REVIEW_RECEIPT_ONLY') !== 'true'
    && usesOpenRouterQualificationClient(env)
    && receiptValue(env, 'REVIEW_PUBLICATION_MODE') === 'disabled';
}

function invalidFullPanelQualificationContract(): Error {
  return new Error('full-panel qualification worker contract is invalid');
}

/** Full-panel qualification is explicit, non-publishing, and mutually exclusive. */
export function isFullPanelQualificationWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return fullPanelQualificationRequested(env)
    && !sameHeadQualificationRequested(env)
    && !panelQualificationRequested(env)
    && !providerQualificationRequested(env)
    && receiptValue(env, 'REVIEW_RECEIPT_ONLY') !== 'true'
    && usesOpenRouterQualificationClient(env)
    && receiptValue(env, 'REVIEW_PUBLICATION_MODE') === 'disabled';
}

function invalidSameHeadQualificationContract(): Error {
  return new Error('same-head qualification worker contract is invalid');
}

/** Same-head qualification accepts one read-only installation token and no App credential. */
export function isSameHeadQualificationWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return sameHeadQualificationRequested(env)
    && !fullPanelQualificationRequested(env)
    && !panelQualificationRequested(env)
    && !providerQualificationRequested(env)
    && receiptValue(env, 'REVIEW_RECEIPT_ONLY') !== 'true'
    && usesOpenRouterQualificationClient(env)
    && receiptValue(env, 'REVIEW_PUBLICATION_MODE') === 'disabled'
    && receiptValue(env, 'GH_TOKEN').startsWith('ghs_')
    && !receiptValue(env, 'GITHUB_TOKEN')
    && !receiptValue(env, 'GITHUB_APP_PRIVATE_KEY')
    && !receiptValue(env, 'GITHUB_APP_ID')
    && !receiptValue(env, 'GITHUB_INSTALLATION_ID');
}

function invalidProviderQualificationContract(): Error {
  return new Error('provider qualification worker contract is invalid');
}

function invalidPanelQualificationContract(): Error {
  return new Error('panel qualification worker contract is invalid');
}

function qualificationTimeoutMs(
  env: NodeJS.ProcessEnv,
  invalidContract: () => Error = invalidProviderQualificationContract,
): number {
  const raw = receiptValue(env, 'REVIEW_QUALIFICATION_TIMEOUT_MS') || '120000';
  const timeoutMs = Number(raw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw invalidContract();
  }
  return timeoutMs;
}

type QualificationIdentity = Omit<ProviderQualificationReceipt,
  'version' | 'status' | 'providerId' | 'requestedModel' | 'resolvedModel' | 'responseDigest' |
  'responseChars' | 'publicationMode' | 'providerCalls' | 'githubWrites' | 'usage' | 'costUSD' |
  'startedAt' | 'completedAt'>;

function qualificationIdentity(
  env: NodeJS.ProcessEnv,
  modeIsValid: (workerEnv: NodeJS.ProcessEnv) => boolean,
  invalidContract: () => Error,
): QualificationIdentity {
  const runId = receiptValue(env, 'REVIEW_RUN_ID');
  const deliveryId = receiptValue(env, 'REVIEW_DELIVERY_ID');
  const repositoryId = Number(receiptValue(env, 'REVIEW_REPOSITORY_ID'));
  const repo = receiptValue(env, 'REVIEW_REPO');
  const prNumber = Number(receiptValue(env, 'REVIEW_PR_NUMBER'));
  const headSha = receiptValue(env, 'REVIEW_HEAD_SHA');
  const baseSha = receiptValue(env, 'REVIEW_BASE_SHA');
  const policyDigest = receiptValue(env, 'REVIEW_POLICY_DIGEST');
  const configDigest = receiptValue(env, 'REVIEW_CONFIG_DIGEST');
  if (!modeIsValid(env)
      || receiptValue(env, 'REVIEW_RECEIPT_PATH') !== RECEIPT_ONLY_PATH
      || !RECEIPT_RUN_ID.test(runId) || deliveryId.length < 1 || deliveryId.length > 512
      || !Number.isSafeInteger(repositoryId) || repositoryId < 1 || !RECEIPT_REPO.test(repo)
      || !Number.isSafeInteger(prNumber) || prNumber < 1 || !RECEIPT_SHA.test(headSha)
      || !RECEIPT_SHA.test(baseSha) || !RECEIPT_DIGEST.test(policyDigest)
      || !RECEIPT_DIGEST.test(configDigest)) {
    throw invalidContract();
  }
  return { runId, deliveryId, repositoryId, repo, prNumber, headSha, baseSha, policyDigest, configDigest };
}

function providerQualificationIdentity(env: NodeJS.ProcessEnv): QualificationIdentity {
  return qualificationIdentity(env, isProviderQualificationWorker, invalidProviderQualificationContract);
}

function panelQualificationIdentity(env: NodeJS.ProcessEnv): QualificationIdentity {
  return qualificationIdentity(env, isPanelQualificationWorker, invalidPanelQualificationContract);
}

function fullPanelQualificationIdentity(env: NodeJS.ProcessEnv): QualificationIdentity {
  return qualificationIdentity(env, isFullPanelQualificationWorker, invalidFullPanelQualificationContract);
}

function sameHeadQualificationIdentity(env: NodeJS.ProcessEnv): QualificationIdentity {
  return qualificationIdentity(env, isSameHeadQualificationWorker, invalidSameHeadQualificationContract);
}

function qualificationModel(
  env: NodeJS.ProcessEnv,
  invalidContract: () => Error = invalidProviderQualificationContract,
): string {
  const model = receiptValue(env, 'REVIEW_QUALIFICATION_MODEL');
  if (!model || model === 'openrouter/auto' || model === 'auto') {
    throw invalidContract();
  }
  return model;
}

function qualificationClient(env: NodeJS.ProcessEnv): OpenRouterClient {
  return new OpenRouterClient({
    baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: env.OPENROUTER_REVIEW_FLEET_KEY
      || env.OPENROUTER_PR_REVIEW_API_KEY
      || requiredWorkerEnv(env, 'OPENROUTER_API_KEY'),
  });
}

/**
 * Run one bounded, streamed provider request without reading GitHub or
 * invoking the panel/publication paths. This is the only worker mode that may
 * use a provider during qualification, and it is never selected implicitly.
 */
export async function runProviderQualificationWorker(
  env: NodeJS.ProcessEnv = process.env,
  client: ReviewModelClient = qualificationClient(env),
): Promise<ProviderQualificationReceipt> {
  const identity = providerQualificationIdentity(env);
  const model = qualificationModel(env);
  const timeoutMs = qualificationTimeoutMs(env);
  const providerId = receiptValue(env, 'REVIEW_QUALIFICATION_PROVIDER_ID') || 'openrouter';
  const startedAt = new Date().toISOString();
  const response = await client.complete({
    model,
    messages: [
      {
        role: 'system',
        content: 'You are a provider transport qualification endpoint. Do not inspect or review code. Return exactly the text QUALIFICATION_OK.',
      },
      { role: 'user', content: 'Reply with exactly QUALIFICATION_OK.' },
    ],
    timeoutMs,
    ttftTimeoutMs: Math.min(timeoutMs, 30_000),
    stream: true,
    maxTokens: 256,
    temperature: 0,
    metadata: {
      qualificationMode: 'provider-only',
      runId: identity.runId,
      providerId,
    },
    jobId: identity.runId,
  });
  if (!response.content.trim()) throw invalidProviderQualificationContract();
  const completedAt = new Date().toISOString();
  const costUSD = response.costUSD !== null && Number.isFinite(response.costUSD) && response.costUSD >= 0
    ? response.costUSD
    : null;
  const receipt: ProviderQualificationReceipt = {
    version: 'ReviewYetiProviderQualification.v1',
    status: 'succeeded',
    ...identity,
    providerId,
    requestedModel: model,
    resolvedModel: response.model,
    responseDigest: createHash('sha256').update(response.content).digest('hex'),
    responseChars: response.content.length,
    publicationMode: 'disabled',
    providerCalls: 1,
    githubWrites: 0,
    usage: response.usage,
    costUSD,
    startedAt,
    completedAt,
  };
  await mkdir(dirname(RECEIPT_ONLY_PATH), { recursive: true });
  await writeFile(RECEIPT_ONLY_PATH, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8' });
  return receipt;
}

type PanelQualificationRunner = (options: {
  config: CtReviewConfigV3;
  changedFiles: Array<{ path: string; patch?: string; content?: string }>;
  repository: string;
  headSha: string;
  client: ReviewModelClient;
  jobId?: string;
  requestPolicy?: PanelRequestPolicy;
}) => Promise<PanelResult>;

/**
 * Match the central OpenRouter policy's three in-flight request cap during a
 * full-panel qualification. The panel engine intentionally starts applicable
 * personas together; this wrapper preserves that scheduling while preventing
 * one provider from being flooded by six simultaneous streams.
 */
class BoundedQualificationClient implements ReviewModelClient {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly delegate: ReviewModelClient,
    private readonly maxInFlight: number,
  ) {
    if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) {
      throw new Error('qualification concurrency limit must be positive');
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxInFlight) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    next?.();
  }

  async complete(request: Parameters<ReviewModelClient['complete']>[0]): ReturnType<ReviewModelClient['complete']> {
    await this.acquire();
    try {
      return await this.delegate.complete(request);
    } finally {
      this.release();
    }
  }
}

const PANEL_QUALIFICATION_FIXTURE = [{
  path: 'qualification-fixture.ts',
  patch: [
    'diff --git a/qualification-fixture.ts b/qualification-fixture.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/qualification-fixture.ts',
    '@@ -0,0 +1,3 @@',
    '+export function add(left: number, right: number): number {',
    '+  return left + right;',
    '+}',
  ].join('\n'),
}];

const FULL_PANEL_QUALIFICATION_PERSONAS = [
  {
    id: 'security',
    charter: 'builtin:security',
    paths: ['src/**', '.github/**', 'k8s/**'],
  },
  {
    id: 'performance',
    charter: 'builtin:performance',
    paths: ['src/**'],
  },
  {
    id: 'architecture',
    charter: 'builtin:constitutional-goals',
    paths: ['src/**', 'Dockerfile', 'k8s/**'],
  },
  {
    id: 'testing',
    charter: 'builtin:correctness',
    paths: ['src/**', 'tests/**'],
  },
  {
    id: 'dependencies',
    charter: 'builtin:contract',
    paths: ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
  },
  {
    id: 'licensing',
    charter: 'builtin:docs',
    paths: ['LICENSE', 'NOTICE', 'package.json'],
  },
] as const;
const FULL_PANEL_MIN_PROVIDER_CALLS = FULL_PANEL_QUALIFICATION_PERSONAS.length + 2;
const FULL_PANEL_MAX_TURNS = 3;
const FULL_PANEL_MAX_ATTEMPT_RECEIPTS = 32;
const FULL_PANEL_FALLBACK_MODEL = 'z-ai/glm-5.3-flash';

function qualificationEngineRevision(env: NodeJS.ProcessEnv, errorFactory: () => Error): string {
  const revision = receiptValue(env, 'REVIEW_ENGINE_REVISION');
  if (!RECEIPT_DIGEST.test(revision)) throw errorFactory();
  return revision;
}

function qualificationFallbackModels(model: string): string[] {
  return model === FULL_PANEL_FALLBACK_MODEL ? [] : [FULL_PANEL_FALLBACK_MODEL];
}

function qualificationProviderTopologyDigest(providerId: string, model: string): string {
  const personaLanes = FULL_PANEL_QUALIFICATION_PERSONAS.map(({ id }) => ({
    role: 'persona',
    lane: id,
    providerId,
    requestedModel: model,
  }));
  const topology = {
    version: 'ReviewYetiProviderTopology.v1',
    lanes: [
      ...personaLanes,
      { role: 'moderator', lane: 'moderator', providerId, requestedModel: model },
      { role: 'arbiter', lane: 'arbiter', providerId, requestedModel: model },
    ],
    fallbackModels: qualificationFallbackModels(model),
  };
  return createHash('sha256').update(JSON.stringify(topology)).digest('hex');
}

function fullPanelRequestPolicy(
  model: string,
  identity: QualificationIdentity,
  providerId: string,
  qualificationMode: 'full-panel' | 'same-head' = 'full-panel',
): PanelRequestPolicy {
  return {
    stream: true,
    ttftTimeoutMs: 30_000,
    maxTokens: 24_576,
    models: model === FULL_PANEL_FALLBACK_MODEL ? [] : [FULL_PANEL_FALLBACK_MODEL],
    responseFormat: { type: 'json_object' },
    provider: {
      allow_fallbacks: true,
      require_parameters: true,
      ignore: ['morph', 'fireworks'],
      sort: 'throughput',
      preferred_min_throughput: { p90: 40 },
      preferred_max_latency: { p99: 3 },
      data_collection: 'deny',
    },
    metadata: {
      qualificationMode,
      runId: identity.runId,
      providerId,
    },
  };
}

function qualificationFailureClass(error: unknown): string {
  if (error instanceof OpenRouterTimeoutError) return `timeout_${error.kind}`;
  if (error instanceof OpenRouterResponseError) {
    if (error.status === 429) return 'rate_limit';
    if (error.status !== undefined && error.status >= 500) return 'provider_5xx';
  }
  const message = error instanceof Error ? error.message : String(error || '');
  if (/GitHub qualification read failed HTTP 429/iu.test(message)) return 'github_rate_limit';
  if (/GitHub qualification read failed HTTP (?:5\d\d)/iu.test(message)) return 'github_5xx';
  if (/GitHub qualification read failed HTTP (?:401|403)/iu.test(message)) return 'github_auth';
  if (/GitHub qualification read failed HTTP 404/iu.test(message)) return 'github_not_found';
  if (/projected pull request identity mismatch/iu.test(message)) return 'github_identity_mismatch';
  if (/pull request moved during qualification read/iu.test(message)) return 'github_head_moved';
  if (/diff size is outside qualification bounds/iu.test(message)) return 'github_diff_bounds';
  if (/same-head qualification worker contract is invalid/iu.test(message)) return 'qualification_contract';
  if (/qualification exceeded \d+ms/iu.test(message)) return 'overall_timeout';
  if (/(?:invalid json|structured output|nonce fence|response contract)/iu.test(message)) return 'structured_output';
  return 'panel_failure';
}

const FULL_PANEL_QUALIFICATION_FIXTURE = [
  {
    path: 'src/auth/session.ts',
    content: [
      'export function loadSession(request: { headers: Record<string, string | undefined> }) {',
      '  const token = request.headers.authorization?.replace("Bearer ", "");',
      '  return token ? { token, authenticated: true } : { authenticated: false };',
      '}',
    ].join('\n'),
  },
  {
    path: 'src/dispatcher/worker.ts',
    content: [
      'export async function dispatch(jobs: Array<() => Promise<void>>) {',
      '  for (const job of jobs) await job();',
      '}',
    ].join('\n'),
  },
  {
    path: 'Dockerfile',
    content: [
      'FROM node:24-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'CMD ["node", "dist/worker.js"]',
    ].join('\n'),
  },
  {
    path: 'k8s/review-job.yaml',
    content: [
      'apiVersion: batch/v1',
      'kind: Job',
      'metadata:',
      '  name: review-job',
      'spec:',
      '  template:',
      '    spec:',
      '      containers:',
      '        - name: worker',
      '          image: review-yeti:qualification',
      '      restartPolicy: Never',
    ].join('\n'),
  },
  {
    path: 'package.json',
    content: JSON.stringify({ name: 'qualification-fixture', dependencies: { example: '^1.0.0' } }, null, 2),
  },
  {
    path: 'LICENSE',
    content: 'Copyright (c) CallTelemetry\n\nPermission is hereby granted, free of charge, to use this software.',
  },
];

function panelQualificationConfig(model: string, timeoutMs: number): CtReviewConfigV3 {
  const perCallSeconds = Math.max(1, Math.floor(timeoutMs / 4_000));
  const base = createDefaultV3Config();
  return {
    ...base,
    quorum: 1,
    personas: [{
      id: 'qualification-lane',
      enabled: true,
      required: true,
      charter: 'builtin:correctness',
      paths: ['**'],
      providers: ['qualification'],
      // One extra turn is reserved for a strict structured-output correction. This is still
      // bounded and does not permit open-ended exploration in the qualification worker.
      maxTurns: 2,
    }],
    reviewers: {
      execution: 'personas',
      fallback: 'none',
      overall_timeout_s: Math.max(1, Math.floor(timeoutMs / 1_000)),
      providers: [{
        id: 'qualification',
        enabled: true,
        model,
        effort: 'low',
        review_timeout_s: perCallSeconds,
        arbiter_timeout_s: perCallSeconds,
      }],
      arbiter: { order: ['qualification'] },
    },
  } as CtReviewConfigV3;
}

function fullPanelQualificationConfig(
  model: string,
  timeoutMs: number,
  providerId: string,
  allPersonasOnEveryFile = false,
  effort: 'low' | 'high' = 'low',
): CtReviewConfigV3 {
  const perCallSeconds = Math.max(1, Math.floor(timeoutMs / 4_000));
  const base = createDefaultV3Config();
  return {
    ...base,
    quorum: 1,
    personas: FULL_PANEL_QUALIFICATION_PERSONAS.map((persona) => ({
      id: persona.id,
      enabled: true,
      required: true,
      charter: persona.charter,
      paths: allPersonasOnEveryFile ? ['**'] : [...persona.paths],
      providers: [providerId],
      // One initial answer plus two bounded format/tool corrections. The
      // qualification profile must exercise the same recovery behavior that
      // production lanes rely on without permitting open-ended exploration.
      maxTurns: FULL_PANEL_MAX_TURNS,
    })),
    reviewers: {
      execution: 'personas',
      fallback: 'none',
      overall_timeout_s: Math.max(1, Math.floor(timeoutMs / 1_000)),
      providers: [{
        id: providerId,
        enabled: true,
        model,
        effort,
        review_timeout_s: perCallSeconds,
        arbiter_timeout_s: perCallSeconds,
      }],
      arbiter: { order: [providerId] },
    },
  } as CtReviewConfigV3;
}

function aggregatePanelUsage(result: PanelResult): TokensUsed | null {
  const usages = [
    ...result.personas.map((lane) => lane.usage),
    result.moderator.usage,
    result.arbiter.usage,
  ].filter((usage): usage is TokensUsed => Boolean(usage));
  if (usages.length === 0) return null;
  return usages.reduce((total, usage) => ({
    prompt: total.prompt + usage.prompt,
    completion: total.completion + usage.completion,
    total: total.total + usage.total,
  }), { prompt: 0, completion: 0, total: 0 });
}

function aggregatePanelCost(result: PanelResult): number | null {
  const costs = [
    ...result.personas.map((lane) => lane.costUSD),
    result.moderator.costUSD,
    result.arbiter.costUSD,
  ];
  const knownCosts = costs.filter((cost): cost is number => cost !== null && Number.isFinite(cost));
  if (knownCosts.length !== costs.length) return null;
  return knownCosts.reduce((total, cost) => total + cost, 0);
}

function panelQualificationResultDigest(
  result: PanelResult,
  canonical?: {
    verdict: 'SHIP' | 'FIX_FIRST' | 'BLOCK';
    p0Count: number;
    p1Count: number;
    p2Count: number;
    totalFindings: number;
    findingFingerprints: QualificationFindingFingerprint[];
  },
): string {
  return createHash('sha256').update(JSON.stringify({
    headSha: result.headSha,
    personas: result.personas.map((lane) => ({
      id: lane.id,
      providerId: lane.providerId,
      model: lane.model,
      decision: lane.decision,
      findingsCount: lane.findings.length,
    })),
    optionalFailures: result.optionalFailures.map((failure) => failure.id),
    quorum: result.quorum,
    moderator: {
      providerId: result.moderator.providerId,
      model: result.moderator.model,
      findingsCount: result.moderator.findings.length,
    },
    arbiter: {
      providerId: result.arbiter.providerId,
      model: result.arbiter.model,
      verdict: canonical?.verdict ?? result.arbiter.verdict,
    },
    ...(canonical ? {
      canonicalProductionPolicy: {
        p0Count: canonical.p0Count,
        p1Count: canonical.p1Count,
        p2Count: canonical.p2Count,
        totalFindings: canonical.totalFindings,
        findingFingerprintVersion: FINDING_FINGERPRINT_VERSION,
        findingFingerprints: canonical.findingFingerprints,
      },
    } : {}),
  })).digest('hex');
}

function qualificationFindingFingerprints(
  diffDigest: string,
  findings: PanelFinding[],
): QualificationFindingFingerprint[] {
  if (findings.length > MAX_FINDING_FINGERPRINTS) {
    throw invalidSameHeadQualificationContract();
  }
  // Bind digests to this exact diff so receipts can compare anchors and exact
  // normalized findings without persisting paths, lines, or review content.
  return findings.map((finding) => ({
    severity: finding.severity,
    anchorDigest: createHash('sha256').update(JSON.stringify({
      version: 'ReviewYetiFindingAnchor.v1',
      diffDigest,
      path: finding.path,
      line: finding.line,
    })).digest('hex'),
    contentDigest: createHash('sha256').update(JSON.stringify({
      version: 'ReviewYetiFindingContent.v1',
      diffDigest,
      severity: finding.severity,
      path: finding.path,
      line: finding.line,
      title: finding.title,
      body: finding.body,
      suggestion: finding.suggestion || '',
    })).digest('hex'),
  })).sort(compareFindingFingerprints);
}

async function runWithQualificationDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`panel qualification exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface FullPanelExecutionTelemetry {
  providerCalls: number;
  attempts: FullPanelQualificationAttemptReceipt[];
}

function qualificationRetryCount(attempts: FullPanelQualificationAttemptReceipt[]): number {
  const callsByLane = new Map<string, number>();
  for (const attempt of attempts) {
    callsByLane.set(attempt.persona, (callsByLane.get(attempt.persona) || 0) + 1);
  }
  return [...callsByLane.values()].reduce((total, calls) => total + Math.max(0, calls - 1), 0);
}

function qualificationLaneAttribution(
  result: PanelResult,
  attempts: FullPanelQualificationAttemptReceipt[],
  errorFactory: () => Error,
): QualificationLaneAttribution[] {
  const resultLanes = new Map(result.personas.map((lane) => [lane.id, {
    providerId: lane.providerId,
    model: lane.model,
  }]));
  resultLanes.set('moderator', {
    providerId: result.moderator.providerId,
    model: result.moderator.model,
  });
  resultLanes.set('arbiter', {
    providerId: result.arbiter.providerId,
    model: result.arbiter.model,
  });

  const expected = [
    ...FULL_PANEL_QUALIFICATION_PERSONAS.map(({ id }) => ({ role: 'persona' as const, lane: id })),
    { role: 'moderator' as const, lane: 'moderator' },
    { role: 'arbiter' as const, lane: 'arbiter' },
  ];
  return expected.map(({ role, lane }) => {
    const laneResult = resultLanes.get(lane);
    const laneAttempts = attempts.filter((attempt) => attempt.persona === lane);
    const completed = [...laneAttempts].reverse().find((attempt) => attempt.outcome === 'completed');
    if (!laneResult || !completed?.resolvedModel || laneAttempts.length < 1) throw errorFactory();
    return {
      role,
      lane,
      providerId: completed.providerId || laneResult.providerId,
      requestedModel: laneAttempts[0].requestedModel,
      resolvedModel: completed.resolvedModel || laneResult.model,
      callCount: laneAttempts.length,
      retryCount: Math.max(0, laneAttempts.length - 1),
    };
  });
}

interface QualifiedFullPanelOptions {
  env: NodeJS.ProcessEnv;
  identity: QualificationIdentity;
  model: string;
  timeoutMs: number;
  providerId: string;
  qualificationMode: 'full-panel' | 'same-head';
  changedFiles: Array<{ path: string; patch?: string; content?: string }>;
  allPersonasOnEveryFile?: boolean;
  panelRunner: PanelQualificationRunner;
  client?: ReviewModelClient;
  telemetry: FullPanelExecutionTelemetry;
}

async function executeQualifiedFullPanel(options: QualifiedFullPanelOptions): Promise<PanelResult> {
  const effectiveClient = options.client || qualificationClient(options.env);
  const countingClient: ReviewModelClient = {
    complete: async (request) => {
      options.telemetry.providerCalls += 1;
      const attempt = options.telemetry.providerCalls;
      const attemptStarted = Date.now();
      try {
        const response = await effectiveClient.complete(request);
        if (options.telemetry.attempts.length < FULL_PANEL_MAX_ATTEMPT_RECEIPTS) {
          options.telemetry.attempts.push({
            attempt,
            persona: request.persona || 'unknown',
            providerId: request.providerId || options.providerId,
            requestedModel: request.model,
            resolvedModel: response.model,
            outcome: 'completed',
            durationMs: Math.max(0, Date.now() - attemptStarted),
            usage: response.usage,
            costUSD: response.costUSD,
          });
        }
        return response;
      } catch (error: any) {
        if (options.telemetry.attempts.length < FULL_PANEL_MAX_ATTEMPT_RECEIPTS) {
          options.telemetry.attempts.push({
            attempt,
            persona: request.persona || 'unknown',
            providerId: request.providerId || options.providerId,
            requestedModel: request.model,
            outcome: 'failed',
            durationMs: Math.max(0, Date.now() - attemptStarted),
            failureClass: qualificationFailureClass(error),
            ...(error instanceof OpenRouterTimeoutError ? { timeoutKind: error.kind } : {}),
            ...(error instanceof OpenRouterResponseError && error.status !== undefined
              ? { responseStatus: error.status }
              : {}),
          });
        }
        throw error;
      }
    },
  };
  const result = await options.panelRunner({
    config: fullPanelQualificationConfig(
      options.model,
      options.timeoutMs,
      options.providerId,
      options.allPersonasOnEveryFile,
      options.qualificationMode === 'same-head' ? 'high' : 'low',
    ),
    changedFiles: options.changedFiles,
    repository: options.identity.repo,
    headSha: options.identity.headSha,
    client: new BoundedQualificationClient(countingClient, 3),
    jobId: options.identity.runId,
    requestPolicy: fullPanelRequestPolicy(
      options.model,
      options.identity,
      options.providerId,
      options.qualificationMode,
    ),
  });
  if (!result.quorum.satisfied || !result.arbiter?.verdict
      || result.personas.length !== FULL_PANEL_QUALIFICATION_PERSONAS.length
      || result.optionalFailures.length > 0
      || options.telemetry.providerCalls < FULL_PANEL_MIN_PROVIDER_CALLS) {
    throw options.qualificationMode === 'same-head'
      ? invalidSameHeadQualificationContract()
      : invalidFullPanelQualificationContract();
  }
  return result;
}

function parseQualificationDiff(diff: string): Array<{ path: string; patch: string }> {
  const headers = Array.from(diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gmu));
  const files = headers.map((header, index) => {
    const start = header.index ?? 0;
    const end = index + 1 < headers.length ? headers[index + 1].index : diff.length;
    const path = (header[2] || '').trim();
    if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) {
      throw invalidSameHeadQualificationContract();
    }
    return { path, patch: diff.slice(start, end).trimEnd() };
  });
  if (files.length === 0) throw invalidSameHeadQualificationContract();
  return files;
}

/**
 * Exercise one real panel, moderator, and arbiter path against a deterministic
 * fixture. The result is an aggregate receipt only; no finding or provider
 * response text is persisted and publication is impossible in this mode.
 */
export async function runPanelQualificationWorker(
  env: NodeJS.ProcessEnv = process.env,
  panelRunner: PanelQualificationRunner = executePersonaPanel,
  client?: ReviewModelClient,
): Promise<PanelQualificationReceipt> {
  if (!isPanelQualificationWorker(env) || receiptValue(env, 'REVIEW_RECEIPT_PATH') !== RECEIPT_ONLY_PATH) {
    throw invalidPanelQualificationContract();
  }
  const identity = panelQualificationIdentity(env);
  const model = qualificationModel(env, invalidPanelQualificationContract);
  const timeoutMs = qualificationTimeoutMs(env, invalidPanelQualificationContract);
  const providerId = receiptValue(env, 'REVIEW_QUALIFICATION_PROVIDER_ID') || 'openrouter';
  const startedAt = new Date().toISOString();
  let providerCalls = 0;
  const effectiveClient = client || qualificationClient(env);
  const countingClient: ReviewModelClient = {
      complete: async (request) => {
        providerCalls += 1;
        return effectiveClient.complete(request);
      },
  };
  const result = await runWithQualificationDeadline(panelRunner({
    config: panelQualificationConfig(model, timeoutMs),
    changedFiles: PANEL_QUALIFICATION_FIXTURE,
    repository: identity.repo,
    headSha: identity.headSha,
    client: countingClient,
    jobId: identity.runId,
  }), timeoutMs);
  if (!result.quorum.satisfied || !result.arbiter?.verdict) throw invalidPanelQualificationContract();
  const completedAt = new Date().toISOString();
  const receipt: PanelQualificationReceipt = {
    version: 'ReviewYetiPanelQualification.v1',
    status: 'succeeded',
    ...identity,
    providerId,
    requestedModel: model,
    resolvedModel: result.arbiter.model,
    resultDigest: panelQualificationResultDigest(result),
    publicationMode: 'disabled',
    providerCalls,
    githubWrites: 0,
    personaCount: result.personas.length,
    findingsCount: result.personas.reduce((total, lane) => total + lane.findings.length, 0)
      + result.moderator.findings.length,
    quorumSatisfied: result.quorum.satisfied,
    verdict: result.arbiter.verdict,
    usage: aggregatePanelUsage(result),
    costUSD: aggregatePanelCost(result),
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    startedAt,
    completedAt,
  };
  await mkdir(dirname(RECEIPT_ONLY_PATH), { recursive: true });
  await writeFile(RECEIPT_ONLY_PATH, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8' });
  return receipt;
}

/**
 * Execute the complete six-persona panel, moderator, and arbiter path against
 * a representative multi-file fixture. This mode is deliberately opt-in and
 * non-publishing so it can be run by the DOKS dispatcher for timing and
 * terminal-reliability measurements without changing production reviews.
 */
export async function runFullPanelQualificationWorker(
  env: NodeJS.ProcessEnv = process.env,
  panelRunner: PanelQualificationRunner = executePersonaPanel,
  client?: ReviewModelClient,
): Promise<FullPanelQualificationReceipt> {
  if (!isFullPanelQualificationWorker(env) || receiptValue(env, 'REVIEW_RECEIPT_PATH') !== RECEIPT_ONLY_PATH) {
    throw invalidFullPanelQualificationContract();
  }
  const identity = fullPanelQualificationIdentity(env);
  const model = qualificationModel(env, invalidFullPanelQualificationContract);
  const timeoutMs = qualificationTimeoutMs(env, invalidFullPanelQualificationContract);
  const providerId = receiptValue(env, 'REVIEW_QUALIFICATION_PROVIDER_ID') || 'openrouter';
  const engineRevision = qualificationEngineRevision(env, invalidFullPanelQualificationContract);
  const providerTopologyDigest = qualificationProviderTopologyDigest(providerId, model);
  const startedAt = new Date().toISOString();
  const telemetry: FullPanelExecutionTelemetry = { providerCalls: 0, attempts: [] };
  let result: PanelResult;
  let laneAttribution: QualificationLaneAttribution[] = [];
  try {
    result = await runWithQualificationDeadline(executeQualifiedFullPanel({
      env,
      identity,
      model,
      timeoutMs,
      providerId,
      qualificationMode: 'full-panel',
      changedFiles: FULL_PANEL_QUALIFICATION_FIXTURE,
      panelRunner,
      client,
      telemetry,
    }), timeoutMs);
    laneAttribution = qualificationLaneAttribution(
      result,
      telemetry.attempts,
      invalidFullPanelQualificationContract,
    );
  } catch (error) {
    const completedAt = new Date().toISOString();
    const failedReceipt: FailedFullPanelQualificationReceipt = {
      version: 'ReviewYetiPanelQualification.v1',
      profile: 'full-panel',
      status: 'failed',
      ...identity,
      engineRevision,
      providerTopologyDigest,
      providerId,
      requestedModel: model,
      publicationMode: 'disabled',
      providerCalls: telemetry.providerCalls,
      retryCount: qualificationRetryCount(telemetry.attempts),
      githubWrites: 0,
      expectedPersonaCount: 6,
      failureClass: qualificationFailureClass(error),
      attempts: telemetry.attempts,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      startedAt,
      completedAt,
    };
    await mkdir(dirname(RECEIPT_ONLY_PATH), { recursive: true });
    await writeFile(RECEIPT_ONLY_PATH, `${JSON.stringify(failedReceipt)}\n`, { encoding: 'utf8' });
    throw error;
  }
  const completedAt = new Date().toISOString();
  const receipt: FullPanelQualificationReceipt = {
    version: 'ReviewYetiPanelQualification.v1',
    profile: 'full-panel',
    expectedPersonaCount: 6,
    optionalFailureCount: 0,
    status: 'succeeded',
    ...identity,
    engineRevision,
    providerTopologyDigest,
    laneAttribution,
    retryCount: laneAttribution.reduce((total, lane) => total + lane.retryCount, 0),
    providerId,
    requestedModel: model,
    resolvedModel: result.arbiter.model,
    resultDigest: panelQualificationResultDigest(result),
    publicationMode: 'disabled',
    providerCalls: telemetry.providerCalls,
    githubWrites: 0,
    personaCount: result.personas.length,
    findingsCount: result.personas.reduce((total, lane) => total + lane.findings.length, 0)
      + result.moderator.findings.length,
    quorumSatisfied: result.quorum.satisfied,
    verdict: result.arbiter.verdict,
    usage: aggregatePanelUsage(result),
    costUSD: aggregatePanelCost(result),
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    startedAt,
    completedAt,
  };
  await mkdir(dirname(RECEIPT_ONLY_PATH), { recursive: true });
  await writeFile(RECEIPT_ONLY_PATH, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8' });
  return receipt;
}

/**
 * Execute the same bounded six-persona profile against one exact GitHub PR
 * diff. GitHub is read only, identity is checked by the source loader, and the
 * persisted receipt contains no review content or credential.
 */
export async function runSameHeadQualificationWorker(
  env: NodeJS.ProcessEnv = process.env,
  panelRunner: PanelQualificationRunner = executePersonaPanel,
  client?: ReviewModelClient,
  sourceLoader: typeof loadSameHeadReviewSource = loadSameHeadReviewSource,
): Promise<SameHeadQualificationReceipt> {
  if (!isSameHeadQualificationWorker(env) || receiptValue(env, 'REVIEW_RECEIPT_PATH') !== RECEIPT_ONLY_PATH) {
    throw invalidSameHeadQualificationContract();
  }
  const identity = sameHeadQualificationIdentity(env);
  const model = qualificationModel(env, invalidSameHeadQualificationContract);
  const timeoutMs = qualificationTimeoutMs(env, invalidSameHeadQualificationContract);
  const providerId = receiptValue(env, 'REVIEW_QUALIFICATION_PROVIDER_ID') || 'openrouter';
  const engineRevision = qualificationEngineRevision(env, invalidSameHeadQualificationContract);
  const providerTopologyDigest = qualificationProviderTopologyDigest(providerId, model);
  const startedAt = new Date().toISOString();
  const telemetry: FullPanelExecutionTelemetry = { providerCalls: 0, attempts: [] };
  let source: SameHeadReviewSource | undefined;
  let changedFiles: Array<{ path: string; patch: string }> = [];
  let result: PanelResult;
  let laneAttribution: QualificationLaneAttribution[] = [];
  let completedSource!: SameHeadReviewSource;
  let canonical!: ReturnType<typeof computeAppVerdict>;
  let findingFingerprints: QualificationFindingFingerprint[] = [];
  try {
    result = await runWithQualificationDeadline((async () => {
      source = await sourceLoader({
        token: receiptValue(env, 'GH_TOKEN'),
        repo: identity.repo,
        prNumber: identity.prNumber,
        expectedBaseSha: identity.baseSha,
        expectedHeadSha: identity.headSha,
      });
      changedFiles = parseQualificationDiff(source.diff);
      const panelResult = await executeQualifiedFullPanel({
        env,
        identity,
        model,
        timeoutMs,
        providerId,
        qualificationMode: 'same-head',
        changedFiles,
        allPersonasOnEveryFile: true,
        panelRunner,
        client,
        telemetry,
      });
      laneAttribution = qualificationLaneAttribution(
        panelResult,
        telemetry.attempts,
        invalidSameHeadQualificationContract,
      );
      return panelResult;
    })(), timeoutMs);
    if (!source) throw invalidSameHeadQualificationContract();
    completedSource = source;
    canonical = computeAppVerdict({
      lanes: result.personas.map((lane) => ({
        id: lane.id,
        required: lane.required,
        decision: lane.decision,
        findings: lane.findings,
      })),
      expectedLanes: result.personas.length,
      changedFiles,
      coverageComplete: result.optionalFailures.length === 0,
      candidateVerdict: result.arbiter.verdict,
      rationale: result.arbiter.rationale,
    });
    findingFingerprints = qualificationFindingFingerprints(completedSource.diffDigest, canonical.findings);
  } catch (error) {
    const completedAt = new Date().toISOString();
    const failureClass = qualificationFailureClass(error);
    const errorReads = Number((error as { githubReads?: unknown })?.githubReads);
    const githubReads = source?.githubReads
      ?? (Number.isSafeInteger(errorReads) && errorReads >= 0 && errorReads <= 3 ? errorReads : 0);
    const failedReceipt: FailedSameHeadQualificationReceipt = {
      version: 'ReviewYetiPanelQualification.v1',
      profile: 'same-head',
      source: 'github-pull-request',
      status: 'failed',
      ...identity,
      ...(source ? { diffDigest: source.diffDigest } : {}),
      engineRevision,
      providerTopologyDigest,
      providerId,
      requestedModel: model,
      publicationMode: 'disabled',
      providerCalls: telemetry.providerCalls,
      retryCount: qualificationRetryCount(telemetry.attempts),
      githubReads,
      githubWrites: 0,
      expectedPersonaCount: 6,
      failureClass,
      attempts: telemetry.attempts,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      startedAt,
      completedAt,
    };
    await mkdir(dirname(RECEIPT_ONLY_PATH), { recursive: true });
    await writeFile(RECEIPT_ONLY_PATH, `${JSON.stringify(failedReceipt)}\n`, { encoding: 'utf8' });
    throw new Error(`same-head qualification failed: ${failureClass}`);
  }
  const completedAt = new Date().toISOString();
  const receipt: SameHeadQualificationReceipt = {
    version: 'ReviewYetiPanelQualification.v1',
    profile: 'same-head',
    source: 'github-pull-request',
    expectedPersonaCount: 6,
    optionalFailureCount: 0,
    status: 'succeeded',
    ...identity,
    diffDigest: completedSource.diffDigest,
    engineRevision,
    providerTopologyDigest,
    laneAttribution,
    retryCount: laneAttribution.reduce((total, lane) => total + lane.retryCount, 0),
    providerId,
    requestedModel: model,
    resolvedModel: result.arbiter.model,
    resultDigest: panelQualificationResultDigest(result, {
      verdict: canonical.verdict,
      ...canonical.metrics,
      findingFingerprints,
    }),
    publicationMode: 'disabled',
    providerCalls: telemetry.providerCalls,
    githubReads: completedSource.githubReads,
    githubWrites: 0,
    personaCount: result.personas.length,
    findingsCount: canonical.metrics.totalFindings,
    quorumSatisfied: result.quorum.satisfied,
    verdict: canonical.verdict,
    verdictSource: 'canonical-production-policy',
    severityCounts: {
      P0: canonical.metrics.p0Count,
      P1: canonical.metrics.p1Count,
      P2: canonical.metrics.p2Count,
    },
    findingFingerprintVersion: FINDING_FINGERPRINT_VERSION,
    findingFingerprints,
    usage: aggregatePanelUsage(result),
    costUSD: aggregatePanelCost(result),
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    startedAt,
    completedAt,
  };
  await mkdir(dirname(RECEIPT_ONLY_PATH), { recursive: true });
  await writeFile(RECEIPT_ONLY_PATH, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8' });
  return receipt;
}

/**
 * Validate and construct the local receipt used by the non-publishing worker
 * qualification. This function reads only immutable, non-secret projection
 * fields and deliberately has no GitHub or provider client dependency.
 */
export function buildReceiptOnlyWorkerReceipt(
  env: NodeJS.ProcessEnv,
  startedAt: string,
  completedAt: string,
): ReceiptOnlyWorkerReceipt {
  const runId = receiptValue(env, 'REVIEW_RUN_ID');
  const deliveryId = receiptValue(env, 'REVIEW_DELIVERY_ID');
  const repositoryId = Number(receiptValue(env, 'REVIEW_REPOSITORY_ID'));
  const repo = receiptValue(env, 'REVIEW_REPO');
  const prNumber = Number(receiptValue(env, 'REVIEW_PR_NUMBER'));
  const headSha = receiptValue(env, 'REVIEW_HEAD_SHA');
  const baseSha = receiptValue(env, 'REVIEW_BASE_SHA');
  const policyDigest = receiptValue(env, 'REVIEW_POLICY_DIGEST');
  const configDigest = receiptValue(env, 'REVIEW_CONFIG_DIGEST');
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (!isReceiptOnlyWorker(env) || receiptValue(env, 'REVIEW_PUBLICATION_MODE') !== 'disabled' ||
      receiptValue(env, 'REVIEW_RECEIPT_PATH') !== RECEIPT_ONLY_PATH ||
      !RECEIPT_RUN_ID.test(runId) || deliveryId.length < 1 || deliveryId.length > 512 ||
      !Number.isSafeInteger(repositoryId) || repositoryId < 1 || !RECEIPT_REPO.test(repo) ||
      !Number.isSafeInteger(prNumber) || prNumber < 1 || !RECEIPT_SHA.test(headSha) ||
      !RECEIPT_SHA.test(baseSha) || !RECEIPT_DIGEST.test(policyDigest) ||
      !RECEIPT_DIGEST.test(configDigest) || !Number.isFinite(startedMs) ||
      !Number.isFinite(completedMs) || completedMs < startedMs) {
    throw invalidReceiptContract();
  }
  return {
    version: 'ReviewYetiReceiptOnly.v1',
    status: 'succeeded',
    runId,
    deliveryId,
    repositoryId,
    repo,
    prNumber,
    headSha,
    baseSha,
    policyDigest,
    configDigest,
    publicationMode: 'disabled',
    providerCalls: 0,
    githubWrites: 0,
    startedAt,
    completedAt,
  };
}

export async function runReceiptOnlyWorker(env: NodeJS.ProcessEnv = process.env): Promise<ReceiptOnlyWorkerReceipt> {
  const startedAt = new Date().toISOString();
  const completedAt = new Date().toISOString();
  const receipt = buildReceiptOnlyWorkerReceipt(env, startedAt, completedAt);
  await mkdir(dirname(RECEIPT_ONLY_PATH), { recursive: true });
  await writeFile(RECEIPT_ONLY_PATH, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8' });
  return receipt;
}

/**
 * Offline image self-test. It loads the worker's admitted code paths and verifies
 * the staged runtime manifest without opening a provider, GitHub, or subprocess.
 */
export async function runWorkerSelfTest(
  env: NodeJS.ProcessEnv = process.env,
  moduleLoader: (moduleId: string) => unknown = require,
): Promise<WorkerSelfTestResult> {
  const manifestPath = env.REVIEW_RUNTIME_MANIFEST_PATH?.trim() || '/app/runtime-manifest.json';
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(manifestPath);
  } catch {
    throw new Error('worker runtime manifest is missing');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('worker runtime manifest is invalid');
  }
  if (!manifest || typeof manifest !== 'object' ||
      (manifest as { version?: unknown }).version !== 'ReviewYetiWorkerRuntime.v1' ||
      (manifest as { entrypoint?: unknown }).entrypoint !== 'dist/cli/runLiveReview.js') {
    throw new Error('worker runtime manifest is invalid');
  }
  const loadedModuleIds: string[] = [];
  for (const moduleId of WORKER_SELF_TEST_MODULES) {
    moduleLoader(moduleId);
    loadedModuleIds.push(moduleId);
  }
  return {
    ok: true,
    nodeVersion: process.versions.node,
    runtimeManifestDigest: createHash('sha256').update(manifestBytes).digest('hex'),
    loadedModuleIds,
  };
}

function requiredWorkerEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for GitHub App worker authentication`);
  return value;
}

function parseRepoArgument(value: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/u.exec(value);
  if (!match) throw new Error(`invalid repository argument: ${value}`);
  return { owner: match[1], repo: match[2] };
}

function ghPrView(prNumber: number, repo: string, jsonFields: string, jq?: string): string {
  const args = ['pr', 'view', String(prNumber), '--repo', repo, '--json', jsonFields];
  if (jq) args.push('--jq', jq);
  return execFileSync('gh', args, GH_EXEC_OPTIONS).trim();
}

export function resolveWorkerAuthConfig(env: NodeJS.ProcessEnv = process.env): WorkerAuthConfig {
  return {
    appId: requiredWorkerEnv(env, 'GITHUB_APP_ID'),
    privateKey: requiredWorkerEnv(env, 'GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n'),
    installationId: requiredWorkerEnv(env, 'GITHUB_INSTALLATION_ID'),
  };
}

export async function runLiveReviewMain(env: NodeJS.ProcessEnv = process.env) {
  const cliArgs = process.argv.slice(2);
  const positionalArgs = cliArgs.filter((value) => !value.startsWith('--'));
  const prValue = cliArgs.find((value) => value.startsWith('--pr='))?.slice('--pr='.length)
    || positionalArgs[0]
    || env.PR_NUMBER
    || '1';
  const repo = cliArgs.find((value) => value.startsWith('--repo='))?.slice('--repo='.length)
    || positionalArgs[1]
    || env.REPO
    || 'review-yeti-ai/review-yeti-bot';
  const prNumber = parseInt(prValue, 10);
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error(`invalid pull request number: ${prValue}`);
  const { owner: repoOwner, repo: repoName } = parseRepoArgument(repo);

  logger.info('Starting live ct-review-bot review dispatch', { repo, prNumber });

  // Fetch target PR head commit SHA from GitHub API
  const headSha = ghPrView(prNumber, repo, 'headRefOid', '.headRefOid');

  // Fetch PR diff via gh CLI
  const diff = execFileSync('gh', ['pr', 'diff', String(prNumber), '--repo', repo], GH_EXEC_OPTIONS);

  // Initialize 10-persona Panel Engine
  const config = createDefaultV3Config();
  const client = new OpenRouterClient({
    baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: env.OPENROUTER_REVIEW_FLEET_KEY || env.OPENROUTER_PR_REVIEW_API_KEY || requiredWorkerEnv(env, 'OPENROUTER_API_KEY'),
  });

  // Parse files from diff
  const fileHeaderMatches = Array.from(
    diff.matchAll(/diff --git a\/(.*?) b\/(.*?)(?=\ndiff --git|\n$|$)/gs)
  );

  const changedFiles = fileHeaderMatches
    .map((match) => ({
      path: (match[2] || match[1] || '').trim(),
      patch: match[0],
    }))
    .filter((f) => f.path.length > 0 && f.path !== '/dev/null');

  if (changedFiles.length === 0) {
    changedFiles.push({ path: 'PR_CHANGES.md', patch: diff });
  }

  // Execute persona panel review through the OpenRouter-only model boundary.
  const panelResult = await executePersonaPanel({
    config,
    changedFiles,
    repository: repo,
    headSha,
    client,
    jobId: `job_${repo.replace('/', '_')}_pr${prNumber}`,
  });

  // Compile findings across personas
  const allFindings = panelResult.personas.flatMap((p) => p.findings || []);
  const mappedFindings = allFindings.map((f: any) => ({
    persona: f.personaId || 'review',
    severity: f.severity || 'P2',
    filePath: f.path || 'README.md',
    lineNumber: f.line || 1,
    comment: f.body || f.title || 'Review finding',
  }));

  const summaryMarkdown = generatePRSummary(diff, mappedFindings, config);
  const mermaidDiagram = generateMermaidDiagram(diff);

  const sections: string[] = [
    `# 🤖 ct-review-bot Summary (PR #${prNumber})`,
    `**Verdict**: \`${panelResult.arbiter?.verdict || 'BLOCK'}\` | **Provider**: \`OpenRouter\``,
    '',
    summaryMarkdown,
  ];

  if (mermaidDiagram && mermaidDiagram.trim().length > 0) {
    sections.push(
      '',
      '<details>',
      '<summary><strong>🧬 Architecture Diagram</strong></summary>',
      '',
      mermaidDiagram,
      '',
      '</details>'
    );
  }

  sections.push(
    '',
    '---',
    `[📊 Live Terminal Dashboard](https://review-bot.calltelemetry.com/dashboard/live?jobId=job_${repo.replace('/', '_')}_pr${prNumber}) | [🏢 Org Settings](https://review-bot.calltelemetry.com/dashboard/organization)`
  );

  const fullSummaryMarkdown = sections.join('\n');

  const auth = resolveWorkerAuthConfig(env);
  const tokenRes = await getGitHubAppInstallationToken(auth);
  if (!tokenRes.token.startsWith('ghs_')) {
    throw new Error('GitHub App token exchange returned a non-installation token');
  }
  const token = tokenRes.token;
  logger.info('Authenticating review post via GitHub App Installation Token (ct-review-bot[bot])', {
    appId: auth.appId,
    installationId: auth.installationId,
  });

  // Post top-level review comment via GitHub REST API
  logger.info('Posting ct-review-bot summary comment to GitHub via REST API', { repo, prNumber });

  const publisher = new CommentPublisher({
    githubToken: token,
    currentHeadSha: async () => ghPrView(prNumber, repo, 'headRefOid', '.headRefOid'),
  });

  const publishRes = await publisher.publishReview({
    owner: repoOwner,
    repo: repoName,
    prNumber,
    commitSha: headSha,
    event: panelResult.arbiter?.verdict === 'SHIP'
      ? 'APPROVE'
      : String(panelResult.arbiter?.verdict) === 'COMMENT'
        ? 'COMMENT'
        : 'REQUEST_CHANGES',
    body: fullSummaryMarkdown,
    idempotencyKey: `worker-arbiter:${repoOwner}/${repoName}#${prNumber}:${headSha}`,
  });

  logger.info('Successfully posted ct-review-bot review comment', { publishRes });
}

/** Entrypoint used by both the live worker and the receipt-only qualification. */
export async function runWorker(
  env: NodeJS.ProcessEnv = process.env,
  liveRunner: (workerEnv: NodeJS.ProcessEnv) => Promise<void> = runLiveReviewMain,
  providerRunner: (workerEnv: NodeJS.ProcessEnv) => Promise<void> = async (workerEnv) => {
    const receipt = await runProviderQualificationWorker(workerEnv);
    logger.info('Provider qualification worker completed without GitHub reads or writes', {
      runId: receipt.runId,
      providerId: receipt.providerId,
      requestedModel: receipt.requestedModel,
      resolvedModel: receipt.resolvedModel,
      responseChars: receipt.responseChars,
      costUSD: receipt.costUSD,
    });
  },
  panelRunner: (workerEnv: NodeJS.ProcessEnv) => Promise<void> = async (workerEnv) => {
    const receipt = await runPanelQualificationWorker(workerEnv);
    logger.info('Panel qualification worker completed without GitHub reads or writes', {
      runId: receipt.runId,
      providerId: receipt.providerId,
      requestedModel: receipt.requestedModel,
      resolvedModel: receipt.resolvedModel,
      providerCalls: receipt.providerCalls,
      verdict: receipt.verdict,
      durationMs: receipt.durationMs,
      costUSD: receipt.costUSD,
    });
  },
  fullPanelRunner: (workerEnv: NodeJS.ProcessEnv) => Promise<void> = async (workerEnv) => {
    const receipt = await runFullPanelQualificationWorker(workerEnv);
    logger.info('Full-panel qualification worker completed without GitHub writes', {
      runId: receipt.runId,
      providerId: receipt.providerId,
      requestedModel: receipt.requestedModel,
      providerCalls: receipt.providerCalls,
      personaCount: receipt.personaCount,
      verdict: receipt.verdict,
      durationMs: receipt.durationMs,
      costUSD: receipt.costUSD,
    });
  },
  sameHeadRunner: (workerEnv: NodeJS.ProcessEnv) => Promise<void> = async (workerEnv) => {
    const receipt = await runSameHeadQualificationWorker(workerEnv);
    logger.info('Same-head qualification worker completed without GitHub writes', {
      runId: receipt.runId,
      providerId: receipt.providerId,
      requestedModel: receipt.requestedModel,
      providerCalls: receipt.providerCalls,
      githubReads: receipt.githubReads,
      personaCount: receipt.personaCount,
      verdict: receipt.verdict,
      durationMs: receipt.durationMs,
      costUSD: receipt.costUSD,
    });
  },
  publishingRunner: (workerEnv: NodeJS.ProcessEnv) => Promise<void> = async (workerEnv) => {
    // REL-586: the worker publishes with a short-lived token scoped to this one
    // repository, minted upstream and delivered in the per-run Secret. It must never
    // hold the App private key -- this pod parses untrusted pull-request diffs and
    // executes model output, so an App key here would let a compromised worker mint
    // tokens for every installation. The operator asserts the same boundary
    // (TestBuildWorkerJobAcceptsAppGatePublicationMode).
    const token = String(workerEnv.GITHUB_PUBLISH_TOKEN || '').trim();
    if (!token.startsWith('ghs_')) {
      throw new Error('publishing review worker requires a ghs_ installation token');
    }
    const checkClient = new GitHubInstallationClient({ token });
    const receipt = await runPublishingReviewWorker(workerEnv, { checkClient });
    logger.info('Publishing review worker completed', {
      runId: receipt.runId,
      repo: receipt.repo,
      prNumber: receipt.prNumber,
      verdict: receipt.verdict,
      conclusion: receipt.conclusion,
      transport: receipt.transport,
      blockingFindingCount: receipt.blockingFindingCount,
    });
  },
): Promise<void> {
  if (sameHeadQualificationRequested(env)) {
    if (!isSameHeadQualificationWorker(env)) throw invalidSameHeadQualificationContract();
    await sameHeadRunner(env);
    return;
  }
  if (fullPanelQualificationRequested(env)) {
    if (!isFullPanelQualificationWorker(env)) throw invalidFullPanelQualificationContract();
    await fullPanelRunner(env);
    return;
  }
  if (panelQualificationRequested(env)) {
    if (!isPanelQualificationWorker(env)) throw invalidPanelQualificationContract();
    await panelRunner(env);
    return;
  }
  if (providerQualificationRequested(env)) {
    if (!isProviderQualificationWorker(env)) throw invalidProviderQualificationContract();
    await providerRunner(env);
    return;
  }
  if (isReceiptOnlyWorker(env)) {
    const receipt = await runReceiptOnlyWorker(env);
    logger.info('Receipt-only worker completed without provider or GitHub calls', {
      runId: receipt.runId,
      repositoryId: receipt.repositoryId,
      prNumber: receipt.prNumber,
    });
    return;
  }
  // REL-586 / ADR 0527: the publishing lane must be dispatched before the legacy
  // `liveRunner` fallthrough. `runLiveReviewMain` resolves its repository and PR
  // from argv with a hardcoded fallback and defaults its base URL to openrouter.ai,
  // so an app-gate dispatch reaching it would review the wrong repository against
  // the wrong provider.
  if (isPublishingReviewWorker(env)) {
    await publishingRunner(env);
    return;
  }
  return liveRunner(env);
}

if (require.main === module) {
  const command = process.argv.includes('--self-test')
    ? runWorkerSelfTest().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    : runWorker();
  command.catch((err) => {
    logger.error('Failed live ct-review-bot review dispatch', { error: err.message });
    process.exit(1);
  });
}
