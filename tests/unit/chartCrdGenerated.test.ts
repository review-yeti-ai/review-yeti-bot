import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * REL-1097: the chart's PRReviewJob CRD was a hand-maintained copy that fell
 * behind the controller-gen output (no spec.cancelRequested, no Cancelled
 * phase, a spec rule that refused every cancel patch). The chart now installs
 * a byte-identical copy of the generated CRD and adds only its labels, so the
 * two cannot drift again without this file failing.
 */
const root = path.resolve(__dirname, '../..');
const generatedPath = path.join(root, 'k8s-operator/config/crd/bases/review-yeti.ai_prreviewjobs.yaml');
const chartCopyPath = path.join(root, 'charts/review-yeti/files/review-yeti.ai_prreviewjobs.yaml');
const templatePath = path.join(root, 'charts/review-yeti/templates/crd.yaml');

type Doc = Record<string, any>;

function helmAvailable(): boolean {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function render(values: Record<string, unknown> = {}): Doc[] {
  const out = execFileSync('helm', [
    'template', 'crd-contract', path.join(root, 'charts/review-yeti'),
    '--namespace', 'ct-review-system', '--values', '-',
  ], { input: yaml.dump(values), encoding: 'utf8', timeout: 30_000 });
  return (yaml.loadAll(out) as Doc[]).filter(Boolean);
}

describe('chart PRReviewJob CRD is the controller-gen output', () => {
  it('ships a byte-identical copy of the generated CRD', () => {
    expect(readFileSync(chartCopyPath, 'utf8')).toBe(readFileSync(generatedPath, 'utf8'));
  });

  it('does not inline a schema in the template', () => {
    // A hand copy pasted back into the template would bypass the byte check.
    const template = readFileSync(templatePath, 'utf8');
    expect(template).toContain('.Files.Get "files/review-yeti.ai_prreviewjobs.yaml"');
    expect(template).not.toMatch(/openAPIV3Schema|CustomResourceDefinition|cancelRequested/u);
  });
});

describe.skipIf(!helmAvailable())('rendered chart CRD', () => {
  const generated = yaml.load(readFileSync(generatedPath, 'utf8')) as Doc;

  it('renders the generated CRD plus only the chart labels', () => {
    const crds = render().filter((doc) => doc.kind === 'CustomResourceDefinition');
    expect(crds).toHaveLength(1);
    const { labels, ...metadata } = crds[0].metadata;
    expect(labels).toMatchObject({ 'app.kubernetes.io/name': 'review-yeti', 'app.kubernetes.io/managed-by': 'Helm' });
    expect({ ...crds[0], metadata }).toEqual(generated);
  });

  it('carries the cancel contract the dispatcher patches against', () => {
    const [crd] = render().filter((doc) => doc.kind === 'CustomResourceDefinition');
    const version = crd.spec.versions.find((v: Doc) => v.name === 'v1alpha2');
    const schema = version.schema.openAPIV3Schema.properties;
    expect(schema.spec.properties.cancelRequested).toMatchObject({ type: 'boolean' });
    expect(schema.status.properties.phase.enum).toContain('Cancelled');
  });

  it('renders no CRD when crd.install is false', () => {
    expect(render({ crd: { install: false } }).some((doc) => doc.kind === 'CustomResourceDefinition')).toBe(false);
  });
});
