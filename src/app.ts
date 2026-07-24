import express, { Express, NextFunction, Request, Response } from 'express';
import { parseAndValidateConfig } from './config/configLoader';
import { CtReviewConfigV3 } from './config/schema';
import { OmniRouteClient } from './gateway/omniRouteClient';
import { getGitHubAppInstallationToken } from './github/appAuth';
import { GitHubEventHandler, ParsedPRPayload } from './github/eventHandler';
import { GitHubInstallationClient } from './github/installationClient';
import { createWebhookRouter, RequestWithRawBody } from './github/webhookServer';
import { executePersonaPanel, PanelResult } from './panel/panelEngine';
import { ReviewRunStore } from './persistence/reviewRunStore';
import { logger } from './utils/logger';

export { RequestWithRawBody };

const store = new ReviewRunStore(process.env.CT_REVIEW_RUN_STORE || '/tmp/ct-review-bot/review-runs.json');

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`required environment variable ${name} is missing`);
  return value;
}

function privateKey(): string {
  return requiredEnv('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n');
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
  return [
    `## Persona: ${lane.id}`,
    '',
    `- Required: ${lane.required ? 'yes' : 'no'}`,
    `- Provider: \`${lane.providerId}\``,
    `- Model: \`${lane.model}\``,
    `- Decision: \`${lane.decision}\``,
    `- Duration: ${lane.durationMs} ms`,
    `- Tokens: ${usage(lane.usage)}`,
    `- Cost: ${cost(lane.costUSD)}`,
    `- Exact head: \`${headSha}\``,
    '',
    lane.findings.length === 0 ? 'No findings.' : `${lane.findings.length} finding(s); see inline review comments.`,
  ].join('\n');
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

async function installationClient(payload: ParsedPRPayload): Promise<GitHubInstallationClient> {
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
    checks: 'write',
  };
  for (const [name, required] of Object.entries(requiredPermissions)) {
    const actual = permissions[name];
    if (actual !== required && actual !== 'admin') {
      throw new Error(`GitHub App installation permission ${name} must be ${required}; got ${actual || 'missing'}`);
    }
  }
  return new GitHubInstallationClient({ token: token.token, baseUrl });
}

export async function runReviewPipeline(payload: ParsedPRPayload): Promise<any> {
  const { owner, repo, prNumber, headSha } = payload;
  const github = await installationClient(payload);
  let checkId: number | undefined;
  try {
    const snapshot = await github.getPullRequest(owner, repo, prNumber);
    if (snapshot.headSha !== headSha) {
      return { status: 'cancelled', reason: 'stale webhook head', expected: snapshot.headSha, received: headSha };
    }
    store.markHead(owner, repo, prNumber, headSha);
    checkId = await github.createCheck(owner, repo, headSha);

    const [rawPolicy, changedFiles] = await Promise.all([
      github.getBasePolicy(owner, repo, snapshot.baseSha),
      github.getChangedFiles(owner, repo, prNumber),
    ]);
    const parsed = parseAndValidateConfig(rawPolicy);
    if (parsed.version !== 3) {
      throw new Error(`base policy version ${parsed.version} is compatible for parsing but protected App execution requires version 3`);
    }
    const config = parsed as CtReviewConfigV3;
    const panel = await withinOverallTimeout(executePersonaPanel({
      config,
      changedFiles,
      repository: `${owner}/${repo}`,
      headSha,
      client: new OmniRouteClient({
        baseUrl: requiredEnv('OMNIROUTE_BASE_URL'),
        accessToken: process.env.OMNIROUTE_ACCESS_TOKEN,
      }),
    }), config.reviewers.overall_timeout_s);

    const fresh = await github.getPullRequest(owner, repo, prNumber);
    if (fresh.headSha !== headSha || !store.isCurrentHead(owner, repo, prNumber, headSha)) {
      await github.completeCheck({
        owner,
        repo,
        checkId,
        conclusion: 'cancelled',
        title: 'Persona panel cancelled for stale head',
        summary: `Review started at \`${headSha}\` but current head is \`${fresh.headSha}\`.`,
      });
      return { status: 'cancelled', reason: 'head changed during review' };
    }

    for (const lane of panel.personas) {
      const published = await github.publishReview({
        owner,
        repo,
        prNumber,
        commitSha: headSha,
        event: 'COMMENT',
        body: personaBody(lane, headSha),
        inlineComments: lane.findings.map((finding) => ({
          owner,
          repo,
          prNumber,
          commitSha: headSha,
          path: finding.path,
          line: finding.line,
          finding: {
            persona: lane.id as any,
            severity: finding.severity === 'P0' ? 'critical' : finding.severity === 'P1' ? 'major' : 'minor',
            filePath: finding.path,
            lineNumber: finding.line,
            comment: `${finding.title}\n\n${finding.body}`,
            suggestion: finding.suggestion,
          },
        })),
      });
      if (!published.success) throw new Error(`failed to publish persona ${lane.id}: ${published.errors?.join('; ')}`);
    }

    const summary = checkSummary(panel);
    const ship = panel.arbiter.verdict === 'SHIP';
    const final = await github.publishReview({
      owner,
      repo,
      prNumber,
      commitSha: headSha,
      event: ship ? 'APPROVE' : 'REQUEST_CHANGES',
      body: `## Binding arbiter verdict: ${panel.arbiter.verdict}\n\n${panel.arbiter.rationale}\n\n${summary}`,
    });
    if (!final.success) throw new Error(`failed to publish arbiter review: ${final.errors?.join('; ')}`);
    await github.completeCheck({
      owner,
      repo,
      checkId,
      conclusion: ship ? 'success' : 'failure',
      title: `Binding arbiter verdict: ${panel.arbiter.verdict}`,
      summary,
    });
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
    const message = error?.message || String(error);
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
}

export function createApp(): Express {
  const app = express();
  const eventHandler = new GitHubEventHandler();

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

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'ct-review-bot',
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
    });
  });

  app.get('/ready', async (_req, res) => {
    const configurationReady = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'WEBHOOK_SECRET', 'OMNIROUTE_BASE_URL']
      .every((name) => Boolean(process.env[name]?.trim()));
    const omniReady = configurationReady
      ? await new OmniRouteClient({
          baseUrl: process.env.OMNIROUTE_BASE_URL!,
          accessToken: process.env.OMNIROUTE_ACCESS_TOKEN,
        }).health()
      : false;
    res.status(configurationReady && omniReady ? 200 : 503).json({
      status: configurationReady && omniReady ? 'ready' : 'not_ready',
      configurationReady,
      omniRouteReady: omniReady,
    });
  });

  app.use(createWebhookRouter({
    onEvent: async (req: RequestWithRawBody) => {
      const eventName = String(req.headers['x-github-event'] || '');
      const deliveryId = String(req.headers['x-github-delivery'] || '');
      const trigger = eventHandler.evaluateTrigger(eventName, req.body, deliveryId);
      if (!trigger.shouldTrigger || !trigger.parsedPayload) {
        return { status: 'ignored', reason: trigger.reason };
      }
      if (!store.claimDelivery(deliveryId)) {
        return { status: 'duplicate', deliveryId };
      }
      setImmediate(() => runReviewPipeline(trigger.parsedPayload!).catch(() => undefined));
      return { status: 'accepted', deliveryId, prNumber: trigger.parsedPayload.prNumber };
    },
  }));
  return app;
}
