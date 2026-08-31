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

/** Provider qualification is opt-in and cannot share the receipt-only/live modes. */
export function isProviderQualificationWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return providerQualificationRequested(env)
    && receiptValue(env, 'REVIEW_RECEIPT_ONLY') !== 'true'
    && receiptValue(env, 'REVIEW_PUBLICATION_MODE') === 'disabled';
}

function invalidProviderQualificationContract(): Error {
  return new Error('provider qualification worker contract is invalid');
}

function qualificationTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = receiptValue(env, 'REVIEW_QUALIFICATION_TIMEOUT_MS') || '120000';
  const timeoutMs = Number(raw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw invalidProviderQualificationContract();
  }
  return timeoutMs;
}

function providerQualificationIdentity(env: NodeJS.ProcessEnv): Omit<ProviderQualificationReceipt,
  'version' | 'status' | 'providerId' | 'requestedModel' | 'resolvedModel' | 'responseDigest' |
  'responseChars' | 'publicationMode' | 'providerCalls' | 'githubWrites' | 'usage' | 'costUSD' |
  'startedAt' | 'completedAt'> {
  const runId = receiptValue(env, 'REVIEW_RUN_ID');
  const deliveryId = receiptValue(env, 'REVIEW_DELIVERY_ID');
  const repositoryId = Number(receiptValue(env, 'REVIEW_REPOSITORY_ID'));
  const repo = receiptValue(env, 'REVIEW_REPO');
  const prNumber = Number(receiptValue(env, 'REVIEW_PR_NUMBER'));
  const headSha = receiptValue(env, 'REVIEW_HEAD_SHA');
  const baseSha = receiptValue(env, 'REVIEW_BASE_SHA');
  const policyDigest = receiptValue(env, 'REVIEW_POLICY_DIGEST');
  const configDigest = receiptValue(env, 'REVIEW_CONFIG_DIGEST');
  if (!isProviderQualificationWorker(env)
      || receiptValue(env, 'REVIEW_RECEIPT_PATH') !== RECEIPT_ONLY_PATH
      || !RECEIPT_RUN_ID.test(runId) || deliveryId.length < 1 || deliveryId.length > 512
      || !Number.isSafeInteger(repositoryId) || repositoryId < 1 || !RECEIPT_REPO.test(repo)
      || !Number.isSafeInteger(prNumber) || prNumber < 1 || !RECEIPT_SHA.test(headSha)
      || !RECEIPT_SHA.test(baseSha) || !RECEIPT_DIGEST.test(policyDigest)
      || !RECEIPT_DIGEST.test(configDigest)) {
    throw invalidProviderQualificationContract();
  }
  return { runId, deliveryId, repositoryId, repo, prNumber, headSha, baseSha, policyDigest, configDigest };
}

function qualificationModel(env: NodeJS.ProcessEnv): string {
  const model = receiptValue(env, 'REVIEW_QUALIFICATION_MODEL');
  if (!model || model === 'openrouter/auto' || model === 'auto') {
    throw invalidProviderQualificationContract();
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
): Promise<void> {
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
