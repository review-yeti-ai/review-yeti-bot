import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadReviewWorkflowFixture, type ReviewWorkflowFixture } from './reviewWorkflowFixtures';

const pipeline = require('../../.github/workflows/pipelines/review-pipeline.js');
const { runReviewPipeline } = require('../../src/runtime/reviewPipelineRuntime.js');

const fixtureRoot = path.resolve(__dirname, '../fixtures/review-workflows');
const repositoryDispatchEventPath = path.resolve(__dirname, '../fixtures/github/repository-dispatch-conflicting.json');

function fixturePath(id: string): string {
  return path.join(fixtureRoot, `${id}.json`);
}

function commandRunnerFactory(repository: string, prNumber: number, headSha: string) {
  const reviewEndpoint = `repos/${repository}/pulls/${prNumber}/reviews`;
  const commentsEndpoint = `repos/${repository}/issues/${prNumber}/comments`;
  let createdReview: Record<string, unknown> | null = null;
  return (command: string, args: string[], options: { input?: string } = {}) => {
    if (command !== 'gh') return { status: 1, stdout: '', stderr: `unexpected command ${command}` };
    const joined = args.join(' ');
    if (args[0] === 'pr' && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify({ headRefOid: headSha, baseRefOid: 'b'.repeat(40) }), stderr: '' };
    }
    if (joined.includes(commentsEndpoint)) return { status: 0, stdout: '[]', stderr: '' };
    if (args.includes('user')) return { status: 0, stdout: 'review-yeti-bot\n', stderr: '' };
    if (args.includes('graphql')) {
      return {
        status: 0,
        stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }),
        stderr: '',
      };
    }
    if (joined.includes(reviewEndpoint) && args.includes('--method') && args.includes('POST')) {
      createdReview = { id: 9001, user: { login: 'review-yeti-bot' }, body: JSON.parse(options.input || '{}').body || '' };
      return { status: 0, stdout: JSON.stringify(createdReview), stderr: '' };
    }
    if (joined.includes(reviewEndpoint) && !args.includes('--method')) return { status: 0, stdout: JSON.stringify(createdReview ? [createdReview] : []), stderr: '' };
    if (args[0] === 'pr' && args[1] === 'comment') return { status: 0, stdout: '', stderr: '' };
    if (args.includes('compare')) return { status: 0, stdout: JSON.stringify({ files: [] }), stderr: '' };
    return { status: 0, stdout: '{}', stderr: '' };
  };
}

function memoryFetchFactory({ available }: { available: boolean }) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!available) return new Response(JSON.stringify({ error: 'fixture provider unavailable' }), { status: 503 });
    if (url.includes('/v3/memories/search')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
    if (url.includes('/v3/memories')) return new Response(JSON.stringify({ status: 'PENDING' }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
}

function fixtureConfig(fixture: ReviewWorkflowFixture, options: { reviewIntelligence?: boolean } = {}): string {
  const config = {
    memory: {
      enabled: true,
      provider: 'mem0',
      mode: 'single',
      transport: 'rest',
      context: true,
      write: true,
      recall: { decision_feedback: true, session_recap: true },
      persist: { processing: true, decision_feedback: true, session_recap: true },
      providers: { mem0: { enabled: true, endpoint_env: 'MEM0_URL', credential_env: 'MEM0_API_KEY' } },
    },
    personas: [{ id: 'security' }, { id: 'testing' }],
    ...fixture.config,
  };
  return `memory:\n  enabled: true\n  provider: ${config.memory.provider}\n  mode: single\n  transport: rest\n  context: true\n  write: true\n  recall:\n    decision_feedback: true\n    session_recap: true\n  persist:\n    processing: true\n    decision_feedback: true\n    session_recap: true\n  providers:\n    mem0:\n      enabled: true\n      endpoint_env: MEM0_URL\n      credential_env: MEM0_API_KEY\npersonas:\n  - id: security\n  - id: testing\n${options.reviewIntelligence ? 'review_intelligence:\n  version: 1\n  enabled: true\n  limits:\n    max_diff_chars: 5000\n' : ''}`;
}

export async function runReviewWorkflowFixture(id: string, options: { memoryAvailable?: boolean; reviewIntelligence?: boolean; repositoryDispatch?: boolean; conflictingDispatchPayload?: boolean } = {}) {
  const fixture = loadReviewWorkflowFixture(fixturePath(id));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `review-yeti-workflow-${id}-`));
  const configRoot = path.join(tempRoot, 'config');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(path.join(configRoot, '.review-yeti.yaml'), fixtureConfig(fixture, options));
  const outputPath = path.join(tempRoot, 'github-output');
  fs.writeFileSync(outputPath, '');
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const env = {
    ...process.env,
    PR_DIFF: JSON.stringify({
      repo: fixture.event.repository,
      prNumber: fixture.event.prNumber,
      ...(options.repositoryDispatch ? {} : { headSha: fixture.event.headSha }),
      title: 'Fixture review',
      diff: 'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n+const safe = true;\n',
    }),
    PR_REPO: fixture.event.repository,
    PR_NUMBER: String(fixture.event.prNumber),
    PR_HEAD_SHA: options.repositoryDispatch ? fixture.event.headSha : '',
    GITHUB_SHA: options.repositoryDispatch ? 'c'.repeat(40) : fixture.event.headSha,
    GITHUB_BASE_SHA: 'b'.repeat(40),
    GITHUB_OUTPUT: outputPath,
    REVIEW_YETI_CONFIG_DIR: configRoot,
    OPENROUTER_API_KEY: 'fixture-key',
    OPENROUTER_MODEL: 'fixture-model',
    OPENROUTER_BASE_URL: 'https://openrouter.fixture.test/v1',
    OPENROUTER_SKIP_CHAT_PREFLIGHT: 'true',
    VITEST: 'true',
    GITHUB_ACTIONS: 'false',
    MEM0_URL: 'https://mem0.fixture.test',
    MEM0_API_KEY: 'fixture-memory-key',
    GITHUB_EVENT_PATH: options.conflictingDispatchPayload ? repositoryDispatchEventPath : '',
  } as NodeJS.ProcessEnv;
  try {
    process.chdir(tempRoot);
    Object.assign(process.env, env);
    const modelClient = async ({ persona }: { persona: { id: string; name: string } }) => ({
      personaId: persona.id,
      displayName: persona.name,
      model: 'fixture-model',
      provider: 'fixture-openrouter',
      decision: 'APPROVE',
      findings: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUSD: 0 },
    });
    const receipt = await runReviewPipeline({
      env,
      cwd: tempRoot,
      now: () => 1_754_752_800_000,
      commandRunner: commandRunnerFactory(fixture.event.repository, fixture.event.prNumber, fixture.event.headSha),
      fetchImplementation: memoryFetchFactory({ available: options.memoryAvailable !== false }),
      modelClient,
    });
    return {
      ...receipt,
      actionOutputs: fs.readFileSync(outputPath, 'utf8'),
      outboxPayload: receipt.outbox.path ? JSON.parse(fs.readFileSync(receipt.outbox.path, 'utf8')) : null,
    };
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
}

export { fixturePath };
