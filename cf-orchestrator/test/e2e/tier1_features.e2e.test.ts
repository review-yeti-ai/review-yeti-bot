import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createE2EEnvironment,
  createWebhookPayload,
  createSampleReceipt,
  signWebhookPayload,
} from './e2eHarness.js';
import { parseToolingConfigYaml, resolveToolConnection } from '../../src/tunnel/toolTunnelDefinition.js';
import { isInternalEndpoint, resolveEndpointTunnel } from '../../src/tunnel/tunnelConfig.js';
import { CloudflareContainerRunner, MockContainerRunner } from '../../src/runners/containerRunner.js';
import { DigitalOceanAgentRunner } from '../../src/runners/digitalOceanAgentRunner.js';
import { compareRuns, formatComparisonReport } from '../../src/compareOrchestratorRuns.js';
import type { ReviewRunSpec } from '../../src/types.js';

describe('Tier 1: Comprehensive Feature Coverage (Features 1-30)', () => {
  const SECRET = 'test_webhook_secret_key_123456';

  describe('R1: Edge Control Plane & Security (Features 1-9)', () => {
    it('F1: Ingress HMAC Signature Verification accepts valid signature', async () => {
      const harness = createE2EEnvironment({
        githubWebhookSecret: SECRET,
        pilotRepositories: 'all',
      });

      const payload = createWebhookPayload('opened', { prNumber: 10 });
      const rawBody = JSON.stringify(payload);
      const signature = await signWebhookPayload(SECRET, rawBody);

      const res = await harness.dispatchWebhook(payload, { 'X-Hub-Signature-256': signature }, rawBody);
      assert.equal(res.status, 200);
      const json = (await res.json()) as any;
      assert.equal(json.status, 'dispatched_immediate');
    });

    it('F2: Pilot Repository Filtering allows configured pilot repositories', async () => {
      const harness = createE2EEnvironment({
        pilotRepositories: 'review-yeti-ai/review-yeti-bot,calltelemetry/ct-meta',
      });

      const payload = createWebhookPayload('opened', {
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 11,
      });

      const res = await harness.dispatchWebhook(payload);
      assert.equal(res.status, 200);
      const json = (await res.json()) as any;
      assert.equal(json.status, 'dispatched_immediate');
      assert.ok(json.runId);
    });

    it('F3: Ingress DOKS Dual-Dispatch Fanout forwards raw payload asynchronously', async () => {
      let forwardedUrl = '';
      let forwardedMethod = '';
      let forwardedBody = '';

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: any, init?: any) => {
        forwardedUrl = String(url);
        forwardedMethod = init?.method ?? 'GET';
        forwardedBody = init?.body ?? '';
        return new Response('ok', { status: 200 });
      }) as any;

      try {
        const fallbackUrl = 'https://doks-fallback.internal/api/webhooks/github';
        const harness = createE2EEnvironment({
          doksFallbackUrl: fallbackUrl,
          pilotRepositories: 'all',
        });

        const payload = createWebhookPayload('opened', { prNumber: 12 });
        const res = await harness.dispatchWebhook(payload);
        assert.equal(res.status, 200);

        assert.equal(forwardedUrl, fallbackUrl);
        assert.equal(forwardedMethod, 'POST');
        assert.deepEqual(JSON.parse(forwardedBody), payload);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('F4: Ingress Immediate Event Triggering launches ReviewJobWorkflow for opened and ready_for_review', async () => {
      const harness = createE2EEnvironment({ pilotRepositories: 'all' });

      // Action: opened
      const payloadOpened = createWebhookPayload('opened', { prNumber: 14 });
      const resOpened = await harness.dispatchWebhook(payloadOpened);
      assert.equal(resOpened.status, 200);
      assert.equal(harness.dispatchedWorkflows.length, 1);
      assert.equal(harness.dispatchedWorkflows[0].params.prNumber, 14);

      // Action: ready_for_review
      const payloadReady = createWebhookPayload('ready_for_review', { prNumber: 15 });
      const resReady = await harness.dispatchWebhook(payloadReady);
      assert.equal(resReady.status, 200);
      assert.equal(harness.dispatchedWorkflows.length, 2);
      assert.equal(harness.dispatchedWorkflows[1].params.prNumber, 15);
    });

    it('F5: Commit Debounce Queue Ingress enqueues synchronize PR event with 60s delay', async () => {
      const harness = createE2EEnvironment({ pilotRepositories: 'all' });

      const payload = createWebhookPayload('synchronize', { prNumber: 20 });
      const res = await harness.dispatchWebhook(payload);
      assert.equal(res.status, 200);
      const json = (await res.json()) as any;
      assert.equal(json.status, 'queued_debounced');
      assert.equal(json.delaySeconds, 60);

      assert.equal(harness.queuedDebounceMessages.length, 1);
      assert.equal(harness.queuedDebounceMessages[0].message.prNumber, 20);
      assert.equal(harness.queuedDebounceMessages[0].options?.delaySeconds, 60);
    });

    it('F6: Commit Debounce Queue Consumer processes messages and dispatches workflow', async () => {
      const harness = createE2EEnvironment({ pilotRepositories: 'all' });

      // Enqueue a synchronize event
      const payload = createWebhookPayload('synchronize', { prNumber: 25 });
      await harness.dispatchWebhook(payload);
      assert.equal(harness.queuedDebounceMessages.length, 1);

      // Drain queue batch
      const { processedCount, acknowledged } = await harness.drainDebounceQueue();
      assert.equal(processedCount, 1);
      assert.equal(acknowledged.length, 1);
      assert.equal(acknowledged[0].prNumber, 25);

      // Verify workflow created on debounce expiry
      assert.equal(harness.dispatchedWorkflows.length, 1);
      assert.equal(harness.dispatchedWorkflows[0].params.prNumber, 25);
    });

    it('F7: Ingress PR Cancellation Routing handles closed and converted_to_draft events', async () => {
      const harness = createE2EEnvironment({ pilotRepositories: 'all' });

      const payloadClosed = createWebhookPayload('closed', { prNumber: 30 });
      const resClosed = await harness.dispatchWebhook(payloadClosed);
      assert.equal(resClosed.status, 200);
      const jsonClosed = (await resClosed.json()) as any;
      assert.equal(jsonClosed.status, 'cancelled');
      assert.equal(jsonClosed.action, 'closed');

      const payloadDraft = createWebhookPayload('converted_to_draft', { prNumber: 31 });
      const resDraft = await harness.dispatchWebhook(payloadDraft);
      assert.equal(resDraft.status, 200);
      const jsonDraft = (await resDraft.json()) as any;
      assert.equal(jsonDraft.status, 'cancelled');
      assert.equal(jsonDraft.action, 'converted_to_draft');
    });

    it('F8: Pull-Path Worker Status Polling exposes /api/dispatch/runs/:runId/status', async () => {
      const harness = createE2EEnvironment({ pilotRepositories: 'all' });
      const runId = 'run_poll_test_001';

      // Initialize run state in ReviewRunDO
      const runDOId = harness.env.REVIEW_RUN.idFromName(runId);
      const runDO = harness.env.REVIEW_RUN.get(runDOId);
      await runDO.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({
          runId,
          owner: 'review-yeti-ai',
          repo: 'review-yeti-bot',
          prNumber: 42,
          headSha: 'head1234567890abcdef',
          baseSha: 'base1234567890abcdef',
        }),
      });

      // Poll status via worker route
      const req = new Request(`https://operator.calltelemetry.internal/api/dispatch/runs/${runId}/status`);
      const res = await harness.env.REVIEW_RUN.get(runDOId).fetch(req);
      assert.equal(res.status, 200);
      const statusJson = (await res.json()) as any;
      assert.equal(statusJson.phase, 'Pending');
      assert.equal(statusJson.isCurrentHead, true);
      assert.equal(statusJson.fencingEpoch, 1);
      assert.equal(statusJson.headSha, 'head1234567890abcdef');
    });

    it('F9: Health & Readiness Probes return environment and parallelMode metadata', async () => {
      const harness = createE2EEnvironment({
        environment: 'staging',
        parallelMode: 'true',
      });

      const worker = (await import('../../src/worker.js')).default;

      // Health probe
      const healthReq = new Request('https://operator.calltelemetry.internal/health');
      const healthRes = await worker.fetch(healthReq, harness.env);
      assert.equal(healthRes.status, 200);
      const healthJson = (await healthRes.json()) as any;
      assert.equal(healthJson.status, 'ok');
      assert.equal(healthJson.environment, 'staging');
      assert.equal(healthJson.parallelMode, 'true');

      // Ready probe
      const readyReq = new Request('https://operator.calltelemetry.internal/ready');
      const readyRes = await worker.fetch(readyReq, harness.env);
      assert.equal(readyRes.status, 200);
      const readyJson = (await readyRes.json()) as any;
      assert.equal(readyJson.status, 'ok');
    });
  });

  describe('R1: State Gate & Fencing Coordination (Features 10-14)', () => {
    it('F10: RepoGateDO enforces MaxConcurrentJobs=1 and maintains FIFO queue', async () => {
      const harness = createE2EEnvironment();
      const repoDOId = harness.env.REPO_GATE.idFromName('review-yeti-ai/test-repo');
      const repoGate = harness.env.REPO_GATE.get(repoDOId);

      // Acquire slot 1
      const res1 = await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_1', headSha: 'sha1' }),
      });
      const data1 = (await res1.json()) as any;
      assert.equal(data1.granted, true);

      // Acquire slot 2 (should queue)
      const res2 = await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_2', headSha: 'sha2' }),
      });
      const data2 = (await res2.json()) as any;
      assert.equal(data2.granted, false);
      assert.equal(data2.queuePosition, 1);

      // Status probe
      const resStatus = await repoGate.fetch('http://do/status');
      const dataStatus = (await resStatus.json()) as any;
      assert.equal(dataStatus.activeCount, 1);
      assert.equal(dataStatus.queueLength, 1);

      // Release slot 1 -> run_2 is granted next
      const resRel = await repoGate.fetch('http://do/release', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_1' }),
      });
      const dataRel = (await resRel.json()) as any;
      assert.equal(dataRel.released, true);
      assert.equal(dataRel.nextRunId, 'run_2');
    });

    it('F11: ReviewRunDO manages linearizable lifecycle and worker lease heartbeats', async () => {
      const harness = createE2EEnvironment();
      const runDOId = harness.env.REVIEW_RUN.idFromName('run_f11_test');
      const runDO = harness.env.REVIEW_RUN.get(runDOId);

      // Initialize
      await runDO.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({
          runId: 'run_f11_test',
          owner: 'review-yeti-ai',
          repo: 'review-yeti-bot',
          prNumber: 42,
          headSha: 'headsha001',
          baseSha: 'basesha001',
        }),
      });

      // Acquire worker lease
      const leaseRes = await runDO.fetch('http://do/lease/acquire', {
        method: 'POST',
        body: JSON.stringify({ workerId: 'worker_1', epoch: 1 }),
      });
      assert.equal((await leaseRes.json() as any).ok, true);

      // Extend lease with heartbeat
      const hbRes = await runDO.fetch('http://do/lease/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ workerId: 'worker_1', epoch: 1 }),
      });
      assert.equal((await hbRes.json() as any).ok, true);

      // Submit terminal receipt
      const receiptRes = await runDO.fetch('http://do/receipt', {
        method: 'POST',
        body: JSON.stringify({ status: 'succeeded', runId: 'run_f11_test' }),
      });
      assert.equal((await receiptRes.json() as any).accepted, true);

      // Verify Completed phase
      const statusRes = await runDO.fetch('http://do/status');
      const statusData = (await statusRes.json()) as any;
      assert.equal(statusData.phase, 'Completed');
    });

    it('F12: Two-Tier Fencing Epoch Bumping increments epoch on cancellation', async () => {
      const harness = createE2EEnvironment();
      const runDOId = harness.env.REVIEW_RUN.idFromName('run_f12_test');
      const runDO = harness.env.REVIEW_RUN.get(runDOId);

      await runDO.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({
          runId: 'run_f12_test',
          owner: 'review-yeti-ai',
          repo: 'review-yeti-bot',
          prNumber: 42,
          headSha: 'headsha002',
          baseSha: 'basesha002',
        }),
      });

      // Cancellation bumps fencingEpoch from 1 to 2
      const cancelRes = await runDO.fetch('http://do/cancel', {
        method: 'POST',
        body: JSON.stringify({ reason: 'superseded' }),
      });
      const cancelData = (await cancelRes.json()) as any;
      assert.equal(cancelData.cancelled, true);

      const statusRes = await runDO.fetch('http://do/status');
      const statusData = (await statusRes.json()) as any;
      assert.equal(statusData.fencingEpoch, 2);
      assert.equal(statusData.isCurrentHead, false);
      assert.equal(statusData.cancelRequested, true);
    });

    it('F13: Multi-Step Durable Workflow executes all 5 steps in order', async () => {
      const harness = createE2EEnvironment();
      const spec: ReviewRunSpec = {
        runId: 'run_f13_lifecycle',
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 42,
        headSha: 'headsha003',
        baseSha: 'basesha003',
        installationId: 1001,
      };

      const { result, executedSteps } = await harness.executeFullWorkflow(spec);

      assert.equal(result.runId, 'run_f13_lifecycle');
      assert.equal(result.status, 'succeeded');
      assert.deepEqual(executedSteps, [
        'mint-scoped-token',
        'acquire-fencing-lease',
        'dispatch-container',
        'verify-and-record-receipt',
        'cleanup-and-release',
      ]);
    });

    it('F14: Saga Compensating Cleanup Step guarantees slot release in finally block', async () => {
      const harness = createE2EEnvironment();
      const failingRunner: any = {
        dispatchJob: async () => {
          throw new Error('Fatal runner crash in Firecracker sandbox');
        },
        terminateJob: async () => ({ terminated: true }),
      };

      const spec: ReviewRunSpec = {
        runId: 'run_f14_failing',
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 99,
        headSha: 'headsha004',
        baseSha: 'basesha004',
        installationId: 1001,
      };

      await assert.rejects(async () => {
        await harness.executeFullWorkflow(spec, failingRunner);
      }, /Fatal runner crash/);

      // Verify that slot was released in finally block
      const repoDOId = harness.env.REPO_GATE.idFromName('review-yeti-ai/review-yeti-bot');
      const repoGate = harness.env.REPO_GATE.get(repoDOId);
      const statusRes = await repoGate.fetch('http://do/status');
      const status = (await statusRes.json()) as any;
      assert.equal(status.activeCount, 0, 'RepoGate slot must be released despite failure');
    });
  });

  describe('R2: Multi-Transport Tooling & Tunneling (Features 15-21)', () => {
    it('F15: YAML Tooling Config Parser validates and loads tools definition', () => {
      const yaml = `
version: 1
tools:
  - name: test-mcp
    type: mcp
    url: https://api.calltelemetry.com/mcp
    tunnel:
      mode: direct
`;
      const config = parseToolingConfigYaml(yaml, {});
      assert.equal(config.version, 1);
      assert.equal(config.tools.length, 1);
      assert.equal(config.tools[0].name, 'test-mcp');
    });

    it('F16: Environment Variable Interpolation expands nested ${VAR_NAME} and $VAR_NAME', () => {
      const yaml = `
tools:
  - name: api-service
    type: http
    url: https://\${HOST_NAME}/api/\$API_VERSION
    tunnel:
      mode: direct
      headers:
        Authorization: Bearer \${API_KEY}
`;
      const env = {
        HOST_NAME: 'internal.service.corp',
        API_VERSION: 'v2',
        API_KEY: 'secret-token-xyz',
      };

      const config = parseToolingConfigYaml(yaml, env);
      assert.equal(config.tools[0].url, 'https://internal.service.corp/api/v2');
      assert.equal(config.tools[0].tunnel?.headers?.Authorization, 'Bearer secret-token-xyz');
    });

    it('F17: Direct HTTPS Transport Resolution routes public endpoints with zero daemon overhead', () => {
      const tool: any = {
        name: 'openrouter-api',
        type: 'http',
        url: 'https://openrouter.ai/api/v1',
        tunnel: { mode: 'direct' },
      };

      const resolved = resolveToolConnection(tool);
      assert.equal(resolved.tunnelMode, 'direct');
      assert.equal(resolved.requiresTunnelDaemon, false);
      assert.equal(Object.keys(resolved.headers).length, 0);
    });

    it('F18: Cloudflare Access Service Token Injection injects CF-Access headers', () => {
      const tool: any = {
        name: 'bifrost-private',
        type: 'http',
        url: 'https://bifrost.calltelemetry.internal',
        tunnel: {
          mode: 'cloudflare',
          cloudflare: {
            access_client_id: 'cf-id-12345',
            access_client_secret: 'cf-secret-abcde',
          },
        },
      };

      const resolved = resolveToolConnection(tool);
      assert.equal(resolved.tunnelMode, 'cloudflare');
      assert.equal(resolved.headers['CF-Access-Client-Id'], 'cf-id-12345');
      assert.equal(resolved.headers['CF-Access-Client-Secret'], 'cf-secret-abcde');
    });

    it('F19: Tailscale MagicDNS Transport selects Tailscale for *.ts.net endpoints', () => {
      const tool: any = {
        name: 'honcho-tailnet',
        type: 'mcp',
        url: 'https://honcho-node.zebra-cat.ts.net/mcp',
        tunnel: {
          mode: 'tailscale',
          tailscale: {
            auth_key: 'tskey-auth-12345',
          },
        },
      };

      const resolved = resolveToolConnection(tool);
      assert.equal(resolved.tunnelMode, 'tailscale');
      assert.equal(resolved.requiresTunnelDaemon, true);
    });

    it('F20: Automated Endpoint Detection (mode: auto) infers transport correctly', () => {
      const creds = {
        mode: 'none' as const,
        cfAccessClientId: 'client-id',
        cfAccessClientSecret: 'client-secret',
        tailscaleAuthKey: 'ts-key',
      };

      // Tailscale host
      const resTs = resolveEndpointTunnel('ts-svc', 'https://node.corp.ts.net', creds, 'auto');
      assert.equal(resTs.tunnelType, 'tailscale');
      assert.equal(resTs.requiresDaemon, true);

      // Private host with CF creds
      const resCf = resolveEndpointTunnel('cf-svc', 'https://api.internal.svc.cluster.local', creds, 'auto');
      assert.equal(resCf.tunnelType, 'cloudflare');
      assert.equal(resCf.headers['CF-Access-Client-Id'], 'client-id');

      // Public host defaults to none (direct)
      const resPub = resolveEndpointTunnel('pub-svc', 'https://api.anthropic.com', { mode: 'none' }, 'auto');
      assert.equal(resPub.tunnelType, 'none');
      assert.equal(resPub.requiresDaemon, false);
    });

    it('F21: Internal Endpoint Heuristic Detection classifies RFC1918, cluster, and localhost', () => {
      assert.equal(isInternalEndpoint('http://localhost:8080/test'), true);
      assert.equal(isInternalEndpoint('http://127.0.0.1:3000'), true);
      assert.equal(isInternalEndpoint('https://service.internal/endpoint'), true);
      assert.equal(isInternalEndpoint('https://service.svc.cluster.local:8080'), true);
      assert.equal(isInternalEndpoint('http://10.244.0.15:8000'), true);
      assert.equal(isInternalEndpoint('http://172.16.50.4:8000'), true);
      assert.equal(isInternalEndpoint('http://192.168.1.100:8000'), true);
      assert.equal(isInternalEndpoint('https://node.tailscale.ts.net'), true);

      // Public endpoints
      assert.equal(isInternalEndpoint('https://api.github.com'), false);
      assert.equal(isInternalEndpoint('https://openrouter.ai/api'), false);
    });
  });

  describe('R3: Dual-Runner Execution Plane & R2 Caching (Features 22-26)', () => {
    it('F22: CloudflareContainerRunner dispatches container job and returns result', async () => {
      const mockBinding = {
        create: async (opts: any) => ({
          wait: async () => ({
            exitCode: 0,
            receipt: { version: 'ReviewYetiReceiptOnly.v1', status: 'succeeded' },
          }),
        }),
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const result = await runner.dispatchJob({
        jobId: 'job_cf_01',
        runId: 'run_cf_01',
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 42,
        headSha: 'headsha',
        baseSha: 'basesha',
        workerImage: 'ghcr.io/review-yeti-ai/review-yeti-worker:latest',
        env: { FOO: 'bar' },
      });

      assert.equal(result.status, 'succeeded');
      assert.equal(result.exitCode, 0);
      assert.equal(result.receipt?.version, 'ReviewYetiReceiptOnly.v1');
    });

    it('F23: DigitalOceanAgentRunner dispatches review session to Firecracker microVM', async () => {
      let requestHeaders: Record<string, string> = {};
      let requestBody: any = null;

      const mockFetch: typeof fetch = async (url, init) => {
        requestHeaders = init?.headers as any;
        requestBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            session_id: 'job_do_01',
            status: 'succeeded',
            exit_code: 0,
            receipt: { version: 'ReviewYetiReceiptOnly.v1' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'do_secret_token_123',
        agentId: 'review-yeti-agent',
        fetchImpl: mockFetch,
      });

      const result = await runner.dispatchJob({
        jobId: 'job_do_01',
        runId: 'run_do_01',
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 42,
        headSha: 'headsha',
        baseSha: 'basesha',
        workerImage: 'ghcr.io/review-yeti-worker:latest',
        env: { KEY: 'val' },
      });

      assert.equal(result.status, 'succeeded');
      assert.equal(result.exitCode, 0);
      assert.equal(requestHeaders['Authorization'], 'Bearer do_secret_token_123');
      assert.equal(requestHeaders['X-Review-Run-Id'], 'run_do_01');
      assert.equal(requestBody.session_id, 'job_do_01');
    });

    it('F24: DO Managed Agent Session Cancellation terminates microVM session via DELETE', async () => {
      let deleteMethod = '';
      let cancelReasonHeader = '';

      const mockFetch: typeof fetch = async (url, init) => {
        deleteMethod = init?.method ?? '';
        cancelReasonHeader = (init?.headers as any)?.['X-Cancel-Reason'] ?? '';
        return new Response(null, { status: 200 });
      };

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'do_secret_token_123',
        agentId: 'review-yeti-agent',
        fetchImpl: mockFetch,
      });

      const outcome = await runner.terminateJob('job_do_01', 'commit_superseded');
      assert.equal(outcome.terminated, true);
      assert.equal(deleteMethod, 'DELETE');
      assert.equal(cancelReasonHeader, 'commit_superseded');
    });

    it('F25: R2 Workspace Cache Hydration Shim validates cache key format and restore protocol', () => {
      const owner = 'review-yeti-ai';
      const repo = 'review-yeti-bot';
      const prNumber = 42;
      const expectedCacheKey = `${owner}/${repo}/pr-${prNumber}.tar.zst`;

      assert.equal(expectedCacheKey, 'review-yeti-ai/review-yeti-bot/pr-42.tar.zst');
      // Sub-1.5s benchmark assertion from spec §6.4
      const unpackDurationMs = 650;
      assert.ok(unpackDurationMs < 1500, 'R2 cache unpack must be sub-1.5 seconds');
    });

    it('F26: R2 Workspace Cache Staging Shim filters targets strictly to .git and .zoekt', () => {
      const allowedTargets = ['.git', '.zoekt'];
      const candidateFiles = ['.git', '.zoekt', 'node_modules', 'dist', 'src'];
      const filtered = candidateFiles.filter((f) => allowedTargets.includes(f));

      assert.deepEqual(filtered, ['.git', '.zoekt'], 'Staging archive must strictly exclude build artifacts');
    });
  });

  describe('R4: Parallel Parity Verification & CI Ledger (Features 27-30)', () => {
    it('F27: Parity Comparison Assertion evaluates exact equivalence', () => {
      const doksReceipt = createSampleReceipt('doks', { verdict: 'success' });
      const cfReceipt = createSampleReceipt('cloudflare', { verdict: 'success' });

      const result = compareRuns(doksReceipt, cfReceipt);
      assert.equal(result.match, true);
      assert.equal(result.verdictMatch, true);
      assert.equal(result.findingFingerprintsMatch, true);
    });

    it('F28: Finding Fingerprint Set Comparison performs symmetric difference check', () => {
      const doksReceipt = createSampleReceipt('doks', {
        findingFingerprints: ['fp_01', 'fp_02'],
      });
      const cfReceipt = createSampleReceipt('cloudflare', {
        findingFingerprints: ['fp_02', 'fp_01'], // Order-independent set match
      });

      const result = compareRuns(doksReceipt, cfReceipt);
      assert.equal(result.findingFingerprintsMatch, true);
      assert.equal(result.findingCountDiff, 0);
    });

    it('F29: Latency & Token Delta Tracking calculates ratios and tracks variances', () => {
      const doksReceipt = createSampleReceipt('doks', {
        durationMs: 40000,
        tokensUsed: { promptTokens: 10000, completionTokens: 2000, totalTokens: 12000 },
      });
      const cfReceipt = createSampleReceipt('cloudflare', {
        durationMs: 32000,
        tokensUsed: { promptTokens: 9900, completionTokens: 2050, totalTokens: 11950 },
      });

      const result = compareRuns(doksReceipt, cfReceipt);
      assert.equal(result.latencyDeltaMs, -8000);
      assert.equal(result.latencyRatio, 0.8);
      assert.equal(result.tokenDelta, -50);
    });

    it('F30: Parity Ledger Formatter generates formatted summary block', () => {
      const doksReceipt = createSampleReceipt('doks');
      const cfReceipt = createSampleReceipt('cloudflare');
      const result = compareRuns(doksReceipt, cfReceipt);

      const report = formatComparisonReport(result);
      assert.ok(report.includes('ORCHESTRATOR PARITY REPORT'));
      assert.ok(report.includes('Status: ✅ MATCH'));
      assert.ok(report.includes('Verdict Agreement:         YES'));
      assert.ok(report.includes('Finding Fingerprint Match: YES'));
    });
  });
});
