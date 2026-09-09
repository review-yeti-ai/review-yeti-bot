import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { buildReviewJobProjection } from '../../src/k8s/reviewJobProjection';
import { MAX_TERMINAL_DEADLINE_MS, MIN_TERMINAL_DEADLINE_MS, TERMINAL_DEADLINE_MS } from '../../src/config/terminalDeadline';

const receivedAt = Date.parse('2026-08-30T20:00:00.000Z');
const projection = buildReviewJobProjection({
  runId: `run_${'1'.repeat(32)}`,
  deliveryId: 'actions:98765:2:123:42:head',
  repositoryId: 123,
  repo: 'calltelemetry/cisco-cdr',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  receivedAt,
  terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
  policyDigest: 'c'.repeat(64),
  configDigest: 'd'.repeat(64),
  publicationMode: 'disabled',
  workerImage: `registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:${'e'.repeat(64)}`,
  namespace: 'ct-review-system',
}, receivedAt + 60_000);

function crdSchema(): Record<string, any> {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../../k8s-operator/config/crd/bases/review-yeti.ai_prreviewjobs.yaml',
  ), 'utf8');
  const crd = yaml.load(source) as Record<string, any>;
  expect(crd.metadata.name).toBe('prreviewjobs.review-yeti.ai');
  expect(crd.spec.group).toBe('review-yeti.ai');
  const version = crd.spec.versions.find((candidate: Record<string, any>) => candidate.name === 'v1alpha2');
  expect(version).toEqual(expect.objectContaining({ served: true, storage: true }));
  return version.schema.openAPIV3Schema;
}

describe('TypeScript projection and v1alpha2 CRD contract', () => {
  it('keeps the exact non-secret projection field set aligned', () => {
    const spec = crdSchema().properties.spec;
    expect(projection.apiVersion).toBe('review-yeti.ai/v1alpha2');
    expect(Object.keys(projection.spec).sort()).toEqual([...spec.required, 'runnerMode'].sort());
    expect(Object.keys(spec.properties).sort()).toEqual([
      ...spec.required,
      'executionAttempt',
      'preparedReview',
      'qualificationModel',
      'qualificationProfile',
      'runnerMode',
    ].sort());
    expect(projection.spec).not.toHaveProperty('qualificationModel');
    expect(projection.spec).not.toHaveProperty('qualificationProfile');
    expect(JSON.stringify(projection.spec)).not.toMatch(/privateKey|providerApiKey|installationToken|callbackToken/u);
  });

  it('keeps preparedReview optional, bounded, immutable, and restricted to prebaked app-gate', () => {
    const spec = crdSchema().properties.spec;
    expect(spec.required).not.toContain('preparedReview');
    expect(spec.properties.preparedReview).toEqual(expect.objectContaining({
      type: 'string', minLength: 1, maxLength: 256 * 1024,
    }));
    expect(spec.properties.preparedReview).not.toHaveProperty('default');
    const rules = spec['x-kubernetes-validations'].map((validation: { rule: string }) => validation.rule);
    expect(rules).toContain('self == oldSelf');
    expect(rules).toContain("!has(self.preparedReview) || (self.publicationMode == 'app-gate' && (!has(self.runnerMode) || self.runnerMode == 'prebaked'))");
    expect(projection.spec).not.toHaveProperty('preparedReview');
  });

  it('accepts the projected identities under every declared string pattern', () => {
    const properties = crdSchema().properties.spec.properties;
    for (const [field, schema] of Object.entries(properties) as Array<[keyof typeof projection.spec, any]>) {
      if (schema.pattern) expect(String(projection.spec[field])).toMatch(new RegExp(schema.pattern, 'u'));
    }
    expect(properties.publicationMode.enum).toEqual(['disabled', 'app-gate']);
    expect(properties.runnerMode.enum).toEqual(['prebaked', 'generic']);
    expect(Date.parse(projection.spec.terminalDeadline) - Date.parse(projection.spec.receivedAt)).toBe(TERMINAL_DEADLINE_MS);
  });

  // REL-733 follow-up: MIN/MAX here and the CRD's CEL rule are a manually
  // maintained lockstep invariant (see terminalDeadline.ts's header comment).
  // The Go side pins this via crd_contract_test.go and job_test.go; this is
  // the TS-side pin, so a drift between the two -- e.g. widening
  // MAX_TERMINAL_DEADLINE_MS without updating the CRD -- fails here instead
  // of admitting a run whose window the CRD's CEL rule (or the Go operator's
  // validateInput) rejects at apply/projection time.
  it('pins the terminalDeadline CEL rule bounds to MIN_TERMINAL_DEADLINE_MS/MAX_TERMINAL_DEADLINE_MS', () => {
    const spec = crdSchema().properties.spec;
    const validations = spec['x-kubernetes-validations'] as Array<{ rule: string; message: string }>;
    const deadlineRule = validations.find(
      (validation) => validation.rule.includes('terminalDeadline') && validation.rule.includes('duration('),
    );
    expect(deadlineRule).toBeDefined();
    const boundsInSeconds = [...deadlineRule!.rule.matchAll(/duration\('(\d+)s'\)/gu)].map((match) => Number(match[1]));
    expect(boundsInSeconds).toEqual([MIN_TERMINAL_DEADLINE_MS / 1_000, MAX_TERMINAL_DEADLINE_MS / 1_000]);
  });

  it('validates public ghcr.io worker image under the CRD pattern', () => {
    const properties = crdSchema().properties.spec.properties;
    const ghcrWorkerImage = `ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${'f'.repeat(64)}`;
    expect(ghcrWorkerImage).toMatch(new RegExp(properties.workerImage.pattern, 'u'));
  });

  it('validates generic node runner images under the CRD pattern', () => {
    const properties = crdSchema().properties.spec.properties;
    const nodeImage = 'node:24-bookworm-slim';
    expect(nodeImage).toMatch(new RegExp(properties.workerImage.pattern, 'u'));
  });

  it('accepts the fresh Secret identity used by a retry execution', () => {
    const properties = crdSchema().properties.spec.properties;
    const retry = buildReviewJobProjection({
      runId: projection.spec.runId,
      deliveryId: projection.spec.deliveryId,
      repositoryId: projection.spec.repositoryId,
      repo: projection.spec.repo,
      prNumber: projection.spec.prNumber,
      headSha: projection.spec.headSha,
      baseSha: projection.spec.baseSha,
      receivedAt: Date.parse(projection.spec.receivedAt),
      terminalDeadline: Date.parse(projection.spec.terminalDeadline),
      policyDigest: projection.spec.policyDigest,
      configDigest: projection.spec.configDigest,
      publicationMode: projection.spec.publicationMode,
      workerImage: projection.spec.workerImage,
      namespace: projection.metadata.namespace,
      executionAttempt: 2,
    }, Date.parse(projection.spec.receivedAt) + 60_000);
    expect(retry.spec.runSecretName).toMatch(new RegExp(properties.runSecretName.pattern, 'u'));
    expect(retry.metadata.name).toBe(`ct-review-${'1'.repeat(32)}-a2`);
  });
});
