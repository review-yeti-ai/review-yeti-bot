import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createCassetteFetch } from '../support/cassetteFetch';
import { CommentPublisher } from '../../src/github/commentPublisher';
import { GitHubInstallationClient } from '../../src/github/installationClient';

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
    },
  )));
  cassette.assertComplete();
  return { results, fingerprints: [...cassette.observedFingerprints] };
}

describe('review pipeline cassette replay', () => {
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
