import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const prContext = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: '42', baseSha, headSha };
const commandRunner = () => ({ status: 0, stdout: JSON.stringify({ baseRefOid: baseSha, headRefOid: headSha }) });

describe('trusted review telemetry policy', () => {
  it('is disabled by default and emits a secret-free receipt', () => {
    const policy = pipeline.resolveTrustedReviewTelemetryPolicy({ localConfig: { parsed: {} }, prContext, env: {}, commandRunner });

    expect(policy).toMatchObject({ status: 'disabled_not_configured', enabled: false });
    expect(JSON.stringify(pipeline.reviewTelemetryReceipt(policy))).not.toContain('credential');
  });

  it('enables OTel only from the Action trusted temp config plus fresh immutable base proof', () => {
    const policy = pipeline.resolveTrustedReviewTelemetryPolicy({
      localConfig: { parsed: { telemetry: { otel: { enabled: true, endpoint_env: 'OTEL_EXPORTER_OTLP_ENDPOINT', credential_env: 'OTEL_EXPORTER_OTLP_HEADERS' } } } },
      prContext,
      env: {
        REVIEW_YETI_CONFIG_DIR: '/tmp/review-yeti-config',
        REVIEW_YETI_TRUSTED_CONFIG_DIR: '/tmp/review-yeti-config',
        REVIEW_YETI_TRUSTED_CONFIG_BASE_SHA: baseSha,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.test/v1/traces',
        OTEL_EXPORTER_OTLP_HEADERS: 'do-not-persist',
      },
      commandRunner,
    });

    expect(policy).toMatchObject({ status: 'trusted', enabled: true, trustedBaseRef: baseSha });
    expect(policy.exporter).toMatchObject({ endpoint: 'https://otel.example.test/v1/traces', credential: 'do-not-persist' });
    const receipt = pipeline.reviewTelemetryReceipt(policy);
    expect(receipt).toMatchObject({ status: 'trusted', enabled: true, exporter: 'configured' });
    expect(JSON.stringify(receipt)).not.toContain('do-not-persist');
    expect(JSON.stringify(receipt)).not.toContain('otel.example.test');
  });

  it('refuses untrusted config, PR-controlled endpoints, and endpoint URLs with query credentials', () => {
    const config = { parsed: { telemetry: { otel: { enabled: true, endpoint: 'https://attacker.example.test', endpoint_env: 'OTEL_ENDPOINT' } } } };
    const baseEnv = { REVIEW_YETI_CONFIG_DIR: '/tmp/untrusted', REVIEW_YETI_TRUSTED_CONFIG_DIR: '/tmp/trusted', REVIEW_YETI_TRUSTED_CONFIG_BASE_SHA: baseSha, OTEL_ENDPOINT: 'https://otel.example.test/v1/traces' };
    expect(pipeline.resolveTrustedReviewTelemetryPolicy({ localConfig: config, prContext, env: baseEnv, commandRunner }))
      .toMatchObject({ enabled: false, status: 'disabled_untrusted_config' });
    expect(pipeline.resolveTrustedReviewTelemetryPolicy({ localConfig: config, prContext, env: { ...baseEnv, REVIEW_YETI_CONFIG_DIR: '/tmp/trusted', OTEL_ENDPOINT: 'https://otel.example.test/v1/traces?token=secret' }, commandRunner }))
      .toMatchObject({ enabled: false, status: 'disabled_invalid_endpoint' });
  });

  it('adds a redacted telemetry status receipt to Action outputs without changing existing fields', () => {
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-telemetry-output-')), 'github-output.txt');
    pipeline.writeStepOutputs({ verdict: 'SHIP', metrics: {}, coverageStatus: 'complete', gateDecision: 'PASS', mergeEligible: true }, output, null, null, {
      telemetryStatus: 'unavailable',
      telemetryEvents: 3,
    });

    const content = fs.readFileSync(output, 'utf-8');
    expect(content).toContain('verdict=SHIP');
    expect(content).toContain('telemetry-status=unavailable');
    expect(content).toContain('telemetry-events=3');
    expect(content).not.toContain('eventId');
    expect(content).not.toContain('https://');
  });

  it('wires the pipeline cancellation seam into telemetry flush without blocking teardown', async () => {
    const controller = new AbortController();
    const cancellation = pipeline.createPipelineCancellation({ signal: controller.signal, installProcessHandlers: false });
    const flush = vi.fn(async ({ signal }) => ({ status: signal.aborted ? 'cancelled' : 'exported', pending: 0, events: 2 }));
    controller.abort();

    await expect(pipeline.flushReviewTelemetry({ flush }, cancellation)).resolves.toMatchObject({ status: 'cancelled', events: 2 });
    expect(flush).toHaveBeenCalledWith({ signal: cancellation.signal });
  });

  it('registers one cancellation receipt handler without invoking it until cancellation', async () => {
    const controller = new AbortController();
    const cancellation = pipeline.createPipelineCancellation({ signal: controller.signal, installProcessHandlers: false });
    const receipt = vi.fn();
    cancellation.setOnCancel(receipt);

    expect(receipt).toHaveBeenCalledTimes(0);

    controller.abort();
    cancellation.cancel();

    expect(receipt).toHaveBeenCalledTimes(1);
    expect(cancellation.signal.aborted).toBe(true);
    cancellation.dispose();
  });

  it('invokes a callback once when its caller signal was already aborted before registration', () => {
    const controller = new AbortController();
    controller.abort();
    const cancellation = pipeline.createPipelineCancellation({ signal: controller.signal, installProcessHandlers: false });
    const receipt = vi.fn();

    cancellation.setOnCancel(receipt);
    expect(receipt).toHaveBeenCalledTimes(1);
    cancellation.cancel();

    expect(receipt).toHaveBeenCalledTimes(1);
    cancellation.dispose();
  });

  it('declares the additive redacted telemetry outputs in the Action manifest', () => {
    const action = fs.readFileSync(path.join(root, 'action.yml'), 'utf-8');
    expect(action).toContain('telemetry-status:');
    expect(action).toContain('steps.review.outputs.telemetry-status');
    expect(action).toContain('telemetry-events:');
    expect(action).toContain('steps.review.outputs.telemetry-events');
  });
});
