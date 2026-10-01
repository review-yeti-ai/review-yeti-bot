import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createE2EEnvironment,
  createWebhookPayload,
  signWebhookPayload,
} from './e2eHarness.js';
import { ReviewJobWorkflow } from '../../src/reviewJobWorkflow.js';
import { CloudflareContainerRunner, MockContainerRunner } from '../../src/runners/containerRunner.js';
import { DigitalOceanAgentRunner } from '../../src/runners/digitalOceanAgentRunner.js';
import { parseToolingConfigYaml, resolveToolConnection } from '../../src/tunnel/toolTunnelDefinition.js';
import type { ReviewRunSpec } from '../../src/types.js';

describe('Tier 3: Cross-Feature Interactions', () => {
  const SECRET = 'test_webhook_secret_key_interactions';

  it('X1: Ingress Dual-Dispatch Fanout + Debounce Queue Ingress interact seamlessly', async () => {
    let fanoutUrl = '';
    let fanoutPayload: any = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      fanoutUrl = String(url);
      fanoutPayload = JSON.parse(init?.body as string);
      return new Response('ok', { status: 200 });
    }) as any;

    try {
      const fallbackUrl = 'https://doks-production.internal/webhooks';
      const harness = createE2EEnvironment({
        githubWebhookSecret: SECRET,
        doksFallbackUrl: fallbackUrl,
        pilotRepositories: 'all',
      });

      const payload = createWebhookPayload('synchronize', {
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 50,
        headSha: 'headsha_sync_001',
      });

      const rawBody = JSON.stringify(payload);
      const sig = await signWebhookPayload(SECRET, rawBody);

      const res = await harness.dispatchWebhook(payload, { 'X-Hub-Signature-256': sig }, rawBody);
      assert.equal(res.status, 200);
      const json = (await res.json()) as any;
      assert.equal(json.status, 'queued_debounced');
      assert.equal(json.delaySeconds, 60);

      // Verify fanout occurred asynchronously with identical payload
      assert.equal(fanoutUrl, fallbackUrl);
      assert.equal(fanoutPayload.action, 'synchronize');
      assert.equal(fanoutPayload.pull_request.head.sha, 'headsha_sync_001');

      // Verify queue received the debounced item
      assert.equal(harness.queuedDebounceMessages.length, 1);
      assert.equal(harness.queuedDebounceMessages[0].message.headSha, 'headsha_sync_001');
      assert.equal(harness.queuedDebounceMessages[0].options?.delaySeconds, 60);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('X2: Debounce Ingress ➔ Queue Consumer ➔ Full Workflow Execution completes pipeline', async () => {
    const harness = createE2EEnvironment({ pilotRepositories: 'all' });

    // Step A: Webhook ingress queues synchronize event
    const payload = createWebhookPayload('synchronize', {
      owner: 'review-yeti-ai',
      repo: 'review-yeti-bot',
      prNumber: 55,
      headSha: 'sha_pipeline_01',
      baseSha: 'sha_base_01',
    });
    const webhookRes = await harness.dispatchWebhook(payload);
    assert.equal(webhookRes.status, 200);
    assert.equal(harness.queuedDebounceMessages.length, 1);

    // Step B: Queue consumer processes message batch
    const { processedCount, acknowledged } = await harness.drainDebounceQueue();
    assert.equal(processedCount, 1);
    assert.equal(acknowledged.length, 1);
    assert.equal(harness.dispatchedWorkflows.length, 1);

    const dispatched = harness.dispatchedWorkflows[0];
    assert.equal(dispatched.params.headSha, 'sha_pipeline_01');

    // Step C: Execute the created workflow
    const { result, executedSteps } = await harness.executeFullWorkflow(dispatched.params);
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(executedSteps, [
      'mint-scoped-token',
      'acquire-fencing-lease',
      'dispatch-container',
      'verify-and-record-receipt',
      'cleanup-and-release',
    ]);

    // Step D: Verify RepoGate slot was released
    const repoGateId = harness.env.REPO_GATE.idFromName('review-yeti-ai/review-yeti-bot');
    const repoGate = harness.env.REPO_GATE.get(repoGateId);
    const repoStatus = await (await repoGate.fetch('http://do/status')).json() as any;
    assert.equal(repoStatus.activeCount, 0);
  });

  it('X3: Commit Supersession invalidates in-flight worker heartbeats and receipts via epoch bump', async () => {
    const harness = createE2EEnvironment();
    const runId = 'run_supersession_test';
    const runDOId = harness.env.REVIEW_RUN.idFromName(runId);
    const runDO = harness.env.REVIEW_RUN.get(runDOId);

    // 1. Initialize run and acquire lease at epoch 1
    await runDO.fetch('http://do/init', {
      method: 'POST',
      body: JSON.stringify({
        runId,
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 60,
        headSha: 'old_commit_sha',
        baseSha: 'base_sha',
        installationId: 101,
      }),
    });

    const leaseRes = await runDO.fetch('http://do/lease/acquire', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'worker_old', epoch: 1 }),
    });
    assert.equal((await leaseRes.json() as any).ok, true);

    // 2. Commit supersession cancels run
    const cancelRes = await runDO.fetch('http://do/cancel', {
      method: 'POST',
      body: JSON.stringify({ reason: 'superseded_by_new_commit' }),
    });
    const cancelData = (await cancelRes.json()) as any;
    assert.equal(cancelData.cancelled, true);

    // 3. Stale worker attempting heartbeat at epoch 1 must fail
    const hbRes = await runDO.fetch('http://do/lease/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'worker_old', epoch: 1 }),
    });
    assert.equal((await hbRes.json() as any).ok, false);

    // 4. Stale worker attempting receipt submission must be rejected
    const receiptRes = await runDO.fetch('http://do/receipt', {
      method: 'POST',
      body: JSON.stringify({ status: 'succeeded', runId }),
    });
    const receiptData = (await receiptRes.json()) as any;
    assert.equal(receiptData.accepted, false);
    assert.equal(receiptData.reason, 'run_cancelled');

    // 5. Worker pull-path polling reports cancelled and incremented epoch
    const statusRes = await runDO.fetch('http://do/status');
    const statusData = (await statusRes.json()) as any;
    assert.equal(statusData.isCurrentHead, false);
    assert.equal(statusData.phase, 'Cancelled');
    assert.equal(statusData.fencingEpoch, 2);
    assert.equal(statusData.cancelRequested, true);
  });

  it('X4: Multi-Transport Tooling Fallback resolves heterogeneous configs accurately', () => {
    const yaml = `
version: 1
tools:
  - name: public-openrouter
    type: http
    url: https://openrouter.ai/api/v1
    tunnel:
      mode: auto
  - name: bifrost-private
    type: http
    url: https://bifrost.svc.cluster.local:8080
    tunnel:
      mode: auto
      cloudflare:
        access_client_id: \${CF_CLIENT_ID}
        access_client_secret: \${CF_CLIENT_SECRET}
  - name: honcho-tailnet
    type: mcp
    url: https://honcho.zebra.ts.net/mcp
    tunnel:
      mode: auto
      tailscale:
        auth_key: \${TAILSCALE_KEY}
  - name: unconfigured-internal
    type: http
    url: https://internal.corp.local/api
    tunnel:
      mode: auto
`;

    const env = {
      CF_CLIENT_ID: 'cf-id-xyz',
      CF_CLIENT_SECRET: 'cf-secret-xyz',
      TAILSCALE_KEY: 'tskey-abc',
    };

    const config = parseToolingConfigYaml(yaml, env);
    assert.equal(config.tools.length, 4);

    // Tool 1: Public OpenRouter -> direct
    const t1 = resolveToolConnection(config.tools[0]);
    assert.equal(t1.tunnelMode, 'direct');
    assert.equal(t1.requiresTunnelDaemon, false);

    // Tool 2: Bifrost Private with CF Access -> cloudflare
    const t2 = resolveToolConnection(config.tools[1]);
    assert.equal(t2.tunnelMode, 'cloudflare');
    assert.equal(t2.headers['CF-Access-Client-Id'], 'cf-id-xyz');
    assert.equal(t2.headers['CF-Access-Client-Secret'], 'cf-secret-xyz');

    // Tool 3: Honcho Tailscale -> tailscale
    const t3 = resolveToolConnection(config.tools[2]);
    assert.equal(t3.tunnelMode, 'tailscale');
    assert.equal(t3.requiresTunnelDaemon, true);

    // Tool 4: Unconfigured internal without credentials -> falls back to direct
    const t4 = resolveToolConnection(config.tools[3]);
    assert.equal(t4.tunnelMode, 'cloudflare'); // auto with internal endpoint selects cloudflare mode
  });

  it('X5: Dual-Runner Execution Plane: Workflow executes polymorphically with CF and DO runners', async () => {
    const harness = createE2EEnvironment();

    // Runner A: CloudflareContainerRunner with mock edge container binding
    let cfDispatchedSpec: any = null;
    const cfBinding = {
      create: async (opts: any) => {
        cfDispatchedSpec = opts;
        return {
          wait: async () => ({
            exitCode: 0,
            receipt: { version: 'ReviewYetiReceiptOnly.v1', status: 'succeeded', runId: 'run_cf_poly' },
          }),
        };
      },
    };
    const cfRunner = new CloudflareContainerRunner(cfBinding);

    const specA: ReviewRunSpec = {
      runId: 'run_cf_poly',
      owner: 'review-yeti-ai',
      repo: 'review-yeti-bot',
      prNumber: 71,
      headSha: 'head_poly_cf',
      baseSha: 'base_poly_cf',
      installationId: 101,
    };

    const { result: resA } = await harness.executeFullWorkflow(specA, cfRunner);
    assert.equal(resA.status, 'succeeded');
    assert.equal(cfDispatchedSpec.env.PARALLEL_CHECK_NAME, 'Review Yeti (Cloudflare Canary)');
    assert.equal(cfDispatchedSpec.env.RUN_ID, 'run_cf_poly');

    // Runner B: DigitalOceanAgentRunner with mock HTTP fetch
    let doSessionCreated: any = null;
    const mockDoFetch: typeof fetch = async (url, init) => {
      doSessionCreated = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          session_id: 'job-run_do_poly',
          status: 'succeeded',
          exit_code: 0,
          receipt: { version: 'ReviewYetiReceiptOnly.v1', status: 'succeeded', runId: 'run_do_poly' },
        }),
        { status: 200 }
      );
    };
    const doRunner = new DigitalOceanAgentRunner({
      apiToken: 'do_token_poly',
      fetchImpl: mockDoFetch,
    });

    const specB: ReviewRunSpec = {
      runId: 'run_do_poly',
      owner: 'review-yeti-ai',
      repo: 'review-yeti-bot',
      prNumber: 72,
      headSha: 'head_poly_do',
      baseSha: 'base_poly_do',
      installationId: 102,
    };

    const { result: resB } = await harness.executeFullWorkflow(specB, doRunner);
    assert.equal(resB.status, 'succeeded');
    assert.equal(doSessionCreated.environment.PARALLEL_CHECK_NAME, 'Review Yeti (Cloudflare Canary)');
    assert.equal(doSessionCreated.environment.RUN_ID, 'run_do_poly');
  });

  it('X6: FIFO Concurrency Contention & Compensating Saga Release unblocks queued run', async () => {
    const harness = createE2EEnvironment();
    const repoGateId = harness.env.REPO_GATE.idFromName('review-yeti-ai/review-yeti-bot');
    const repoGate = harness.env.REPO_GATE.get(repoGateId);

    // Run 1 acquires slot
    const acq1 = await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run_active_holder', headSha: 'sha1' }),
    });
    assert.equal((await acq1.json() as any).granted, true);

    // Run 2 attempts acquire and is placed in FIFO queue position 1
    const acq2 = await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run_queued_waiter', headSha: 'sha2' }),
    });
    const dataAcq2 = (await acq2.json()) as any;
    assert.equal(dataAcq2.granted, false);
    assert.equal(dataAcq2.queuePosition, 1);

    // Simulate Run 1 finishing or crashing and releasing slot in saga step
    const rel1 = await repoGate.fetch('http://do/release', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run_active_holder' }),
    });
    const dataRel1 = (await rel1.json()) as any;
    assert.equal(dataRel1.released, true);
    assert.equal(dataRel1.nextRunId, 'run_queued_waiter');

    // Run 2 is now active in RepoGate
    const status = await (await repoGate.fetch('http://do/status')).json() as any;
    assert.equal(status.activeCount, 1);
    assert.equal(status.activeJobs.includes('run_queued_waiter'), true);
    assert.equal(status.queueLength, 0);
  });
});
