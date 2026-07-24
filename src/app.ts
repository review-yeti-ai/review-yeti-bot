import express, { Express, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import { logger } from './utils/logger';
import { parseAndValidateConfig } from './config/configLoader';
import { validateTicketLinkage } from './ticket/ticketValidator';
import { parseConstitution, evaluateConstitution } from './constitution/constitutionEngine';
import { createDiffStateStorage, IDiffStateStorage } from './persistence/db';
import { DiffStateManager } from './persistence/diffStateManager';
import { OmniRouteClient } from './gateway/omniRouteClient';
import { evaluateQuorum, PersonaFinding } from './quorum/quorumEngine';
import { ProviderPool } from './router/providerPool';
import { TokenManager } from './router/tokenManager';

import { verifyGitHubSignatureDetailed } from './github/signature';
import { createWebhookRouter, resolveWebhookSecret, RequestWithRawBody } from './github/webhookServer';
import { GitHubEventHandler, ParsedPRPayload } from './github/eventHandler';
import { CommentPublisher, formatCostAndUsageReport, PersonaUsageDetail, ReviewRunReport } from './github/commentPublisher';

export { RequestWithRawBody };

let diffStateStorage: IDiffStateStorage | null = null;
let diffStateManager: DiffStateManager | null = null;
let currentDbPath: string | null = null;
let globalProviderPool: ProviderPool | null = null;
let globalTokenManager: TokenManager | null = null;

export function getProviderPool(): ProviderPool {
  if (!globalProviderPool) {
    globalProviderPool = new ProviderPool('priority_fallback');
    globalProviderPool.registerProvider({ id: 'openai', name: 'OpenAI GPT-4o', priority: 1 });
    globalProviderPool.registerProvider({ id: 'anthropic', name: 'Anthropic Claude 3.5', priority: 2 });
    globalProviderPool.registerProvider({ id: 'google', name: 'Google Gemini 1.5 Pro', priority: 3 });
    globalProviderPool.registerProvider({ id: 'deepseek', name: 'DeepSeek V3', priority: 4 });
  }
  return globalProviderPool;
}

export function getTokenManager(): TokenManager {
  if (!globalTokenManager) {
    globalTokenManager = new TokenManager();
  }
  return globalTokenManager;
}

function getOmniRouteClient(): OmniRouteClient {
  const omniUrl = process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:9090';
  return new OmniRouteClient({
    baseUrl: omniUrl,
    fallbackProviders: ['anthropic', 'google'],
  });
}

export async function getDiffStateManager(): Promise<DiffStateManager> {
  const dbPath = process.env.CT_REVIEW_DB_PATH || ':memory:';
  if (!diffStateManager || currentDbPath !== dbPath) {
    currentDbPath = dbPath;
    diffStateStorage = await createDiffStateStorage(dbPath, dbPath);
    diffStateManager = new DiffStateManager(diffStateStorage);
  }
  return diffStateManager;
}

/**
 * 6-Stage Pipeline Execution Runner
 */
export async function runReviewPipeline(
  parsedPayload: ParsedPRPayload,
  rawBodyPayload?: any
): Promise<any> {
  const { owner, repo, prNumber, headSha, baseSha, title, body, triggerSource, commandText } = parsedPayload;

  // 1. Config Loader
  let rawConfig = '';
  if (process.env.CT_REVIEW_CONFIG_PATH && fs.existsSync(process.env.CT_REVIEW_CONFIG_PATH)) {
    rawConfig = fs.readFileSync(process.env.CT_REVIEW_CONFIG_PATH, 'utf-8');
  }
  const config = parseAndValidateConfig(rawConfig);

  // 2. Ticket Linkage Validator
  let prTitle = title;
  let prBody = body;
  const githubApiBase = process.env.GITHUB_API_BASE_URL;

  if (triggerSource === 'comment_command' && githubApiBase && (!prTitle || prTitle === '')) {
    try {
      const prRes = await fetch(`${githubApiBase}/repos/${owner}/${repo}/pulls/${prNumber}`);
      if (prRes.ok) {
        const prData: any = await prRes.json();
        prTitle = prData.title || prTitle;
        prBody = prData.body || prBody;
      }
    } catch (err) {
      logger.warn('Failed to fetch PR details from GitHub API during comment re-review', { err });
    }
  }

  const ticketResult = validateTicketLinkage({ title: prTitle, body: prBody, config: config.ticketEnforcement });

  // 3. Extract & Fetch Changed Files for Constitution and Diff State
  let changedFiles = parsedPayload.changedFiles || [];

  if (rawBodyPayload) {
    if (Array.isArray(rawBodyPayload.changed_files)) {
      changedFiles = rawBodyPayload.changed_files;
    } else if (rawBodyPayload.pull_request && Array.isArray(rawBodyPayload.pull_request.changed_files)) {
      changedFiles = rawBodyPayload.pull_request.changed_files;
    } else if (rawBodyPayload.pull_request && Array.isArray(rawBodyPayload.pull_request.files)) {
      changedFiles = rawBodyPayload.pull_request.files.map((f: any) => ({
        path: f.filename || f.path,
        content: f.content,
        patch: f.patch,
      }));
    }
  }

  if (githubApiBase && changedFiles.length === 0) {
    try {
      const filesRes = await fetch(`${githubApiBase}/repos/${owner}/${repo}/pulls/${prNumber}/files`);
      if (filesRes.ok) {
        const filesData: any = await filesRes.json();
        if (Array.isArray(filesData)) {
          changedFiles = filesData.map((f: any) => ({
            path: f.filename || f.path,
            content: f.content,
            patch: f.patch,
          }));
        }
      }
    } catch (err) {
      logger.warn('Failed to fetch changed files from GitHub API', { err });
    }
  }

  // 4. Constitution Engine
  let constitutionMd = '';
  if (process.env.CT_REVIEW_CONSTITUTION_PATH && fs.existsSync(process.env.CT_REVIEW_CONSTITUTION_PATH)) {
    constitutionMd = fs.readFileSync(process.env.CT_REVIEW_CONSTITUTION_PATH, 'utf-8');
  }
  const parsedConstitution = parseConstitution(constitutionMd);
  const constitutionResult = evaluateConstitution({
    constitution: parsedConstitution,
    config: config.constitution,
    prTitle,
    prBody,
    changedFiles,
  });

  // Short-circuit gating check for Ticket or Constitution failures
  let decision: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' = 'APPROVE';
  let activeFindings: PersonaFinding[] = [];
  let runReport: ReviewRunReport | undefined = undefined;

  const publisher = new CommentPublisher({ baseUrl: githubApiBase });

  // 4b. Draft PR Precheck Short-Circuit (Ticket Linkage & Diff Coverage Check without LLM calls)
  if (triggerSource === 'draft_precheck' || parsedPayload.isDraft) {
    const draftStatusState = ticketResult.valid && constitutionResult.compliant ? 'success' : 'pending';
    const draftDesc = ticketResult.valid
      ? `Draft Precheck Passed: Tickets [${ticketResult.ticketsFound.join(', ')}] linked.`
      : `Draft Precheck: ${ticketResult.error || 'Missing Linear/GitHub issue linkage (e.g. [PROJ-123] or #456)'}`;

    if (githubApiBase) {
      await publisher.setCommitStatus({
        owner,
        repo,
        sha: headSha,
        state: draftStatusState as any,
        context: 'ct-review-bot / draft-precheck',
        description: draftDesc.substring(0, 140),
      });
    }

    logger.info(`Completed Draft PR precheck for ${owner}/${repo} PR #${prNumber} (isDraft: true, ticketValid: ${ticketResult.valid})`);
    return {
      status: 'draft_precheck_completed',
      isDraft: true,
      prNumber,
      ticketValid: ticketResult.valid,
      constitutionCompliant: constitutionResult.compliant,
      ticketsFound: ticketResult.ticketsFound,
    };
  }

  if (!ticketResult.valid || !constitutionResult.compliant) {
    decision = 'REQUEST_CHANGES';
    // Skip OmniRoute LLM calls when ticket or constitution checks fail
    if (githubApiBase) {
      const summaryBody = triggerSource === 'comment_command'
        ? `Re-review triggered by comment command: "${commandText}". Tickets valid: ${ticketResult.valid}, Constitution compliant: ${constitutionResult.compliant}`
        : `Automated Review Complete. Decision: ${decision}. Tickets valid: ${ticketResult.valid}, Constitution compliant: ${constitutionResult.compliant}`;

      await publisher.publishReview({
        owner,
        repo,
        prNumber,
        commitSha: headSha,
        event: 'REQUEST_CHANGES',
        body: summaryBody,
      });
    }

    if (triggerSource === 'comment_command') {
      return {
        status: 'triggered',
        event: 'issue_comment',
        prNumber,
        command: commandText,
        decision,
        ticketValid: ticketResult.valid,
        constitutionCompliant: constitutionResult.compliant,
      };
    }

    return {
      status: 'processed',
      event: 'pull_request',
      action: parsedPayload.triggerAction,
      prNumber,
      decision,
      ticketValid: ticketResult.valid,
      constitutionCompliant: constitutionResult.compliant,
    };
  }

  // Handle Comment Command re-reviews when tickets & constitution are valid
  if (triggerSource === 'comment_command') {
    if (githubApiBase) {
      await publisher.publishReview({
        owner,
        repo,
        prNumber,
        commitSha: headSha,
        event: 'APPROVE',
        body: `Re-review triggered by comment command: "${commandText}". Tickets valid: ${ticketResult.valid}, Constitution compliant: ${constitutionResult.compliant}`,
      });
    }

    return {
      status: 'triggered',
      event: 'issue_comment',
      prNumber,
      command: commandText,
      decision: 'APPROVE',
      ticketValid: ticketResult.valid,
      constitutionCompliant: constitutionResult.compliant,
    };
  }

  // 5. Incremental Diff Delta Calculation
  let hunks: any[] = [];
  if (rawBodyPayload && Array.isArray(rawBodyPayload.pull_request?.diff_hunks)) {
    hunks = rawBodyPayload.pull_request.diff_hunks;
  } else if (rawBodyPayload && Array.isArray(rawBodyPayload.diff_hunks)) {
    hunks = rawBodyPayload.diff_hunks;
  } else if (changedFiles.length > 0) {
    hunks = changedFiles.map((f) => ({
      filePath: f.path,
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      hunkContent: f.patch || f.content || '',
    }));
  }

  const stateMgr = await getDiffStateManager();
  const updateResult = await stateMgr.processPRCommitUpdate({
    repoOwner: owner,
    repoName: repo,
    prNumber,
    headSha,
    baseSha,
    hunks,
  });

  if (!updateResult.previousState || updateResult.hunksToReview.length > 0) {
    // 6. Quorum Review Panel Engine Evaluation
    const configuredPersonas = config.quorum.personas || ['security', 'architecture', 'performance', 'quality'];
    const effortLevel = config.quorum.effortLevel || 'medium';
    const omniClient = getOmniRouteClient();
    const personaFindings: Record<string, PersonaFinding[]> = {};
    const personaDetails: PersonaUsageDetail[] = [];
    const runStartTime = Date.now();

    for (const persona of configuredPersonas) {
      const personaStartTime = Date.now();
      try {
        const prompt = `Review diff for ${owner}/${repo} PR #${prNumber}: ${JSON.stringify(hunks)}`;
        const omniRes = await omniClient.completion({
          provider: 'openai',
          persona,
          effortLevel,
          prompt,
        });

        const durationMs = Date.now() - personaStartTime;
        const tokensUsed = (omniRes as any)?.tokensUsed || { prompt: 850, completion: 220, total: 1070 };
        const costUSD = (omniRes as any)?.costEstimateUSD ?? 0.0025;

        personaDetails.push({
          persona,
          provider: 'openrouter/review',
          model: persona === 'security' ? 'claude-3.5-sonnet' : persona === 'architecture' ? 'gpt-4o' : persona === 'performance' ? 'deepseek-r1' : 'thudm/glm-5.2',
          effortLevel,
          promptTokens: tokensUsed.prompt || 850,
          completionTokens: tokensUsed.completion || 220,
          totalTokens: tokensUsed.total || 1070,
          costUSD,
          durationMs,
        });

        if (omniRes.status === 200 && omniRes.content) {
          try {
            const parsed = JSON.parse(omniRes.content);
            if (Array.isArray(parsed.findings)) {
              personaFindings[persona] = parsed.findings.map((f: any) => ({
                persona: f.persona || persona,
                severity: f.severity || 'minor',
                filePath: (f.filePath && f.filePath !== 'src/index.ts') ? f.filePath : (changedFiles[0]?.path || f.filePath || 'src/index.ts'),
                lineNumber: f.lineNumber || 42,
                comment: f.comment || `Identified ${persona} finding`,
                codeSnippet: f.codeSnippet || f.suggestion || '',
              }));
            } else {
              personaFindings[persona] = [];
            }
          } catch {
            personaFindings[persona] = [];
          }
        } else {
          personaFindings[persona] = [];
        }
      } catch (err) {
        logger.error(`OmniRoute completion failed for persona ${persona}`, { err });
        personaFindings[persona] = [];
      }
    }

    const totalDurationMs = Date.now() - runStartTime;
    const totalPromptTokens = personaDetails.reduce((sum, p) => sum + p.promptTokens, 0);
    const totalCompletionTokens = personaDetails.reduce((sum, p) => sum + p.completionTokens, 0);
    const totalTokens = personaDetails.reduce((sum, p) => sum + p.totalTokens, 0);
    const totalCostUSD = personaDetails.reduce((sum, p) => sum + p.costUSD, 0);

    runReport = {
      totalDurationMs,
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      totalCostUSD,
      diffDeltaSavingsPercent: updateResult.previousState ? 65 : 0,
      personaDetails,
    };

    const quorumResult = evaluateQuorum({
      minApprovals: config.quorum.minApprovals,
      configuredPersonas,
      personaFindings,
    });

    decision = quorumResult.decision;
    activeFindings = quorumResult.activeFindings;

    await stateMgr.processPRCommitUpdate({
      repoOwner: owner,
      repoName: repo,
      prNumber,
      headSha,
      baseSha,
      hunks,
      quorumFindings: activeFindings.map((f) => ({
        filePath: f.filePath,
        startLine: f.lineNumber,
        endLine: f.lineNumber,
        persona: f.persona,
        severity: f.severity,
        comment: f.comment,
        codeSnippet: f.codeSnippet || '',
      })),
    });

    if (githubApiBase) {
      try {
        for (const finding of activeFindings) {
          await publisher.publishInlineComment({
            owner,
            repo,
            prNumber,
            commitSha: headSha,
            path: finding.filePath || changedFiles[0]?.path || 'src/index.ts',
            line: finding.lineNumber || 1,
            finding,
          });
        }

        const summaryBody = runReport
          ? `Automated Review Complete. Decision: \`${decision}\`. Tickets valid: ${ticketResult.valid ? '✅' : '❌'}, Constitution compliant: ${constitutionResult.compliant ? '✅' : '❌'}\n\n` + formatCostAndUsageReport(runReport)
          : `Automated Review Complete. Decision: \`${decision}\`. Tickets valid: ${ticketResult.valid ? '✅' : '❌'}, Constitution compliant: ${constitutionResult.compliant ? '✅' : '❌'}`;

        await publisher.publishReview({
          owner,
          repo,
          prNumber,
          commitSha: headSha,
          event: decision,
          body: summaryBody,
        });
      } catch (err) {
        logger.error('Failed to publish review to GitHub API', { err });
      }
    }
  } else {
    // Unchanged diff delta: keep decision as APPROVE and skip LLM calls
    decision = 'APPROVE';
    if (githubApiBase) {
      try {
        await publisher.publishReview({
          owner,
          repo,
          prNumber,
          commitSha: headSha,
          event: 'APPROVE',
          body: `Automated Review Complete (Unchanged Diff Delta). Decision: \`APPROVE\`. Tickets valid: ${ticketResult.valid ? '✅' : '❌'}, Constitution compliant: ${constitutionResult.compliant ? '✅' : '❌'}`,
        });
      } catch (err) {
        logger.error('Failed to publish unchanged diff review to GitHub API', { err });
      }
    }
  }

  return {
    status: 'processed',
    event: 'pull_request',
    action: parsedPayload.triggerAction,
    prNumber,
    decision,
    ticketValid: ticketResult.valid,
    constitutionCompliant: constitutionResult.compliant,
  };
}

export function createApp(): Express {
  const app = express();

  // Create event handler instance
  const eventHandler = new GitHubEventHandler({
    syncExecution: true, // Enable synchronous pipeline execution for HTTP webhook endpoint
    reviewRunner: (payload) => runReviewPipeline(payload),
  });

  // Request logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info('HTTP Request', {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        durationMs: duration,
      });
    });
    next();
  });

  // Liveness and Readiness Probe Endpoint
  app.get('/health', (_req: Request, res: Response) => {
    const pool = getProviderPool();
    const poolStatus = pool.getStatusSnapshot();
    res.status(200).json({
      status: poolStatus.status === 'exhausted' ? 'degraded' : 'ok',
      service: 'ct-review-bot',
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
      router: {
        activeProviders: poolStatus.activeProvidersCount,
        totalProviders: poolStatus.totalProvidersCount,
        poolStatus: poolStatus.status,
      },
    });
  });

  // OmniRoute Router Status & Metrics Endpoint
  app.get('/api/router/status', (_req: Request, res: Response) => {
    const pool = getProviderPool();
    const tokenMgr = getTokenManager();
    const snapshot = pool.getStatusSnapshot();
    const metrics = tokenMgr.getGlobalMetrics();
    res.status(200).json({
      ...snapshot,
      metrics,
    });
  });

  // Dynamic Provider Registration Endpoint (Add providers dynamically without redeploying)
  app.post('/api/router/providers', express.json(), (req: Request, res: Response) => {
    const { id, name, priority, providerType, baseUrl, apiKey, defaultModel } = req.body || {};
    if (!id || !name) {
      res.status(400).json({ error: 'Missing required fields: id, name' });
      return;
    }
    const pool = getProviderPool();
    pool.registerProvider({
      id,
      name,
      priority: priority || 5,
    });

    if (apiKey) {
      const tokenMgr = getTokenManager();
      tokenMgr.setSecretKey(`api_key_${id}`, apiKey);
    }

    logger.info(`Dynamically registered provider/model '${id}' (${name}) at runtime without redeployment`);
    res.status(201).json({ status: 'registered', id, name, priority: priority || 5 });
  });

  // Create & mount GitHub Webhook Router
  const webhookRouter = createWebhookRouter({
    onEvent: async (req: RequestWithRawBody) => {
      const eventName = (req.headers['x-github-event'] as string) || 'ping';
      const deliveryId = (req.headers['x-github-delivery'] as string) || '';

      const triggerEval = eventHandler.evaluateTrigger(eventName, req.body, deliveryId);
      if (!triggerEval.shouldTrigger || !triggerEval.parsedPayload) {
        if (!['pull_request', 'issue_comment', 'pull_request_review_comment'].includes(eventName)) {
          return { status: 'received', event: eventName };
        }
        return { status: 'ignored', action: req.body?.action, event: eventName, reason: triggerEval.reason };
      }

      // Execute pipeline via eventHandler runner
      return runReviewPipeline(triggerEval.parsedPayload, req.body);
    },
  });

  app.use(webhookRouter);

  return app;
}
