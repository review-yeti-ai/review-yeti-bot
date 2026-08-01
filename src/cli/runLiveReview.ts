import { execSync } from 'node:child_process';
import { executePersonaPanel } from '../panel/panelEngine';
import { generatePRSummary } from '../review/summaryEngine';
import { generateMermaidDiagram } from '../review/mermaidEngine';
import { CommentPublisher } from '../github/commentPublisher';
import { getGitHubAppInstallationToken } from '../github/appAuth';
import { OpenRouterClient } from '../gateway/openRouterClient';
import { createDefaultV3Config } from '../config/configLoader';
import { logger } from '../utils/logger';

async function main() {
  const prNumber = parseInt(process.argv[2] || '1', 10);
  const repo = process.argv[3] || 'JBJMLLC/ct-review-bot';

  logger.info('Starting live ct-review-bot review dispatch', { repo, prNumber });

  // Fetch target PR head commit SHA from GitHub API
  const headSha = execSync(`gh pr view ${prNumber} --repo ${repo} --json headRefOid --jq .headRefOid`, { encoding: 'utf-8' }).trim();

  // Fetch PR diff via gh CLI
  const diff = execSync(`gh pr diff ${prNumber} --repo ${repo}`, { encoding: 'utf-8' });

  // Initialize 10-persona Panel Engine
  const config = createDefaultV3Config();
  const client = new OpenRouterClient({
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
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

  const appId = process.env.GITHUB_APP_ID || '4385771';
  const installationId = process.env.GITHUB_INSTALLATION_ID || '148780830';
  let privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!privateKey) {
    try {
      privateKey = execSync('doppler secrets get GITHUB_APP_PRIVATE_KEY --plain', { encoding: 'utf-8' }).trim();
    } catch {
      // Doppler CLI fallback
    }
  }

  let token = process.env.GITHUB_TOKEN || execSync('gh auth token', { encoding: 'utf-8' }).trim();
  let allowUserToken = true;

  if (privateKey) {
    try {
      const tokenRes = await getGitHubAppInstallationToken({
        appId,
        privateKey,
        installationId,
      });
      token = tokenRes.token;
      allowUserToken = false;
      logger.info('Authenticating review post via GitHub App Installation Token (ct-review-bot[bot])', { appId, installationId });
    } catch (err: any) {
      logger.warn('Failed to obtain GitHub App installation token, falling back to active user token', { error: err.message });
    }
  } else {
    logger.info('GITHUB_APP_PRIVATE_KEY not detected in environment. To post as ct-review-bot[bot], store GITHUB_APP_PRIVATE_KEY in Doppler or K8s secrets.', { appId, installationId });
  }

  // Post top-level review comment via GitHub REST API
  logger.info('Posting ct-review-bot summary comment to GitHub via REST API', { repo, prNumber });

  const publisher = new CommentPublisher({ githubToken: token, allowUserToken });

  const publishRes = await publisher.publishReview({
    owner: repo.split('/')[0],
    repo: repo.split('/')[1],
    prNumber,
    commitSha: headSha,
    event: panelResult.arbiter?.verdict === 'SHIP' ? 'APPROVE' : 'REQUEST_CHANGES',
    body: fullSummaryMarkdown,
    idempotencyKey: 'worker-arbiter',
  });

  logger.info('Successfully posted ct-review-bot review comment', { publishRes });
}

main().catch((err) => {
  logger.error('Failed live ct-review-bot review dispatch', { error: err.message });
  process.exit(1);
});
