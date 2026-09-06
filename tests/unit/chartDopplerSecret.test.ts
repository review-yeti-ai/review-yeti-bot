import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const chartDir = path.resolve(__dirname, '../../charts/review-yeti');

function render(...setArgs: string[]): string {
  return execFileSync('helm', ['template', 'rv', chartDir, ...setArgs], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Parse the rendered manifests so assertions can target real fields, not substrings. */
function renderDocs(...setArgs: string[]): Array<Record<string, any>> {
  return (yaml.loadAll(render(...setArgs)) as Array<Record<string, any>>).filter(Boolean);
}

function jobDispatcherDeployment(...setArgs: string[]): Record<string, any> {
  const found = renderDocs(...setArgs).find((doc) => doc.kind === 'Deployment'
    && doc.metadata?.name === 'ct-review-job-dispatcher');
  if (!found) throw new Error('job dispatcher Deployment not rendered');
  return found;
}

function helmAvailable(): boolean {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The chart is the only supported way to change this cluster's manifests, so the
// projection has to be asserted where it is declared rather than against a live
// namespace.
describe.skipIf(!helmAvailable() || !existsSync(chartDir))('review-yeti chart Doppler projection', () => {
  it('renders no DopplerSecret by default', () => {
    // Enabling it requires the Doppler operator plus an out-of-band service-token
    // Secret; a chart that projected credentials by default would fail to install
    // on any cluster without them.
    expect(render()).not.toContain('kind: DopplerSecret');
  });

  it('projects the gateway credential through the operator when enabled', () => {
    const rendered = render('--set', 'doppler.enabled=true');
    expect(rendered).toContain('kind: DopplerSecret');
    expect(rendered).toContain('project: "ct-llm-gateway"');
    expect(rendered).toContain('config: "prd"');
    // The operator must keep re-reading Doppler: the gateway credential is a
    // Bifrost virtual key that can be revoked upstream, and a one-shot copy goes
    // stale silently (the cluster copy was already found revoked once while the
    // GitHub copy still worked, so nothing observed the rot).
    expect(rendered).toMatch(/resyncSeconds:\s*\d+/u);
  });

  it('never renders a Doppler token into a manifest', () => {
    // The token is referenced by Secret name only. Rendering one into the chart
    // would put a long-lived credential into Helm release history and any values
    // file that sets it.
    const rendered = render('--set', 'doppler.enabled=true');
    expect(rendered).toContain('name: doppler-token-secret');
    expect(rendered).not.toMatch(/serviceToken\s*:/u);
    expect(rendered).not.toMatch(/dp\.st\./u);
  });
});

describe('review-yeti chart publishing transport', () => {
  it('renders no transport by default so the operator refuses app-gate', () => {
    // An unset transport leaves the operator's publishing config incomplete and
    // BuildWorkerJob refuses every app-gate review. Defaulting a gateway URL here
    // would dispatch reviews against a gateway nobody chose.
    const rendered = render();
    expect(rendered).not.toContain('REVIEW_YETI_GATEWAY_BASE_URL');
    expect(rendered).not.toContain('REVIEW_YETI_REVIEW_MODEL');
  });

  it('passes the transport to the operator when configured', () => {
    const rendered = render(
      '--set', 'publishing.gatewayBaseUrl=https://llm-gateway.calltelemetry.com/v1',
      '--set', 'publishing.model=ollama/glm-5.3-flash',
    );
    expect(rendered).toContain('REVIEW_YETI_GATEWAY_BASE_URL');
    expect(rendered).toContain('https://llm-gateway.calltelemetry.com/v1');
    expect(rendered).toContain('ollama/glm-5.3-flash');
  });

  it('always points the operator at the Doppler-projected secret', () => {
    // The Secret name is a location, not a transport choice, so it may default --
    // and it must line up with the DopplerSecret this chart projects.
    const rendered = render();
    expect(rendered).toContain('review-yeti-gateway-credentials');
    expect(rendered).toContain('REVIEW_YETI_BIFROST_API_KEY');
  });
});

describe('review-yeti chart run-secret RBAC', () => {
  it('grants the dispatcher nothing over secrets by default', () => {
    // The grant is only needed by a publishing install; a non-publishing one should
    // not be able to touch Secrets at all.
    expect(render()).not.toContain('resources: ["secrets"]');
  });

  it('grants only create and delete, never get or list', () => {
    // The dispatcher writes run credentials. It must not be able to read any other
    // Secret in the namespace -- including the App private key it holds by env, and
    // the Doppler-projected gateway credential.
    const rendered = render('--set', 'publishing.runSecrets.enabled=true');
    const rule = rendered.slice(rendered.indexOf('resources: ["secrets"]'));
    const verbs = rule.slice(rule.indexOf('verbs:'), rule.indexOf('\n---'));
    expect(verbs).toContain('create');
    expect(verbs).toContain('delete');
    expect(verbs).not.toContain('get');
    expect(verbs).not.toContain('list');
    expect(verbs).not.toContain('watch');
  });

  it('binds the job dispatcher, not the action-dispatch API', () => {
    // The provisioner runs in `node dist/reviewJobDispatcherIndex.js` under
    // ct-review-job-dispatcher. The chart's `.Values.dispatcher` is a different
    // component -- the action-dispatch API (`dist/dispatchIndex.js`,
    // ct-review-action-dispatch) -- which never provisions run secrets. Binding it
    // would grant Secret writes to a component that does not need them while
    // leaving the one that does unable to work.
    const rendered = render('--set', 'publishing.runSecrets.enabled=true');
    const start = rendered.indexOf('ct-review-job-dispatcher-run-secrets');
    expect(start).toBeGreaterThan(-1);
    const block = rendered.slice(start, start + 1200);
    expect(block).toContain('ct-review-job-dispatcher');
    expect(block).not.toContain('ct-review-action-dispatch');
  });

  it('scopes the grant to a namespaced Role, never a ClusterRole', () => {
    const rendered = render('--set', 'publishing.runSecrets.enabled=true');
    const secretsAt = rendered.indexOf('resources: ["secrets"]');
    const preceding = rendered.slice(0, secretsAt);
    expect(preceding.lastIndexOf('kind: Role')).toBeGreaterThan(preceding.lastIndexOf('kind: ClusterRole'));
  });
});

describe('review-yeti chart job dispatcher', () => {
  it('is absent by default', () => {
    // This Deployment has historically been applied outside Helm; enabling it makes
    // the chart the owner, which is a deliberate adoption step.
    expect(render()).not.toContain('ct-review-job-dispatcher');
  });

  it('runs the job dispatcher entrypoint, not the action-dispatch API', () => {
    // Same image, different entrypoint. Only this component provisions run secrets.
    const rendered = render(
      '--set', 'jobDispatcher.enabled=true',
      '--set', 'jobDispatcher.image=ghcr.io/x@sha256:abc',
    );
    expect(rendered).toContain('dist/reviewJobDispatcherIndex.js');
  });

  it('refuses to render without a pinned image', () => {
    // Defaulting to the chart appVersion would make adopting the existing
    // Deployment into Helm a silent version change as well.
    expect(() => render('--set', 'jobDispatcher.enabled=true'))
      .toThrow(/jobDispatcher\.image is required/u);
  });

  it('supplies App credentials only when run-secret provisioning is on', () => {
    const base = ['--set', 'jobDispatcher.enabled=true', '--set', 'jobDispatcher.image=ghcr.io/x@sha256:abc'];
    // Without provisioning there is nothing to mint, so the credential would be an
    // unnecessary grant sitting in a pod.
    const withoutSecrets = jobDispatcherDeployment(...base);
    const names = (withoutSecrets.spec.template.spec.containers[0].env || [])
      .map((entry: any) => entry.name);
    expect(names).not.toContain('GITHUB_APP_PRIVATE_KEY');
  });

  it('resolves App credentials to the right secret and key names', () => {
    // Asserting env-var *names* is not enough: a reference to the wrong secret (the
    // action-dispatch runtime secret, say) or a mistyped key would render cleanly,
    // pass a substring check, and only fail at pod start -- silently reinstating the
    // 'runSecrets enabled but the component has nothing' failure this exists to fix.
    const deployment = jobDispatcherDeployment(
      '--set', 'jobDispatcher.enabled=true',
      '--set', 'jobDispatcher.image=ghcr.io/x@sha256:abc',
      '--set', 'publishing.runSecrets.enabled=true',
      '--set', 'jobDispatcher.appSecretName=my-app-secret',
    );
    const env: any[] = deployment.spec.template.spec.containers[0].env || [];
    const resolved = Object.fromEntries(env.map((entry) => [
      entry.name,
      { secret: entry.valueFrom?.secretKeyRef?.name, key: entry.valueFrom?.secretKeyRef?.key },
    ]));
    expect(resolved.GITHUB_APP_ID).toEqual({ secret: 'my-app-secret', key: 'GITHUB_APP_ID' });
    expect(resolved.GITHUB_APP_PRIVATE_KEY).toEqual({ secret: 'my-app-secret', key: 'GITHUB_APP_PRIVATE_KEY' });
    // No inline values: every credential must arrive by reference.
    for (const entry of env) expect(entry.value).toBeUndefined();
  });

  it('runs under the job dispatcher service account, not the API one', () => {
    // The RBAC grant is bound to this account. A mismatch means the pod cannot write
    // run secrets even though the Role exists -- the defect shipped in #530.
    const deployment = jobDispatcherDeployment(
      '--set', 'jobDispatcher.enabled=true',
      '--set', 'jobDispatcher.image=ghcr.io/x@sha256:abc',
      '--set', 'jobDispatcher.serviceAccountName=custom-job-sa',
    );
    expect(deployment.spec.template.spec.serviceAccountName).toBe('custom-job-sa');
    expect(deployment.spec.template.spec.serviceAccountName).not.toBe('ct-review-action-dispatch');
  });

  it('binds the run-secret Role to the same account the deployment runs as', () => {
    // The two are configured independently, so they can drift apart. Assert they agree.
    const docs = renderDocs(
      '--set', 'jobDispatcher.enabled=true',
      '--set', 'jobDispatcher.image=ghcr.io/x@sha256:abc',
      '--set', 'publishing.runSecrets.enabled=true',
    );
    const deployment = docs.find((d) => d.kind === 'Deployment' && d.metadata?.name === 'ct-review-job-dispatcher');
    const binding = docs.find((d) => d.kind === 'RoleBinding' && String(d.metadata?.name).endsWith('-run-secrets'));
    expect(binding?.subjects?.[0]?.name).toBe(deployment?.spec.template.spec.serviceAccountName);
  });

  it('never renders a credential value into the manifest', () => {
    const rendered = render(
      '--set', 'jobDispatcher.enabled=true',
      '--set', 'jobDispatcher.image=ghcr.io/x@sha256:abc',
      '--set', 'publishing.runSecrets.enabled=true',
    );
    // Referenced by Secret name and key only.
    expect(rendered).toContain('secretKeyRef');
    expect(rendered).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/u);
  });
});
