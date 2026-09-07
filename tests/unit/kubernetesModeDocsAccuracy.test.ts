import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

/**
 * The Action pins its dispatch endpoint: `validateDispatchEndpoint` requires the
 * exact hosted origin and path. Documentation that promises a reader can point
 * Kubernetes Mode at "your own cluster" therefore describes something the code
 * refuses, and a reader following it deploys the chart and waits for reviews that
 * can never arrive.
 *
 * These assertions are deliberately narrow: they pin the *contradiction*, not the
 * prose. If the endpoint ever becomes configurable, the code change lands first
 * and these are updated with it.
 */
describe('Kubernetes Mode documentation matches enforced behaviour', () => {
  it('pins the endpoint in code, so the docs must not promise arbitrary clusters', () => {
    const dispatch = read('scripts/dispatch-doks-action.mjs');
    // The premise of the whole test: if this ever stops being true, revisit.
    expect(dispatch).toContain('url.origin === expected.origin');
    expect(dispatch).toContain('url.pathname === expected.pathname');
  });

  it('does not advertise self-hosting the worker in arbitrary clusters', () => {
    const doc = read('docs/KUBERNETES_MODE.md');
    expect(doc).not.toMatch(/EKS, GKE, AKS, or any vanilla K8s cluster/u);
    expect(doc).not.toMatch(/worker pods in your own cluster/u);
  });

  it('states plainly that the endpoint is fixed', () => {
    // A reader must be able to learn this without reading the dispatch script.
    const doc = read('docs/KUBERNETES_MODE.md');
    expect(doc).toMatch(/dispatch endpoint is fixed/iu);
    expect(doc).toContain('validateDispatchEndpoint');
  });

  it('does not title the chart section as self-hosting', () => {
    const readme = read('README.md');
    expect(readme).not.toMatch(/Self-Hosting with Official Helm 3 Chart/u);
    expect(readme).toMatch(/will not receive reviews yet/u);
  });
});
