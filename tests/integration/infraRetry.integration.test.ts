// API-2902: bounded infra-failure retry + INCOMPLETE_INFRA status split, exercised through the
// real pipeline entrypoint (not just the reviewCore.js unit tests) so the retry wiring in
// review-pipeline.js itself -- re-invoking the extracted `runPersonaLane` for just the failed
// persona -- is proven end to end, not only the classification math.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));

// Mirrors tests/support/reviewWorkflowHarness.ts's commandRunnerFactory closely enough to drive
// a full run (view/graphql/user/review-create/review-list/comments) without depending on that
// harness's hardcoded 2-persona always-APPROVE modelClient, which this suite needs to override.
function baseCommandRunner(repository: string, prNumber: number, headSha: string) {
  const reviewEndpoint = `repos/${repository}/pulls/${prNumber}/reviews`;
  const commentsEndpoint = `repos/${repository}/issues/${prNumber}/comments`;
  let createdReview: Record<string, unknown> | null = null;
  return (command: string, args: string[], options: { input?: string } = {}) => {
    if (command !== 'gh') return { status: 1, stdout: '', stderr: `unexpected command ${command}` };
    const joined = args.join(' ');
    if (args[0] === 'pr' && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify({ headRefOid: headSha, baseRefOid: 'a'.repeat(40) }), stderr: '' };
    }
    if (!args.includes('--method') && (joined.includes(commentsEndpoint) || (args[0] === 'api' && String(args[1] || '').includes(`/issues/${prNumber}/comments`)))) {
      return { status: 0, stdout: '[]', stderr: '' };
    }
    if (args.includes('user')) return { status: 0, stdout: 'review-yeti-bot\n', stderr: '' };
    if (args.includes('graphql')) {
      return {
        status: 0,
        stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }),
        stderr: '',
      };
    }
    if (joined.includes(reviewEndpoint) && args.includes('--method') && args.includes('POST')) {
      const payload = JSON.parse(options.input || '{}');
      createdReview = { id: 9001, commit_id: payload.commit_id, user: { login: 'review-yeti-bot' }, body: payload.body || '' };
      return { status: 0, stdout: JSON.stringify(createdReview), stderr: '' };
    }
    if (joined.includes(reviewEndpoint) && !args.includes('--method')) return { status: 0, stdout: JSON.stringify(createdReview ? [createdReview] : []), stderr: '' };
    if (args[0] === 'pr' && args[1] === 'comment') return { status: 0, stdout: '', stderr: '' };
    if (args.includes('compare')) return { status: 0, stdout: JSON.stringify({ files: [] }), stderr: '' };
    return { status: 0, stdout: '{}', stderr: '' };
  };
}

async function runPipeline(modelClient: (input: { persona: { id: string } }) => Promise<any>) {
  // Isolate cwd: main() writes dispatch-receipt/session artifacts relative to process.cwd(),
  // which otherwise land in the repo working tree (tests/support/reviewWorkflowHarness.ts uses
  // the same chdir isolation for exactly this reason).
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-infra-retry-'));
  const outputPath = path.join(tempRoot, 'github-output.txt');
  fs.writeFileSync(outputPath, '');
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-infra-retry-config-'));
  const originalCwd = process.cwd();
  process.chdir(tempRoot);
  try {
    await pipeline.main({
      env: {
        VITEST: 'true',
        GITHUB_ACTIONS: 'false',
        GITHUB_OUTPUT: outputPath,
        REVIEW_YETI_CONFIG_DIR: configDir,
        PR_DIFF: 'synthetic',
        ACTIVE_PERSONAS: JSON.stringify(['security', 'testing']),
        OPENROUTER_API_KEY: 'test-key',
        OPENROUTER_MODEL: 'model-a',
        GITHUB_RUN_ID: 'infra-retry-test-run',
        GITHUB_RUN_ATTEMPT: '1',
        REVIEW_YETI_ACTION_SHA: 'd'.repeat(40),
      },
      installProcessHandlers: false,
      commandRunner: baseCommandRunner('review-yeti-ai/review-yeti-bot', 42, 'b'.repeat(40)),
      prContext: {
        repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
        diffText: 'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -0,0 +1 @@\n+const safe = true;\n',
      },
      modelClient,
    });
  } finally {
    process.chdir(originalCwd);
  }
  return { outputPath };
}

describe('bounded infra-failure retry (API-2902)', () => {
  it('recovers a lane that failed once for an infra reason and ships clean, with zero blocking findings and N-1 quorum satisfied on the first pass', async () => {
    const calls: Record<string, number> = {};
    const { outputPath } = await runPipeline(async ({ persona }) => {
      calls[persona.id] = (calls[persona.id] || 0) + 1;
      if (persona.id === 'testing' && calls[persona.id] === 1) {
        return { ok: false, error: 'timeout' };
      }
      return {
        personaId: persona.id, displayName: persona.id, model: 'model-a', provider: 'openrouter', decision: 'APPROVE', findings: [],
      };
    });

    // The failed lane was retried exactly once (called twice total: initial + one retry).
    expect(calls.testing).toBe(2);
    expect(calls.security).toBe(1);
    const output = fs.readFileSync(outputPath, 'utf-8');
    expect(output).toContain('review-status=SHIP');
  }, 15_000);

  it('reports INCOMPLETE_INFRA -- and retries exactly once, not in a loop -- when the retry does not recover the lane', async () => {
    const calls: Record<string, number> = {};
    const { outputPath } = await runPipeline(async ({ persona }) => {
      calls[persona.id] = (calls[persona.id] || 0) + 1;
      if (persona.id === 'testing') return { ok: false, error: 'timeout' };
      return {
        personaId: persona.id, displayName: persona.id, model: 'model-a', provider: 'openrouter', decision: 'APPROVE', findings: [],
      };
    });

    // Exactly one retry attempt -- not retried again after the retry itself fails.
    expect(calls.testing).toBe(2);
    expect(calls.security).toBe(1);
    const output = fs.readFileSync(outputPath, 'utf-8');
    expect(output).toContain('review-status=INCOMPLETE_INFRA');
    // Still fail-closed: never an auto-pass.
    expect(output).not.toContain('review-status=SHIP');
  }, 15_000);
});
