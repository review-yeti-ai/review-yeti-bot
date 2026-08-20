import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));
const { createReviewTelemetry } = require(path.join(root, 'src/telemetry/reviewTelemetry.js'));

describe('Action telemetry cancellation seam', () => {
  it('propagates pipeline cancellation into an in-flight exporter and returns a bounded receipt', async () => {
    let exporterAborted = false;
    const cancellation = pipeline.createPipelineCancellation({ installProcessHandlers: false });
    const telemetry = createReviewTelemetry({
      identity: { repository: 'review-yeti-ai/review-yeti-bot', prNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64) },
      exporter: {
        endpoint: 'https://otel.example.test/v1/traces',
        signal: cancellation.signal,
        fetchImplementation: async (_url: string, options: any) => new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => { exporterAborted = true; reject(new Error('aborted')); });
        }),
      },
    });

    telemetry.record({ phase: 'review', unitId: 'pipeline', outcome: 'started' });
    cancellation.cancel();

    await expect(pipeline.flushReviewTelemetry(telemetry, cancellation)).resolves.toMatchObject({ status: 'cancelled' });
    expect(exporterAborted).toBe(true);
    cancellation.dispose();
  });

  it('writes bounded telemetry outputs before a SIGTERM cancellation exits naturally', async () => {
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-sigterm-')), 'github-output.txt');
    const originalExitCode = process.exitCode;
    const env = {
      VITEST: 'true',
      GITHUB_ACTIONS: 'false',
      GITHUB_OUTPUT: output,
    } as NodeJS.ProcessEnv;
    try {
      const run = pipeline.main({
        env,
        installProcessHandlers: true,
        prContext: { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), diffText: '' },
      });
      process.emit('SIGTERM');

      await expect(run).resolves.toBeUndefined();
      expect(fs.readFileSync(output, 'utf-8')).toContain('telemetry-status=cancelled');
      expect(fs.readFileSync(output, 'utf-8')).toContain('telemetry-events=0');
      expect(process.exitCode).toBe(143);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('aborts active model work before SIGTERM finalization', async () => {
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-sigterm-model-')), 'github-output.txt');
    const originalExitCode = process.exitCode;
    let modelAborted = false;
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    try {
      const run = pipeline.main({
        env: {
          VITEST: 'true',
          GITHUB_ACTIONS: 'false',
          GITHUB_OUTPUT: output,
          PR_DIFF: 'synthetic',
          ACTIVE_PERSONAS: JSON.stringify(['security']),
          OPENROUTER_API_KEY: 'test-key',
          OPENROUTER_MODEL: 'model-a',
        },
        installProcessHandlers: true,
        commandRunner: () => ({ status: 0, stdout: '[]', stderr: '' }),
        prContext: {
          repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
          diffText: 'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -0,0 +1 @@\n+const safe = true;\n',
        },
        fetchImplementation: async (_url: string, options: any) => new Promise((_resolve, reject) => {
          modelStarted();
          options.signal.addEventListener('abort', () => { modelAborted = true; reject(new Error('aborted')); });
        }),
      });
      await started;
      process.emit('SIGTERM');

      await expect(run).resolves.toBeUndefined();
      expect(modelAborted).toBe(true);
      expect(fs.readFileSync(output, 'utf-8')).toContain('telemetry-status=cancelled');
      expect(process.exitCode).toBe(143);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('aborts a non-VITEST OpenRouter preflight through the injected fetch boundary', async () => {
    const controller = new AbortController();
    let preflightAborted = false;
    let preflightStarted!: () => void;
    const started = new Promise<void>((resolve) => { preflightStarted = resolve; });
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-preflight-config-'));

    const run = pipeline.main({
      signal: controller.signal,
      env: {
        VITEST: 'false',
        GITHUB_ACTIONS: 'false',
        REVIEW_YETI_CONFIG_DIR: configDir,
        OPENROUTER_API_KEY: 'test-key',
        OPENROUTER_MODEL: 'model-a',
        ACTIVE_PERSONAS: JSON.stringify(['security']),
      },
      commandRunner: (_command: string, args: string[]) => ({
        status: 0,
        stdout: args.includes('view')
          ? JSON.stringify({ baseRefOid: 'a'.repeat(40), headRefOid: 'b'.repeat(40) })
          : JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
        stderr: '',
      }),
      prContext: {
        repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
        diffText: 'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -0,0 +1 @@\n+const safe = true;\n',
      },
      fetchImplementation: async (_url: string, options: any) => new Promise((_resolve, reject) => {
        preflightStarted();
        options.signal.addEventListener('abort', () => {
          preflightAborted = true;
          reject(new Error('preflight aborted'));
        }, { once: true });
      }),
    });

    await started;
    controller.abort();

    await expect(run).resolves.toBeUndefined();
    expect(preflightAborted).toBe(true);
  });

  it('aborts an in-flight model call through the pipeline cancellation signal', async () => {
    const controller = new AbortController();
    let modelAborted = false;
    let rejectFetch: ((reason?: unknown) => void) | undefined;
    const review = pipeline.reviewWithModel(
      { id: 'security', name: 'Security', charter: 'Review safely.' },
      [{ path: 'src/app.js', patch: '+const safe = true;', addedLines: [{ text: 'const safe = true;' }] }],
      { repo: 'review-yeti-ai/review-yeti-bot', prNumber: '42', headSha: 'b'.repeat(40) },
      {},
      {
        model: 'model-a', apiKey: 'test-key', baseUrl: 'https://api.example.test', maxAttempts: 1,
        signal: controller.signal,
        rawTurn: true,
        investigationMessages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }],
        fetchImplementation: async (_url: string, options: any) => new Promise((_resolve, reject) => {
          rejectFetch = reject;
          options.signal.addEventListener('abort', () => { modelAborted = true; reject(new Error('aborted')); });
        }),
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    try {
      expect(modelAborted).toBe(true);
    } finally {
      rejectFetch?.(new Error('test cleanup'));
      await expect(review).resolves.toMatchObject({ decision: 'ERROR' });
    }
  });

  it('stops model retry timers once cancelled', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let modelCalls = 0;
    const review = pipeline.reviewWithModel(
      { id: 'security', name: 'Security', charter: 'Review safely.' },
      [{ path: 'src/app.js', patch: '+const safe = true;', addedLines: [{ text: 'const safe = true;' }] }],
      { repo: 'review-yeti-ai/review-yeti-bot', prNumber: '42', headSha: 'b'.repeat(40) },
      {},
      {
        model: 'model-a', apiKey: 'test-key', baseUrl: 'https://api.example.test', maxAttempts: 2,
        signal: controller.signal,
        rawTurn: true,
        investigationMessages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }],
        fetchImplementation: async () => {
          modelCalls += 1;
          return { ok: false, status: 500, headers: { get: () => null }, text: async () => '' };
        },
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2_000);

    try {
      await expect(review).resolves.toMatchObject({ decision: 'ERROR' });
      // Streaming is unconditional and has no buffered retry. Cancellation still stops the
      // retry timer after the one dispatched SSE attempt.
      expect(modelCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes cancellation to an in-flight memory query fetch', async () => {
    const controller = new AbortController();
    let memoryAborted = false;
    const memoryRuntime = pipeline.createReviewMemoryRouter({
      memory: {
        enabled: true,
        context: true,
        write: false,
        provider: 'mem0',
        mode: 'single',
        transport: 'rest',
        selectedProfile: { enabled: true, endpoint_env: 'MEM0_URL', credential_env: 'MEM0_API_KEY' },
      },
    }, {
      env: { MEM0_URL: 'https://memory.example.test', MEM0_API_KEY: 'test-key' },
      signal: controller.signal,
      fetchImplementation: async (_url: string, options: any) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => { memoryAborted = true; reject(new Error('aborted')); });
      }),
    });
    const query = memoryRuntime.router.queryContext({
      providerId: 'mem0',
      identity: { repository: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'b'.repeat(40) },
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(query).resolves.toMatchObject({ status: 'unavailable' });
    expect(memoryAborted).toBe(true);
  });

  it('does not create a memory outbox intent for a pre-aborted run', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-preaborted-'));
    const configDir = path.join(rootDir, 'config');
    const output = path.join(rootDir, 'github-output.txt');
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, '.review-yeti.yaml'), 'memory:\n  enabled: true\n  provider: mem0\n  mode: single\n  transport: rest\n  context: false\n  write: true\n  persist:\n    processing: true\n');
    const controller = new AbortController();
    controller.abort();

    await expect(pipeline.main({
      cwd: rootDir,
      signal: controller.signal,
      env: { VITEST: 'true', GITHUB_ACTIONS: 'false', REVIEW_YETI_CONFIG_DIR: configDir, GITHUB_OUTPUT: output },
      prContext: { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), diffText: '' },
    })).resolves.toBeUndefined();

    expect(fs.existsSync(path.join(rootDir, 'sessions'))).toBe(false);
  });
});
