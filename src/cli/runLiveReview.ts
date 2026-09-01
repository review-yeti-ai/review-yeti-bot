import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { executePersonaPanel } from '../panel/panelEngine';
import { generatePRSummary } from '../review/summaryEngine';
import { generateMermaidDiagram } from '../review/mermaidEngine';
import { CommentPublisher } from '../github/commentPublisher';
import { getGitHubAppInstallationToken } from '../github/appAuth';
import { OpenRouterClient } from '../gateway/openRouterClient';
import type { ReviewModelClient, TokensUsed } from '../gateway/openRouterClient';
import { createDefaultV3Config } from '../config/configLoader';
import type { CtReviewConfigV3 } from '../config/schema';
import type { PanelResult } from '../panel/panelEngine';
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

/** Provider qualification is opt-in and cannot share the receipt-only/live modes. */
export function isProviderQualificationWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return providerQualificationRequested(env)
    && !panelQualificationRequested(env)
    && receiptValue(env, 'REVIEW_RECEIPT_ONLY') !== 'true'
    && receiptValue(env, 'REVIEW_PUBLICATION_MODE') === 'disabled';
}

/** Panel qualification is opt-in and mutually exclusive with all other worker modes. */
export function isPanelQualificationWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return panelQualificationRequested(env)
    && !fullPanelQualificationRequested(env)
    && !providerQualificationRequested(env)
    && receiptValue(env, 'REVIEW_RECEIPT_ONLY') !== 'true'
    && receiptValue(env, 'REVIEW_PUBLICATION_MODE') === 'disabled';
}

function invalidFullPanelQualificationContract(): Error {
  return new Error('full-panel qualification worker contract is invalid');
}

/** Full-panel qualification is explicit, non-publishing, and mutually exclusive. */
export function isFullPanelQualificationWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return fullPanelQualificationRequested(env)
    && !panelQualificationRequested(env)
    && !providerQualificationRequested(env)
    && receiptValue(env, 'REVIEW_RECEIPT_ONLY') !== 'true'
    && receiptValue(env, 'REVIEW_PUBLICATION_MODE') === 'disabled';
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

function fullPanelQualificationConfig(model: string, timeoutMs: number): CtReviewConfigV3 {
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
      paths: [...persona.paths],
      providers: ['qualification'],
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

function panelQualificationResultDigest(result: PanelResult): string {
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
      verdict: result.arbiter.verdict,
    },
  })).digest('hex');
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
  const startedAt = new Date().toISOString();
  let providerCalls = 0;
  const effectiveClient = client || qualificationClient(env);
  const countingClient: ReviewModelClient = {
    complete: async (request) => {
      providerCalls += 1;
      return effectiveClient.complete(request);
    },
  };
  const boundedClient = new BoundedQualificationClient(countingClient, 3);
  const result = await runWithQualificationDeadline(panelRunner({
    config: fullPanelQualificationConfig(model, timeoutMs),
    changedFiles: FULL_PANEL_QUALIFICATION_FIXTURE,
    repository: identity.repo,
    headSha: identity.headSha,
    client: boundedClient,
    jobId: identity.runId,
  }), timeoutMs);
  if (!result.quorum.satisfied || !result.arbiter?.verdict
      || result.personas.length !== FULL_PANEL_QUALIFICATION_PERSONAS.length
      || result.optionalFailures.length > 0
      || providerCalls < FULL_PANEL_MIN_PROVIDER_CALLS) {
    throw invalidFullPanelQualificationContract();
  }
  const completedAt = new Date().toISOString();
  const receipt: FullPanelQualificationReceipt = {
    version: 'ReviewYetiPanelQualification.v1',
    profile: 'full-panel',
    expectedPersonaCount: 6,
    optionalFailureCount: 0,
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
    || 'JBJMLLC/ct-review-bot';
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
): Promise<void> {
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
