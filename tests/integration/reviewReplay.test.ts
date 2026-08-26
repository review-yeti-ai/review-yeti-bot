import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createCassetteFetch } from '../support/cassetteFetch';
import { CommentPublisher } from '../../src/github/commentPublisher';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import {
  openRouterCassettePath,
  openRouterReplayDiffFiles,
  openRouterReplayPersonas,
  openRouterReplayPolicy,
  openRouterReplaySystemPrompts,
  openRouterReplayUserPrompt,
  runOpenRouterReplay,
} from '../support/openRouterReplayScenario';

const rootRepoDir = path.resolve(__dirname, '../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const modelCassettePath = path.join(rootRepoDir, 'tests/fixtures/cassettes/model-panel.json');
const githubCassettePath = path.join(rootRepoDir, 'tests/fixtures/cassettes/github-review.json');
const malformedCassettePath = path.join(rootRepoDir, 'tests/fixtures/cassettes/github-malformed.json');

const diffFiles = [{
  path: 'src/api/user.ts',
  patch: 'diff --git a/src/api/user.ts b/src/api/user.ts\n@@ -1,1 +1,2 @@\n+const id = req.query.id;\n',
  addedLines: [{ text: 'const id = req.query.id;' }],
  deletedLines: [],
}];

async function runModelReplay() {
  const cassette = createCassetteFetch({ cassettePath: modelCassettePath });
  const circuitBreaker = new pipeline.RunTransportCircuitBreaker();
  const personas = ['security', 'performance', 'architecture', 'style']
    .map((id) => pipeline.PERSONA_CHARTERS.find((persona: any) => persona.id === id));
  const results = await Promise.all(personas.map((persona: any) => pipeline.reviewWithModel(
    persona,
    diffFiles,
    { repo: 'calltelemetry/ct-review-bot', prNumber: '42', title: 'Replay review' },
    null,
    {
      apiKey: 'synthetic-key',
      baseUrl: 'https://llm.test/v1',
      model: 'synthetic/reviewer',
      fetchImplementation: cassette.fetchImplementation,
      circuitBreaker,
    },
  )));
  cassette.assertComplete();
  return { results, fingerprints: [...cassette.observedFingerprints] };
}

describe('review pipeline cassette replay', () => {
  it('replays the exact OpenRouter auto-router policy request and zero-findings response', async () => {
    const result = await runOpenRouterReplay('zero-findings.json', [openRouterReplayPersonas.testing]);
    const interaction = result.cassette.interactions[0];

    expect(interaction.request).toEqual({
      method: 'POST',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: {
        authorization: '<redacted>',
        'content-type': 'application/json',
      },
      body: {
        messages: [
          { role: 'system', content: openRouterReplaySystemPrompts.testing },
          { role: 'user', content: openRouterReplayUserPrompt },
        ],
        model: 'openrouter/auto',
        plugins: [{
          id: 'auto-router',
          allowed_models: [
            'openai/gpt-5.6-luna',
            'moonshotai/kimi-k2.6',
            'tencent/hy3',
            'z-ai/glm-5.1',
            'google/gemini-3.5-flash-lite',
          ],
          cost_quality_tradeoff: 7,
        }],
        provider: {
          data_collection: 'deny',
        },
        response_format: {
          type: 'json_object',
        },
        temperature: 0.1,
        max_tokens: '<redacted>',
      },
    });
    expect(interaction.response).toEqual({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '777',
      },
      body: {
        choices: [{
          message: {
            content: '{"findings":[]}',
          },
        }],
      },
    });
    expect(result.results[0]).toMatchObject({ decision: 'APPROVE', findings: [] });
    expect(result.arbitration).toMatchObject({
      verdict: 'SHIP',
      quorumSatisfied: true,
      metrics: { totalFindings: 0 },
    });
    expect(result.policyFingerprint).toBe(openRouterReplayPolicy.policy_fingerprint);
  });

  it('replays OpenRouter out-of-diff sanitization and malformed provider JSON as ERROR', async () => {
    const sanitized = await runOpenRouterReplay('out-of-diff-sanitized.json', [openRouterReplayPersonas.documentation]);
    expect(sanitized.results[0]).toMatchObject({
      decision: 'FINDINGS',
      findings: [{
        severity: 'P2',
        path: 'src/api/user.ts',
        line: 2,
        title: 'Document lookup behavior',
      }],
    });
    expect(sanitized.results[0].findings).toHaveLength(1);

    const cassette = createCassetteFetch({ cassettePath: openRouterCassettePath('malformed-provider-json.json') });
    const [malformed] = await Promise.all([pipeline.reviewWithModel(
      openRouterReplayPersonas.security,
      openRouterReplayDiffFiles,
      { repo: 'calltelemetry/ct-review-bot', prNumber: '42', title: 'OpenRouter fleet replay' },
      null,
      {
        apiKey: 'synthetic-key',
        openRouterPolicy: openRouterReplayPolicy,
        fetchImplementation: cassette.fetchImplementation,
        timeoutMs: 1_000,
      },
    )]);
    expect(malformed.decision).toBe('ERROR');
    expect(malformed.findings).toEqual([]);
    cassette.assertComplete();
  });

  it('consumes repeated identical OpenRouter fingerprints and renders the same final comment', async () => {
    const cassette = createCassetteFetch({ cassettePath: openRouterCassettePath('repeated-deterministic.json') });
    const runOnce = async () => {
      const result = await pipeline.reviewWithModel(
        openRouterReplayPersonas.testing,
        openRouterReplayDiffFiles,
        { repo: 'calltelemetry/ct-review-bot', prNumber: '42', title: 'OpenRouter fleet replay' },
        null,
        {
          apiKey: 'synthetic-key',
          openRouterPolicy: openRouterReplayPolicy,
          fetchImplementation: cassette.fetchImplementation,
          timeoutMs: 1_000,
        },
      );
      const arbitration = pipeline.computeArbitrationQuorum([result], 1, {
        changedFiles: openRouterReplayDiffFiles,
      });
      const comment = pipeline.formatPRComment(arbitration, [result], {
        repo: 'calltelemetry/ct-review-bot',
        prNumber: '42',
        title: 'OpenRouter fleet replay',
        headSha: '0123456789abcdef0123456789abcdef01234567',
      }, {}, {
        enabled: true,
        model: openRouterReplayPolicy.model,
        maxDiffChars: 24_000,
      });
      return { result, arbitration, comment };
    };

    const first = await runOnce();
    const second = await runOnce();

    // Review-level and per-attempt latency are observations, not deterministic replay data.
    // Keep the equality assertion focused on provider response and verdict data so a 0/1 ms
    // scheduling difference cannot make the replay suite flaky.
    const withoutObservedLatency = ({ latencyMs, responseAttempts, ...result }: any) => ({
      ...result,
      responseAttempts: Array.isArray(responseAttempts)
        ? responseAttempts.map(({ latencyMs: attemptLatencyMs, ...attempt }: any) => attempt)
        : responseAttempts,
    });
    expect(withoutObservedLatency(first.result)).toEqual(withoutObservedLatency(second.result));
    expect(first.arbitration).toEqual(second.arbitration);
    expect(first.comment).toBe(second.comment);
    expect(cassette.observedFingerprints).toHaveLength(2);
    expect(cassette.observedFingerprints[0]).toBe(cassette.observedFingerprints[1]);
    cassette.assertComplete();
  });

  it('replays a multi-persona panel, sanitizes out-of-diff findings, and blocks provider errors', async () => {
    const first = await runModelReplay();
    const second = await runModelReplay();

    expect(first.results.map((result: any) => ({
      decision: result.decision,
      findings: result.findings,
      error: result.error || null,
    }))).toEqual(second.results.map((result: any) => ({
      decision: result.decision,
      findings: result.findings,
      error: result.error || null,
    })));
    expect(first.fingerprints).toEqual(second.fingerprints);

    expect(first.results[0].decision).toBe('APPROVE');
    expect(first.results[0].findings).toEqual([]);
    expect(first.results[1].decision).toBe('FINDINGS');
    expect(first.results[2].findings).toHaveLength(1);
    expect(first.results[2].findings[0].path).toBe('src/api/user.ts');
    expect(first.results[3].decision).toBe('ERROR');

    const arbitration = pipeline.computeArbitrationQuorum(first.results, 4);
    expect(arbitration.verdict).toBe('BLOCK');
    expect(arbitration.verdict).not.toBe('SHIP');
    expect(arbitration.quorumSatisfied).toBe(false);
  });

  it('replays GitHub metadata, base policy, paginated files, publication fallbacks, and retry headers', async () => {
    process.env.DASHBOARD_URL = 'https://dashboard.test';
    const cassette = createCassetteFetch({ cassettePath: githubCassettePath });
    const token = 'ghs_synthetic_installation_token';
    const sleep = async () => {};
    const client = new GitHubInstallationClient({
      token,
      baseUrl: 'https://github.test',
      fetchImplementation: cassette.fetchImplementation,
      now: () => 1_700_000_000_000,
      sleep,
      random: () => 0,
    });

    await expect(client.getPullRequest('calltelemetry', 'ct-review-bot', 42)).resolves.toEqual({
      headSha: 'head-sha-42',
      baseSha: 'base-sha-42',
      title: 'Replay PR',
      body: 'Synthetic PR',
    });
    await expect(client.getBasePolicy('calltelemetry', 'ct-review-bot', 'base-sha-42')).resolves.toContain('profile: balanced');
    await expect(client.getChangedFiles('calltelemetry', 'ct-review-bot', 42)).resolves.toHaveLength(101);

    const publisherOptions = {
      githubToken: token,
      baseUrl: 'https://github.test',
      fetchImplementation: cassette.fetchImplementation,
      maxRetries: 1,
      maxDelayMs: 100,
      now: () => 1_700_000_000_000,
      sleep,
      random: () => 0,
    };
    const finding = {
      persona: 'security' as const,
      severity: 'P1' as const,
      filePath: 'src/api/user.ts',
      lineNumber: 2,
      comment: 'Synthetic finding',
      title: 'Validate input',
    };

    const success = await new CommentPublisher(publisherOptions).publishReview({
      owner: 'calltelemetry', repo: 'ct-review-bot', prNumber: 42, commitSha: 'head-sha-42',
      event: 'COMMENT', body: 'Replay publication',
      inlineComments: [{ path: 'src/api/user.ts', line: 2, finding }],
    });
    expect(success).toMatchObject({ success: true, reviewId: 4201, commentsCreated: 1 });

    const lineFallback = await new CommentPublisher(publisherOptions).publishReview({
      owner: 'calltelemetry', repo: 'ct-review-bot', prNumber: 43, commitSha: 'head-sha-43',
      event: 'REQUEST_CHANGES', body: 'Line fallback',
      inlineComments: [{ path: 'src/api/user.ts', line: 2, finding }],
    });
    expect(lineFallback).toMatchObject({ success: true, reviewId: 4202, commentsCreated: 0 });

    const selfApprovalFallback = await new CommentPublisher(publisherOptions).publishReview({
      owner: 'calltelemetry', repo: 'ct-review-bot', prNumber: 44, commitSha: 'head-sha-44',
      event: 'APPROVE', body: 'Approve fallback',
    });
    expect(selfApprovalFallback).toMatchObject({ success: true, reviewId: 4203, commentsCreated: 1 });

    const retrySleep = [] as number[];
    const retry = await new CommentPublisher({
      ...publisherOptions,
      sleep: async (milliseconds) => { retrySleep.push(milliseconds); },
    }).publishReview({
      owner: 'calltelemetry', repo: 'ct-review-bot', prNumber: 45, commitSha: 'head-sha-45',
      event: 'COMMENT', body: 'Retry review',
    });
    expect(retry).toMatchObject({ success: true, reviewId: 4204 });
    expect(retrySleep).toEqual([100]);

    const publicationRequests = cassette.observedFingerprints.filter((fingerprint) => fingerprint.includes('/reviews') || fingerprint.includes('/comments'));
    expect(publicationRequests).toHaveLength(7);
    cassette.assertComplete();
  });

  it('fails closed on malformed GitHub JSON and does not permit an unrecorded network call', async () => {
    const cassette = createCassetteFetch({ cassettePath: malformedCassettePath });
    const client = new GitHubInstallationClient({
      token: 'ghs_synthetic_installation_token',
      baseUrl: 'https://github.test',
      fetchImplementation: cassette.fetchImplementation,
    });

    await expect(client.getPullRequest('calltelemetry', 'ct-review-bot', 99)).rejects.toThrow(/Unexpected token|JSON/);
    await expect(cassette.fetchImplementation('https://github.test/unrecorded')).rejects.toThrow('No cassette interaction matches');
    cassette.assertComplete();
    expect(fs.readFileSync(malformedCassettePath, 'utf8')).not.toMatch(/ghs_|Bearer\s+[^<]/);
  });
});
