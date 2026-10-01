import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createE2EEnvironment,
  createWebhookPayload,
  createSampleReceipt,
  signWebhookPayload,
} from './e2eHarness.js';
import { parseToolingConfigYaml } from '../../src/tunnel/toolTunnelDefinition.js';
import { isInternalEndpoint, resolveEndpointTunnel } from '../../src/tunnel/tunnelConfig.js';
import { DigitalOceanAgentRunner } from '../../src/runners/digitalOceanAgentRunner.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { compareRuns, runCli } from '../../src/compareOrchestratorRuns.js';

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
      const req = new Request('https://operator.calltelemetry.internal/api/webhooks/github', {
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
        pilotRepositories: 'review-yeti-ai/review-yeti-bot,calltelemetry/ct-meta',
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

      const req = new Request('https://operator.calltelemetry.internal/api/unknown-endpoint');
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

  describe('DigitalOcean Runner & Parity Comparison Boundaries', () => {
    it('B26: DO Agent Runner handles non-200 API response gracefully', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('Quota exceeded', { status: 429 });
      };

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'token',
        fetchImpl: mockFetch,
      });

      const res = await runner.dispatchJob({
        jobId: 'job_b26',
        runId: 'run_b26',
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        headSha: 'h',
        baseSha: 'b',
        workerImage: 'img',
        env: {},
      });

      assert.equal(res.status, 'failed');
      assert.equal(res.exitCode, 1);
      assert.ok(res.error?.includes('429'));
    });

    it('B27: DO Agent Runner treats HTTP 404 on session delete as successful termination', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('Session not found', { status: 404 });
      };

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'token',
        fetchImpl: mockFetch,
      });

      const outcome = await runner.terminateJob('job_finished_already');
      assert.equal(outcome.terminated, true);
    });

    it('B28: compareRuns with doks.durationMs = 0 sets latencyRatio: 1.0 without NaN', () => {
      const doks = createSampleReceipt('doks', { durationMs: 0 });
      const cf = createSampleReceipt('cloudflare', { durationMs: 5000 });

      const res = compareRuns(doks, cf);
      assert.equal(res.latencyRatio, 1.0);
      assert.equal(Number.isNaN(res.latencyRatio), false);
    });

    it('B29: compareRuns flags token delta > 500 with warning note', () => {
      const doks = createSampleReceipt('doks', {
        tokensUsed: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      });
      const cf = createSampleReceipt('cloudflare', {
        tokensUsed: { promptTokens: 1500, completionTokens: 700, totalTokens: 2200 },
      });

      const res = compareRuns(doks, cf);
      assert.equal(res.tokenDelta, 700);
      assert.ok(res.notes.some((n) => n.includes('Noticeable token difference')));
    });

    it('B30: Finding fingerprints with identical counts but divergent values flags mismatch', () => {
      const doks = createSampleReceipt('doks', {
        findingFingerprints: ['fp_alpha', 'fp_beta'],
      });
      const cf = createSampleReceipt('cloudflare', {
        findingFingerprints: ['fp_alpha', 'fp_gamma'],
      });

      const res = compareRuns(doks, cf);
      assert.equal(res.findingFingerprintsMatch, false);
      assert.equal(res.match, false);
      assert.ok(res.notes.some((n) => n.includes('Finding fingerprint divergence')));
    });

    it('B31: CLI error handling on missing args, missing file, invalid JSON, invalid schema (exit code 2)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b31-cli-'));
      try {
        const validDoks = createSampleReceipt('doks');
        const validCf = createSampleReceipt('cloudflare');
        const doksPath = path.join(tmpDir, 'doks.json');
        const cfPath = path.join(tmpDir, 'cf.json');
        const invalidJsonPath = path.join(tmpDir, 'invalid.json');
        const invalidSchemaPath = path.join(tmpDir, 'invalid-schema.json');
        const divergentRepoPath = path.join(tmpDir, 'divergent-repo.json');

        fs.writeFileSync(doksPath, JSON.stringify(validDoks, null, 2));
        fs.writeFileSync(cfPath, JSON.stringify(validCf, null, 2));
        fs.writeFileSync(invalidJsonPath, '{"broken": [');
        fs.writeFileSync(invalidSchemaPath, JSON.stringify({ orchestrator: 'invalid_orchestrator' }));
        fs.writeFileSync(divergentRepoPath, JSON.stringify({ ...validCf, repo: 'other-repo' }, null, 2));

        // 1. Missing args (in-process)
        assert.equal(runCli([]), 2);
        assert.equal(runCli(['--doks', doksPath]), 2);
        assert.equal(runCli(['--cf', cfPath]), 2);

        // 2. Missing file (in-process)
        assert.equal(runCli(['--doks', path.join(tmpDir, 'missing.json'), '--cf', cfPath]), 2);

        // 3. Invalid JSON (in-process)
        assert.equal(runCli(['--doks', invalidJsonPath, '--cf', cfPath]), 2);

        // 4. Invalid schema (in-process)
        assert.equal(runCli(['--doks', invalidSchemaPath, '--cf', cfPath]), 2);

        // 5. Cross-receipt target mismatch (in-process)
        assert.equal(runCli(['--doks', doksPath, '--cf', divergentRepoPath]), 2);

        // 6. Direct CLI script invocation via spawnSync to verify process exit code
        const scriptPath = fs.existsSync(path.resolve(process.cwd(), 'scripts/ci/compare-orchestrator-runs.ts'))
          ? path.resolve(process.cwd(), 'scripts/ci/compare-orchestrator-runs.ts')
          : path.resolve(process.cwd(), '../../scripts/ci/compare-orchestrator-runs.ts');
        const procMissing = spawnSync(process.execPath, [scriptPath]);
        assert.equal(procMissing.status, 2);

        const procInvalid = spawnSync(process.execPath, [scriptPath, '--doks', invalidJsonPath, '--cf', cfPath]);
        assert.equal(procInvalid.status, 2);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('B32: CLI exit code on mismatch (exit code 1 with --fail-on-mismatch, exit code 0 without)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b32-cli-'));
      try {
        const doksReceipt = createSampleReceipt('doks', {
          verdict: 'success',
          findingFingerprints: ['fp_1', 'fp_2'],
        });
        const cfMismatchVerdict = createSampleReceipt('cloudflare', {
          verdict: 'action_required',
          findingFingerprints: ['fp_1', 'fp_2'],
        });
        const cfMismatchFindings = createSampleReceipt('cloudflare', {
          verdict: 'success',
          findingFingerprints: ['fp_1', 'fp_different'],
        });
        const cfMatch = createSampleReceipt('cloudflare', {
          verdict: 'success',
          findingFingerprints: ['fp_1', 'fp_2'],
        });

        const doksPath = path.join(tmpDir, 'doks.json');
        const cfMismatchVerdictPath = path.join(tmpDir, 'cf-verdict-mismatch.json');
        const cfMismatchFindingsPath = path.join(tmpDir, 'cf-findings-mismatch.json');
        const cfMatchPath = path.join(tmpDir, 'cf-match.json');

        fs.writeFileSync(doksPath, JSON.stringify(doksReceipt, null, 2));
        fs.writeFileSync(cfMismatchVerdictPath, JSON.stringify(cfMismatchVerdict, null, 2));
        fs.writeFileSync(cfMismatchFindingsPath, JSON.stringify(cfMismatchFindings, null, 2));
        fs.writeFileSync(cfMatchPath, JSON.stringify(cfMatch, null, 2));

        // Mismatch without --fail-on-mismatch returns 0 (monitoring/shadow mode)
        assert.equal(runCli(['--doks', doksPath, '--cf', cfMismatchVerdictPath]), 0);
        assert.equal(runCli(['--doks', doksPath, '--cf', cfMismatchFindingsPath]), 0);

        // Mismatch with --fail-on-mismatch returns 1 (strict CI gate)
        assert.equal(runCli(['--doks', doksPath, '--cf', cfMismatchVerdictPath, '--fail-on-mismatch']), 1);
        assert.equal(runCli(['--doks', doksPath, '--cf', cfMismatchFindingsPath, '--fail-on-mismatch']), 1);

        // Match with --fail-on-mismatch returns 0
        assert.equal(runCli(['--doks', doksPath, '--cf', cfMatchPath, '--fail-on-mismatch']), 0);

        // Direct CLI process execution via spawnSync
        const scriptPath = fs.existsSync(path.resolve(process.cwd(), 'scripts/ci/compare-orchestrator-runs.ts'))
          ? path.resolve(process.cwd(), 'scripts/ci/compare-orchestrator-runs.ts')
          : path.resolve(process.cwd(), '../../scripts/ci/compare-orchestrator-runs.ts');
        const procAdvisory = spawnSync(process.execPath, [
          scriptPath,
          '--doks',
          doksPath,
          '--cf',
          cfMismatchVerdictPath,
        ]);
        assert.equal(procAdvisory.status, 0);

        const procStrict = spawnSync(process.execPath, [
          scriptPath,
          '--doks',
          doksPath,
          '--cf',
          cfMismatchVerdictPath,
          '--fail-on-mismatch',
        ]);
        assert.equal(procStrict.status, 1);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('B33: CLI markdown summary, output file creation, spaces in path, and $GITHUB_STEP_SUMMARY appending', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b33-cli-'));
      try {
        const doksReceipt = createSampleReceipt('doks', {
          findingFingerprints: ['fp_test_1', 'fp_test_2'],
        });
        const cfReceipt = createSampleReceipt('cloudflare', {
          findingFingerprints: ['fp_test_1', 'fp_test_2'],
        });

        const doksPath = path.join(tmpDir, 'doks.json');
        const cfPath = path.join(tmpDir, 'cf.json');
        fs.writeFileSync(doksPath, JSON.stringify(doksReceipt, null, 2));
        fs.writeFileSync(cfPath, JSON.stringify(cfReceipt, null, 2));

        // Nested directory path with spaces
        const outPathWithSpaces = path.join(tmpDir, 'sub directory with spaces', 'ledger report.md');
        const stepSummaryWithSpaces = path.join(tmpDir, 'ci logs with spaces', 'step_summary.md');
        fs.mkdirSync(path.dirname(stepSummaryWithSpaces), { recursive: true });
        fs.writeFileSync(stepSummaryWithSpaces, '# Existing CI Summary\n');

        // Run in-process with --output and --github-step-summary
        const exitCode = runCli(
          ['--doks', doksPath, '--cf', cfPath, '--output', outPathWithSpaces, '--github-step-summary'],
          { GITHUB_STEP_SUMMARY: stepSummaryWithSpaces }
        );
        assert.equal(exitCode, 0);

        // Verify output file creation and contents
        assert.ok(fs.existsSync(outPathWithSpaces));
        const outContent = fs.readFileSync(outPathWithSpaces, 'utf8');
        assert.ok(outContent.includes('# ⚖️ Review Yeti Orchestrator Parity Ledger'));
        assert.ok(outContent.includes('### Status: ✅ MATCH'));
        assert.ok(outContent.includes('100% Finding Parity'));
        assert.ok(outContent.includes('| **Wall Latency** |'));

        // Verify GITHUB_STEP_SUMMARY was appended rather than overwritten
        assert.ok(fs.existsSync(stepSummaryWithSpaces));
        const summaryContent = fs.readFileSync(stepSummaryWithSpaces, 'utf8');
        assert.ok(summaryContent.includes('# Existing CI Summary'));
        assert.ok(summaryContent.includes('# ⚖️ Review Yeti Orchestrator Parity Ledger'));
        assert.ok(summaryContent.includes('### Status: ✅ MATCH'));

        // Direct CLI process execution with spaces in path
        const scriptPath = fs.existsSync(path.resolve(process.cwd(), 'scripts/ci/compare-orchestrator-runs.ts'))
          ? path.resolve(process.cwd(), 'scripts/ci/compare-orchestrator-runs.ts')
          : path.resolve(process.cwd(), '../../scripts/ci/compare-orchestrator-runs.ts');
        const procOutSpaces = path.join(tmpDir, 'proc out with spaces', 'report.md');
        const proc = spawnSync(
          process.execPath,
          [scriptPath, '--doks', doksPath, '--cf', cfPath, '--output', procOutSpaces, '--summary'],
          { encoding: 'utf8' }
        );
        assert.equal(proc.status, 0);
        assert.ok(fs.existsSync(procOutSpaces));
        assert.ok(proc.stdout.includes('ORCHESTRATOR PARITY REPORT'));
        assert.ok(proc.stdout.includes('Status: ✅ MATCH'));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
