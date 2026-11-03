import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createE2EEnvironment,
  createWebhookPayload,
  signWebhookPayload,
} from './e2eHarness.js';
import { parseToolingConfigYaml } from '../../src/tunnel/toolTunnelDefinition.js';
import { isInternalEndpoint, resolveEndpointTunnel } from '../../src/tunnel/tunnelConfig.js';

describe('Tier 2: Boundary & Corner Cases', () => {
  const SECRET = 'test_webhook_secret_key_boundary';

  describe('Edge Ingress & Gateway Boundary Cases', () => {
    it('B1: Missing X-Hub-Signature-256 header returns HTTP 401', async () => {
      const harness = createE2EEnvironment({
        githubWebhookSecret: SECRET,
        pilotRepositories: 'all',
      });

      const payload = createWebhookPayload('opened', { prNumber: 1 });
      const rawBody = JSON.stringify(payload);

      // Do NOT provide X-Hub-Signature-256 header
      const req = new Request('https://operator.example.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
        },
        body: rawBody,
      });

      const worker = (await import('../../src/worker.js')).default;
      const res = await worker.fetch(req, harness.env);

      assert.equal(res.status, 401);
      assert.equal(await res.text(), 'Unauthorized: Invalid HMAC signature');
    });

    it('B2: Invalid HMAC signature returns HTTP 401', async () => {
      const harness = createE2EEnvironment({
        githubWebhookSecret: SECRET,
        pilotRepositories: 'all',
      });

      const payload = createWebhookPayload('opened', { prNumber: 2 });
      const rawBody = JSON.stringify(payload);
      const invalidSignature = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';

      const res = await harness.dispatchWebhook(payload, { 'X-Hub-Signature-256': invalidSignature }, rawBody);
      assert.equal(res.status, 401);
      assert.equal(await res.text(), 'Unauthorized: Invalid HMAC signature');
    });

    it('B3: Malformed JSON body returns HTTP 400 Bad Request', async () => {
      const harness = createE2EEnvironment({
        githubWebhookSecret: SECRET,
        pilotRepositories: 'all',
      });

      const malformedBody = '{"action": "opened", "pull_request": ...corrupt json...';
      const sig = await signWebhookPayload(SECRET, malformedBody);

      const res = await harness.dispatchWebhook({}, { 'X-Hub-Signature-256': sig }, malformedBody);
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Bad Request: Invalid JSON');
    });

    it('B4: Non-pilot repository returns HTTP 200 ignored payload', async () => {
      const harness = createE2EEnvironment({
        pilotRepositories: 'review-yeti-ai/review-yeti-bot,exampleorg/example-meta',
      });

      const payload = createWebhookPayload('opened', {
        owner: 'unauthorized-org',
        repo: 'unauthorized-repo',
        prNumber: 3,
      });

      const res = await harness.dispatchWebhook(payload);
      assert.equal(res.status, 200);
      const json = (await res.json()) as any;
      assert.equal(json.status, 'ignored');
      assert.equal(json.reason, 'not_pilot_repository');
      assert.equal(harness.dispatchedWorkflows.length, 0);
    });

    it('B5: Draft PR on opened or ready_for_review suppresses dispatch', async () => {
      const harness = createE2EEnvironment({ pilotRepositories: 'all' });

      const payloadDraftOpened = createWebhookPayload('opened', { prNumber: 4, draft: true });
      const res1 = await harness.dispatchWebhook(payloadDraftOpened);
      assert.equal(res1.status, 200);
      const json1 = (await res1.json()) as any;
      assert.equal(json1.status, 'ignored');
      assert.equal(json1.reason, 'draft_pr');
      assert.equal(harness.dispatchedWorkflows.length, 0);

      const payloadDraftReady = createWebhookPayload('ready_for_review', { prNumber: 5, draft: true });
      const res2 = await harness.dispatchWebhook(payloadDraftReady);
      assert.equal(res2.status, 200);
      const json2 = (await res2.json()) as any;
      assert.equal(json2.status, 'ignored');
      assert.equal(json2.reason, 'draft_pr');
    });

    it('B6: Unhandled GitHub events return ignored status', async () => {
      const harness = createE2EEnvironment({ pilotRepositories: 'all' });

      const payload = { zen: 'Favor focus over features.' };
      const res = await harness.dispatchWebhook(payload, { 'X-GitHub-Event': 'ping' });
      assert.equal(res.status, 200);
      const json = (await res.json()) as any;
      assert.equal(json.status, 'ignored');
      assert.equal(json.event, 'ping');
    });

    it('B7: Unknown HTTP routes return HTTP 404 Not Found', async () => {
      const harness = createE2EEnvironment();
      const worker = (await import('../../src/worker.js')).default;

      const req = new Request('https://operator.example.internal/api/unknown-endpoint');
      const res = await worker.fetch(req, harness.env);
      assert.equal(res.status, 404);
      assert.equal(await res.text(), 'Not Found');
    });
  });

  describe('RepoGateDO Concurrency Gate Boundaries', () => {
    it('B8: Duplicate acquireSlot for an already active run returns granted: true', async () => {
      const harness = createE2EEnvironment();
      const repoDO = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName('owner/repo'));

      const res1 = await repoDO.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_dup_1', headSha: 'sha1' }),
      });
      assert.equal((await res1.json() as any).granted, true);

      // Re-acquiring with same runId
      const res2 = await repoDO.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_dup_1', headSha: 'sha1' }),
      });
      assert.equal((await res2.json() as any).granted, true);

      const status = await (await repoDO.fetch('http://do/status')).json() as any;
      assert.equal(status.activeCount, 1);
      assert.equal(status.queueLength, 0);
    });

    it('B9: Releasing a pending (non-active) run removes it from queue and returns released: false', async () => {
      const harness = createE2EEnvironment();
      const repoDO = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName('owner/repo'));

      // Active
      await repoDO.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_active', headSha: 'sha1' }),
      });
      // Queued
      await repoDO.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_pending_1', headSha: 'sha2' }),
      });
      await repoDO.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_pending_2', headSha: 'sha3' }),
      });

      // Release pending run
      const resRel = await repoDO.fetch('http://do/release', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_pending_1' }),
      });
      const dataRel = (await resRel.json()) as any;
      assert.equal(dataRel.released, false);

      const status = await (await repoDO.fetch('http://do/status')).json() as any;
      assert.equal(status.activeCount, 1);
      assert.equal(status.queueLength, 1);
    });

    it('B10: Releasing a non-existent run returns released: false with state untouched', async () => {
      const harness = createE2EEnvironment();
      const repoDO = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName('owner/repo'));

      const resRel = await repoDO.fetch('http://do/release', {
        method: 'POST',
        body: JSON.stringify({ runId: 'non_existent_run' }),
      });
      const dataRel = (await resRel.json()) as any;
      assert.equal(dataRel.released, false);

      const status = await (await repoDO.fetch('http://do/status')).json() as any;
      assert.equal(status.activeCount, 0);
      assert.equal(status.queueLength, 0);
    });

    it('B11: HTTP fetch to unmapped RepoGateDO URL returns HTTP 404', async () => {
      const harness = createE2EEnvironment();
      const repoDO = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName('owner/repo'));

      const res = await repoDO.fetch('http://do/unknown-path');
      assert.equal(res.status, 404);
      assert.equal(await res.text(), 'Not Found');
    });
  });

  describe('ReviewRunDO Coordinator & Fencing Boundaries', () => {
    it('B12: acquireWorkerLease on uninitialized DO returns ok: false, reason: uninitialized', async () => {
      const harness = createE2EEnvironment();
      const runDO = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName('uninit_run_1'));

      const res = await runDO.fetch('http://do/lease/acquire', {
        method: 'POST',
        body: JSON.stringify({ workerId: 'w1', epoch: 1 }),
      });
      const data = (await res.json()) as any;
      assert.equal(data.ok, false);
      assert.equal(data.reason, 'uninitialized');
    });

    it('B13: acquireWorkerLease after cancellation returns ok: false, reason: cancel_requested', async () => {
      const harness = createE2EEnvironment();
      const runDO = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName('cancelled_run_1'));

      await runDO.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({ runId: 'cancelled_run_1', headSha: 'sha', owner: 'o', repo: 'r', prNumber: 1 }),
      });
      await runDO.fetch('http://do/cancel', {
        method: 'POST',
        body: JSON.stringify({ reason: 'pr_closed' }),
      });

      const res = await runDO.fetch('http://do/lease/acquire', {
        method: 'POST',
        body: JSON.stringify({ workerId: 'w1', epoch: 2 }),
      });
      const data = (await res.json()) as any;
      assert.equal(data.ok, false);
      assert.equal(data.reason, 'cancel_requested');
    });

    it('B14: acquireWorkerLease with epoch mismatch returns fencing_epoch_mismatch', async () => {
      const harness = createE2EEnvironment();
      const runDO = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName('epoch_mismatch_run'));

      await runDO.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({ runId: 'epoch_mismatch_run', headSha: 'sha', owner: 'o', repo: 'r', prNumber: 1 }),
      });

      const res = await runDO.fetch('http://do/lease/acquire', {
        method: 'POST',
        body: JSON.stringify({ workerId: 'w1', epoch: 99 }), // current epoch is 1
      });
      const data = (await res.json()) as any;
      assert.equal(data.ok, false);
      assert.equal(data.reason, 'fencing_epoch_mismatch');
    });

    it('B15: heartbeat with wrong workerId or mismatched epoch returns ok: false', async () => {
      const harness = createE2EEnvironment();
      const runDO = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName('hb_test_run'));

      await runDO.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({ runId: 'hb_test_run', headSha: 'sha', owner: 'o', repo: 'r', prNumber: 1 }),
      });
      await runDO.fetch('http://do/lease/acquire', {
        method: 'POST',
        body: JSON.stringify({ workerId: 'legit_worker', epoch: 1 }),
      });

      // Wrong workerId
      const resWrongWorker = await runDO.fetch('http://do/lease/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ workerId: 'imposter_worker', epoch: 1 }),
      });
      assert.equal((await resWrongWorker.json() as any).ok, false);

      // Wrong epoch
      const resWrongEpoch = await runDO.fetch('http://do/lease/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ workerId: 'legit_worker', epoch: 5 }),
      });
      assert.equal((await resWrongEpoch.json() as any).ok, false);
    });

    it('B16: requestCancellation on uninitialized DO returns cancelled: false', async () => {
      const harness = createE2EEnvironment();
      const runDO = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName('uninit_cancel_run'));

      const res = await runDO.fetch('http://do/cancel', {
        method: 'POST',
        body: JSON.stringify({ reason: 'abort' }),
      });
      const data = (await res.json()) as any;
      assert.equal(data.cancelled, false);
      assert.equal(data.previousPhase, 'Uninitialized');
    });

    it('B17: submitReceipt on cancelled run rejects with run_cancelled', async () => {
      const harness = createE2EEnvironment();
      const runDO = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName('receipt_cancel_run'));

      await runDO.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({ runId: 'receipt_cancel_run', headSha: 'sha', owner: 'o', repo: 'r', prNumber: 1 }),
      });
      await runDO.fetch('http://do/cancel', {
        method: 'POST',
        body: JSON.stringify({ reason: 'superseded' }),
      });

      const res = await runDO.fetch('http://do/receipt', {
        method: 'POST',
        body: JSON.stringify({ status: 'succeeded', runId: 'receipt_cancel_run' }),
      });
      const data = (await res.json()) as any;
      assert.equal(data.accepted, false);
      assert.equal(data.reason, 'run_cancelled');
    });

    it('B18: submitReceipt on uninitialized run returns accepted: false, reason: uninitialized', async () => {
      const harness = createE2EEnvironment();
      const runDO = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName('receipt_uninit_run'));

      const res = await runDO.fetch('http://do/receipt', {
        method: 'POST',
        body: JSON.stringify({ status: 'succeeded' }),
      });
      const data = (await res.json()) as any;
      assert.equal(data.accepted, false);
      assert.equal(data.reason, 'uninitialized');
    });

    it('B19: getStatus on uninitialized DO returns Unknown phase and isCurrentHead: false', async () => {
      const harness = createE2EEnvironment();
      const runDO = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName('uninit_status_run'));

      const res = await runDO.fetch('http://do/status');
      const data = (await res.json()) as any;
      assert.equal(data.isCurrentHead, false);
      assert.equal(data.phase, 'Unknown');
      assert.equal(data.cancelRequested, true);
      assert.equal(data.fencingEpoch, 0);
    });
  });

  describe('Tooling YAML & Tunnel Resolution Boundaries', () => {
    it('B20: Empty YAML string throws expected root object error', () => {
      assert.throws(
        () => parseToolingConfigYaml('', {}),
        /Invalid tooling YAML: expected root object/
      );
    });

    it('B21: YAML missing or non-array tools throws missing tools error', () => {
      assert.throws(
        () => parseToolingConfigYaml('version: 1\ntools: "not-an-array"', {}),
        /Invalid tooling YAML: missing or invalid 'tools' array/
      );
      assert.throws(
        () => parseToolingConfigYaml('version: 1', {}),
        /Invalid tooling YAML: missing or invalid 'tools' array/
      );
    });

    it('B22: Undefined environment variables resolve to empty string without error', () => {
      const yaml = `
tools:
  - name: test-tool
    type: http
    url: https://api.com/\${UNDEFINED_VAR_KEY}
`;
      const config = parseToolingConfigYaml(yaml, {});
      assert.equal(config.tools[0].url, 'https://api.com/');
    });

    it('B23: isInternalEndpoint with invalid URLs returns false without throwing', () => {
      assert.equal(isInternalEndpoint(''), false);
      assert.equal(isInternalEndpoint('not-a-valid-url'), false);
      assert.equal(isInternalEndpoint('http://'), false);
    });

    it('B24: Border IP resolution correctly evaluates 172.16 vs 172.32 CIDRs', () => {
      assert.equal(isInternalEndpoint('http://172.16.0.1:8080'), true);
      assert.equal(isInternalEndpoint('http://172.32.0.1:8080'), false);
    });

    it('B25: Explicit mode: none overrides internal detection', () => {
      const res = resolveEndpointTunnel(
        'local-mock',
        'http://127.0.0.1:8000',
        { mode: 'none' },
        'none'
      );
      assert.equal(res.tunnelType, 'none');
      assert.equal(res.requiresDaemon, false);
    });
  });
});
