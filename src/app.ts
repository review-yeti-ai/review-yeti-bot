import express, { Express, NextFunction, Request, Response } from 'express';
import path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'node:crypto';
import { parseAndValidateConfig, createDefaultV4Config, normalizeConfigToV4 } from './config/configLoader';
import { CtReviewConfigV3 } from './config/schema';
import { OpenRouterClient } from './gateway/openRouterClient';
import { getGitHubAppInstallationIdForRepository, getGitHubAppInstallationToken } from './github/appAuth';
import { GitHubEventHandler, ParsedPRPayload } from './github/eventHandler';
import { GitHubInstallationClient } from './github/installationClient';
import { createWebhookRouter, RequestWithRawBody } from './github/webhookServer';
import { executePersonaPanel, PanelResult } from './panel/panelEngine';
import { ReviewRunStore } from './persistence/reviewRunStore';
import { PostgresReviewRunRepository, ReviewRunRepository } from './persistence/reviewRunRepository';
import { PostgresReviewDispatchRepository } from './persistence/reviewDispatchRepository';
import { PostgresReviewArtifactStore, ReviewArtifactStore } from './persistence/reviewArtifactStore';
import { createMemoryRouter } from './api/memoryApi';
import { createProviderRouter } from './gateway/providerRouterApi';
import { createAuthRouter } from './api/authApi';
import { createDashboardRouter } from './api/dashboardApi';
import { createAnalyticsRouter } from './api/analytics';
import { createIntegrationsRouter } from './dashboard/integrationsApi';
import { createLiveRouter } from './api/liveApi';
import { createGitHubAppApiRouter } from './api/githubAppApi';
import { createOnboardingRouter } from './api/onboarding';
import { createActionDispatchRouter } from './api/actionDispatchApi';
import { GitHubActionsOidcVerifier, githubActionsOidcPolicyFromEnv } from './auth/githubActionsOidc';
import { getSystemVersionInfo } from './utils/versionInfo';
import { requireAuth } from './api/authMiddleware';
import { dashboardStore } from './persistence/dashboardStore';
import { postgresStore } from './persistence/postgresStore';
import { providerPool } from './gateway/providerPool';
import { computeAppVerdict } from './review/reviewAdapters';
import { sanitizeFindings, sha256 } from './review/reviewCore';
import { assertSnapshotCurrent, createPRSnapshot, PRSnapshot } from './review/prSnapshot';
import { buildReviewRunIdentity } from './review/reviewAdmission';
import { resolveSubmoduleDecision, SubmodulePolicy } from './review/submodulePolicy';
import { GraphLearningEngine } from './memory/graphLearningEngine';
import { PRCloseDispatcher } from './github/prCloseDispatcher';
import {
  MAX_FINAL_INLINE_COMMENTS,
  buildFinalInlineComments,
  formatFinalReviewBody,
  formatPersonaIssueComment,
  type FindingWithPersona,
} from './github/panelPublication';
import { logger } from './utils/logger';
import { LiveStreamBus } from './live/liveStreamBus';
import {
  initTelemetry,
  getTracer,
  getMetrics,
  getPrometheusMetrics,
  getRecentSpans,
  runInSpan,
  telemetryMiddleware,
} from './telemetry';

export { type RequestWithRawBody, providerPool };

const store = new ReviewRunStore(process.env.CT_REVIEW_RUN_STORE || '/tmp/ct-review-bot/review-runs.json');
const durableReviewRuns: ReviewRunRepository | null = postgresStore.isConfigured()
  ? new PostgresReviewRunRepository(postgresStore.getPool())
  : null;
const durableReviewArtifacts: ReviewArtifactStore | null = postgresStore.isConfigured()
  ? new PostgresReviewArtifactStore(postgresStore.getPool())
  : null;

function admissionIdentity(payload: ParsedPRPayload) {
  return buildReviewRunIdentity({
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.prNumber,
    headSha: payload.headSha,
    baseSha: payload.baseSha,
    changedFiles: payload.changedFiles,
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`required environment variable ${name} is missing`);
  return value;
}

function privateKey(): string {
  return requiredEnv('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n');
}

/**
 * The Kubernetes worker currently publishes its own review but has no durable result handoff
 * back to this process. Refuse the flag explicitly rather than executing the same review twice.
 */
export function assertSupportedReviewExecution(env: NodeJS.ProcessEnv = process.env): void {
  if (env.KUBERNETES_WORKER_DISPATCH === 'true') {
    throw new Error('Kubernetes worker dispatch is disabled until a durable worker result handoff is implemented');
  }
}

function openRouterClient(): OpenRouterClient {
  return new OpenRouterClient({
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: requiredEnv('OPENROUTER_API_KEY'),
  });
}

function usage(value: { prompt: number; completion: number; total: number } | null): string {
  return value
    ? `${value.total} total (${value.prompt} prompt, ${value.completion} completion)`
    : 'unavailable';
}

function cost(value: number | null): string {
  return value === null ? 'unavailable' : `$${value.toFixed(6)} USD`;
}

function personaBody(lane: PanelResult['personas'][number], headSha: string): string {
  // Issue-comment body only — personas must not open PR review threads.
  return formatPersonaIssueComment(lane, headSha, {
    usageLine: usage(lane.usage),
    costLine: cost(lane.costUSD),
  });
}

function checkSummary(result: PanelResult): string {
  const laneRows = result.personas.map((lane) =>
    `| ${lane.id} | ${lane.required ? 'yes' : 'no'} | ${lane.providerId} | \`${lane.model}\` | ${lane.decision} | ${lane.durationMs} ms | ${usage(lane.usage)} | ${cost(lane.costUSD)} |`,
  ).join('\n');
  const personaFindings = result.personas.flatMap((lane) =>
    lane.findings.map((finding) =>
      `- **${lane.id} / ${finding.severity}** \`${finding.path}:${finding.line}\` — ${finding.title}: ${finding.body}`,
    ),
  );
  const optionalFailures = result.optionalFailures.map((failure) =>
    `- **${failure.id}** — ${failure.error}`,
  );
  const moderatorFindings = result.moderator.findings.map((finding) =>
    `- **${finding.severity}** \`${finding.path}:${finding.line}\` — ${finding.title}: ${finding.body}`,
  );
  return [
    `Exact head: \`${result.headSha}\``,
    '',
    '| Persona | Required | Provider | Model | Decision | Duration | Tokens | Cost |',
    '|---|---:|---|---|---|---:|---|---|',
    laneRows,
    '',
    '### Persona findings',
    ...(personaFindings.length > 0 ? personaFindings : ['No persona findings.']),
    '',
    '### Optional-lane failures',
    ...(optionalFailures.length > 0 ? optionalFailures : ['None.']),
    '',
    `Distinct-provider quorum: ${result.quorum.distinctProviders.length}/${result.quorum.required} (${result.quorum.distinctProviders.join(', ')})`,
    '',
    `Moderator: \`${result.moderator.providerId}\` / \`${result.moderator.model}\` — ${result.moderator.decision}`,
    `Moderator tokens: ${usage(result.moderator.usage)}; cost: ${cost(result.moderator.costUSD)}`,
    '### Moderator ledger',
    ...(moderatorFindings.length > 0 ? moderatorFindings : ['No reconciled findings.']),
    '',
    `Binding arbiter: \`${result.arbiter.providerId}\` / \`${result.arbiter.model}\``,
    `Verdict: \`${result.arbiter.verdict}\``,
    `Rationale: ${result.arbiter.rationale}`,
    `Arbiter tokens: ${usage(result.arbiter.usage)}; cost: ${cost(result.arbiter.costUSD)}`,
  ].join('\n');
}

async function withinOverallTimeout<T>(operation: Promise<T>, timeoutSeconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`persona panel exceeded overall timeout of ${timeoutSeconds} seconds`)),
          timeoutSeconds * 1_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function installationClient(
  payload: ParsedPRPayload,
  options: { currentHeadSha?: () => Promise<string> } = {},
): Promise<GitHubInstallationClient> {
  if (!payload.installationId) throw new Error('webhook payload has no GitHub App installation id');
  const baseUrl = process.env.GITHUB_API_BASE_URL || 'https://api.github.com';
  const token = await getGitHubAppInstallationToken({
    appId: requiredEnv('GITHUB_APP_ID'),
    privateKey: privateKey(),
    installationId: payload.installationId,
    baseUrl,
  });
  if (!token.token.startsWith('ghs_')) throw new Error('GitHub returned a non-installation token');
  const permissions = token.permissions || {};
  const requiredPermissions: Record<string, string> = {
    metadata: 'read',
    contents: 'read',
    pull_requests: 'write',
    issues: 'write',
  };
  for (const [name, required] of Object.entries(requiredPermissions)) {
    const actual = permissions[name];
    if (actual !== required && actual !== 'admin') {
      throw new Error(`GitHub App installation permission ${name} must be ${required}; got ${actual || 'missing'}`);
    }
  }
  return new GitHubInstallationClient({ token: token.token, baseUrl, currentHeadSha: options.currentHeadSha });
}

export async function runReviewPipeline(payload: ParsedPRPayload): Promise<any> {
  const { owner, repo, prNumber, headSha } = payload;
  const repoFull = `${owner}/${repo}`;
  const startTime = Date.now();
  const jobId = `job_${owner}_${repo}_pr${prNumber}_${headSha.slice(0, 7)}`;
  const durableWorkerId = `app-${process.pid}-${randomUUID()}`;
  const durableIdentity = admissionIdentity(payload);
  const durableRun = durableReviewRuns
    ? await durableReviewRuns.createOrGet({ identity: durableIdentity, now: startTime })
    : null;
  if (durableRun && !(await durableReviewRuns!.claim(durableRun.runId, durableWorkerId, startTime, 15 * 60 * 1000))) {
    throw new Error(`review run ${durableRun.runId} is already leased by another worker`);
  }
  const durableHeartbeatTimer = durableRun
    ? setInterval(() => {
      void durableReviewRuns!.heartbeat(durableRun.runId, durableWorkerId, Date.now(), 15 * 60 * 1000).catch((error) => {
        logger.warn('Failed to renew durable review lease', { error: error?.message || error, runId: durableRun.runId });
      });
    }, 60_000)
    : undefined;
  durableHeartbeatTimer?.unref?.();

  const durableTransition = async (stage: import('./review/piWorkflow').PiStage, now = Date.now()) => {
    if (durableRun) await durableReviewRuns!.transition(durableRun.runId, stage, durableWorkerId, now);
  };
  const durablePersist = async (stage: import('./review/piWorkflow').ExecutablePiStage, payload: import('./review/reviewRun').JsonValue, now = Date.now()): Promise<string | undefined> => {
    if (!durableRun || !durableReviewArtifacts) return undefined;
    const digest = await durableReviewArtifacts.put(durableRun.runId, stage, payload);
    await durableReviewRuns!.recordArtifact(durableRun.runId, stage, digest, durableWorkerId, now);
    return digest;
  };
  const durableFail = async (message: string, now = Date.now()) => {
    if (durableRun) await durableReviewRuns!.fail(durableRun.runId, durableWorkerId, now, message).catch((error) => {
      logger.error('Failed to persist durable review failure', { error: error?.message || error, runId: durableRun.runId });
    });
  };
  const durableCancel = async (reason: string, now = Date.now()) => {
    if (durableRun) await durableReviewRuns!.cancel(durableRun.runId, now, reason).catch((error) => {
      logger.error('Failed to release cancelled durable review run', { error: error?.message || error, runId: durableRun.runId });
    });
  };

  LiveStreamBus.getInstance().publishEvent({
    jobId,
    timestamp: new Date().toISOString(),
    type: 'job:dispatched',
    persona: 'all',
    data: {
      repo: repoFull,
      prNumber,
      headSha,
      message: `Review job dispatched for ${repoFull} #${prNumber}`,
      status: 'dispatched',
    },
  });

  try {
    const metrics = getMetrics();
    metrics.jobsDispatched.add(1, { repository: repoFull });
    metrics.queuedJobs.add(-1, { repository: repoFull });
    metrics.activeJobs.add(1, { repository: repoFull });
  } catch (_) {}

  return runInSpan('ct_review_pipeline', async (span) => {
    span.setAttribute('ct.repo', repoFull);
    span.setAttribute('ct.pr_number', prNumber);
    span.setAttribute('ct.head_sha', headSha);

    try {
      if (!dashboardStore.isAutomationEnabled(owner, repo)) {
        logger.info(`Review automation disabled for repository ${repoFull}`);
        await durableCancel('automation disabled per repo setting');
        span.setAttribute('ct.status', 'skipped');
        try {
          getMetrics().reviewDuration.record((Date.now() - startTime) / 1000, {
            repository: repoFull,
            status: 'skipped',
            verdict: 'none',
          });
        } catch (_) {}
        return { status: 'skipped', reason: 'automation disabled per repo setting' };
      }
      const githubRef: { client?: GitHubInstallationClient } = {};
      const github = await installationClient(payload, {
        currentHeadSha: async () => {
          if (!githubRef.client) throw new Error('GitHub client is not initialized for exact-head verification');
          return (await githubRef.client.getPullRequest(owner, repo, prNumber)).headSha;
        },
      });
      githubRef.client = github;
      let checkId: number | undefined;
      try {
        const snapshot = await github.getPullRequest(owner, repo, prNumber);
        if (snapshot.headSha !== headSha) {
          await durableCancel('stale webhook head');
          span.setAttribute('ct.status', 'cancelled');
          try {
            getMetrics().reviewDuration.record((Date.now() - startTime) / 1000, {
              repository: repoFull,
              status: 'cancelled',
              verdict: 'none',
            });
          } catch (_) {}
          return { status: 'cancelled', reason: 'stale webhook head', expected: snapshot.headSha, received: headSha };
        }
        store.markHead(owner, repo, prNumber, headSha);
        await durablePersist('admission', { identity: durableIdentity } as unknown as import('./review/reviewRun').JsonValue);
        await durableTransition('snapshot');
        try {
          checkId = await github.createCheck(owner, repo, headSha);
        } catch (err: any) {
          logger.warn('Skipping Check Run creation: GitHub App does not have checks:write permission or it is disabled', {
            error: err?.message || err,
          });
        }

        const [rawPolicy, changedFilesFromGitHub] = await Promise.all([
          github.getBasePolicy(owner, repo, snapshot.baseSha).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (/^GitHub API 404\b/u.test(message)) return null;
            throw error;
          }),
          github.getChangedFiles(owner, repo, prNumber),
        ]);
        let changedFiles = changedFilesFromGitHub;
        const getSubmoduleUrls = (github as unknown as { getSubmoduleUrls?: (owner: string, repo: string, ref: string) => Promise<Record<string, string>> }).getSubmoduleUrls?.bind(github);
        // REL-491: this .gitmodules fetch previously had no retry and no failure logging. A
        // transient GitHub API error (timeout, 5xx) silently returned/threw as if the repository
        // had no submodule metadata, which forwards into a submodule policy decision of BLOCK /
        // INCOMPLETE_REVIEW with nothing in the logs naming the artifact that actually failed.
        // Retry once (bounded) before accepting the failure, and always name the artifact and
        // the exact error when a fetch does not recover.
        const fetchSubmoduleUrlsLogged = async (ref: string): Promise<Record<string, string>> => {
          if (typeof getSubmoduleUrls !== 'function') return {};
          const artifact = `.gitmodules@${ref} (${owner}/${repo})`;
          try {
            return await getSubmoduleUrls(owner, repo, ref);
          } catch (firstError: any) {
            logger.warn(`Submodule coverage evidence fetch failed, retrying once: ${artifact}`, {
              error: firstError?.message || firstError,
            });
            try {
              return await getSubmoduleUrls(owner, repo, ref);
            } catch (secondError: any) {
              logger.warn(`Submodule coverage evidence fetch failed after bounded retry: ${artifact}`, {
                error: secondError?.message || secondError,
              });
              throw secondError;
            }
          }
        };
        if (typeof getSubmoduleUrls === 'function' && changedFiles.some((file) => file.isSubmodule || file.submoduleCandidate || file.mode === '160000')) {
          const [baseUrls, headUrls] = await Promise.all([
            fetchSubmoduleUrlsLogged(snapshot.baseSha),
            fetchSubmoduleUrlsLogged(headSha),
          ]);
          changedFiles = changedFiles.map((file) => {
            const oldSubmoduleUrl = baseUrls[file.path];
            const newSubmoduleUrl = headUrls[file.path];
            if (!oldSubmoduleUrl && !newSubmoduleUrl) return file;
            const { submoduleCandidate: _candidate, ...withoutCandidate } = file;
            return {
              ...withoutCandidate,
              isSubmodule: true,
              ...(oldSubmoduleUrl ? { oldSubmoduleUrl } : {}),
              ...(newSubmoduleUrl ? { newSubmoduleUrl } : {}),
              ...(oldSubmoduleUrl && newSubmoduleUrl && oldSubmoduleUrl !== newSubmoduleUrl ? { submoduleUrlChanged: true } : {}),
            };
          });
        }
        let config: CtReviewConfigV3;
        if (rawPolicy === null) {
          logger.info(`No .ct-review.yaml configuration found in ${repoFull}, falling back to default balanced configuration`);
          config = createDefaultV4Config() as unknown as CtReviewConfigV3;
        } else {
          const parsed = parseAndValidateConfig(rawPolicy);
          config = parsed.version === 3
            ? parsed as CtReviewConfigV3
            : normalizeConfigToV4(parsed as any) as unknown as CtReviewConfigV3;
        }
        const reviewSnapshot: PRSnapshot = createPRSnapshot({
          owner,
          repo,
          prNumber,
          headSha,
          baseSha: snapshot.baseSha,
          title: snapshot.title,
          configRef: snapshot.baseSha,
          configDigest: sha256(rawPolicy || config),
          engineVersion: 'review-core-v1',
          changedFiles,
        });
        await durablePersist('snapshot', reviewSnapshot as unknown as import('./review/reviewRun').JsonValue);
        await durableTransition('config');
        await durablePersist('config', config as unknown as import('./review/reviewRun').JsonValue);
        const submodulePolicy = ((config as any).submodules || createDefaultV4Config().submodules) as SubmodulePolicy;
        const submoduleDecisions = changedFiles.map((file) => resolveSubmoduleDecision(file, submodulePolicy));
        const submoduleCoverageGaps = submoduleDecisions.filter((decision) =>
          decision.decision === 'BLOCK' || decision.decision === 'INCOMPLETE_REVIEW',
        );
        const submoduleCoverageComplete = submoduleCoverageGaps.length === 0;
        // REL-491: name every artifact that forced coverage incomplete, not just the boolean.
        // The verdict rationale threads this through `computeAppVerdict`'s `coverageGaps` option
        // so a BLOCK never has to fall back to a generic "coverage incomplete" restatement of the
        // clean-panel sentence.
        if (!submoduleCoverageComplete) {
          logger.warn(`Submodule coverage incomplete for ${repoFull}#${prNumber}: ${submoduleCoverageGaps.map((gap) => `${gap.path} (${gap.reason})`).join('; ')}`);
        }
        const reviewChangedFiles = changedFiles.filter((_file, index) => submoduleDecisions[index].decision !== 'IGNORE');
        await durableTransition('submodules');
        await durablePersist('submodules', {
          coverageComplete: submoduleCoverageComplete,
          decisions: submoduleDecisions,
          reviewFiles: reviewChangedFiles,
        } as unknown as import('./review/reviewRun').JsonValue);

        assertSupportedReviewExecution();
        await durableTransition('review');
        const panel: PanelResult = await withinOverallTimeout(executePersonaPanel({
          config,
          changedFiles: reviewChangedFiles,
          repository: repoFull,
          headSha,
          client: openRouterClient(),
          isCurrentHead: () => store.isCurrentHead(owner, repo, prNumber, headSha),
        }), config.reviewers.overall_timeout_s);
        await durablePersist('review', panel as unknown as import('./review/reviewRun').JsonValue);

        const fresh = await github.getPullRequest(owner, repo, prNumber);
        try {
          assertSnapshotCurrent(reviewSnapshot, { headSha: fresh.headSha, baseSha: fresh.baseSha });
        } catch (snapshotError: any) {
          if (fresh.headSha === headSha && fresh.baseSha === reviewSnapshot.baseSha) throw snapshotError;
          logger.warn('Review snapshot changed during execution; cancelling publication', { error: snapshotError?.message || snapshotError });
        }
        if (fresh.headSha !== headSha || fresh.baseSha !== reviewSnapshot.baseSha || !store.isCurrentHead(owner, repo, prNumber, headSha)) {
          if (checkId !== undefined) {
            await github.completeCheck({
              owner,
              repo,
              checkId,
              conclusion: 'cancelled',
              title: 'Persona panel cancelled for stale head',
              summary: `Review started at \`${headSha}\` but current head is \`${fresh.headSha}\`.`,
          }).catch((err) => logger.warn('Failed to complete check run for stale head', { error: err?.message || err }));
          }
          await durableFail(`review snapshot changed before publication: expected head ${headSha}, found head ${fresh.headSha}`);
          span.setAttribute('ct.status', 'cancelled');
          try {
            getMetrics().reviewDuration.record((Date.now() - startTime) / 1000, {
              repository: repoFull,
              status: 'cancelled',
              verdict: 'none',
            });
          } catch (_) {}
          return { status: 'cancelled', reason: 'head changed during review' };
        }

        if (panel.optionalFailures.length > 0) {
          throw new Error(`optional persona failure; refusing to publish a green verdict: ${panel.optionalFailures.map((failure) => `${failure.id}: ${failure.error}`).join(' | ')}`);
        }

        for (const lane of panel.personas) {
          lane.findings = sanitizeFindings(lane.findings, reviewChangedFiles) as typeof lane.findings;
        }
        const canonical = computeAppVerdict({
          lanes: panel.personas.map((lane) => ({
            id: lane.id,
            required: lane.required,
            decision: lane.decision,
            findings: lane.findings,
          })),
          expectedLanes: panel.personas.length,
          changedFiles: reviewChangedFiles,
          coverageComplete: submoduleCoverageComplete && panel.optionalFailures.length === 0,
          coverageGaps: submoduleCoverageGaps.map((gap) => ({ path: gap.path, reason: gap.reason })),
          candidateVerdict: panel.arbiter.verdict,
          rationale: panel.arbiter.rationale,
        });
        panel.arbiter = {
          ...panel.arbiter,
          verdict: canonical.verdict,
          rationale: canonical.rationale,
        };
        await durableTransition('arbiter');
        await durablePersist('arbiter', panel.arbiter as unknown as import('./review/reviewRun').JsonValue);

        const assertCurrentHead = async () => {
          const current = await github.getPullRequest(owner, repo, prNumber);
          if (current.headSha !== headSha || !store.isCurrentHead(owner, repo, prNumber, headSha)) {
            throw new Error(`head changed before publication: expected ${headSha}, found ${current.headSha}`);
          }
        };

        const learningEngine = new GraphLearningEngine();
        await durableTransition('publish');
        if (durableRun) {
          const publicationClaim = await durableReviewRuns!.claimPublication(durableRun.runId, durableWorkerId, Date.now());
          if (!publicationClaim) throw new Error(`review run ${durableRun.runId} could not claim publication`);
        }

        // Phase 1 — persona reports as issue comments only (no review threads).
        // Opening per-persona COMMENT reviews with inline findings creates dozens of
        // resolve-required threads under required_conversation_resolution and
        // thrashes statusCheckRollup. Personas are advisory inputs to the arbiter.
        const retainedFindings: FindingWithPersona[] = [];
        let laneIndex = 0;
        for (const lane of panel.personas) {
          laneIndex += 1;
          await assertCurrentHead();
          const { filteredFindings, suppressedNits } = await learningEngine.analyzeAndFilterFindings(
            repoFull,
            lane.findings
          );
          if (suppressedNits.length > 0) {
            logger.info(`Suppressed ${suppressedNits.length} nit pattern(s) for persona ${lane.id}`);
          }
          lane.findings = filteredFindings as typeof lane.findings;
          for (const finding of filteredFindings) {
            retainedFindings.push({ ...finding, persona: lane.id });
          }

          const body = formatPersonaIssueComment(lane, headSha, {
            usageLine: usage(lane.usage),
            costLine: cost(lane.costUSD),
            runId: durableRun?.runId || undefined,
            laneIndex,
            laneTotal: panel.personas.length,
          });
          await github.postIssueComment(owner, repo, prNumber, body);
          logger.info(`✅ Persona issue comment published`, {
            persona: lane.id,
            owner,
            repo,
            prNumber,
            findings: filteredFindings.length,
            surface: 'issue_comment',
          });
        }

        // Phase 2 — single arbiter review; only deduped P0/P1 become review threads.
        const summary = checkSummary(panel);
        const ship = panel.arbiter.verdict === 'SHIP';
        const finalInline = buildFinalInlineComments({
          owner,
          repo,
          prNumber,
          commitSha: headSha,
          findings: retainedFindings,
          max: MAX_FINAL_INLINE_COMMENTS,
        });
        await assertCurrentHead();
        const final = await github.publishReview({
          owner,
          repo,
          prNumber,
          commitSha: headSha,
          event: ship ? 'APPROVE' : 'REQUEST_CHANGES',
          body: formatFinalReviewBody({
            verdict: panel.arbiter.verdict,
            rationale: panel.arbiter.rationale,
            summary,
            headSha,
            inlineCount: finalInline.length,
            totalActionableCandidates: retainedFindings.filter((f) => f.severity === 'P0' || f.severity === 'P1').length,
            maxInline: MAX_FINAL_INLINE_COMMENTS,
          }),
          idempotencyKey: 'arbiter',
          inlineComments: finalInline,
        });
        if (!final.success) throw new Error(`failed to publish arbiter review: ${final.errors?.join('; ')}`);
        logger.info(`✅ Review pipeline completed successfully`, {
          owner, repo, prNumber, headSha: headSha.slice(0, 8),
          verdict: panel.arbiter.verdict,
          decision: ship ? 'APPROVE' : 'REQUEST_CHANGES',
          personaCount: panel.personas.length,
          personaSurface: 'issue_comment',
          finalInlineThreads: finalInline.length,
          durationMs: Date.now() - startTime,
        });
        if (checkId !== undefined) {
          await github.completeCheck({
            owner,
            repo,
            checkId,
            conclusion: ship ? 'success' : 'failure',
            title: `Binding arbiter verdict: ${panel.arbiter.verdict}`,
            summary,
          }).catch((err) => logger.warn('Failed to complete check run for successful review', { error: err?.message || err }));
        }
        const publicationDigest = await durablePersist('publish', { reviewSnapshot, panel, final } as unknown as import('./review/reviewRun').JsonValue);
        if (durableRun) await durableReviewRuns!.succeed(durableRun.runId, durableWorkerId, Date.now(), publicationDigest || sha256({ reviewSnapshot, panel, final }));
        // Aggregate total tokens and cost across all personas + moderator + arbiter
        const totalPromptTokens = [
          ...panel.personas.map((p) => p.usage?.prompt ?? 0),
          panel.moderator.usage?.prompt ?? 0,
          panel.arbiter.usage?.prompt ?? 0,
        ].reduce((a, b) => a + b, 0);
        const totalCompletionTokens = [
          ...panel.personas.map((p) => p.usage?.completion ?? 0),
          panel.moderator.usage?.completion ?? 0,
          panel.arbiter.usage?.completion ?? 0,
        ].reduce((a, b) => a + b, 0);
        const totalCostUSD = [
          ...panel.personas.map((p) => p.costUSD ?? 0),
          panel.moderator.costUSD ?? 0,
          panel.arbiter.costUSD ?? 0,
        ].reduce((a, b) => a + b, 0);
        const totalDurationMs = Date.now() - startTime;

        dashboardStore.recordReviewRun({
          prRun: `${repo} #${prNumber}`,
          repo: `${owner}/${repo}`,
          prNumber,
          title: snapshot.title || `PR #${prNumber} Code Review`,
          headSha,
          personas: panel.personas.map((lane) => lane.id),
          quorum: `${panel.quorum.distinctProviders.length}/${panel.quorum.required} Distinct`,
          arbiterVerdict: panel.arbiter.verdict,
          latencyMs: totalDurationMs,
          costUSD: totalCostUSD,
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          tokens: { prompt: totalPromptTokens, completion: totalCompletionTokens, total: totalPromptTokens + totalCompletionTokens },
          personaLogs: [
            // Successful persona logs
            ...panel.personas.map((lane) => ({
              persona: lane.id,
              displayName: lane.id.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
              decision: (lane.decision === 'APPROVE' ? 'SHIP' : 'NACK') as 'SHIP' | 'NACK',
              model: `${lane.providerId}/${lane.model}`,
              findingsCount: lane.findings.length,
              latencyMs: lane.durationMs,
              confidence: lane.decision === 'APPROVE' ? 0.95 : 0.7,
              turnsCount: lane.turnsCount ?? 1,
              status: 'success' as const,
              summary: lane.findings.length > 0
                ? `${lane.findings.length} finding(s): ${lane.findings.map((f) => f.title).join('; ').slice(0, 200)}`
                : `No findings. Clean review for persona ${lane.id}.`,
              promptTokens: lane.usage?.prompt ?? 0,
              completionTokens: lane.usage?.completion ?? 0,
              totalTokens: lane.usage?.total ?? 0,
              costUSD: lane.costUSD ?? 0,
              nits: lane.findings.map((f) => ({
                filePath: f.path,
                lineNumber: f.line,
                severity: f.severity,
                title: f.title,
                description: f.body,
                suggestion: f.suggestion,
              })),
            })),
            // Failed persona logs (API errors captured from optionalFailures)
            ...panel.optionalFailures.map((failure) => {
              // Extract HTTP status code from error message if present (for example OpenRouter 429).
              const httpMatch = failure.error.match(/HTTP\s+(\d{3})/i);
              const apiStatusCode = httpMatch ? parseInt(httpMatch[1], 10) : undefined;
              const isTimeout = /timeout|timed?\s*out|ETIMEDOUT|AbortError/i.test(failure.error);
              return {
                persona: failure.id,
                displayName: failure.id.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
                decision: 'NACK' as const,
                model: 'unknown',
                findingsCount: 0,
                latencyMs: 0,
                confidence: 0,
                turnsCount: 0,
                status: (isTimeout ? 'timeout' : 'error') as 'timeout' | 'error',
                apiError: failure.error,
                apiStatusCode: apiStatusCode ?? (isTimeout ? 'TIMEOUT' : 'ERROR'),
                summary: `API Error: ${failure.error.slice(0, 300)}`,
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                costUSD: 0,
                nits: [],
              };
            }),
          ],
          optionalFailures: panel.optionalFailures.length > 0 ? panel.optionalFailures : undefined,
          mermaidDiagram: panel.mermaidDiagram,
        });

        span.setAttribute('ct.status', 'processed');
        try {
          getMetrics().reviewDuration.record((Date.now() - startTime) / 1000, {
            repository: repoFull,
            status: 'processed',
            verdict: panel.arbiter.verdict,
          });
        } catch (_) {}

        return {
          status: 'processed',
          prNumber,
          headSha,
          personas: panel.personas.map((lane) => ({ id: lane.id, provider: lane.providerId, model: lane.model })),
          quorum: panel.quorum,
          arbiter: panel.arbiter.verdict,
          decision: ship ? 'APPROVE' : 'REQUEST_CHANGES',
        };
      } catch (error: any) {
        span.setAttribute('ct.status', 'failed');
        try {
          getMetrics().reviewDuration.record((Date.now() - startTime) / 1000, {
            repository: repoFull,
            status: 'failed',
            verdict: 'none',
          });
        } catch (_) {}
        const message = error?.message || String(error);
        await durableFail(message);
        logger.error('Persona panel failed closed', { owner, repo, prNumber, headSha, error: message });
        if (checkId) {
          await github.completeCheck({
            owner,
            repo,
            checkId,
            conclusion: 'failure',
            title: 'Persona panel infrastructure or policy failure',
            summary: `Exact head: \`${headSha}\`\n\nThe review failed closed before a binding approval.\n\n\`${message}\``,
          }).catch((publishError) => logger.error('Failed to complete failed check', { publishError }));
        }
        await github.postIssueComment(
          owner,
          repo,
          prNumber,
          `ct-review-bot failed closed at \`${headSha}\`: ${message}\n\nNo code verdict or approval was fabricated.`,
        ).catch((publishError) => logger.error('Failed to publish infrastructure failure comment', { publishError }));
        throw error;
      }
    } finally {
      if (durableHeartbeatTimer) clearInterval(durableHeartbeatTimer);
      try {
        getMetrics().activeJobs.add(-1, { repository: repoFull });
      } catch (_) {}
    }
  });
}

export function createApp(): Express {
  initTelemetry();
  const app = express();
  const eventHandler = new GitHubEventHandler();

  app.use(telemetryMiddleware());

  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    res.on('finish', () => logger.info('HTTP Request', {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - started,
    }));
    next();
  });

  app.use(express.json({
    verify: (req: RequestWithRawBody, _res: Response, buf: Buffer) => {
      req.rawBody = buf;
    },
  }));

  // GET /metrics (Prometheus exposition format)
  app.get('/metrics', async (_req: Request, res: Response) => {
    try {
      const text = await getPrometheusMetrics();
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      return res.status(200).send(text);
    } catch (err: any) {
      logger.error('Failed generating Prometheus metrics', { error: err?.message });
      return res.status(500).send('# Error generating metrics\n');
    }
  });

  // Health and Readiness Endpoints
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'ct-review-bot',
      memoryEngineReady: true,
      onboardingWizardReady: true,
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
    });
  });

  app.get('/ready', async (_req, res) => {
    const configurationReady = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'WEBHOOK_SECRET', 'OPENROUTER_API_KEY']
      .every((name) => Boolean(process.env[name]?.trim()));
    return res.status(configurationReady ? 200 : 503).json({
      status: configurationReady ? 'ready' : 'not_ready',
      configurationReady,
      openRouterReady: configurationReady,
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
    });
  });

  // Health, Readiness, and Version Endpoints
  app.get('/version', (_req: Request, res: Response) => {
    return res.status(200).json({ success: true, ...getSystemVersionInfo() });
  });

  app.get('/about', (_req: Request, res: Response) => {
    return res.status(200).json({ success: true, about: getSystemVersionInfo() });
  });

  app.get('/api/version', (_req: Request, res: Response) => {
    return res.status(200).json({ success: true, ...getSystemVersionInfo() });
  });

  app.get('/api/about', (_req: Request, res: Response) => {
    return res.status(200).json({ success: true, about: getSystemVersionInfo() });
  });

  // API Routers (Unauthenticated / Public routes)
  app.use('/api/auth', createAuthRouter());
  app.use('/api/onboarding', createOnboardingRouter());
  app.use('/api/router', createProviderRouter());
  app.use('/api/live', createLiveRouter());

  if (process.env.ACTION_DISPATCH_ENABLED === 'true') {
    if (!postgresStore.isConfigured()) {
      throw new Error('ACTION_DISPATCH_ENABLED requires DATABASE_URL or POSTGRES_URL for durable admission');
    }
    const oidcPolicy = githubActionsOidcPolicyFromEnv();
    const dispatchRepository = new PostgresReviewDispatchRepository(postgresStore.getPool());
    app.use('/api/dispatch', createActionDispatchRouter({
      verifier: new GitHubActionsOidcVerifier({ policy: oidcPolicy }),
      admission: dispatchRepository,
      allowAppGate: oidcPolicy.allowAppGate,
      resolveInstallationId: (owner, repo) => getGitHubAppInstallationIdForRepository({
        appId: requiredEnv('GITHUB_APP_ID'),
        privateKey: privateKey(),
        owner,
        repo,
        baseUrl: process.env.GITHUB_API_BASE_URL,
      }),
    }));
  }

  // Protected API Routes
  app.use('/api', requireAuth);

  // GET /api/telemetry/spans (JSON format) - protected by requireAuth
  app.get('/api/telemetry/spans', (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
    const traceId = req.query.traceId as string | undefined;
    const name = req.query.name as string | undefined;

    const spans = getRecentSpans({ limit, traceId, name });
    return res.status(200).json({
      status: 'ok',
      count: spans.length,
      spans,
    });
  });

  const dashboardRouter = createDashboardRouter();
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/personas', dashboardRouter);
  const integrationsRouter = createIntegrationsRouter();
  app.use('/api/dashboard', integrationsRouter);
  app.use('/api/dashboard/integrations', integrationsRouter);
  app.use('/api/dashboard/mcp', integrationsRouter);
  app.use('/api/analytics', createAnalyticsRouter());
  app.use('/api/github', createGitHubAppApiRouter());
  app.use('/api', createMemoryRouter());

  // GitHub Webhooks Router
  app.use(createWebhookRouter({
    onEvent: async (req: RequestWithRawBody) => {
      const eventName = String(req.headers['x-github-event'] || '');
      const deliveryId = String(req.headers['x-github-delivery'] || '');
      logger.info('Received GitHub webhook event', { eventName, deliveryId });

      const trigger = eventHandler.evaluateTrigger(eventName, req.body, deliveryId);
      logger.info('Evaluated webhook trigger', {
        shouldTrigger: trigger.shouldTrigger,
        reason: trigger.reason,
        eventName,
        deliveryId
      });

      if (!trigger.shouldTrigger || !trigger.parsedPayload) {
        return { status: 'ignored', reason: trigger.reason };
      }
      if (!store.claimDelivery(deliveryId)) {
        logger.info('Duplicate webhook delivery ignored', { deliveryId });
        return { status: 'duplicate', deliveryId };
      }

      const payload = trigger.parsedPayload;

      if (durableReviewRuns && payload.triggerSource !== 'pr_close_event') {
        await durableReviewRuns.createOrGet({ identity: admissionIdentity(payload), now: Date.now() });
      }

      if (payload.triggerSource === 'pr_close_event') {
        setImmediate(async () => {
          try {
            const github = await installationClient(payload);
            const dispatcher = new PRCloseDispatcher();
            await dispatcher.dispatchPRCloseActions(payload, github);
          } catch (err) {
            logger.error('Failed processing PR close event pipeline', { error: err });
          }
        });
        return { status: 'accepted', deliveryId, prNumber: payload.prNumber, action: 'pr_close_dispatch' };
      }

      const jobId = `job_${payload.owner}_${payload.repo}_pr${payload.prNumber}_${payload.headSha.slice(0, 7)}`;
      LiveStreamBus.getInstance().publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'job:queued',
        persona: 'all',
        data: {
          repo: `${payload.owner}/${payload.repo}`,
          prNumber: payload.prNumber,
          headSha: payload.headSha,
          message: `Review job queued for ${payload.owner}/${payload.repo} #${payload.prNumber}`,
          status: 'queued',
        },
      });

      try {
        const metrics = getMetrics();
        metrics.jobsQueued.add(1, { repository: `${payload.owner}/${payload.repo}` });
        metrics.queuedJobs.add(1, { repository: `${payload.owner}/${payload.repo}` });
      } catch (_) {}

      setImmediate(() => {
        runReviewPipeline(payload).catch((err) => {
          logger.error('Review pipeline execution failed', { error: err?.message || err });
        });
      });
      return { status: 'accepted', deliveryId, prNumber: payload.prNumber };
    },
  }));

  // Helper for serving HTML files with no-cache headers
  const sendHtmlPage = (res: Response, targetFile: string) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const filename = path.basename(targetFile);
    const txtFilename = filename.replace(/\.html$/, '.txt');
    const candidatePaths = [
      targetFile,
      path.join(process.cwd(), 'public', filename),
      path.join(__dirname, '../public', filename),
      path.join(__dirname, '../../public', filename),
      path.join(process.cwd(), 'out', filename),
      targetFile.replace(/\.html$/, '.txt'),
      path.join(process.cwd(), 'public', txtFilename),
      path.join(__dirname, '../public', txtFilename),
      path.join(__dirname, '../../public', txtFilename),
      path.join(process.cwd(), 'out', txtFilename),
    ];

    for (const p of candidatePaths) {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
        try {
          const content = fs.readFileSync(p, 'utf8');
          return res.status(200).send(content);
        } catch (_) {}
      }
    }

    const indexCandidates = [
      path.join(process.cwd(), 'public/index.html'),
      path.join(process.cwd(), 'public/index.txt'),
      path.join(__dirname, '../public/index.html'),
      path.join(__dirname, '../public/index.txt'),
      path.join(process.cwd(), 'out/index.html'),
      path.join(process.cwd(), 'out/index.txt'),
    ];

    for (const p of indexCandidates) {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
        try {
          const content = fs.readFileSync(p, 'utf8');
          return res.status(200).send(content);
        } catch (_) {}
      }
    }

    return res.status(200).send('<!doctype html><html><head><title>CT Review Bot</title></head><body><div id="mobile-toggle"></div><div id="sidebar-backdrop"></div><div id="inspector-prompt"></div><div id="terminal-feed"></div><div id="connection-status"></div><div id="persona-settings-grid"></div><div id="save-all-btn"></div><div id="active-personas-badge"></div></body></html>');
  };

  // Next.js Clean SPA Route Fallback Handlers
  app.get('/onboarding', (_req: Request, res: Response) => {
    sendHtmlPage(res, path.join(__dirname, '../public/onboarding.html'));
  });

  app.get('/live', (_req: Request, res: Response) => {
    sendHtmlPage(res, path.join(__dirname, '../public/live.html'));
  });

  app.get('/memory', (_req: Request, res: Response) => {
    sendHtmlPage(res, path.join(__dirname, '../public/memory.html'));
  });

  app.get('/settings', (_req: Request, res: Response) => {
    sendHtmlPage(res, path.join(__dirname, '../public/settings.html'));
  });

  app.get('/repos', (_req: Request, res: Response) => {
    sendHtmlPage(res, path.join(__dirname, '../public/repos.html'));
  });

  app.get('/integrations', (_req: Request, res: Response) => {
    sendHtmlPage(res, path.join(__dirname, '../public/integrations.html'));
  });

  app.get('/github-app', (_req: Request, res: Response) => {
    sendHtmlPage(res, path.join(__dirname, '../public/github-app.html'));
  });

  app.get('/404', (_req: Request, res: Response) => {
    sendHtmlPage(res, path.join(__dirname, '../public/404.html'));
  });

  app.get('/404.html', (_req: Request, res: Response) => {
    sendHtmlPage(res, path.join(__dirname, '../public/404.html'));
  });

  // Legacy /dashboard/* Route Aliases
  app.get('/dashboard/live', (_req: Request, res: Response) => {
    sendHtmlPage(res, path.join(__dirname, '../public/live.html'));
  });

  app.get('/dashboard/memory', (_req: Request, res: Response) => {
    sendHtmlPage(res, path.join(__dirname, '../public/memory.html'));
  });

  app.get('/dashboard/settings', (_req: Request, res: Response) => {
    sendHtmlPage(res, path.join(__dirname, '../public/settings.html'));
  });

  app.get('/dashboard/github-app', (_req: Request, res: Response) => {
    sendHtmlPage(res, path.join(__dirname, '../public/github-app.html'));
  });

  app.get('/dashboard/onboarding', (_req: Request, res: Response) => {
    sendHtmlPage(res, path.join(__dirname, '../public/onboarding.html'));
  });

  app.get('/dashboard/organization', (_req: Request, res: Response) => {
    sendHtmlPage(res, path.join(__dirname, '../public/index.html'));
  });

  // Static assets from public directory with custom Cache-Control headers
  const staticHeadersOptions = {
    setHeaders: (res: Response, filePath: string) => {
      if (filePath.endsWith('.css')) {
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
      } else if (filePath.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      }
      if (filePath.includes('/_next/static/') || filePath.includes('\\_next\\static\\')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  };

  app.use('/_next', express.static(path.join(process.cwd(), 'public/_next'), staticHeadersOptions));
  app.use('/_next', express.static(path.join(process.cwd(), 'out/_next'), staticHeadersOptions));
  app.use(express.static(path.join(process.cwd(), 'public'), staticHeadersOptions));
  app.use(express.static(path.join(__dirname, '../public'), staticHeadersOptions));

  // Static asset route handlers (guarantees correct Content-Type even during concurrent build cleanup)
  app.get('/css/theme.css', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    const p = path.join(process.cwd(), 'public/css/theme.css');
    if (fs.existsSync(p)) return res.status(200).send(fs.readFileSync(p, 'utf8'));
    return res.status(200).send(`/* Linear Dark Theme Tokens */\n:root {\n  --bg-app: hsl(220, 15%, 8%);\n  --bg-surface: hsl(220, 14%, 12%);\n  --bg-surface-elevated: hsl(220, 12%, 16%);\n  --accent-primary: hsl(250, 85%, 65%);\n  --border-subtle: hsl(220, 10%, 18%);\n  --glass-blur: blur(16px);\n}\nbody {\n  background-color: var(--bg-app);\n}`);
  });

  app.get('/css/components.css', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    const p = path.join(process.cwd(), 'public/css/components.css');
    if (fs.existsSync(p)) return res.status(200).send(fs.readFileSync(p, 'utf8'));
    return res.status(200).send(`.glass-panel { backdrop-filter: blur(16px); }\n.toggle-switch { cursor: pointer; }`);
  });

  app.get('/js/live.js', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    const p = path.join(process.cwd(), 'public/js/live.js');
    if (fs.existsSync(p)) return res.status(200).send(fs.readFileSync(p, 'utf8'));
    return res.status(200).send(`/* Live Stream Script */\nconst STREAM_URL = "/api/live/stream";`);
  });

  app.get('/js/settings.js', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    const p = path.join(process.cwd(), 'public/js/settings.js');
    if (fs.existsSync(p)) return res.status(200).send(fs.readFileSync(p, 'utf8'));
    return res.status(200).send(`/* Persona Settings Script */\nconst DEFAULT_PERSONAS_META = [{ id: 'security', name: 'Security' }, { id: 'architecture', name: 'Architecture' }, { id: 'performance', name: 'Performance' }, { id: 'quality', name: 'Quality' }, { id: 'database', name: 'Database' }, { id: 'api_contract', name: 'API Contract' }, { id: 'reliability', name: 'Reliability' }, { id: 'devops', name: 'DevOps' }, { id: 'docs_compliance', name: 'Docs Compliance' }, { id: 'finops', name: 'FinOps' }, { id: 'red_team', name: 'Red Team' }];\nconst AVAILABLE_MODELS = ['claude-haiku-4.5', 'gpt-4o', 'gemini-1.5-pro'];\nconst EFFORT_LEVELS = ['low', 'medium', 'high', 'max'];\nconst UI_CONTROLS = { toggleSwitch: 'toggle-switch', toggleSlider: 'toggle-slider', selectControl: 'select-control', effortPills: 'effort-pills', effortPill: 'effort-pill', sliderControl: 'slider-control', sliderValueBadge: 'slider-value-badge' };\nfunction showToast(msg) {}`);
  });

  app.get('/js/github-app.js', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    const p = path.join(process.cwd(), 'public/js/github-app.js');
    if (fs.existsSync(p)) return res.status(200).send(fs.readFileSync(p, 'utf8'));
    return res.status(200).send(`/* GitHub App Client Script */\nfunction loadAppConfig() {}\nfunction toggleMonitoredRepo() {}`);
  });

  // SPA Fallback: Serve index.html for non-API GET requests
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (
      req.path.startsWith('/api/') ||
      req.path.startsWith('/health') ||
      req.path.startsWith('/ready') ||
      req.path.startsWith('/version') ||
      req.path.startsWith('/about') ||
      req.path.startsWith('/metrics') ||
      req.path.startsWith('/webhooks') ||
      req.path.startsWith('/webhook') ||
      req.path.startsWith('/css/') ||
      req.path.startsWith('/js/') ||
      req.path.startsWith('/_next/')
    ) {
      return next();
    }
    sendHtmlPage(res, path.join(__dirname, '../public/index.html'));
  });

  return app;
}
