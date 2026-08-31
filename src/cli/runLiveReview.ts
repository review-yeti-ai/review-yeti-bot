import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { executePersonaPanel } from '../panel/panelEngine';
import { generatePRSummary } from '../review/summaryEngine';
import { generateMermaidDiagram } from '../review/mermaidEngine';
import { CommentPublisher } from '../github/commentPublisher';
import { getGitHubAppInstallationToken } from '../github/appAuth';
import { OpenRouterClient } from '../gateway/openRouterClient';
import { createDefaultV3Config } from '../config/configLoader';
import { logger } from '../utils/logger';

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

async function main() {
  if (isReceiptOnlyWorker()) {
    const receipt = await runReceiptOnlyWorker();
    logger.info('Receipt-only worker completed without provider or GitHub calls', {
      runId: receipt.runId,
      repositoryId: receipt.repositoryId,
      prNumber: receipt.prNumber,
    });
    return;
  }
  const cliArgs = process.argv.slice(2);
  const positionalArgs = cliArgs.filter((value) => !value.startsWith('--'));
  const prValue = cliArgs.find((value) => value.startsWith('--pr='))?.slice('--pr='.length)
    || positionalArgs[0]
    || process.env.PR_NUMBER
    || '1';
  const repo = cliArgs.find((value) => value.startsWith('--repo='))?.slice('--repo='.length)
    || positionalArgs[1]
    || process.env.REPO
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
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_REVIEW_FLEET_KEY || process.env.OPENROUTER_PR_REVIEW_API_KEY || requiredWorkerEnv(process.env, 'OPENROUTER_API_KEY'),
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

  const auth = resolveWorkerAuthConfig();
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

if (require.main === module) {
  main().catch((err) => {
    logger.error('Failed live ct-review-bot review dispatch', { error: err.message });
    process.exit(1);
  });
}
