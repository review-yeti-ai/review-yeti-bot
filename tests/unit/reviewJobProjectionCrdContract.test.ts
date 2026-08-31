import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { buildReviewJobProjection } from '../../src/k8s/reviewJobProjection';

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
  terminalDeadline: receivedAt + 900_000,
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
    expect(Object.keys(projection.spec).sort()).toEqual([...spec.required].sort());
    expect(Object.keys(spec.properties).sort()).toEqual([...spec.required].sort());
    expect(JSON.stringify(projection.spec)).not.toMatch(/privateKey|providerApiKey|installationToken|callbackToken/u);
  });

  it('accepts the projected identities under every declared string pattern', () => {
    const properties = crdSchema().properties.spec.properties;
    for (const [field, schema] of Object.entries(properties) as Array<[keyof typeof projection.spec, any]>) {
      if (schema.pattern) expect(String(projection.spec[field])).toMatch(new RegExp(schema.pattern, 'u'));
    }
    expect(properties.publicationMode.enum).toEqual(['disabled']);
    expect(Date.parse(projection.spec.terminalDeadline) - Date.parse(projection.spec.receivedAt)).toBe(900_000);
  });
});
